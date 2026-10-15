// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'

usePinnedBrowserLanguages('en-US')
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
beforeEach(() => { localStorage.clear() })

function Settings({ renderSlot }: PropsRenderSlots<'settings.general.item'>) {
  return <>{renderSlot('settings.general.item', {})}</>
}

it('renders permission controls, routes each live category, and releases listeners on unload', async () => {
  const notices: { onclick: (() => void) | null; close: ReturnType<typeof vi.fn>; body: string | undefined }[] = []
  let permission: NotificationPermission = 'default'
  const requestPermission = vi.fn(async () => { permission = 'granted'; return permission })
  class NativeNotice {
    static get permission() { return permission }
    static requestPermission = requestPermission
    onclick: (() => void) | null = null
    onerror: (() => void) | null = null
    close = vi.fn()
    body: string | undefined
    constructor(_title: string, options: NotificationOptions) { this.body = options.body; notices.push(this) }
  }
  vi.stubGlobal('Notification', NativeNotice)
  vi.stubGlobal('isSecureContext', true)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  vi.spyOn(window, 'focus').mockImplementation(() => {})
  const runtime = await SlotTestRuntime.create()
  onTestFinished(async () => { await runtime.dispose() })
  const publish = runtime.ctx.get('uiSession')!.registerPendingInteraction<SessionPendingInteractionBase>(() => 0)
  const open = vi.fn()
  runtime.ctx.provide('uiWorkspace', { openSession: open })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({ 'settings.general.item': { kind: 'list', scope: 'root' } }, Settings)
  const plugin = await runtime.mount({ inject: [...inject], apply })
  const view = runtime.renderRoot()
  await waitFor(() => { expect(view.getByRole('button', { name: 'Allow notifications' })).toBeDefined() })
  expect(requestPermission).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Allow notifications' }))
  await waitFor(() => { expect(requestPermission).toHaveBeenCalledOnce() })
  const sessionId = 'notification-session' as SessionId
  const requests = [
    { key: 'a', kind: 'approval', sessionId, callId: 'shared-tool-call' },
    { key: 'b', kind: 'question', sessionId },
    { key: 'c', kind: 'plan-review', sessionId },
    { key: 'd', kind: 'question', sessionId, review: [] },
    { key: 'e', kind: 'other-domain', sessionId },
    { key: 'f', kind: 'approval', sessionId, callId: 'shared-tool-call' },
  ]
  await act(async () => { for (const request of requests) publish(request, async () => {}) })
  await waitFor(() => { expect(notices).toHaveLength(4) })
  expect(notices.map(notice => notice.body)).toEqual([
    'An operation needs approval. Click to open the conversation.',
    'A question needs an answer. Click to open the conversation.',
    'A plan needs review. Click to open the conversation.',
    'An operation needs approval. Click to open the conversation.',
  ])
  notices[1]!.onclick?.()
  expect(open).toHaveBeenCalledExactlyOnceWith(sessionId)
  await act(async () => { window.dispatchEvent(new Event('blur')) })
  expect(notices).toHaveLength(4)
  expect(runtime.sessions.binding(sessionId)).toBeUndefined()
  await runtime.sessions.emitProjectionUpdate({ sessionId, key: 'interactionTaskCompletion', value: 10, seq: 10 as SessionSeq })
  await waitFor(() => { expect(notices).toHaveLength(5) })
  expect(notices[4]?.body).toBe('Your task has finished. Click to open the conversation.')
  fireEvent.click(view.getByRole('switch', { name: 'System notifications' }))
  expect(notices.every(notice => notice.close.mock.calls.length === 1)).toBe(true)
  await plugin.dispose()
  expect(view.queryByRole('switch', { name: 'System notifications' })).toBeNull()
  await act(async () => { publish({ key: 'after-dispose', kind: 'approval', sessionId }, async () => {}) })
  await runtime.sessions.emitProjectionUpdate({ sessionId, key: 'interactionTaskCompletion', value: 11, seq: 11 as SessionSeq })
  expect(notices).toHaveLength(5)
})
