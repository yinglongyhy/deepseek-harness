/** Pure operations for in-memory conversation annotation drafts. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ChatTextRevision, ChatTextSurfaceId } from '@deepseek-ai/dsh-client-ui-chat/text-identities'

/** Package-owned stable identity for one annotation. */
export type AnnotationId = Branded<'conversation-annotation-id'>

/** Source position in visible conversation text, measured in UTF-16 units. */
export interface ConversationAnchor {
  readonly kind: 'conversation'
  readonly sessionId: SessionId
  readonly messageId: MessageId
  readonly blockId: ChatTextSurfaceId
  readonly revision: ChatTextRevision
  readonly start: number
  readonly end: number
  readonly selectedText: string
}

/** Draft annotation with stable identity and its last-saved comment revision. */
export interface Annotation {
  readonly id: AnnotationId
  readonly anchor: ConversationAnchor
  readonly comment: string
  readonly revision: number
}

/** Unsaved comment buffer kept separate from the saved annotation. */
export interface CommentEdit {
  readonly annotationId: AnnotationId
  readonly value: string
}

/** Draft state for one Session; display numbers follow annotation order. */
export interface DraftState {
  readonly sessionId: SessionId
  readonly revision: number
  readonly annotations: readonly Annotation[]
  readonly edit: CommentEdit | null
}

function validateAnchor(anchor: ConversationAnchor): void {
  if (!anchor.sessionId || !anchor.messageId || !anchor.blockId || !anchor.revision) {
    throw new Error('Annotation source identity is incomplete.')
  }
  if (!Number.isSafeInteger(anchor.start) || anchor.start < 0 || !Number.isSafeInteger(anchor.end) || anchor.end <= anchor.start) {
    throw new Error('Annotation source range is invalid.')
  }
  if (!anchor.selectedText.trim() || anchor.selectedText.length !== anchor.end - anchor.start) {
    throw new Error('Annotation source text does not match its UTF-16 range.')
  }
}

function sameAnchor(left: ConversationAnchor, right: ConversationAnchor): boolean {
  return left.sessionId === right.sessionId
    && left.messageId === right.messageId
    && left.blockId === right.blockId
    && left.revision === right.revision
    && left.start === right.start
    && left.end === right.end
    && left.selectedText === right.selectedText
}

/**
 * Creates an empty draft for one Session.
 * @param sessionId - owning Session id.
 * @returns a draft with no annotations or edit buffer.
 * @throws if the id is empty.
 */
export function createDraft(sessionId: SessionId): DraftState {
  if (!sessionId.trim()) throw new Error('sessionId must not be empty.')
  return { sessionId, revision: 0, annotations: [], edit: null }
}

/**
 * Adds a copied source anchor unless that exact range already exists.
 * @param draft - current Session draft.
 * @param id - new annotation identity.
 * @param anchor - completed conversation-text range.
 * @returns the updated draft, or the same draft when the range already exists.
 * @throws if identity, Session ownership, or UTF-16 range is invalid.
 */
export function addAnnotation(draft: DraftState, id: AnnotationId, anchor: ConversationAnchor): DraftState {
  if (!id.trim()) throw new Error('Annotation id must not be empty.')
  validateAnchor(anchor)
  if (anchor.sessionId !== draft.sessionId) throw new Error('Annotation source belongs to another Session.')
  const existing = draft.annotations.find(item => item.id === id)
  if (existing) {
    if (sameAnchor(existing.anchor, anchor)) return draft
    throw new Error(`Annotation id "${id}" already exists for another source.`)
  }
  if (draft.annotations.some(item => sameAnchor(item.anchor, anchor))) return draft
  const revision = draft.revision + 1
  return {
    ...draft,
    revision,
    annotations: [...draft.annotations, { id, anchor: { ...anchor }, comment: '', revision }],
  }
}

/**
 * Starts editing one saved comment.
 * @param draft - current Session draft.
 * @param id - annotation to edit.
 * @returns the draft with its edit buffer open.
 * @throws if the annotation is missing or another edit is active.
 */
export function beginCommentEdit(draft: DraftState, id: AnnotationId): DraftState {
  const annotation = draft.annotations.find(item => item.id === id)
  if (!annotation) throw new Error(`Unknown annotation id "${id}".`)
  if (draft.edit) {
    if (draft.edit.annotationId === id) return draft
    throw new Error('Another annotation comment is already being edited.')
  }
  return { ...draft, revision: draft.revision + 1, edit: { annotationId: id, value: annotation.comment } }
}

/**
 * Replaces the active comment buffer verbatim.
 * @param draft - current Session draft.
 * @param value - exact unsaved comment text.
 * @returns the updated draft.
 * @throws if no comment edit is active.
 */
export function updateCommentEdit(draft: DraftState, value: string): DraftState {
  if (!draft.edit) throw new Error('No annotation comment is being edited.')
  if (draft.edit.value === value) return draft
  return { ...draft, revision: draft.revision + 1, edit: { ...draft.edit, value } }
}

/**
 * Saves the active buffer and closes the edit.
 * @param draft - current Session draft.
 * @returns the draft with the comment saved.
 * @throws if no comment edit is active.
 */
export function saveCommentEdit(draft: DraftState): DraftState {
  if (!draft.edit) throw new Error('No annotation comment is being edited.')
  const revision = draft.revision + 1
  const { annotationId, value } = draft.edit
  return {
    ...draft,
    revision,
    annotations: draft.annotations.map(item => item.id === annotationId ? { ...item, comment: value, revision } : item),
    edit: null,
  }
}

/**
 * Discards the active buffer without changing the saved comment.
 * @param draft - current Session draft.
 * @returns the updated draft, or the same draft when no edit is active.
 */
export function cancelCommentEdit(draft: DraftState): DraftState {
  return draft.edit ? { ...draft, revision: draft.revision + 1, edit: null } : draft
}

/**
 * Removes an annotation and its edit buffer; an unknown id is a no-op.
 * @param draft - current Session draft.
 * @param id - annotation identity to remove.
 * @returns the updated draft, or the same draft when the id is absent.
 */
export function removeAnnotation(draft: DraftState, id: AnnotationId): DraftState {
  if (!draft.annotations.some(item => item.id === id)) return draft
  return {
    ...draft,
    revision: draft.revision + 1,
    annotations: draft.annotations.filter(item => item.id !== id),
    edit: draft.edit?.annotationId === id ? null : draft.edit,
  }
}

/**
 * Clears all annotations and the edit buffer while preserving the Session.
 * @param draft - current Session draft.
 * @returns the updated draft, or the same draft when already empty.
 */
export function clearAnnotations(draft: DraftState): DraftState {
  if (draft.annotations.length === 0 && draft.edit === null) return draft
  return { ...draft, revision: draft.revision + 1, annotations: [], edit: null }
}

/**
 * Returns one-based display numbers derived from annotation order.
 * @param draft - Session draft to number.
 * @returns annotations paired with their current display numbers.
 */
export function numberAnnotations(draft: DraftState): readonly { readonly number: number; readonly annotation: Annotation }[] {
  return draft.annotations.map((annotation, index) => ({ number: index + 1, annotation }))
}
