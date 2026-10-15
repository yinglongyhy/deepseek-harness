// @vitest-environment jsdom
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationKind } from '../src/types.ts'
import { InteractionNotifications, type InteractionNotice } from '../src/client/controller.ts'
import type { NoticeCopy, NoticeHandle, NotificationPermissionState, NotificationPlatform } from '../src/client/platform.ts'

const sessionId = (value: string): SessionId => brandString<SessionId>(value)
const request = (id: string, session: string, kind: NotificationKind = 'approval'): InteractionNotice => ({ key: id, sessionId: sessionId(session), kind })
const copy = (kind: NotificationKind): NoticeCopy => ({ title: kind, body: 'Action required' })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

interface Attempt { request: { id: string; kind: NotificationKind; locale: 'zh' | 'en' }; click: () => void; failed: () => void }
interface Shown extends Attempt { handle: { close: () => void } }
function platform(initial: NotificationPermissionState = 'granted') {
  const shown: Shown[] = []
  const closed: string[] = []
  let permissionResult: Promise<NotificationPermissionState> = Promise.resolve(initial)
  const showResults: Promise<NoticeHandle | undefined>[] = []
  const attempts: Attempt[] = []
  const permissionSpy = vi.fn<NotificationPlatform['permission']>(() => permissionResult)
  const requestPermissionSpy = vi.fn<NotificationPlatform['requestPermission']>(() => permissionResult)
  const showSpy = vi.fn<NotificationPlatform['show']>((notice, _copy, click, failed) => {
    attempts.push({ request: notice, click, failed })
    const showResult = showResults.shift()
    if (showResult !== undefined) return showResult
    const handle = { close: vi.fn(() => { closed.push(notice.id) }) }
    shown.push({ request: notice, click, failed, handle })
    return Promise.resolve(handle)
  })
  const disposeSpy = vi.fn<NotificationPlatform['dispose']>(() => {})
  const api: NotificationPlatform = {
    permission: permissionSpy,
    requestPermission: requestPermissionSpy,
    show: showSpy,
    dispose: disposeSpy,
  }
  return {
    api, shown, attempts, closed, permissionSpy, requestPermissionSpy, showSpy, disposeSpy,
    setPermission(value: Promise<NotificationPermissionState>) { permissionResult = value },
    setShowResult(value: Promise<NoticeHandle | undefined>) { showResults.push(value) },
  }
}

function makeController(fake = platform(), open: (sessionId: SessionId) => void = vi.fn()) {
  return { fake, open, controller: new InteractionNotifications(fake.api, copy, () => 'en', open) }
}
async function grant(controller: InteractionNotifications): Promise<void> { await controller.refreshPermission() }

beforeEach(() => {
  localStorage.clear()
  sessionStorage.removeItem('dsh.interaction-notifications.enabled')
})

