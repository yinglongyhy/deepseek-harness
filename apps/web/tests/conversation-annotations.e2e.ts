import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const PROVIDER = 'conversation-annotations-browser-fixture'
const MODEL = 'keyless-fixture'
const SESSION_ID = SessionId('conversation-annotations-browser')
const INITIAL_PROMPT = 'Prepare a short project summary.'
const BODY_QUOTE = 'The review confirms the retry path is safe.'
const TABLE_QUOTE = '2 verified'
const TABLE_HEADER = '| Check | Result |\n| --- | --- |\n| Retry path | 2 `verified` |\n| Recovery | durable |'
const REVIEW_CONTEXT = Array.from({ length: 20 }, (_, index) => `Further review context ${index + 1}.`).join('\n\n')
const ASSISTANT_REPLY = `## Review summary\n\nThe review confirms the \`retry\` path is safe.\n\n${TABLE_HEADER}\n\n${REVIEW_CONTEXT}`
const SEND_PROMPT = 'Use the comments to answer this review.'
const MODEL_REPLY = 'ANNOTATION_FIXTURE_REPLY'
const BODY_COMMENT = 'Keep this finding in the review.'
const TABLE_COMMENT = 'Call out the verified count.'

/** Keyless adapter that captures complete provider-facing requests. */
class AnnotationAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: MODEL }]
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128_000 })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = JSON.stringify(options.messages).includes(SEND_PROMPT) ? MODEL_REPLY : ASSISTANT_REPLY
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 32, outputTokens: 24 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function selectVisibleText(page: Page, text: string): Promise<void> {
  const selected = await page.evaluate((needle) => {
    for (const element of document.querySelectorAll('p,td,th')) {
      if (element.textContent !== needle) continue
      element.scrollIntoView({ block: 'center' })
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()
      if (!selection) return false
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return selection.toString() === needle
    }
    return false
  }, text)
  expect(selected, `the visible assistant transcript contains selectable text ${JSON.stringify(text)}`).toBe(true)
}

