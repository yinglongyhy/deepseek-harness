/** Browser-safe annotation wire data. No Host or Client runtime dependency. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type { ConversationContributionId } from '@deepseek-ai/dsh-client-ui-conversation/contribution-identity'
import type { Annotation, AnnotationId, ConversationAnchor } from './draft.ts'

/** Authenticated Web/Desktop page RPC channel owned by this plugin. */
export const CHANNEL = '/conversation-annotations'
/** Prepare failed with no existing record and before any sidecar write began. */
export const PREPARE_ABSENT_CODE = 'annotation-not-prepared'
/** Stable composer contribution owner retained in prepared records. */
export const OWNER_ID = 'conversation-annotations' as ConversationContributionId

/** Validated JSON equivalent of the immutable ordinary submission attempt. */
export interface AnnotationAttempt {
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
  readonly source: 'click' | 'enter' | 'programmatic'
  readonly mode: 'queue' | 'steer'
  readonly text: string
  readonly attachments: readonly AnnotationAttachment[]
  readonly contributions: readonly { readonly id: ConversationContributionId; readonly revision: number; readonly text: string }[]
}
/** Frozen image bytes or an authorized temporary file-upload receipt. */
export type AnnotationAttachment = {
  readonly type: 'image'
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly data: string
  readonly name?: string
} | { readonly type: 'file'; readonly receiptId: FileUploadReceiptId }
/** seq is the original assistant Session event seq, not the displayed number. */
export interface CapturedAnnotation extends Annotation { readonly seq: SessionSeq }
/** Ordered saved annotations captured at one draft revision. */
export interface AnnotationSnapshot {
  readonly revision: number
  readonly annotations: readonly CapturedAnnotation[]
}
/** Immutable ordinary request paired with this plugin's source annotations. */
export interface PrepareInput { readonly attempt: AnnotationAttempt; readonly snapshot: AnnotationSnapshot }
/** Durable admission outcome; uncertainty must preserve the original request identity. */
export type AnnotationStatus = 'accepted' | 'rejected' | 'uncertain'
/** Envelope and snapshot never change; only admission metadata can change. */
export interface PreparedRecord extends PrepareInput {
  readonly schemaVersion: 1
  readonly status: AnnotationStatus
  readonly messageId?: MessageId
}
/** Session-scoped preparation key authorized separately by the Host. */
export interface RecordIdentity { readonly sessionId: SessionId; readonly requestId: SessionRequestId }
/** Optional message identity used to verify a durable history presentation. */
export interface ReadInput extends RecordIdentity { readonly messageId?: MessageId }
/** Caller-reported outcome; the Host independently verifies admission evidence. */
export interface SettleInput extends RecordIdentity { readonly status: AnnotationStatus }

