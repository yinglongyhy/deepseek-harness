// @vitest-environment jsdom
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopNotificationBridge, DesktopNotificationEvent, NotificationToken } from '../src/types.ts'
import { createNotificationPlatform, type NoticeCopy } from '../src/client/platform.ts'

const token = (value: string): NotificationToken => brandString<NotificationToken>(value)
const noticeCopy: NoticeCopy = { title: 'Interaction needed', body: 'Open the application' }
interface BrowserNotice {
  title: string
  options: NotificationOptions
  onclick: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  close: ReturnType<typeof vi.fn>
}
const notices: BrowserNotice[] = []
let requestPermission: () => Promise<NotificationPermission>
class MockNotification {
  static permission: NotificationPermission = 'default'
  static requestPermission: () => Promise<NotificationPermission> = () => Promise.resolve('default')
  readonly options: NotificationOptions
  onclick: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly close = vi.fn()
  constructor(readonly title: string, options?: NotificationOptions) {
    this.options = options ?? {}
    notices.push(this)
  }
}
function browserPlatform() { return createNotificationPlatform(undefined) }
function bridge(overrides: Partial<DesktopNotificationBridge> = {}) {
  const listeners = new Set<(event: DesktopNotificationEvent) => void>()
  const statusSpy = overrides.status ?? vi.fn<DesktopNotificationBridge['status']>(async () => 'available')
  const showSpy = overrides.show ?? vi.fn<DesktopNotificationBridge['show']>(async () => 'shown')
  const closeSpy = overrides.close ?? vi.fn<DesktopNotificationBridge['close']>(async () => undefined)
  const subscribeSpy = vi.fn<DesktopNotificationBridge['subscribe']>((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  const api: DesktopNotificationBridge = {
    status: statusSpy,
    show: showSpy,
    close: closeSpy,
    subscribe: subscribeSpy,
  }
  return {
    api, listeners, showSpy, closeSpy,
    emit(event: DesktopNotificationEvent) { for (const listener of listeners) listener(event) },
  }
}

beforeEach(() => {
  notices.length = 0
  vi.stubGlobal('Notification', MockNotification)
  vi.stubGlobal('isSecureContext', true)
  requestPermission = vi.fn<() => Promise<NotificationPermission>>(async () => 'granted')
  MockNotification.permission = 'default'
  MockNotification.requestPermission = requestPermission
})
afterEach(() => vi.unstubAllGlobals())

describe('createNotificationPlatform', () => {
  it('reports browser permission only in a secure supported context', async () => {
    const platform = browserPlatform()
    expect(await platform.permission()).toBe('default')
    expect(await platform.requestPermission()).toBe('granted')
    expect(requestPermission).toHaveBeenCalledOnce()
    vi.stubGlobal('isSecureContext', false)
    expect(await platform.permission()).toBe('unsupported')
    expect(await platform.requestPermission()).toBe('unsupported')
    expect(requestPermission).toHaveBeenCalledOnce()
  })

  it('does not fall back to browser notifications inside desktop', async () => {
    const desktop = createNotificationPlatform({ protocolVersion: 2 })
    expect(await desktop.permission()).toBe('unsupported')
    expect(await desktop.requestPermission()).toBe('unsupported')
    await expect(desktop.show({ id: token('a'), kind: 'question', locale: 'en' }, noticeCopy, vi.fn(), vi.fn())).resolves.toBeUndefined()
    expect(notices).toHaveLength(0)
    await desktop.dispose()
  })

  it('constructs silent tagged browser notifications and routes click to focus then session action', async () => {
    const platform = browserPlatform()
    const click = vi.fn()
    const failed = vi.fn()
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    const handle = await platform.show({ id: token('request-id'), kind: 'approval', locale: 'en' }, noticeCopy, click, failed)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ title: noticeCopy.title, options: { body: noticeCopy.body, tag: 'request-id', silent: true } })
    notices[0]!.onclick?.(new Event('click'))
    expect(focus).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(failed).not.toHaveBeenCalled()
    await handle?.close()
    expect(notices[0]!.onclick).toBeNull()
    expect(notices[0]!.onerror).toBeNull()
    expect(notices[0]!.close).toHaveBeenCalledOnce()
    focus.mockRestore()
  })

  it('reports browser notification errors and detaches error listeners on close', async () => {
    const platform = browserPlatform()
    const failed = vi.fn()
    const handle = await platform.show({ id: token('broken'), kind: 'question', locale: 'zh' }, noticeCopy, vi.fn(), failed)
    notices[0]!.onerror?.(new Event('error'))
    expect(failed).toHaveBeenCalledOnce()
    if (handle === undefined) throw new Error('Expected browser notification handle')
    await handle.close()
    notices[0]!.onerror?.(new Event('error'))
    expect(failed).toHaveBeenCalledOnce()
  })

  it('uses desktop bridge permission and suppresses browser fallback for foreground responses', async () => {
    const native = bridge({ show: vi.fn<DesktopNotificationBridge['show']>(async () => 'foreground') })
    const platform = createNotificationPlatform({ protocolVersion: 1, notifications: native.api })
    expect(await platform.permission()).toBe('granted')
    expect(await platform.requestPermission()).toBe('granted')
    const handle = await platform.show({ id: token('foreground'), kind: 'approval', locale: 'en' }, noticeCopy, vi.fn(), vi.fn())
    expect(handle).toBeUndefined()
    expect(native.showSpy).toHaveBeenCalledOnce()
    expect(native.closeSpy).not.toHaveBeenCalled()
    expect(notices).toHaveLength(0)
    await platform.dispose()
    expect(native.listeners.size).toBe(0)
  })

  it('delivers native click and failure events until close, then removes callbacks', async () => {
    const native = bridge()
    const platform = createNotificationPlatform({ protocolVersion: 1, notifications: native.api })
    const click = vi.fn()
    const failed = vi.fn()
    const handle = await platform.show({ id: token('native-id'), kind: 'plan-review', locale: 'zh' }, noticeCopy, click, failed)
    native.emit({ id: token('native-id'), kind: 'click' })
    native.emit({ id: token('native-id'), kind: 'failed' })
    expect(click).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledOnce()
    await handle?.close()
    expect(native.closeSpy).toHaveBeenCalledExactlyOnceWith(token('native-id'))
    native.emit({ id: token('native-id'), kind: 'click' })
    expect(click).toHaveBeenCalledOnce()
    await platform.dispose()
    expect(native.listeners.size).toBe(0)
  })

  it('withdraws native callbacks and subscriptions on dispose', async () => {
    const native = bridge()
    const platform = createNotificationPlatform({ protocolVersion: 1, notifications: native.api })
    const click = vi.fn()
    await platform.show({ id: token('owned'), kind: 'question', locale: 'en' }, noticeCopy, click, vi.fn())
    await platform.dispose()
    native.emit({ id: token('owned'), kind: 'click' })
    expect(click).not.toHaveBeenCalled()
    expect(native.closeSpy).toHaveBeenCalledExactlyOnceWith(token('owned'))
    expect(native.listeners.size).toBe(0)
  })

  it('reports bridge show failure and removes its callback', async () => {
    const native = bridge({ show: vi.fn<DesktopNotificationBridge['show']>(async () => 'failed') })
    const platform = createNotificationPlatform({ protocolVersion: 1, notifications: native.api })
    await expect(platform.show({ id: token('failed'), kind: 'approval', locale: 'en' }, noticeCopy, vi.fn(), vi.fn())).rejects.toThrow('Native notification submission failed')
    native.emit({ id: token('failed'), kind: 'click' })
    expect(native.listeners.size).toBe(1)
    await platform.dispose()
    expect(native.closeSpy).not.toHaveBeenCalled()
  })
})
