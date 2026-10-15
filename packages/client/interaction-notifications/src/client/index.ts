/** Background system reminders over the existing Session interaction registry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { SessionPendingInteraction, SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DesktopNotificationBridge } from '../types.ts'
import { InteractionNotifications, type InteractionNotice } from './controller.ts'
import { createNotificationPlatform } from './platform.ts'
import { observeCompletions } from './completions.ts'
import { NotificationRow } from './NotificationRow.tsx'
import { en, zh } from './locales.ts'

/** Required Client services; no Host request interception is involved. */
export const inject = ['sessions', 'uiSession', 'uiWorkspace', 'slots', 'locale']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Privacy-preserving notifications and their settings controls. */
    interactionNotifications: keyof typeof en
  }
}

function noticeOf(base: SessionPendingInteractionBase): InteractionNotice | undefined {
  const pending = base as SessionPendingInteraction
  switch (pending.kind) {
    case 'approval': break
    case 'question':
    case 'plan-review':
      if (pending.review !== undefined) return undefined
      break
    // The pending interaction registry is merge-extensible; other domains do not opt in.
    default: return undefined
  }
  return { key: JSON.stringify([pending.sessionId, pending.kind, pending.key]), sessionId: pending.sessionId, kind: pending.kind }
}

/**
 * Mount notification policy, system presentation, and one General Settings row.
 * @param ctx - Client plugin context owning all listeners and notifications.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('interactionNotifications', { en, zh }), 'interaction-notifications: locale')
  const t = ctx.locale.bind('interactionNotifications')
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { protocolVersion: number; notifications?: DesktopNotificationBridge }
  }).dshDesktop
  const notifications = new InteractionNotifications(
    createNotificationPlatform(carrier),
    kind => ({ title: t(kind === 'task-completed' ? 'completionTitle' : 'notificationTitle'), body: t(kind) }),
    () => ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh' : 'en',
    (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
  )
  ctx.effect(() => {
    const selectedSession = (): SessionId | undefined => {
      const snapshot = ctx.sessions.list.getSnapshot()
      return snapshot.ids.find(sessionId => (snapshot.byId[sessionId]?.retainedBy.mainView ?? 0) > 0)
    }
    const update = (): void => {
      const requests = ctx.uiSession.pendingInteractions.getSnapshot().flatMap((pending) => {
        const notice = noticeOf(pending)
        return notice === undefined ? [] : [notice]
      })
      notifications.update(requests, document.visibilityState !== 'visible' || !document.hasFocus(), selectedSession())
    }
    const focus = (): void => { update(); void notifications.refreshPermission() }
    const stopList = ctx.sessions.list.subscribe(update)
    const stop = ctx.uiSession.pendingInteractions.subscribe(update)
    const stopCompletions = observeCompletions(
      ctx.sessions,
      (sessionId, seq) => { update(); notifications.completed(sessionId, seq) },
    )
    window.addEventListener('focus', focus)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', focus)
    update()
    void notifications.refreshPermission()
    return () => {
      stopCompletions()
      stopList()
      stop()
      window.removeEventListener('focus', focus)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', focus)
      return notifications.dispose()
    }
  }, 'interaction-notifications: lifecycle')
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'interaction-notifications', order: 20, locale: 'interactionNotifications',
    inject: () => ({
      hooks: { notifications: notifications.state },
      setEnabled: (enabled: boolean) => { notifications.setEnabled(enabled) },
      requestPermission: () => notifications.requestPermission(),
    }),
  }, NotificationRow))
}
