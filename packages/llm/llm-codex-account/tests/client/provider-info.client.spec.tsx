// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cssSource = readFileSync(resolve(process.cwd(), 'packages/llm/llm-codex-account/src/client/ProviderInfo.module.css'), 'utf8')
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { createProviderInfoFooter, ProviderInfoChannel, ProviderInfoRevision, providerInfoText, type ProviderInfoProps } from '../../src/client/provider-info.tsx'
import type { InfoProvider, ProviderInfoResult } from '../../src/shared/provider-info.ts'
import { CODEX_OAUTH_CHANNEL } from '../../src/shared/protocol.ts'
import { translate, deferred } from './seams.client.ts'
import { snapshotHook } from './reactivity.client.ts'

function source<T>(initial: T): ObservableSnapshot<T> & { set(value: T): void; listeners: Set<() => void> } {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return { listeners,
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next) => { snapshot = next; for (const listener of listeners) listener() },
  }
}

function answer(provider: InfoProvider): ProviderInfoResult {
  return { refreshIntervalMs: 60_000, info: provider === 'deepseek-official'
    ? { provider, queriedAt: 1, currency: 'CNY', balance: '12.34' }
    : {
      provider, queriedAt: 1,
      fiveHour: { remainingPercent: 82, resetsAt: null },
      week: { remainingPercent: 61, resetsAt: 2_000_000_000_000 },
    } }
}

function mount(provider: string | null = 'deepseek-official') {
  const directory = source({ current: provider === null ? null : { provider, model: 'model-one' } })
  const session = source({ running: false })
  const revisions = new ProviderInfoRevision()
  const read = vi.fn<(provider: InfoProvider) => Promise<ProviderInfoResult>>().mockImplementation(async provider => answer(provider))
  const locale = source<{ active: 'zh' | 'en' }>({ active: 'zh' })
  const Component = createProviderInfoFooter({ read })
  const useSession: ProviderInfoProps['useSession'] = selector => selector(snapshotHook(session)(value => value) as never)
  const t: ProviderInfoProps['t'] = (key, params) => translate(locale.getSnapshot().active)(key, params)
  const view = render(createElement(Component, {
    useDirectory: snapshotHook(directory), useRevision: snapshotHook(revisions), useLocale: snapshotHook(locale), useSession, t,
  } as ProviderInfoProps))
  return { ...view, directory, session, locale, revisions, read }
}

async function settle(): Promise<void> { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }

