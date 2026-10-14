// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { MarkdownTextSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ChatTextDecorationHandle, ChatTextDecorationId, ChatTextSelection } from '../src/client/contract/text.ts'
import { ChatTextHost } from '../src/client/text-host.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const source = { sessionId: 's1' as SessionId, messageId: 'm1' as MessageId, seq: 5 as SessionSeq, block: 0, text: '**中国😀** hello' }
function surface() {
  return {
    id: '0', text: '中国😀 hello',
    selection: () => ({ start: 1, end: 4 }),
    accepts: ({ start, end }) => start >= 0 && end > start && end <= 10 && start !== 3 && end !== 3,
    geometry: vi.fn(() => [{ x: 1, y: 2, width: 3, height: 4 }]),
    reveal: vi.fn<MarkdownTextSurface['reveal']>(() => vi.fn()), decorate: vi.fn<MarkdownTextSurface['decorate']>(),
  } satisfies MarkdownTextSurface
}

describe('chat completed-text host', () => {
  it('rejects queued activations after update, replacement, unmount and disposal', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const host = new ChatTextHost(async () => undefined)
    onTestFinished(() => { host.dispose() })
    const mounted = surface()
    const unregister = host.registerText(source, [mounted])
    const selected = host.selection()!
    const id = 'stable' as ChatTextDecorationId
    const callback = vi.fn()
    const current = () => mounted.decorate.mock.lastCall![0][0]!.activation!.activate
    const handle = host.register(ctx, { id, source: selected, label: '1' }, { label: 'Edit 1', onActivate: callback })
    const queued = current()
    queued()
    expect(callback).toHaveBeenLastCalledWith({ id, source: selected })
    handle.update({ source: { ...selected, start: 0, selectedText: '中国😀' }, label: '2' })
    queued()
    expect(callback).toHaveBeenCalledOnce()
    current()()
    expect(callback).toHaveBeenLastCalledWith({ id, source: { ...selected, start: 0, selectedText: '中国😀' } })
    const replaced = current()
    const replacement = host.register(ctx, { id, source: selected, label: '3' }, { label: 'Edit 3', onActivate: callback })
    replaced()
    await handle.dispose()
    expect(mounted.decorate.mock.lastCall![0]).toHaveLength(1)
    const removed = current()
    unregister()
    removed()
    const remounted = surface()
    host.registerText(source, [remounted])
    removed()
    expect(callback).toHaveBeenCalledTimes(2)
    remounted.decorate.mock.lastCall![0][0]!.activation!.activate()
    expect(callback).toHaveBeenCalledTimes(3)
    await replacement.dispose()
    removed()
    expect(callback).toHaveBeenCalledTimes(3)
  })

  it('contains synchronous errors and asynchronous rejections and refuses inactive owners', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const host = new ChatTextHost(async () => undefined)
    onTestFinished(() => { host.dispose() })
    const mounted = surface()
    host.registerText(source, [mounted])
    const selected = host.selection()!
    const failures = () => ctx.logger.buffer.filter(message => message.name === 'chatText' && message.type === 'error')
    let owner!: Context
    const fiber = ctx.plugin({ apply(context: Context) { owner = context } })
    await fiber.await()
    const handle = host.register(owner, { id: 'error' as ChatTextDecorationId, source: selected, label: '1' }, {
      label: 'Edit', onActivate: () => { throw new Error('sync failure') },
    })
    expect(() => { mounted.decorate.mock.lastCall![0][0]!.activation!.activate() }).not.toThrow()
    handle.update({ source: selected, label: '1' }, { label: 'Edit', onActivate: async () => { throw new Error('async failure') } })
    mounted.decorate.mock.lastCall![0][0]!.activation!.activate()
    await Promise.resolve()
    expect(failures()).toHaveLength(2)
    const stale = mounted.decorate.mock.lastCall![0][0]!.activation!.activate
    await fiber.dispose()
    stale()
    expect(failures()).toHaveLength(2)
    expect(() => host.register(owner, { id: 'inactive' as ChatTextDecorationId, source: selected, label: '2' })).toThrow()
    expect(mounted.decorate.mock.lastCall![0]).toEqual([])
  })

  it('isolates stable ids by owner, updates overlapping decorations, and removes contributions on fiber disposal', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const host = new ChatTextHost(async () => undefined)
    const mounted = surface()
    const unregister = host.registerText(source, [mounted])
    const selection = host.selection()!
    expect(selection).toMatchObject({ completed: true, surfaceId: 'block:0/0', revision: source.text, start: 1, end: 4, selectedText: '国😀' })
    const id = 'same' as ChatTextDecorationId
    let handle: ChatTextDecorationHandle | undefined
    const first = ctx.plugin({ apply: (owner) => { handle = host.register(owner, { id, source: selection, label: 'First' }) } })
    const second = ctx.plugin({ apply: (owner) => { host.register(owner, { id, source: { ...selection, start: 0, selectedText: '中国😀' }, label: 'Second' }) } })
    await Promise.all([first.await(), second.await()])
    expect(vi.mocked(mounted.decorate).mock.lastCall?.[0]).toHaveLength(2)
    handle!.update({ source: selection, label: 'Updated' })
    expect(vi.mocked(mounted.decorate).mock.lastCall?.[0].map(value => value.label)).toEqual(['Updated', 'Second'])
    await first.dispose()
    expect(vi.mocked(mounted.decorate).mock.lastCall?.[0].map(value => value.label)).toEqual(['Second'])
    await second.dispose()
    expect(vi.mocked(mounted.decorate).mock.lastCall?.[0]).toEqual([])
    unregister()
    expect(host.selection()).toBeNull()
    const remounted = surface()
    host.registerText(source, [remounted])
    expect(host.selection()).toEqual(selection)
    host.dispose()
    expect(vi.mocked(remounted.decorate).mock.lastCall?.[0]).toEqual([])
    await ctx.fiber.dispose()
  })

  it('keeps equal callbacks registered by independent owners alive until each owner leaves', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const host = new ChatTextHost(async () => undefined)
    host.registerText(source, [surface()])
    const listener = vi.fn()
    const first = ctx.plugin({ apply: (owner) => { host.subscribe(owner, listener) } })
    const second = ctx.plugin({ apply: (owner) => { host.subscribe(owner, listener) } })
    await Promise.all([first.await(), second.await()])
    host.selectionChanged()
    expect(listener).toHaveBeenCalledTimes(2)
    await first.dispose()
    host.selectionChanged()
    expect(listener).toHaveBeenCalledTimes(3)
    await second.dispose()
    host.selectionChanged()
    expect(listener).toHaveBeenCalledTimes(3)
    host.dispose()
    await ctx.fiber.dispose()
  })

  it('awaits independently owned manual subscription and decoration cleanup', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const host = new ChatTextHost(async () => undefined)
    onTestFinished(() => { host.dispose() })
    const mounted = surface()
    host.registerText(source, [mounted])
    const listener = vi.fn()
    const unsubscribe = host.subscribe(ctx, listener)
    const handle = host.register(ctx, {
      id: 'manual' as ChatTextDecorationId, source: host.selection()!, label: 'Manual',
    })
    host.selectionChanged()
    expect(listener).toHaveBeenCalledOnce()
    await unsubscribe()
    host.selectionChanged()
    expect(listener).toHaveBeenCalledOnce()
    await handle.dispose()
    expect(mounted.decorate.mock.lastCall?.[0]).toEqual([])
    await handle.dispose()
    expect(mounted.decorate.mock.lastCall?.[0]).toEqual([])
  })

  it('does not reveal a surface when disposal occurs during the awaited renderer commit', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return 0 })
    const host = new ChatTextHost(async () => undefined)
    onTestFinished(() => { host.dispose() })
    const mounted = surface()
    host.registerText(source, [mounted])
    const navigation = host.navigate(host.selection()!)
    await Promise.resolve()
    const frame = frames[0]
    if (frame === undefined) throw new Error('Navigation did not request the renderer commit')
    host.dispose()
    frame(0)
    expect(await navigation).toEqual({ status: 'unavailable' })
    expect(mounted.reveal).not.toHaveBeenCalled()
  })

  it('validates selected text, revision and surrogate boundaries before returning owned geometry', () => {
    const host = new ChatTextHost(async () => undefined)
    host.registerText(source, [surface()])
    const selection = host.selection()!
    expect(host.geometry(selection)).toEqual([{ x: 1, y: 2, width: 3, height: 4 }])
    expect(host.geometry({ ...selection, selectedText: 'similar' })).toBeNull()
    expect(host.geometry({ ...selection, revision: 'changed' as ChatTextSelection['revision'] })).toBeNull()
    expect(host.geometry({ ...selection, end: 3 })).toBeNull()
    expect(host.geometry({ ...selection, messageId: 'other' as MessageId })).toBeNull()
    host.dispose()
    expect(host.geometry(selection)).toBeNull()
  })

  it('highlights the exact interval for three seconds, replaces it on repeated navigation and clears it on disposal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
    const host = new ChatTextHost(async () => undefined)
    onTestFinished(() => { host.dispose() })
    const mounted = surface()
    const clear = vi.fn()
    mounted.reveal.mockReturnValue(clear)
    const unregister = host.registerText(source, [mounted])
    const selected = host.selection()!
    await host.navigate(selected)
    expect(mounted.reveal).toHaveBeenCalledWith({ start: selected.start, end: selected.end })
    vi.advanceTimersByTime(2999)
    expect(clear).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(clear).toHaveBeenCalledOnce()
    await host.navigate(selected)
    await host.navigate(selected)
    expect(clear).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    unregister()
    expect(clear).toHaveBeenCalledTimes(3)
    host.registerText(source, [mounted])
    await host.navigate(selected)
    host.dispose()
    expect(clear).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares feedback across Markdown leaves and clears only the last owning mount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
    const host = new ChatTextHost(async () => undefined)
    onTestFinished(() => { host.dispose() })
    const highlight = vi.fn()
    const first = host.registerText(source, [surface()], highlight)
    const second = host.registerText({ ...source, block: 1 }, [surface()], highlight)
    expect(await host.navigate(host.selection()!)).toEqual({ status: 'revealed' })
    expect(highlight).toHaveBeenLastCalledWith(true)
    first()
    expect(highlight).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    second()
    expect(highlight).toHaveBeenLastCalledWith(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never starts feedback when disposed during a pending commit or reveal fails', async () => {
    let frame!: FrameRequestCallback
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 0 })
    const host = new ChatTextHost(async () => undefined)
    const highlight = vi.fn()
    host.registerText(source, [surface()], highlight)
    const selected = host.selection()!
    const pending = host.navigate(selected)
    await Promise.resolve()
    host.dispose()
    frame(0)
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(highlight).not.toHaveBeenCalled()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
    const failing = new ChatTextHost(async () => undefined)
    const broken = surface()
    broken.reveal.mockImplementation(() => { throw new Error('cannot reveal') })
    failing.registerText(source, [broken], highlight)
    await expect(failing.navigate(selected)).rejects.toThrow('cannot reveal')
    expect(highlight).not.toHaveBeenCalled()
    failing.dispose()
  })

  it('loads before classifying an unmounted source and never reveals changed or unavailable targets', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0 })
    const original = new ChatTextHost(async () => undefined)
    original.registerText(source, [surface()])
    const selection = original.selection()!
    original.dispose()
    const mounted = surface()
    const prepare = vi.fn(async () => { host.registerText(source, [mounted]); return undefined })
    const host = new ChatTextHost(prepare)
    expect(await host.navigate(selection)).toEqual({ status: 'revealed' })
    expect(prepare).toHaveBeenCalledWith(selection)
    expect(mounted.reveal).toHaveBeenCalledOnce()
    expect(await host.navigate({ ...selection, selectedText: 'not this source' })).toEqual({ status: 'changed' })
    expect(mounted.reveal).toHaveBeenCalledOnce()
    host.dispose()
    const unavailable = new ChatTextHost(async () => undefined)
    expect(await unavailable.navigate(selection)).toEqual({ status: 'unavailable' })
    const missing = new ChatTextHost(async () => ({ status: 'missing' }))
    expect(await missing.navigate(selection)).toEqual({ status: 'missing' })
    const changed = new ChatTextHost(async () => ({ status: 'changed' }))
    expect(await changed.navigate(selection)).toEqual({ status: 'changed' })
    for (const service of [unavailable, missing, changed]) service.dispose()
  })
})