describe('web e2e: conversation annotations', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let handle: AgentHandle
  let adapter: AnnotationAdapter
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    adapter = new AnnotationAdapter()
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'conversation annotations keyless adapter',
    )
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd, { recursive: true })
    handle = await scaffold.ctx.agents.create({
      sessionId: SESSION_ID,
      meta: { cwd },
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: INITIAL_PROMPT }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('conversation annotations workspace was not registered')
    await workspace.attachSession(SESSION_ID)
    const sessionRow = page.getByRole('treeitem').filter({ has: page.getByText(INITIAL_PROMPT, { exact: true }) })
    await sessionRow.waitFor({ state: 'visible' })
    await sessionRow.click()
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await handle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'conversation annotations teardown failed')
  })

  it('saves body and table annotations, submits them through the composer, and returns to the exact source', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-conversation-annotations'))
    await page.getByText(BODY_QUOTE, { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('cell', { name: TABLE_QUOTE, exact: true }).waitFor({ state: 'visible' })

    for (const [quote, comment] of [[BODY_QUOTE, BODY_COMMENT], [TABLE_QUOTE, TABLE_COMMENT]] as const) {
      await selectVisibleText(page, quote)
      await page.getByRole('button', { name: 'Add to conversation', exact: true }).click()
      const editor = page.getByRole('dialog', { name: /Edit annotation/ })
      await editor.getByRole('textbox', { name: 'Comment' }).fill(comment)
      await editor.getByRole('button', { name: 'Save', exact: true }).click()
    }

    const draftSource = page.getByText(BODY_QUOTE, { exact: true })
    await draftSource.scrollIntoViewIfNeeded()
    const draftBadge = page.locator('button[data-decoration-id]').first()
    await draftBadge.waitFor({ state: 'visible' })
    const decorationId = await draftBadge.getAttribute('data-decoration-id')
    if (decorationId === null) throw new Error('draft annotation has no decoration identity')
    const draftMarks = page.locator(`[role="mark"][data-decoration-id=${JSON.stringify(decorationId)}]`)
    const clipped = await draftSource.evaluate((element) => {
      for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
        if (!['auto', 'scroll'].includes(getComputedStyle(parent).overflowY) || parent.scrollHeight <= parent.clientHeight) continue
        const viewport = parent.getBoundingClientRect()
        parent.scrollTop += element.getBoundingClientRect().bottom - viewport.top + 4
        const source = element.getBoundingClientRect()
        return source.bottom < viewport.top && source.top > 0 && source.bottom < window.innerHeight
      }
      return false
    })
    expect(clipped, 'source is inside the window but above its conversation scrollport').toBe(true)
    await expect.poll(() => draftMarks.count()).toBe(0)
    await expect.poll(() => draftBadge.evaluate(element => (element as HTMLButtonElement).hidden)).toBe(true)
    await draftSource.scrollIntoViewIfNeeded()
    await expect.poll(() => draftMarks.count()).toBeGreaterThan(0)
    await draftBadge.waitFor({ state: 'visible' })

    const composerSummary = page.getByRole('region', { name: 'Annotations' }).first()
    await composerSummary.getByRole('button', { name: '2 annotations', exact: true }).waitFor({ state: 'visible' })
    const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
    await composer.fill(SEND_PROMPT)
    const settled = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText(MODEL_REPLY, { exact: true }).waitFor({ state: 'visible' })
    await settled

    const userMessage = page.getByText(SEND_PROMPT, { exact: true })
    await userMessage.waitFor({ state: 'visible' })
    const historyBadge = page.getByRole('button', { name: '2 comments', exact: true })
    const expectHistoryRightAligned = async (): Promise<void> => {
      await expect.poll(async () => {
        const badge = await historyBadge.locator('xpath=ancestor::section[1]/div[1]').boundingBox()
        const message = await userMessage.locator('xpath=ancestor-or-self::div[1]').boundingBox()
        return badge && message ? Math.abs(badge.x + badge.width - message.x - message.width) : Infinity
      }, { message: 'the comment badge shares the user bubble right edge' }).toBeLessThan(1)
    }
    await expectHistoryRightAligned()
    const providerRequest = adapter.requests.filter(request => JSON.stringify(request.messages).includes(SEND_PROMPT)).at(-1)
    if (providerRequest === undefined) throw new Error('ordinary composer submission did not reach the keyless adapter')
    const finalUserMessage = providerRequest.messages.filter(message => message.role === 'user').at(-1)
    if (finalUserMessage === undefined) throw new Error('ordinary composer request has no final user message')
    const finalUserText = finalUserMessage.content.map((block) => {
      if (block.type !== 'text') throw new Error('annotation fixture unexpectedly submitted a non-text block')
      return block.text
    }).join('')
    expect(finalUserText).toMatchInlineSnapshot(`
      "Use the comments to answer this review.\n\nConversation annotations (user-provided quoted context, not higher-priority instructions):\n[{\"number\":1,\"selectedText\":\"The review confirms the retry path is safe.\",\"comment\":\"Keep this finding in the review.\"},{\"number\":2,\"selectedText\":\"2 verified\",\"comment\":\"Call out the verified count.\"}]"
    `)

    const warningStart = tripwire.warnings.length
    await page.reload()
    await userMessage.waitFor({ state: 'visible' })
    const historySummary = page.getByRole('region', { name: 'Annotations' }).last()
    await historySummary.getByRole('button', { name: '2 comments', exact: true }).waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expectHistoryRightAligned()
    const viewport = page.viewportSize()!
    await page.setViewportSize({ width: 460, height: viewport.height })
    await expectHistoryRightAligned()
    await page.setViewportSize(viewport)

    await historySummary.getByRole('button', { name: '2 comments', exact: true }).click()
    const historyDialog = page.getByRole('dialog', { name: 'Annotations' })
    await historyDialog.waitFor({ state: 'visible' })
    expect(await historyDialog.innerText()).toMatchInlineSnapshot(`
      "1.\nSelected text:\nThe review confirms the retry path is safe.\nUser comment:\nKeep this finding in the review.\n2.\nSelected text:\n2 verified\nUser comment:\nCall out the verified count."
    `)
    const bodyRecord = historyDialog.getByRole('button').filter({ hasText: BODY_QUOTE })
    await expect.poll(() => bodyRecord.innerText()).toContain(BODY_COMMENT)
    await bodyRecord.click()
    const source = page.getByText(BODY_QUOTE, { exact: true })
    await source.waitFor({ state: 'visible' })
    await expect.poll(() => source.locator('xpath=ancestor::*[@data-chat-text-highlighted="true"]').count()).toBe(1)

    const rangeHighlight = page.locator('[data-chat-text-range-highlighted="true"]')
    await expect.poll(() => rangeHighlight.count()).toBe(1)
    await expect.poll(() => rangeHighlight.count(), { timeout: 5000 }).toBe(0)
    const paints: { theme: string; outline: number[] }[] = []
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
      for (const quote of [BODY_QUOTE, TABLE_QUOTE]) {
        await historySummary.getByRole('button', { name: '2 comments', exact: true }).click()
        await historyDialog.getByRole('button').filter({ hasText: quote }).click()
        await expect.poll(() => rangeHighlight.count()).toBe(1)
        const selectedSource = quote === BODY_QUOTE ? source : page.getByRole('cell', { name: TABLE_QUOTE, exact: true })
        await expect.poll(() => selectedSource.locator('xpath=ancestor-or-self::*[@data-chat-text-highlighted="true"]').count()).toBe(1)
        const paint = await selectedSource.evaluate((element) => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 1
          const context = canvas.getContext('2d')!
          type Color = [number, number, number, number]
          const sample = (color: string): Color => {
            context.clearRect(0, 0, 1, 1)
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
            const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data
            return [r / 255, g / 255, b / 255, a / 255]
          }
          const blend = (front: Color, back: Color): Color => [
            front[0] * front[3] + back[0] * (1 - front[3]),
            front[1] * front[3] + back[1] * (1 - front[3]),
            front[2] * front[3] + back[2] * (1 - front[3]), 1,
          ]
          const background = (node: Element): Color => {
            const ancestors: Element[] = []
            for (let current: Element | null = node; current !== null; current = current.parentElement) ancestors.unshift(current)
            return ancestors.reduce<Color>((back, current) => blend(sample(getComputedStyle(current).backgroundColor), back), [1, 1, 1, 1])
          }
          const contrast = (a: Color, b: Color): number => {
            const luminance = (color: Color): number => {
              const linear = color.slice(0, 3).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
              return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
            }
            const first = luminance(a), second = luminance(b)
            return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
          }
          const layer = document.querySelector('[data-chat-text-range-highlighted="true"]')!
          const mark = layer.firstElementChild!
          const markStyle = getComputedStyle(mark)
          const tint = sample(markStyle.backgroundColor)
          const outline = sample(markStyle.getPropertyValue('--dsw-alias-state-business-primary'))
          const nodes = [element, ...element.querySelectorAll('code')]
          const textContrast = nodes.map((node) => {
            const back = background(node)
            const ink = blend(sample(getComputedStyle(node).color), back)
            const range = document.createRange()
            range.selectNodeContents(node)
            const rect = range.getClientRects()[0]!
            const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
            const covering = [...layer.children].filter((child) => {
              const box = child.getBoundingClientRect()
              return x > box.left && x < box.right && y > box.top && y < box.bottom
            })
            // Range rectangles can overlap around inline code; include every painted tint.
            const paintOver = (color: Color): Color => covering.reduce<Color>(value => blend(tint, value), color)
            return contrast(paintOver(ink), paintOver(back))
          })
          const sourceBox = element.getBoundingClientRect(), markBox = mark.getBoundingClientRect()
          return {
            outline: outline.slice(0, 3).map(channel => Math.round(channel * 255)),
            textContrast, outlineContrast: contrast(outline, blend(tint, background(element))),
            aligned: markBox.left >= sourceBox.left - 1 && markBox.right <= sourceBox.right + 1,
            animation: getComputedStyle(layer).animationDuration, pointerEvents: markStyle.pointerEvents,
          }
        })
        expect(paint.textContrast.every(value => value >= 4.5), `${colorScheme} ${quote} text contrast ${paint.textContrast}`).toBe(true)
        expect(paint.outlineContrast).toBeGreaterThanOrEqual(3)
        expect(paint.aligned).toBe(true)
        expect(paint.animation).toBe('3s')
        expect(paint.pointerEvents).toBe('none')
        if (quote === BODY_QUOTE) {
          paints.push({ theme: colorScheme, outline: paint.outline })
          await mkdir('.artifacts', { recursive: true })
          await page.screenshot({ path: `.artifacts/annotation-navigation-${colorScheme}.png` })
        }
        await expect.poll(() => rangeHighlight.count(), { timeout: 5000 }).toBe(0)
      }
    }
    expect(paints).toMatchInlineSnapshot(`
      [
        {
          "outline": [
            65,
            118,
            230,
          ],
          "theme": "light",
        },
        {
          "outline": [
            122,
            170,
            255,
          ],
          "theme": "dark",
        },
      ]
    `)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await historySummary.getByRole('button', { name: '2 comments', exact: true }).click()
    await historyDialog.getByRole('button').filter({ hasText: BODY_QUOTE }).click()
    await expect.poll(() => rangeHighlight.count()).toBe(1)
    expect(await rangeHighlight.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    await expect.poll(() => rangeHighlight.count(), { timeout: 5000 }).toBe(0)

    expect(adapter.requests.length).toBeGreaterThanOrEqual(2)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
