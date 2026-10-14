/** DOM-free public host capability for completed assistant prose and table cells. */
import type { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ChatTextRevision, ChatTextSurfaceId } from '../../text-identities.ts'
export type { ChatTextRevision, ChatTextSurfaceId } from '../../text-identities.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Contributor-selected stable id, scoped to its owning Cordis context. */
/** Contributor-selected stable id, scoped to its owning Cordis context. */
export type ChatTextDecorationId = Branded<'chat-text-decoration-id'>
/** Durable source plus one controlled visible-text interval. */
export interface ChatTextSelection {
  readonly sessionId: SessionId
  readonly messageId: MessageId
  readonly seq: SessionSeq
  readonly surfaceId: ChatTextSurfaceId
  readonly revision: ChatTextRevision
  readonly completed: true
  /** UTF-16 half-open offsets in visible text, not raw Markdown. */
  readonly start: number
  readonly end: number
  readonly selectedText: string
}
/** Viewport CSS-pixel rectangle measured by the owned renderer. */
export interface ChatTextRectangle {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
/** Decoration labels belong to the contributing plugin's locale. */
export interface ChatTextDecoration {
  readonly id: ChatTextDecorationId
  readonly source: ChatTextSelection
  readonly label: string
}
/** Exact source and stable id delivered only to the registering owner's callback. */
export interface ChatTextDecorationActivationEvent {
  readonly id: ChatTextDecorationId
  readonly source: ChatTextSelection
}
/** Optional local behavior, separate from serializable decoration data. */
export interface ChatTextDecorationActivation {
  /** Localized accessible action name, independent of the visible decoration label. */
  readonly label: string
  /**
   * Handle mouse or native Enter/Space activation of the current mounted decoration.
   * @param event - stable id and current exact source; never a displayed number or DOM event.
   * @returns optional asynchronous work; thrown errors and rejections are logged by ChatText.
   */
  readonly onActivate: (event: ChatTextDecorationActivationEvent) => void | Promise<void>
}
/** Reversible registration; updating never changes its stable owner/id. */
export interface ChatTextDecorationHandle {
  /**
   * Replace this contribution without changing its owner/id.
   * @param decoration - replacement source and localized label.
   * @param activation - replacement behavior; omitted preserves it, null removes it.
   */
  update(decoration: Omit<ChatTextDecoration, 'id'>, activation?: ChatTextDecorationActivation | null): void
  /**
   * Remove this registration; also called on owner disposal.
   * @returns Cordis cleanup completion; await manual disposal.
   */
  dispose(): Promise<void>
}
/** Exact navigation never searches for a similar substring. */
export type ChatTextNavigationResult =
  | { readonly status: 'revealed' }
  | { readonly status: 'missing' | 'changed' | 'unavailable' }
/** Browser service injected as `chatText`; consumers never receive DOM or Lexical objects. */
export interface ChatTextService {
  /**
   * Read the current eligible browser selection.
   * @returns the captured source, or null for streaming, excluded or cross-surface text.
   */
  selection(): ChatTextSelection | null
  /**
   * Measure the captured interval at current scroll and zoom.
   * @param source - exact captured interval.
   * @returns fresh viewport geometry, or null when unmounted or changed.
   */
  geometry(source: ChatTextSelection): readonly ChatTextRectangle[] | null
  /**
   * Observe eligible browser selection changes for one caller lifetime.
   * @param owner - caller's plugin context, owning cleanup.
   * @param listener - selection notification.
   * @returns caller-owned cleanup whose Promise must be awaited on manual disposal.
   */
  subscribe(owner: Context, listener: (selection: ChatTextSelection | null) => void): () => Promise<void>
  /**
   * Register a reversible decoration, replacing only the same owner/id.
   * @param owner - caller's plugin context.
   * @param decoration - stable id, exact source and localized visible label.
   * @param activation - optional localized action name and owner-scoped callback; omission renders a passive mark.
   * @returns independently updatable and disposable handle.
   */
  register(owner: Context, decoration: ChatTextDecoration, activation?: ChatTextDecorationActivation): ChatTextDecorationHandle
  /**
   * Load source history, activate its Chat target, and reveal the exact validated interval; never fuzzy-match.
   * Success highlights the whole owning Assistant response for 2000ms; repeated success renews it.
   * @param source - captured durable selection.
   * @returns revealed, durable absence, changed content or an unavailable mounted surface.
   */
  navigate(source: ChatTextSelection): Promise<ChatTextNavigationResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context { chatText: ChatTextService }
}