function descriptionOf(element: HTMLElement): string {
  const id = element.getAttribute('aria-describedby')
  return id === null ? '' : document.getElementById(id)?.textContent ?? ''
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  class TestResizeObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      const entry: ResizeObserverEntry = {
        borderBoxSize: [{ inlineSize: 240, blockSize: 80 }],
        contentBoxSize: [{ inlineSize: 240, blockSize: 80 }],
        devicePixelContentBoxSize: [{ inlineSize: 240, blockSize: 80 }],
        contentRect: new DOMRectReadOnly(0, 0, 240, 80),
        target,
      }
      this.callback([entry], this)
    }
    unobserve(_target: Element): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('provider footer', () => {
  it('renders only the requested compact content and places its own pill after context usage', async () => {
    mount()
    await settle()
    expect(screen.getByText('¥12.34')).toBeDefined()
    expect(screen.queryByText('DeepSeek:')).toBeNull()
    const group = screen.getByRole('group', { name: 'DeepSeek 账户余额' })
    expect(group.hasAttribute('title')).toBe(false)
    expect(descriptionOf(group)).toMatch(/¥12\.34.*DeepSeek 账户余额.*更新时间：/s)
    fireEvent.focus(group)
    expect(screen.getByRole('tooltip').textContent).toContain('DeepSeek 账户余额')
    expect(cssSource).toMatch(/order:\s*1/)
    expect(cssSource).toMatch(/min-width:\s*0/)
    expect(providerInfoText({ provider: 'deepseek-official', currency: 'USD', balance: '0', queriedAt: 1 }, translate('en'), 'en')).toBe('$0.00')
  })

  it('follows provider selection without rereading for another model of the same provider', async () => {
    const app = mount()
    await settle()
    act(() => { app.directory.set({ current: { provider: 'deepseek-official', model: 'model-two' } }) })
    await settle()
    expect(app.read).toHaveBeenCalledTimes(1)
    act(() => { app.directory.set({ current: { provider: 'openai-codex', model: 'gpt-model' } }) })
    expect(screen.queryByText('¥12.34')).toBeNull()
    await settle()
    expect(screen.getByText('5 小时 82% · 周 61%')).toBeDefined()
    fireEvent.focus(screen.getByRole('group', { name: 'Codex 剩余额度' }))
    expect(screen.getByRole('tooltip').textContent).toContain('周额度重置')
    expect(screen.queryByText('Codex:')).toBeNull()
  })

  it.each(['deepseek-account', 'openai', 'custom-proxy', null])('renders nothing and makes no request for %s', async (provider) => {
    const app = mount(provider)
    await settle()
    expect(app.container.textContent).toBe('')
    expect(app.read).not.toHaveBeenCalled()
  })

  it('hides absent 5-hour quota but displays an exhausted week', async () => {
    const app = mount('openai-codex')
    app.read.mockResolvedValue({ refreshIntervalMs: 60_000, info: { provider: 'openai-codex', queriedAt: 1, week: { remainingPercent: 0, resetsAt: null } } })
    act(() => { app.revisions.invalidate() })
    await settle()
    expect(screen.getByText('周 0%')).toBeDefined()
    expect(screen.getByRole('group').textContent).not.toContain('5 小时')
  })

  it('ignores a late answer from the previously selected provider', async () => {
    const app = mount()
    await settle()
    const late = deferred<ProviderInfoResult>()
    app.read.mockReturnValueOnce(late.promise)
    act(() => { app.revisions.invalidate() })
    await settle()
    act(() => { app.directory.set({ current: { provider: 'openai-codex', model: 'gpt' } }) })
    await settle()
    await act(async () => { late.resolve(answer('deepseek-official')) })
    expect(screen.getByText('5 小时 82% · 周 61%')).toBeDefined()
    expect(screen.queryByText('¥12.34')).toBeNull()
  })

  it('clears old account data immediately on invalidation and hides unavailable or failed queries', async () => {
    const app = mount()
    await settle()
    const pending = deferred<ProviderInfoResult>()
    app.read.mockReturnValueOnce(pending.promise)
    act(() => { app.revisions.invalidate() })
    expect(screen.queryByText('¥12.34')).toBeNull()
    await act(async () => { pending.resolve({ refreshIntervalMs: 60_000, info: null }) })
    expect(app.container.textContent).toBe('')
    app.read.mockRejectedValueOnce(new Error('server-secret'))
    act(() => { app.revisions.invalidate() })
    await settle()
    expect(app.container.textContent).toBe('')
  })

  it('refreshes on completion and cadence, pauses while hidden, and resumes on visibility', async () => {
    const app = mount()
    await settle()
    act(() => { app.session.set({ running: true }) })
    await settle()
    act(() => { app.session.set({ running: false }) })
    await settle()
    expect(app.read).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(app.read).toHaveBeenCalledTimes(4)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(app.read).toHaveBeenCalledTimes(4)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    expect(app.read).toHaveBeenCalledTimes(5)
  })

  it('updates quota labels and dates with the application locale without refetching', async () => {
    const app = mount('openai-codex')
    await settle()
    fireEvent.focus(screen.getByRole('group', { name: 'Codex 剩余额度' }))
    expect(screen.getByRole('tooltip').textContent).toContain(new Date(2_000_000_000_000).toLocaleString('zh'))
    act(() => { app.locale.set({ active: 'en' }) })
    expect(screen.getByText('5h 82% · week 61%')).toBeDefined()
    expect(descriptionOf(screen.getByRole('group', { name: 'Codex remaining quota' }))).toMatch(/5h 82% · week 61%.*Weekly reset:.*Updated:/s)
    expect(screen.getByRole('tooltip').textContent).toContain(new Date(2_000_000_000_000).toLocaleString('en'))
    expect(screen.getByRole('tooltip').textContent).toContain('Weekly reset:')
    expect(app.read).toHaveBeenCalledTimes(1)
  })

  it('formats fractional percentages and tolerates custom non-Intl locale ids', () => {
    const info = { provider: 'openai-codex' as const, queriedAt: 1, fiveHour: { remainingPercent: 82.34, resetsAt: null } }
    expect(providerInfoText(info, translate('zh'), 'zh')).toBe('5 小时 82.3%')
    expect(providerInfoText(info, translate('en'), 'custom_locale')).toBe('5h 82.3%')
  })

  it('removes subscriptions and timers on unmount', async () => {
    const app = mount()
    await settle()
    app.unmount()
    expect(app.directory.listeners.size).toBe(0)
    expect(app.session.listeners.size).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(app.read).toHaveBeenCalledTimes(1)
  })
})

describe('provider information uses the login Connection RPC', () => {
  it('uses the same channel, validates the reply and sends only a provider id', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, value: answer('openai-codex') })
    const channel = new ProviderInfoChannel({ call })
    expect(await channel.read('openai-codex')).toEqual(answer('openai-codex'))
    expect(call).toHaveBeenCalledWith(CODEX_OAUTH_CHANNEL, 'provider-info', { provider: 'openai-codex' })
  })

  it.each([
    { ok: false, error: { message: 'secret' } },
    { ok: true, value: { ...answer('openai-codex'), token: 'secret' } },
    { ok: true, value: answer('deepseek-official') },
  ])('does not accept errors, widened results or a mismatched account provider', async (result) => {
    const channel = new ProviderInfoChannel({ call: vi.fn().mockResolvedValue(result) })
    await expect(channel.read('openai-codex')).rejects.toThrow('provider-info-unavailable')
  })
})
