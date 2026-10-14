import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { createDraft } from '../draft.ts'
import { AnnotationClient, type AnnotationSessionSnapshot, type HistoryState } from './controller.ts'
import { en, zh, NAMESPACE } from './locales.ts'
import { PendingUserPresentation, UserPresentation, SelectionAction, Summary, type HistoryInjected, type SelectionInjected, type SummaryInjected } from './view.tsx'

export const inject = ['connection', 'chatText', 'conversation', 'sessions', 'slots', 'locale']

/** Register annotation behavior for ordinary Conversation Sessions. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { en, zh }), 'annotations: locale')
  const t = ctx.locale.bind(NAMESPACE)
  const client = new AnnotationClient(ctx, reason => t(reason), number => t('edit', { number }))
  ctx.effect(() => () => client.dispose(), 'annotations: client lifecycle')
  ctx.effect(() => ctx.locale.subscribe(client.invalidateLabels), 'annotations: localized gate')
  ctx.effect(() => {
    const refresh = client.refreshGeometry
    window.addEventListener('scroll', refresh, true)
    window.addEventListener('resize', refresh)
    const viewport = window.visualViewport
    viewport?.addEventListener('scroll', refresh)
    viewport?.addEventListener('resize', refresh)
    return () => {
      window.removeEventListener('scroll', refresh, true)
      window.removeEventListener('resize', refresh)
      viewport?.removeEventListener('scroll', refresh)
      viewport?.removeEventListener('resize', refresh)
    }
  }, 'annotations: selection geometry')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'conversation-annotations-selection', locale: NAMESPACE,
    inject: (): SelectionInjected => ({ hooks: { selection: client.selection, editor: client.editor },
      add: (source) =>{  client.forSession(source.sessionId).addAndEdit(source) },
      update: client.updateEditor, save: client.saveEditor, cancel: client.cancelEditor, removeEditor: client.removeEditor }),
  }, SelectionAction)), 'annotations: selection action')
  ctx.effect(() => ctx.slots.inject('conversation.input.summary', () => ctx.slots.register({
    name: 'conversation.input.summary', id: 'conversation-annotations-draft', locale: NAMESPACE,
    inject: (sessionId): SummaryInjected => {
      if (!client.isOrdinarySession(sessionId)) {
        const value: AnnotationSessionSnapshot = {
          draft: createDraft(sessionId), pending: null, busy: false, error: null,
          navigation: null, frozenIds: Object.freeze([]),
        }
        const unavailable: ObservableSnapshot<AnnotationSessionSnapshot> = {
          getSnapshot: () => value, subscribe: () => () => {},
        }
        return { available: false, hooks: { annotations: unavailable }, edit: async () => {},
          clear: () => {}, remove: () => {}, releaseEditor: () => {}, navigate: async () => {},
          retry: async () => {}, reconcile: async () => {} }
      }
      const draft = client.forSession(sessionId)
      return { available: true, hooks: { annotations: draft }, edit: draft.editAtSource,
        clear: draft.clear, remove: draft.remove, releaseEditor: draft.releaseEditor,
        navigate: draft.navigate, retry: draft.retry, reconcile: draft.reconcile }
    },
  }, Summary)), 'annotations: draft summary')
  const emptyValue: HistoryState = Object.freeze({ record: null, busy: false, error: null })
  const empty: ObservableSnapshot<HistoryState> = { getSnapshot: () => emptyValue, subscribe: () => () => {} }
  ctx.effect(() => ctx.slots.inject('conversation.chat.user-presentation', () => ctx.slots.register({
    name: 'conversation.chat.user-presentation', registrant: 'conversation-annotations-history', locale: NAMESPACE,
    select: owner => owner.node.data.requestId ? true : null,
    inject: (sessionId): HistoryInjected => ({ keyedHooks: {
      history: (key) => {
        const [requestId, messageId] = JSON.parse(key) as [SessionRequestId, MessageId]
        return requestId && client.isOrdinarySession(sessionId) ? client.historyFor(sessionId, requestId, messageId) : empty
      },
    }, navigate: client.navigateSource }),
  }, UserPresentation)), 'annotations: history presentation')
  ctx.effect(() => ctx.slots.inject('conversation.chat.pending-user-presentation', () => ctx.slots.register({
    name: 'conversation.chat.pending-user-presentation', registrant: 'conversation-annotations-pending', locale: NAMESPACE,
    select: ({ input }) => ('requestId' in input ? input.requestId : input.source.kind === 'user' && 'rpcId' in input.source ? input.source.rpcId : undefined) ? true : null,
    inject: (sessionId): HistoryInjected => ({ keyedHooks: {
      history: requestId => requestId && client.isOrdinarySession(sessionId)
        ? client.forSession(sessionId).pendingPresentationFor(brandString<SessionRequestId>(requestId))
        : empty,
    }, navigate: client.navigateSource }),
  }, PendingUserPresentation)), 'annotations: pending presentation')
}
