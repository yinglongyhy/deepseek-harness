// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cssSource = readFileSync(resolve(process.cwd(), 'packages/llm/llm-codex-account/src/client/Card.module.css'), 'utf8')
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { CodexOAuthCard } from '../../src/client/card.ts'
import { apply, inject } from '../../src/client/index.ts'
import { en, zh } from '../../src/client/locales.ts'
import { openAuthorizationInBrowser } from '../../src/client/open.ts'
import { CodexOAuthSection, type CodexOAuthSectionInjected, type CodexOAuthSectionProps } from '../../src/client/view.ts'
import { snapshotHook } from './reactivity.client.ts'
import { nativeBench } from './native-seams.client.ts'
import {
  CODEX_ATTEMPT_ID,
  CODEX_OWNER_TOKEN,
  FakeCodexOAuthEndpoint,
  FakeOpener,
  clientBench,
  initiatingView,
  officialAuthorizeUrl,
  statusFixture,
  translate,
  waitingView,
} from './seams.client.ts'

const URL = officialAuthorizeUrl()
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

/** The props one settings section occurrence receives, supply typed at the component factory. */
function sectionProps({ hooks, ...injected }: CodexOAuthSectionInjected): CodexOAuthSectionProps {
  return { ...injected, useCard: snapshotHook(hooks.card), close: () => {}, t: translate('zh'), useResource, usePanelInfo,
    useSessions: () => undefined as never,
    useSessionStatus: () => undefined as never,
    useSessionRetainInfo: () => undefined as never,
    useWorkspaces: () => undefined as never,
    useRemoteAccess: () => { throw new Error('account section does not read remote access state') },
    useSessionAccess: () => { throw new Error('account section does not read Session access state') },
    useWorkspaceAccess: () => { throw new Error('account section does not read Workspace access state') },
  }
}

/** Mount the section component the way the Settings shell mounts its slot entry. */
function mountSection(component: (props: CodexOAuthSectionProps) => ReactNode, injected: CodexOAuthSectionInjected): HTMLElement {
  const element = createElement(component, {
    ...sectionProps(injected),
  })
  return render(element).container
}

/** One mounted card over a scripted endpoint. */
interface CardScreen {
  readonly endpoint: FakeCodexOAuthEndpoint
  readonly opener: FakeOpener
  readonly card: CodexOAuthCard
  readonly container: HTMLElement
}

/**
 * Mount one section occurrence.
 * @param facts - the `status` facts the endpoint reports.
 * @returns the mounted section and its controls.
 */
function sectionScreen(facts: Parameters<typeof statusFixture>[0] = {}): CardScreen {
  const endpoint = new FakeCodexOAuthEndpoint()
  endpoint.statusAnswer = () => ({ value: statusFixture(facts) })
  const opener = new FakeOpener()
  const card = new CodexOAuthCard({ endpoint, open: opener.open })
  return { endpoint, opener, card, container: mountSection(CodexOAuthSection, {
    hooks: { card }, actions: card,
    attach: () => { card.attach() }, detach: () => { card.detach() }, catalog: nativeBench(),
  }) }
}

/** Run pending promise continuations inside `act`. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** Advance one poll interval inside `act`. */
async function poll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
}

function textOf(container: HTMLElement): string {
  return container.textContent ?? ''
}

function statuses(): string[] {
  return screen.queryAllByRole('status').map(node => node.textContent ?? '')
}

function alerts(): string[] {
  return screen.queryAllByRole('alert').map(node => node.textContent ?? '')
}

