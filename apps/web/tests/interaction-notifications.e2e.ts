// Real Web Loader replay for privacy-preserving interaction notifications.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  assertFinalWorkspaceSnapshot, assertFixtureInventory, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, openSettings, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/approval-composer/session.v3.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/interaction-notifications', import.meta.url))
const EXPECTED = fileURLToPath(new URL('../../../snapshots/web/interaction-notifications/notification.expected.md', import.meta.url))
const MODE = webSnapshotMode()

type MockNotice = { title: string; body: string; tag: string; closed: boolean; onclick: (() => void) | null }
declare global {
  interface Window {
    __dshTestNotices: MockNotice[]
    __dshTestFocused: boolean
  }
}

describe('web e2e: interaction notifications over recorded approval replay', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: { sessionId: string; event: SessionEvent }[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, paceMs: 15, compareReplaySession: 'read-only' })
    scaffold.ctx.on('session/event', (session: { id: string }, event: SessionEvent) => {
      events.push({ sessionId: session.id, event })
    })
    browser = await chromium.launch()
    context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    page = await context.newPage()
    tripwire = watchConsole(page)
    await page.addInitScript(() => {
      const notices: MockNotice[] = []
      class FakeNotification {
        static permission: NotificationPermission = 'granted'
        static requestPermission(): Promise<NotificationPermission> { return Promise.resolve('granted') }
        private readonly record: MockNotice
        onerror: (() => void) | null = null
        closed = false
        constructor(readonly title: string, readonly options: NotificationOptions) {
          this.record = { title, body: options.body ?? '', tag: options.tag ?? '', closed: false, onclick: null }
          notices.push(this.record)
        }
        set onclick(value: (() => void) | null) { this.record.onclick = value }
        get onclick(): (() => void) | null { return this.record.onclick }
        close(): void { this.closed = true; this.record.closed = true }
      }
      const host = window
      host.__dshTestNotices = notices
      host.__dshTestFocused = true
      Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification })
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => host.__dshTestFocused })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('notifies in the background, opens its session, and leaves approval pending', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-interaction-notifications'))
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0]
    if (prompt === undefined) throw new Error('The approval fixture has no user prompt')
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })

    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.waitFor({ timeout: 10_000 })
    const settingTitle = settings.getByText('System notifications', { exact: true })
    await settingTitle.waitFor({ timeout: 10_000 })
    const toggle = settings.getByRole('switch', { name: 'System notifications', exact: true })
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    await settings.getByText('Notify when a task finishes or needs your input while this window is in the background. Saved for this browser or device.', { exact: true }).waitFor()
    const settingsSnapshot = await settingTitle.locator('xpath=../..').ariaSnapshot()
    expect(await page.evaluate(() => window.__dshTestNotices.length)).toBe(0)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /Access mode/ }).click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await expect.poll(() => page.getByRole('button', { name: 'Access mode, current: Read Only' }).count(), { timeout: 15_000 }).toBe(1)

    await page.evaluate(() => {
      const host = window
      host.__dshTestFocused = false
      window.dispatchEvent(new Event('blur'))
    })
    await input.fill(prompt)
    await input.press('Enter')
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 60_000 })
    await expect.poll(() => page.evaluate(() => window.__dshTestNotices.length), { timeout: 15_000 }).toBe(1)

    const originSession = await page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')
    if (originSession === null) throw new Error('The approval conversation has no session identity')
    const notice = await page.evaluate(() => {
      const value = window.__dshTestNotices[0]
      if (value === undefined) throw new Error('Expected a system notification')
      return { title: value.title, body: value.body, tag: value.tag }
    })
    expect(notice.title).toBe('DeepSeek Harness needs your attention')
    expect(notice.body).toBe('An operation needs approval. Click to open the conversation.')
    expect(notice.body).not.toContain(prompt)
    expect(notice.tag).toBeTruthy()
    expect(notice.tag).not.toContain(prompt)

    const create = page.waitForResponse('**/api/session/create')
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    const created = await create
    expect(created.ok()).toBe(true)
    const newSessionId = (await created.json() as { result: { value: { sessionId: string } } }).result.value.sessionId
    expect(newSessionId).not.toBe(originSession)
    await page.locator('[data-conversation-session="' + newSessionId + '"]').waitFor({ timeout: 15_000 })
    expect(await panel.count()).toBe(0)

    await page.evaluate(() => {
      window.__dshTestFocused = true
      window.dispatchEvent(new Event('focus'))
    })
    const originRow = page.locator('[data-row-key="session:' + originSession + '"]')
    await originRow.waitFor({ timeout: 15_000 })
    await originRow.click()
    await page.locator('[data-conversation-session="' + originSession + '"]').waitFor({ timeout: 15_000 })
    await panel.waitFor({ timeout: 15_000 })
    expect(events.filter(item => item.sessionId === originSession && item.event.type === 'approval/decided')).toEqual([])
    await expect.poll(() => panel.getByRole('button', { name: 'Allow once' }).count(), { timeout: 10_000 }).toBe(1)
    expect(await page.evaluate(() => {
      const notice = window.__dshTestNotices[0]
      if (notice === undefined) throw new Error('Expected a system notification')
      return notice.closed
    })).toBe(true)
    await page.evaluate(() => {
      window.__dshTestFocused = false
      window.dispatchEvent(new Event('blur'))
    })
    await expect.poll(() => page.evaluate(() => window.__dshTestNotices.length)).toBe(1)

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*=frame]', { timeout: 30_000 })
    await panel.waitFor({ timeout: 15_000 })
    await page.evaluate(() => {
      window.__dshTestFocused = false
      window.dispatchEvent(new Event('blur'))
    })
    await expect.poll(() => page.evaluate(() => window.__dshTestNotices.length), { timeout: 15_000 }).toBe(1)

    await openSettings(page, 'en')
    const reopened = page.getByRole('dialog', { name: 'Settings', exact: true })
    const settingSwitch = reopened.getByRole('switch', { name: 'System notifications', exact: true })
    await settingSwitch.click()
    await expect.poll(() => settingSwitch.getAttribute('aria-checked')).toBe('false')
    await expect.poll(() => page.evaluate(() => {
      const notice = window.__dshTestNotices[0]
      if (notice === undefined) throw new Error('Expected a system notification')
      return notice.closed
    })).toBe(true)
    await settingSwitch.click()
    await expect.poll(() => settingSwitch.getAttribute('aria-checked')).toBe('true')
    await expect.poll(() => page.evaluate(() => window.__dshTestNotices.length)).toBe(1)
    await page.keyboard.press('Escape')
    const detachedSessionCreate = page.waitForResponse('**/api/session/create')
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    const detachedSessionResponse = await detachedSessionCreate
    expect(detachedSessionResponse.ok()).toBe(true)
    const detachedSessionId = (await detachedSessionResponse.json() as { result: { value: { sessionId: string } } }).result.value.sessionId
    expect(detachedSessionId).not.toBe(originSession)
    await page.locator('[data-conversation-session="' + detachedSessionId + '"]').waitFor({ timeout: 15_000 })

    // Resolve the origin from a second real Web page while this page has no
    // rendered conversation reference to it. The first page must receive the
    // completion notification without becoming the selected conversation.
    expect(await page.locator('[data-conversation-session="' + originSession + '"]').count()).toBe(0)
    expect(await panel.count()).toBe(0)
    const approvalPage = await context.newPage()
    await approvalPage.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await approvalPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const workspaceGroup = approvalPage.locator('[data-row-key^="workspace:"]').first()
    await workspaceGroup.waitFor({ timeout: 15_000 })
    if (await workspaceGroup.getAttribute('aria-expanded') !== 'true') await workspaceGroup.click()
    const approvalOriginRow = approvalPage.locator('[data-row-key="session:' + originSession + '"]')
    await approvalOriginRow.waitFor({ timeout: 15_000 })
    await approvalOriginRow.click()
    const remotePanel = approvalPage.locator('[data-approval-key]')
    await remotePanel.waitFor({ timeout: 15_000 })
    const settled = scaffold.whenTurnSettled(60_000)
    await remotePanel.getByRole('button', { name: 'Allow once' }).click()
    expect(await settled).toBe(originSession)
    const completedTurns = events.filter(item => item.sessionId === originSession && item.event.type === 'turn/end')
    expect(completedTurns.map(item => item.event.type === 'turn/end' ? item.event.data.reason.kind : undefined)).toEqual(['completed'])
    await expect.poll(() => page.evaluate(() => window.__dshTestNotices.length), { timeout: 15_000 }).toBe(2)
    const taskNotice = await page.evaluate(() => {
      const value = window.__dshTestNotices[1]
      if (value === undefined) throw new Error('Expected a task-completed notification')
      return { title: value.title, body: value.body, tag: value.tag }
    })
    expect(taskNotice.title).toBe('DeepSeek Harness · Task completed')
    expect(taskNotice.body).toBe('Your task has finished. Click to open the conversation.')
    expect(taskNotice.tag).toBeTruthy()
    expect(await page.locator('[data-conversation-session="' + detachedSessionId + '"]').count()).toBe(1)

    const createForTaskNotice = page.waitForResponse('**/api/session/create')
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    const taskOtherSession = await createForTaskNotice
    expect(taskOtherSession.ok()).toBe(true)
    const taskOtherSessionId = (await taskOtherSession.json() as { result: { value: { sessionId: string } } }).result.value.sessionId
    expect(taskOtherSessionId).not.toBe(originSession)
    await page.locator('[data-conversation-session="' + taskOtherSessionId + '"]').waitFor({ timeout: 15_000 })
    const originEventCount = events.filter(item => item.sessionId === originSession).length
    await page.evaluate(() => {
      const value = window.__dshTestNotices[1]
      if (value === undefined) throw new Error('Expected a task-completed notification')
      value.onclick?.()
    })
    await page.locator('[data-conversation-session="' + originSession + '"]').waitFor({ timeout: 15_000 })
    await expect.poll(() => page.locator('[data-approval-key]').count()).toBe(0)
    expect(events.filter(item => item.sessionId === originSession)).toHaveLength(originEventCount)
    expect(events.filter(item => item.sessionId === originSession && item.event.type === 'approval/decided')).toHaveLength(1)
    expect(await page.evaluate(() => window.__dshTestNotices[1]?.closed)).toBe(true)
    await page.evaluate(() => {
      window.__dshTestFocused = true
      window.dispatchEvent(new Event('focus'))
      window.__dshTestFocused = false
      window.dispatchEvent(new Event('blur'))
    })
    await expect.poll(() => page.evaluate(() => window.__dshTestNotices.length)).toBe(2)
    const waitingSession = scaffold.ctx.sessions.get(SessionId(detachedSessionId))
    const controlSession = scaffold.ctx.sessions.get(SessionId(taskOtherSessionId))
    if (waitingSession === undefined || controlSession === undefined) throw new Error('Expected live notification test sessions')
    const completion = Promise.withResolvers<JobOutcome>()
    const jobId = scaffold.ctx.jobs.start({
      owner: waitingSession.id, kind: 'bash', label: 'Notification regression barrier',
      run: () => ({ done: completion.promise, cancel: () => { completion.resolve({ status: 'killed' }) } }),
    })
    onTestFinished(async () => {
      const settled = scaffold.ctx.jobs.wait(jobId, 30_000, waitingSession.id)
      completion.resolve({ status: 'completed' })
      await settled
    })
    waitingSession.append('turn/start', { turn: 1 })
    waitingSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // A later completion on the same ordered projection transport is the delivery barrier.
    controlSession.append('turn/start', { turn: 1 })
    controlSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect.poll(() => page.evaluate(() => window.__dshTestNotices.length)).toBe(3)
    const waitingNoticeCount = await page.evaluate(() => window.__dshTestNotices.length - 3)
    const jobSettled = scaffold.ctx.jobs.wait(jobId, 30_000, waitingSession.id)
    completion.resolve({ status: 'completed' })
    expect((await jobSettled).status).toBe('completed')
    controlSession.append('turn/start', { turn: 2 })
    controlSession.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await expect.poll(() => page.evaluate(() => window.__dshTestNotices.length)).toBe(4)
    const settlementNoticeCount = await page.evaluate(() => window.__dshTestNotices.length - 4)
    waitingSession.append('turn/start', { turn: 2 })
    waitingSession.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await expect.poll(() => page.evaluate(() => window.__dshTestNotices.length)).toBe(5)
    const resumedNoticeCount = await page.evaluate(() => window.__dshTestNotices.length - 4)

    await compareOrRefreshGolden(EXPECTED, [
      'Settings:', settingsSnapshot.trim(), '',
      'Approval notification:',
      '  title: ' + notice.title,
      '  body: ' + notice.body,
      '  tag: {{request}}',
      '',
      'Task completion notification:',
      '  title: ' + taskNotice.title,
      '  body: ' + taskNotice.body,
      '  tag: {{session}}',
      '',
      'Background work completion policy:',
      '  waiting turn notifications: ' + String(waitingNoticeCount),
      '  job settlement notifications: ' + String(settlementNoticeCount),
      '  subsequent completed turn notifications: ' + String(resumedNoticeCount),
    ].join('\n'), MODE)

    await assertFinalWorkspaceSnapshot(SNAPSHOT_DIR, join(scaffold.workspaceCwd, 'workspace'))
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['notification.expected.md', 'workspace.expected'])
  }, 180_000)
})
