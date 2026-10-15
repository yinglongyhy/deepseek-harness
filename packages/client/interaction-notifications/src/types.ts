/** Renderer-to-shell protocol for privacy-preserving interaction notifications. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-projection/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Own normal-turn completion candidates; runtime eligibility is not persisted. */
    interactionTaskCompletion: { readonly primary: boolean; readonly completedSeq: SessionSeq | null }
  }
  interface SessionProjectionMap {
    /** Latest replayable completion candidate; live change-feed publication additionally checks pending runtime work. */
    interactionTaskCompletion: SessionSeq | null
  }
}

/** Renderer-owned identity echoed by the shell, never interpreted as a Session or command. */
export type NotificationToken = Branded<'InteractionNotificationToken'>

/** Interaction categories supported by both system notification providers. */
export type NotificationKind = 'approval' | 'question' | 'plan-review' | 'task-completed'
/** Shell-owned notification languages. */
export type NotificationLocale = 'zh' | 'en'
/** Opaque renderer token and fixed copy selectors; never a command or URL. */
export interface DesktopNotificationRequest {
  readonly id: NotificationToken
  readonly kind: NotificationKind
  readonly locale: NotificationLocale
}
/** Native feedback correlated with a renderer-owned token. */
export interface DesktopNotificationEvent {
  readonly kind: 'click' | 'failed'
  readonly id: NotificationToken
}
/** Narrow native presentation API; clicking never grants approval. */
export interface DesktopNotificationBridge {
  /** @returns whether this platform supports native notifications; OS suppression remains possible. */
  status(): Promise<'available' | 'unsupported'>
  /**
   * Show fixed, silent copy only while the owning window is in the background.
   * @param request - token and localized interaction category.
   * @returns native submission outcome, not an OS delivery acknowledgement.
   */
  show(request: DesktopNotificationRequest): Promise<'shown' | 'foreground' | 'unsupported' | 'failed'>
  /**
   * Withdraw a token's notification and listeners; an absent token is a no-op.
   * @param id - previously submitted renderer token.
   */
  close(id: NotificationToken): Promise<void>
  /**
   * Observe clicks and asynchronous presentation failures.
   * @param listener - token-correlated feedback callback.
   * @returns listener disposer.
   */
  subscribe(listener: (event: DesktopNotificationEvent) => void): () => void
}