describe('InteractionNotifications', () => {
  it('does not present in the foreground and presents after a background update', async () => {
    const { fake, controller } = makeController()
    await grant(controller)
    controller.update([request('a', 's1')], false)
    expect(fake.showSpy).not.toHaveBeenCalled()
    controller.update([request('a', 's1')], true)
    await Promise.resolve()
    expect(fake.shown).toHaveLength(1)
    await controller.dispose()
  })

  it('deduplicates updates within one controller but allows reminders after recreation', async () => {
    const first = makeController()
    await grant(first.controller)
    first.controller.update([request('a', 's1')], true)
    await Promise.resolve()
    first.controller.update([request('a', 's1')], true)
    expect(first.fake.showSpy).toHaveBeenCalledTimes(1)
    await first.controller.dispose()
    const next = makeController()
    await grant(next.controller)
    next.controller.update([request('a', 's1')], true)
    await Promise.resolve()
    expect(next.fake.showSpy).toHaveBeenCalledOnce()
    expect(next.fake.shown).toHaveLength(1)
    await next.controller.dispose()
  })

  it('isolates receipts by request key and opens the exact session on click', async () => {
    const { fake, controller, open } = makeController()
    await grant(controller)
    controller.update([request('a', 'session-a'), request('b', 'session-b')], true)
    await Promise.resolve()
    expect(fake.shown).toHaveLength(2)
    expect(new Set(fake.shown.map(item => item.request.id)).size).toBe(2)
    fake.shown[1]!.click()
    expect(open).toHaveBeenCalledExactlyOnceWith(sessionId('session-b'))
    expect(fake.closed).toEqual([fake.shown[1]!.request.id])
    await controller.dispose()
  })

  it('preserves click navigation when focus selects another Session before the callback', async () => {
    const { fake, controller, open } = makeController()
    await grant(controller)
    controller.update([request('focused', 'session-a')], true)
    await Promise.resolve()
    controller.update([request('focused', 'session-a')], false, sessionId('session-b'))
    fake.shown[0]!.click()
    expect(open).toHaveBeenCalledExactlyOnceWith(sessionId('session-a'))
    await controller.dispose()
  })

  it('ignores a click callback after focus already selected its Session', async () => {
    const { fake, controller, open } = makeController()
    await grant(controller)
    controller.update([request('already-selected', 'session-a')], true)
    await Promise.resolve()
    controller.update([request('already-selected', 'session-a')], false, sessionId('session-a'))
    fake.shown[0]!.click()
    expect(open).not.toHaveBeenCalled()
    expect(fake.closed).toEqual([fake.shown[0]!.request.id])
    await controller.dispose()
  })

  it('withdraws a task-completed notice when its Session becomes foreground', async () => {
    const { fake, controller } = makeController()
    await grant(controller)
    const owner = sessionId('completed-session')
    controller.update([], true)
    controller.completed(owner, 1 as SessionSeq)
    await Promise.resolve()
    expect(fake.shown).toHaveLength(1)
    controller.update([], false, owner)
    expect(fake.closed).toEqual([fake.shown[0]!.request.id])
    await controller.dispose()
  })

  it('withdraws only the foreground Session notice and preserves other Sessions', async () => {
    const { fake, controller } = makeController()
    await grant(controller)
    controller.update([request('a', 'session-a'), request('b', 'session-b')], true)
    await Promise.resolve()
    controller.update([request('a', 'session-a'), request('b', 'session-b')], false, sessionId('session-a'))
    expect(fake.closed).toEqual([fake.shown[0]!.request.id])
    expect(fake.shown[1]!.handle.close).not.toHaveBeenCalled()
    controller.update([request('a', 'session-a'), request('b', 'session-b')], true)
    expect(fake.showSpy).toHaveBeenCalledTimes(2)
    await controller.dispose()
  })

  it('withdraws notices when requests resolve or notifications are disabled', async () => {
    const { fake, controller, open } = makeController()
    await grant(controller)
    controller.update([request('resolved', 's1'), request('pending', 's2')], true)
    await Promise.resolve()
    controller.update([request('pending', 's2')], true)
    fake.shown[0]!.click()
    expect(open).not.toHaveBeenCalled()
    expect(fake.closed).toEqual([fake.shown[0]!.request.id])
    controller.setEnabled(false)
    expect(fake.closed).toEqual(fake.shown.map(item => item.request.id))
    expect(localStorage.getItem('dsh.interaction-notifications.enabled')).toBe('false')
    await controller.dispose()
  })

  it('does not request permission without an explicit user action', async () => {
    const { fake, controller } = makeController(platform('default'))
    await controller.refreshPermission()
    expect(fake.permissionSpy).toHaveBeenCalledOnce()
    expect(fake.requestPermissionSpy).not.toHaveBeenCalled()
    await controller.requestPermission()
    expect(fake.requestPermissionSpy).toHaveBeenCalledOnce()
    expect(controller.state.getSnapshot()).toMatchObject({ permission: 'default', failed: false })
    await controller.dispose()
  })

  it('records denied permission and permission-read failures', async () => {
    const denied = makeController(platform('denied'))
    await denied.controller.refreshPermission()
    expect(denied.controller.state.getSnapshot().permission).toBe('denied')
    await denied.controller.dispose()

    const broken = platform()
    broken.setPermission(Promise.reject(new Error('permission unavailable')))
    const { controller } = makeController(broken)
    await controller.requestPermission()
    expect(controller.state.getSnapshot()).toMatchObject({ failed: true, permission: 'loading' })
    broken.setPermission(Promise.resolve('granted'))
    await controller.refreshPermission()
    expect(controller.state.getSnapshot()).toMatchObject({ failed: true, permission: 'granted' })
    await controller.requestPermission()
    expect(controller.state.getSnapshot()).toMatchObject({ failed: false, permission: 'granted' })
    await controller.dispose()
  })

  it('starts notifications only after permission is granted', async () => {
    const fake = platform('default')
    const { controller } = makeController(fake)
    controller.update([request('a', 's1')], true)
    await Promise.resolve()
    expect(fake.showSpy).not.toHaveBeenCalled()
    fake.setPermission(Promise.resolve('granted'))
    await controller.requestPermission()
    expect(fake.showSpy).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('closes a handle that arrives after its Session becomes foreground', async () => {
    const pending = deferred<NoticeHandle | undefined>()
    const fake = platform()
    fake.setShowResult(pending.promise)
    const { controller } = makeController(fake)
    await grant(controller)
    controller.update([request('late-selected', 's1')], true)
    controller.update([request('late-selected', 's1')], false, sessionId('s1'))
    const close = vi.fn()
    pending.resolve({ close })
    await Promise.resolve()
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('closes a handle that arrives after its request was removed', async () => {
    const pending = deferred<NoticeHandle | undefined>()
    const fake = platform()
    fake.setShowResult(pending.promise)
    const { controller } = makeController(fake)
    await grant(controller)
    controller.update([request('late', 's1')], true)
    controller.update([], true)
    const close = vi.fn()
    pending.resolve({ close })
    await Promise.resolve()
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('closes a handle that arrives after disable or dispose', async () => {
    for (const finish of ['disable', 'dispose'] as const) {
      localStorage.removeItem('dsh.interaction-notifications.enabled')
      const pending = deferred<NoticeHandle | undefined>()
      const fake = platform()
      fake.setShowResult(pending.promise)
      const { controller } = makeController(fake)
      await grant(controller)
      controller.update([request(finish, 's1')], true)
      let disposal: Promise<void> | undefined
      if (finish === 'disable') controller.setEnabled(false)
      else disposal = controller.dispose()
      const close = vi.fn()
      pending.resolve({ close })
      await Promise.resolve()
      await Promise.resolve()
      expect(close).toHaveBeenCalledOnce()
      if (disposal === undefined) await controller.dispose()
      else await disposal
    }
  })

  it('uses a distinct token when the same request is removed and re-added during submission', async () => {
    const oldSubmission = deferred<NoticeHandle | undefined>()
    const newSubmission = deferred<NoticeHandle | undefined>()
    const fake = platform()
    fake.setShowResult(oldSubmission.promise)
    const { controller } = makeController(fake)
    await grant(controller)
    controller.update([request('same-key', 's1')], true)
    controller.update([], true)
    fake.setShowResult(newSubmission.promise)
    controller.update([request('same-key', 's1')], true)
    expect(fake.attempts).toHaveLength(2)
    expect(fake.attempts[0]!.request.id).not.toBe(fake.attempts[1]!.request.id)

    const oldClose = vi.fn()
    const newClose = vi.fn()
    newSubmission.resolve({ close: newClose })
    oldSubmission.resolve({ close: oldClose })
    await Promise.resolve()
    await Promise.resolve()
    expect(oldClose).toHaveBeenCalledOnce()
    expect(newClose).not.toHaveBeenCalled()
    await controller.dispose()
    expect(newClose).toHaveBeenCalledOnce()
  })

  it('waits for a late submission withdrawal before disposing the platform', async () => {
    const submission = deferred<NoticeHandle | undefined>()
    const closeStarted = deferred<undefined>()
    const closeGate = deferred<undefined>()
    const fake = platform()
    fake.setShowResult(submission.promise)
    const { controller } = makeController(fake)
    await grant(controller)
    controller.update([request('pending', 's1')], true)
    const disposal = controller.dispose()
    let disposalCompleted = false
    void disposal.then(() => { disposalCompleted = true })
    submission.resolve({ close: () => { closeStarted.resolve(undefined); return closeGate.promise } })
    await closeStarted.promise
    expect(disposalCompleted).toBe(false)
    expect(fake.disposeSpy).not.toHaveBeenCalled()
    closeGate.resolve(undefined)
    await disposal
    expect(fake.disposeSpy).toHaveBeenCalledOnce()
  })

  it('waits for an already-running withdrawal before disposing the platform', async () => {
    const closeStarted = deferred<undefined>()
    const closeGate = deferred<undefined>()
    const fake = platform()
    fake.setShowResult(Promise.resolve({ close: () => { closeStarted.resolve(undefined); return closeGate.promise } }))
    const { controller } = makeController(fake)
    await grant(controller)
    controller.update([request('withdraw', 's1')], true)
    await Promise.resolve()
    controller.update([], true)
    await closeStarted.promise
    const disposal = controller.dispose()
    expect(fake.disposeSpy).not.toHaveBeenCalled()
    closeGate.resolve(undefined)
    await disposal
    expect(fake.disposeSpy).toHaveBeenCalledOnce()
  })

  it('ignores permission completion after disposal and after a newer read', async () => {
    const late = deferred<NotificationPermissionState>()
    const fake = platform()
    fake.setPermission(late.promise)
    const { controller } = makeController(fake)
    const snapshot = controller.state.getSnapshot()
    const read = controller.refreshPermission()
    await controller.dispose()
    late.resolve('granted')
    await read
    expect(controller.state.getSnapshot()).toBe(snapshot)

    const oldRead = deferred<NotificationPermissionState>()
    fake.setPermission(oldRead.promise)
    const currentRead = deferred<NotificationPermissionState>()
    fake.setPermission(currentRead.promise)
    const second = makeController(fake)
    const old = second.controller.refreshPermission()
    fake.setPermission(currentRead.promise)
    const current = second.controller.requestPermission()
    oldRead.resolve('denied')
    currentRead.resolve('default')
    await Promise.all([old, current])
    expect(second.controller.state.getSnapshot().permission).toBe('default')
    await second.controller.dispose()
  })

  it('ignores late failures and stale click callbacks after disposal', async () => {
    const pending = deferred<NoticeHandle | undefined>()
    const fake = platform()
    fake.setShowResult(pending.promise)
    const { controller, open } = makeController(fake)
    await grant(controller)
    controller.update([request('a', 's1')], true)
    const click = vi.fn()
    const disposal = controller.dispose()
    click()
    const close = vi.fn()
    pending.resolve({ close })
    await disposal
    expect(open).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('reports native presentation failures and contains open callback errors', async () => {
    const fake = platform()
    const { controller } = makeController(fake, () => { throw new Error('navigation failed') })
    await grant(controller)
    controller.update([request('a', 's1')], true)
    await Promise.resolve()
    fake.shown[0]!.failed()
    expect(controller.state.getSnapshot().failed).toBe(true)
    fake.shown[0]!.click()
    expect(controller.state.getSnapshot().failed).toBe(true)
    await controller.dispose()
  })
})

it('consumes foreground and disabled task completions without replaying them later', async () => {
  const { controller, fake } = makeController()
  await grant(controller)
  const id = sessionId('completed')
  controller.update([], false)
  controller.completed(id, 1 as SessionSeq)
  controller.update([], true)
  controller.completed(id, 1 as SessionSeq)
  controller.setEnabled(false)
  controller.completed(id, 2 as SessionSeq)
  controller.setEnabled(true)
  controller.completed(id, 2 as SessionSeq)
  expect(fake.showSpy).not.toHaveBeenCalled()
  controller.completed(id, 3 as SessionSeq)
  await Promise.resolve()
  expect(fake.shown.map(item => item.request.kind)).toEqual(['task-completed'])
  await controller.dispose()
})

it('holds only the latest completion per Session and permits a click after native foreground restoration', async () => {
  const { controller, fake, open } = makeController()
  const permission = deferred<NotificationPermissionState>()
  fake.setPermission(permission.promise)
  controller.update([], true)
  controller.completed(sessionId('first'), 1 as SessionSeq)
  const checking = controller.refreshPermission()
  expect(fake.showSpy).not.toHaveBeenCalled()
  permission.resolve('granted')
  await checking
  controller.completed(sessionId('first'), 1 as SessionSeq)
  expect(fake.showSpy).toHaveBeenCalledOnce()
  controller.completed(sessionId('first'), 2 as SessionSeq)
  controller.completed(sessionId('other'), 1 as SessionSeq)
  await Promise.resolve()
  expect(fake.closed).toContain(fake.shown[0]!.request.id)
  expect(fake.showSpy).toHaveBeenCalledTimes(3)
  controller.update([], false)
  fake.shown[2]!.click()
  expect(open).toHaveBeenCalledExactlyOnceWith(sessionId('other'))
  await Promise.resolve()
  expect(fake.closed).toHaveLength(2)
  controller.update([], true)
  controller.completed(sessionId('first'), 2 as SessionSeq)
  expect(fake.showSpy).toHaveBeenCalledTimes(3)
  await controller.dispose()
})

it('does not retry a completion suppressed by the platform on unrelated state updates', async () => {
  const { controller, fake } = makeController()
  await grant(controller)
  controller.update([], true)
  fake.setShowResult(Promise.resolve(undefined))
  controller.completed(sessionId('suppressed'), 1 as SessionSeq)
  await Promise.resolve()
  controller.update([], true)
  await controller.refreshPermission()
  controller.completed(sessionId('suppressed'), 1 as SessionSeq)
  expect(fake.showSpy).toHaveBeenCalledOnce()
  await controller.dispose()
})

it.each(['default', 'denied', 'unsupported'] as const)('does not replay completions captured without %s permission', async (permission) => {
  const { controller, fake } = makeController(platform(permission))
  await grant(controller)
  controller.update([], true)
  controller.completed(sessionId('unavailable'), 1 as SessionSeq)
  fake.setPermission(Promise.resolve('granted'))
  await controller.requestPermission()
  controller.completed(sessionId('unavailable'), 1 as SessionSeq)
  expect(fake.showSpy).not.toHaveBeenCalled()
  await controller.dispose()
})