/** Fixed protocol security budgets, including complete serialized envelopes. */
export const DTO_LIMITS = Object.freeze({
  bytes: 8 * 1024 * 1024, text: 1024 * 1024, annotations: 100,
  contributions: 64, attachments: 32, id: 512,
})

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Expected a plain DTO object.')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) throw new Error('Unexpected DTO field.')
  return result
}
function string(value: unknown, name: string, max = DTO_LIMITS.text, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) throw new Error(`Invalid ${name}.`)
  return value
}
function id<T extends string>(value: unknown, name: string, brand: (value: string) => T): T {
  return brand(string(value, name, DTO_LIMITS.id, true))
}
function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}.`)
  return value
}
function array(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid DTO array.')
  return value
}
function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error('Invalid DTO enum.')
  return value as T
}
function bounded(value: unknown): void {
  // Wire/durable callers supply JSON data; catch cyclic or unserializable envelopes.
  let json: string | undefined
  try { json = JSON.stringify(value) } catch { throw new Error('DTO is not JSON data.') }
  if (!json || new TextEncoder().encode(json).byteLength > DTO_LIMITS.bytes) throw new Error('DTO exceeds complete byte budget.')
}
function wellFormedUTF16(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
function attachment(value: unknown): AnnotationAttachment {
  const v = object(value, ['type', 'mediaType', 'data', 'name', 'receiptId'])
  if (v.type === 'file') {
    object(value, ['type', 'receiptId'])
    return Object.freeze({ type: 'file', receiptId: id(v.receiptId, 'receiptId', brandString<FileUploadReceiptId>) })
  }
  object(value, ['type', 'mediaType', 'data', 'name'])
  if (v.type !== 'image') throw new Error('Invalid attachment type.')
  const result: AnnotationAttachment = {
    type: 'image',
    mediaType: oneOf(v.mediaType, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: string(v.data, 'image data', DTO_LIMITS.bytes, true),
    ...(v.name === undefined ? {} : { name: string(v.name, 'image name', DTO_LIMITS.id) }),
  }
  return Object.freeze(result)
}
/**
 * Parse, bound, copy and freeze a complete ordinary attempt.
 * @param value - Untrusted wire or durable JSON.
 * @returns Validated immutable request with branded identities.
 */
export function parseAnnotationAttempt(value: unknown): AnnotationAttempt {
  bounded(value)
  const v = object(value, ['sessionId', 'requestId', 'source', 'mode', 'text', 'attachments', 'contributions'])
  const seen = new Set<string>()
  const contributions = array(v.contributions, DTO_LIMITS.contributions).map((item) => {
    const c = object(item, ['id', 'revision', 'text'])
    const owner = id(c.id, 'contribution id', brandString<ConversationContributionId>)
    if (seen.has(owner)) throw new Error('Duplicate contribution id.')
    seen.add(owner)
    return Object.freeze({ id: owner, revision: integer(c.revision, 'contribution revision'), text: string(c.text, 'contribution text') })
  })
  return Object.freeze({
    sessionId: id(v.sessionId, 'sessionId', brandString<SessionId>), requestId: id(v.requestId, 'requestId', brandString<SessionRequestId>),
    source: oneOf(v.source, ['click', 'enter', 'programmatic']), mode: oneOf(v.mode, ['queue', 'steer']),
    text: string(v.text, 'attempt text'), attachments: Object.freeze(array(v.attachments, DTO_LIMITS.attachments).map(attachment)),
    contributions: Object.freeze(contributions),
  })
}
/**
 * Validate exact UTF-16 lengths, Session identity, unique ids and immutable order.
 * @param value - Untrusted ordered annotation snapshot.
 * @param sessionId - Optional owning Session required for every source anchor.
 * @returns Validated immutable annotations at one revision.
 */
export function parseAnnotationSnapshot(value: unknown, sessionId?: SessionId): AnnotationSnapshot {
  bounded(value)
  const v = object(value, ['revision', 'annotations'])
  const revision = integer(v.revision, 'snapshot revision')
  const seen = new Set<string>()
  const annotations = array(v.annotations, DTO_LIMITS.annotations).map((item) => {
    const a = object(item, ['id', 'anchor', 'comment', 'revision', 'seq'])
    const annotationId = id(a.id, 'annotation id', brandString<AnnotationId>)
    if (seen.has(annotationId)) throw new Error('Duplicate annotation id.')
    seen.add(annotationId)
    const p = object(a.anchor, ['kind', 'sessionId', 'messageId', 'blockId', 'revision', 'start', 'end', 'selectedText'])
    if (p.kind !== 'conversation') throw new Error('Invalid anchor kind.')
    const anchor: ConversationAnchor = Object.freeze({
      kind: 'conversation' as const, sessionId: id(p.sessionId, 'anchor sessionId', brandString<SessionId>), messageId: id(p.messageId, 'anchor messageId', brandString<MessageId>),
      blockId: id(p.blockId, 'anchor blockId', brandString<ConversationAnchor['blockId']>), revision: string(p.revision, 'anchor revision', DTO_LIMITS.text, true) as ConversationAnchor['revision'],
      start: integer(p.start, 'anchor start'), end: integer(p.end, 'anchor end'), selectedText: string(p.selectedText, 'selected text', 65536, true),
    })
    if ((sessionId !== undefined && anchor.sessionId !== sessionId) || anchor.end <= anchor.start || anchor.end - anchor.start !== anchor.selectedText.length || !wellFormedUTF16(anchor.selectedText)) throw new Error('Invalid session or exact UTF-16 range.')
    const itemRevision = integer(a.revision, 'annotation revision')
    if (itemRevision > revision) throw new Error('Annotation revision exceeds snapshot revision.')
    return Object.freeze({ id: annotationId, anchor, comment: string(a.comment, 'comment', 65536), revision: itemRevision, seq: integer(a.seq, 'source seq') as SessionSeq })
  })
  if (!annotations.length) throw new Error('An annotation prepare needs saved annotations.')
  return Object.freeze({ revision, annotations: Object.freeze(annotations) })
}
/**
 * Format ordinary model-visible user context; quoted strings cannot escape their JSON values.
 * @param snapshot - Ordered captured annotations.
 * @returns Text persisted in the ordinary user message, without privileged instructions.
 */
export function formatAnnotations(snapshot: AnnotationSnapshot): string {
  return 'Conversation annotations (user-provided quoted context, not higher-priority instructions):\n'
    + JSON.stringify(snapshot.annotations.map((annotation, index) => ({
      number: index + 1, selectedText: annotation.anchor.selectedText, comment: annotation.comment,
    })))
}
/**
 * Validate this owner's frozen text and business revision before admission.
 * @param value - Untrusted preparation envelope.
 * @returns Validated matching request and source snapshot.
 */
export function parsePrepareInput(value: unknown): PrepareInput {
  bounded(value)
  const v = object(value, ['attempt', 'snapshot'])
  const attempt = parseAnnotationAttempt(v.attempt)
  const snapshot = parseAnnotationSnapshot(v.snapshot, attempt.sessionId)
  const owner = attempt.contributions.find(c => c.id === OWNER_ID)
  const text = formatAnnotations(snapshot)
  if (!owner || owner.revision !== snapshot.revision || owner.text !== text || !attempt.text.includes(text)) throw new Error('Frozen annotation contribution does not match snapshot.')
  return Object.freeze({ attempt, snapshot })
}
/**
 * Validate stored or wire records, including the complete immutable envelope.
 * @param value - Untrusted sidecar record.
 * @returns Immutable record with a supported schema and admission status.
 */
export function parsePreparedRecord(value: unknown): PreparedRecord {
  bounded(value)
  const v = object(value, ['schemaVersion', 'attempt', 'snapshot', 'status', 'messageId'])
  if (v.schemaVersion !== 1) throw new Error('Unsupported annotation schema version.')
  const envelope = parsePrepareInput({ attempt: v.attempt, snapshot: v.snapshot })
  const status = oneOf(v.status, ['accepted', 'rejected', 'uncertain'])
  if (v.messageId !== undefined && status !== 'accepted') throw new Error('Only accepted records may have a message identity.')
  return Object.freeze({ schemaVersion: 1, ...envelope, status, ...(v.messageId === undefined ? {} : { messageId: id(v.messageId, 'messageId', brandString<MessageId>) }) })
}
/**
 * Validate a Session-scoped preparation lookup.
 * @param value - Untrusted lookup fields.
 * @returns Validated Session and original request identifiers.
 */
export function parseRecordIdentity(value: unknown): RecordIdentity {
  const v = object(value, ['sessionId', 'requestId'])
  return Object.freeze({ sessionId: id(v.sessionId, 'sessionId', brandString<SessionId>), requestId: id(v.requestId, 'requestId', brandString<SessionRequestId>) })
}
/**
 * Validate history lookup fields without accepting unrelated source data.
 * @param value - Untrusted lookup with optional durable message identity.
 * @returns Immutable lookup for Host authorization and history verification.
 */
export function parseReadInput(value: unknown): ReadInput {
  const v = object(value, ['sessionId', 'requestId', 'messageId'])
  return Object.freeze({ ...parseRecordIdentity({ sessionId: v.sessionId, requestId: v.requestId }), ...(v.messageId === undefined ? {} : { messageId: id(v.messageId, 'messageId', brandString<MessageId>) }) })
}
/**
 * Validate the caller's claimed admission result.
 * @param value - Untrusted identity and outcome fields.
 * @returns Immutable settlement request requiring independent Host verification.
 */
export function parseSettleInput(value: unknown): SettleInput {
  const v = object(value, ['sessionId', 'requestId', 'status'])
  return Object.freeze({ ...parseRecordIdentity({ sessionId: v.sessionId, requestId: v.requestId }), status: oneOf(v.status, ['accepted', 'rejected', 'uncertain']) })
}
/**
 * Validate the owner of a recovery-list request.
 * @param value - Untrusted Session lookup.
 * @returns Validated Session identity for Host authorization.
 */
export function parseListInput(value: unknown): { readonly sessionId: SessionId } {
  const v = object(value, ['sessionId'])
  return Object.freeze({ sessionId: id(v.sessionId, 'sessionId', brandString<SessionId>) })
}
/**
 * Validate every record returned by the recovery-list endpoint.
 * @param value - Untrusted record array.
 * @returns Immutable array of validated prepared records.
 */
export function parsePreparedRecords(value: unknown): readonly PreparedRecord[] {
  if (!Array.isArray(value)) throw new Error('Expected prepared record list.')
  return Object.freeze(value.map(parsePreparedRecord))
}
/**
 * Serialize a value using native JSON property order and omission rules.
 * @param value - Value to serialize.
 * @returns Native JSON text, or `undefined` for unsupported top-level values.
 */
function stringifyJSON(value: unknown): string | undefined {
  return JSON.stringify(value)
}

/**
 * Ignore object property order while retaining array order and every JSON value.
 * @param value - Acyclic JSON-compatible data already validated by the caller.
 * @returns Deterministic serialized value for immutable-envelope comparisons.
 */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']'
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    return '{' + Object.keys(v).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(v[key])).join(',') + '}'
  }
  const result = stringifyJSON(value)
  if (result === undefined) throw new Error('Not JSON data.')
  return result
}
