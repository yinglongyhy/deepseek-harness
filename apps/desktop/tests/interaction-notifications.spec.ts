import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopInteractionNotifications, isDesktopNotificationRequest, type InteractionNotificationConstructor } from '../src/interaction-notifications.ts'
import type { NotificationToken } from '@deepseek-ai/dsh-client-interaction-notifications/types'

class FakeNotification extends EventEmitter {
  readonly show = vi.fn(() => { if (failNextShow) { failNextShow = false; throw new Error('system unavailable') } })
  readonly close = vi.fn(() => { this.emit('close') })
  constructor(readonly options: { title: string; body: string; silent: true }) { super() }
}

let supported = true
let failNextShow = false
const created: FakeNotification[] = []
class FakeNotificationClass extends FakeNotification {
  static isSupported = (): boolean => supported
  constructor(options: { title: string; body: string; silent: true }) { super(options); created.push(this) }
}
const NotificationClass: InteractionNotificationConstructor = FakeNotificationClass

afterEach(() => { created.length = 0; supported = true; failNextShow = false; vi.restoreAllMocks() })

it('uses fixed silent copy and emits only a click token', () => {
  const click = vi.fn()
  const failed = vi.fn()
  const owner = new DesktopInteractionNotifications(NotificationClass, () => false, click, failed)
  expect(owner.show({ id: 'token-1' as NotificationToken, kind: 'approval', locale: 'zh' })).toBe('shown')
  expect(created[0]?.options).toEqual({ title: 'DeepSeek Harness · 需要你处理', body: '有一项操作等待你确认。', silent: true })
  created[0]?.emit('click')
  expect(click).toHaveBeenCalledExactlyOnceWith('token-1')
  expect(failed).not.toHaveBeenCalled()
  owner.dispose()
})

it.each(['en', 'zh'] as const)('presents silent task completion copy in %s through the validated bridge', (locale) => {
  const click = vi.fn()
  const owner = new DesktopInteractionNotifications(NotificationClass, () => false, click, vi.fn())
  const request = { id: 'completion-token' as NotificationToken, kind: 'task-completed' as const, locale }
  expect(isDesktopNotificationRequest(request)).toBe(true)
  expect(owner.show(request)).toBe('shown')
  expect(created[0]?.options).toEqual(locale === 'zh'
    ? { title: 'DeepSeek Harness · 任务已完成', body: '任务已完成，点击打开对应会话。', silent: true }
    : { title: 'DeepSeek Harness · Task completed', body: 'Your task has finished. Click to open the conversation.', silent: true })
  created[0]?.emit('click')
  expect(click).toHaveBeenCalledExactlyOnceWith(request.id)
  owner.dispose()
})

it('returns foreground or unsupported without constructing a notification', () => {
  const owner = new DesktopInteractionNotifications(NotificationClass, () => true, vi.fn(), vi.fn())
  expect(owner.show({ id: 'foreground' as NotificationToken, kind: 'question', locale: 'en' })).toBe('foreground')
  supported = false
  expect(owner.status()).toBe('unsupported')
  expect(owner.show({ id: 'unsupported' as NotificationToken, kind: 'question', locale: 'en' })).toBe('unsupported')
  expect(created).toHaveLength(0)
})

it('closes replaced instances and removes listeners on native close and disposal', () => {
  const click = vi.fn()
  const owner = new DesktopInteractionNotifications(NotificationClass, () => false, click, vi.fn())
  owner.show({ id: 'same' as NotificationToken, kind: 'question', locale: 'en' })
  const old = created[0]!
  owner.show({ id: 'same' as NotificationToken, kind: 'plan-review', locale: 'en' })
  expect(old.close).toHaveBeenCalledOnce()
  old.emit('click')
  expect(click).not.toHaveBeenCalled()
  const current = created[1]!
  current.emit('close')
  current.emit('click')
  expect(click).not.toHaveBeenCalled()
  owner.show({ id: 'dispose' as NotificationToken, kind: 'approval', locale: 'en' })
  const disposed = created[2]!
  owner.dispose()
  disposed.emit('click')
  expect(click).not.toHaveBeenCalled()
})

it('continues cleanup when native close throws and contains renderer callback failures', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const owner = new DesktopInteractionNotifications(NotificationClass, () => false,
    () => { throw new Error('renderer click callback failed') },
    () => { throw new Error('renderer failure callback failed') })
  owner.show({ id: 'close-fails' as NotificationToken, kind: 'question', locale: 'en' })
  owner.show({ id: 'close-continues' as NotificationToken, kind: 'approval', locale: 'en' })
  created[0]!.close.mockImplementationOnce(() => { throw new Error('native close failed') })
  owner.dispose()
  expect(created[0]?.close).toHaveBeenCalledOnce()
  expect(created[1]?.close).toHaveBeenCalledOnce()
  expect(log).toHaveBeenCalledOnce()
  owner.show({ id: 'callbacks' as NotificationToken, kind: 'plan-review', locale: 'en' })
  expect(() => created[2]!.emit('click')).not.toThrow()
  expect(() => created[2]!.emit('failed')).not.toThrow()
  expect(log).toHaveBeenCalledTimes(3)
  owner.dispose()
})

it('reports synchronous and asynchronous failures and validates IPC requests', () => {
  const failed = vi.fn()
  const owner = new DesktopInteractionNotifications(NotificationClass, () => false, vi.fn(), failed)
  failNextShow = true
  expect(owner.show({ id: 'failed-sync' as NotificationToken, kind: 'approval', locale: 'en' })).toBe('failed')
  expect(failed).toHaveBeenCalledExactlyOnceWith('failed-sync')
  expect(isDesktopNotificationRequest({ id: 'id', kind: 'question', locale: 'zh' })).toBe(true)
  expect(isDesktopNotificationRequest({ id: '', kind: 'question', locale: 'zh' })).toBe(false)
  expect(isDesktopNotificationRequest({ id: 'id', kind: 'unknown', locale: 'zh' })).toBe(false)
  owner.show({ id: 'failed-event' as NotificationToken, kind: 'approval', locale: 'en' })
  created[1]?.emit('failed')
  expect(failed).toHaveBeenLastCalledWith('failed-event')
  owner.dispose()
})