function click(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('codex oauth settings section', () => {
  it('mounts as its own page, with no Models page or provider row behind it', async () => {
    const app = sectionScreen()
    await settle()
    expect(screen.getByRole('group', { name: '使用 ChatGPT 登录' })).toBeDefined()
    expect(app.endpoint.calls.map(call => call.endpoint)).toEqual(['status'])
  })

  it('offers sign-in from the official record fact, with no manual-code entry', async () => {
    const app = sectionScreen()
    await settle()
    expect(textOf(app.container)).toContain('尚未登录。')
    expect(screen.getByRole('button', { name: '登录' })).toBeDefined()
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    // The only inputs this page owns are the model checkboxes of the panel below:
    // nothing here accepts a typed authorization code.
    expect(app.container.querySelectorAll('input:not([type="checkbox"]),textarea,select')).toHaveLength(0)
    expect(app.endpoint.calls.map(call => call.endpoint)).toEqual(['status'])
  })

  it('opens the authorization page once and offers a reopen control the user drives', async () => {
    const app = sectionScreen()
    app.endpoint.queryAnswer = (_request, ordinal) => ({ value: ordinal === 0 ? initiatingView() : waitingView(URL) })
    await settle()
    click('登录')
    await settle()
    expect(app.endpoint.calls.map(call => call.endpoint)).toEqual(['status', 'begin', 'query'])
    expect(app.opener.urls).toEqual([])
    await poll()
    expect(app.opener.urls).toEqual([URL])
    expect(statuses()).toContain('请在浏览器中完成授权。')
    await poll()
    expect(app.opener.urls).toEqual([URL])
    click('重新打开授权页')
    expect(app.opener.urls).toEqual([URL, URL])
    click('取消登录')
    await settle()
    expect(statuses()).toContain('登录已取消。')
    expect(app.endpoint.calls.filter(call => call.endpoint === 'cancel').map(call => call.payload)).toEqual([
      { attemptId: CODEX_ATTEMPT_ID, ownerToken: CODEX_OWNER_TOKEN, reason: 'user' },
    ])
  })

  it('localizes a refused attempt from its code and offers the retry', async () => {
    const app = sectionScreen()
    app.endpoint.beginAnswer = () => ({ failure: 'callback-port-unavailable' })
    await settle()
    click('登录')
    await settle()
    expect(alerts().join('|')).toContain('本机回调端口 1455 不可用')
    expect(screen.getByRole('button', { name: '登录' })).toBeDefined()
  })

  it('shows an official capability gap instead of a sign-in button', async () => {
    const app = sectionScreen({ available: false, gap: 'codex-flow-unavailable' })
    await settle()
    expect(alerts().join('|')).toContain('官方未提供 Codex 授权流程')
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
    expect(textOf(app.container)).toContain('尚未登录。')
  })

  it('offers only one full-width account action based on the saved record', async () => {
    sectionScreen({ stored: true })
    await settle()
    const group = screen.getByRole('group', { name: '使用 ChatGPT 登录' })
    const buttons = group.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toBe('退出')
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
    expect(screen.queryByRole('button', { name: '刷新状态' })).toBeNull()
    expect(cssSource).toMatch(/width:\s*100%/)
  })

  it('deletes the local record only after the user confirmed, and states its scope', async () => {
    const app = sectionScreen({ stored: true })
    await settle()
    expect(textOf(app.container)).toContain('已保存登录记录。')
    click('退出')
    expect(screen.getByRole('dialog', { name: '确认删除本机 Codex 凭据记录？' })).toBeDefined()
    expect(app.endpoint.calls.filter(call => call.endpoint === 'logout')).toEqual([])
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: false }) })
    click('删除本机记录')
    await settle()
    expect(app.endpoint.calls.filter(call => call.endpoint === 'logout')).toHaveLength(1)
    expect(textOf(app.container)).toContain('尚未登录。')
    expect(screen.getByRole('button', { name: '登录' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '退出' })).toBeNull()
    expect(textOf(app.container)).toContain('已删除本机凭据记录；模型路由配置未改动。')
  })

  it('marks its busy states and keeps every control a plain button', async () => {
    const app = sectionScreen()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    await settle()
    expect(app.container.querySelector('[aria-label="使用 ChatGPT 登录"]')?.getAttribute('aria-busy')).toBeNull()
    click('登录')
    await settle()
    expect(app.container.querySelector('[aria-label="使用 ChatGPT 登录"]')?.getAttribute('aria-busy')).toBe('true')
    for (const button of screen.getAllByRole('button')) expect(button.getAttribute('type')).toBe('button')
  })

  it('styles itself with host theme tokens only', async () => {
    sectionScreen()
    await settle()
    expect(cssSource).toContain('var(--dsw-alias-')
    expect(cssSource).not.toMatch(/#[0-9a-fA-F]{3}/)
    expect(cssSource).not.toMatch(/\brgba?\(/)
  })

  it('keeps every dictionary key present in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(translate('en')('card.title')).toBe('Sign in with ChatGPT')
    expect(translate('zh')('card.title')).toBe('使用 ChatGPT 登录')
    expect(translate('en')('failure.route-write-failed')).toBe(
      'Models could not be enabled automatically. Try again.',
    )
  })

  it('persists nothing: the attempt credential stays in memory', async () => {
    const app = sectionScreen()
    app.endpoint.queryAnswer = () => ({ value: waitingView(URL) })
    await settle()
    click('登录')
    await settle()
    expect(app.opener.urls).toEqual([URL])
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
    expect(document.cookie).toBe('')
  })

  it('hands the shell only an official authorization request', () => {
    const opened: string[] = []
    const spy = vi.spyOn(window, 'open').mockImplementation((url?: string | URL) => {
      opened.push(String(url))
      return null
    })
    openAuthorizationInBrowser(URL)
    openAuthorizationInBrowser('https://auth.openai.com/oauth/authorize?response_type=code')
    openAuthorizationInBrowser('https://example.com/oauth/authorize')
    openAuthorizationInBrowser(`${URL}#fragment`)
    expect(opened).toEqual([URL])
    spy.mockRestore()
  })

  it('registers one section entry through the injected slot and reads the page transport', async () => {
    const bench = clientBench()
    apply(bench.ctx)
    expect(bench.slots.injected).toEqual(['settings.section'])
    expect(bench.slots.registrations.map(entry => entry.options)).toHaveLength(1)
    const options = bench.slots.registrations[0]!.options
    expect(options).toMatchObject({ name: 'settings.section', id: 'codex-account', order: 11, locale: 'dsh-llm-codex-account' })
    expect(typeof options.label).toBe('function')
    expect(typeof options.inject).toBe('function')
    expect(bench.locale.registered.map(entry => [entry.ns, Object.keys(entry.dicts).sort()])).toEqual([
      ['dsh-llm-codex-account', ['en', 'zh']],
      ['codex-model-catalog', ['en', 'zh']],
    ])
    const component = bench.slots.component as (props: CodexOAuthSectionProps) => ReactNode
    const mine = mountSection(component, bench.slots.registrations[0]!.options.inject!(undefined as never) as CodexOAuthSectionInjected)
    await settle()
    expect(textOf(mine)).toContain('尚未登录。')
    expect(bench.rpc.calls.map(call => [call.channel, call.endpoint])).toEqual([
      ['/codex-oauth', 'status'],
    ])
    click('登录')
    await settle()
    expect(bench.rpc.calls.map(call => call.endpoint)).toEqual(['status', 'begin', 'query'])
  })

  it('drops the previous attempt and rereads the facts when the connection is re-established', async () => {
    const bench = clientBench()
    const fiber = bench.ctx.plugin({ inject, apply })
    await fiber.await()
    const component = bench.slots.component as (props: CodexOAuthSectionProps) => ReactNode
    const injected = bench.slots.registrations[0]!.options.inject!(undefined as never) as CodexOAuthSectionInjected
    const container = mountSection(component, injected)
    await settle()
    bench.rpc.server.queryAnswer = () => ({ value: initiatingView() })
    click('登录')
    await settle()
    const reads = bench.rpc.calls.filter(call => call.endpoint === 'status').length
    bench.ctx.emit('connection/reset')
    await settle()
    expect(bench.rpc.calls.some(call => call.endpoint === 'cancel'
      && (call.payload as { reason: string }).reason === 'page-closed')).toBe(true)
    expect(bench.rpc.calls.filter(call => call.endpoint === 'status')).toHaveLength(reads + 1)
    expect(textOf(container)).toContain('尚未登录。')
    await fiber.dispose()
    const settled = bench.rpc.calls.length
    bench.ctx.emit('connection/reset')
    await settle()
    expect(bench.rpc.calls.length).toBe(settled)
  })
})
