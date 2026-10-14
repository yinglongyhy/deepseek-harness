/** Plugin-owned durable sidecar. Preparation is NOT Session admission or a transaction. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, PeerScope } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-agent'
import type { AttachmentId, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { z } from 'zod'
import {
  CHANNEL, PREPARE_ABSENT_CODE, canonicalJSON, parseListInput, parsePrepareInput, parsePreparedRecord, parseReadInput,
  parseRecordIdentity, parseSettleInput, type PreparedRecord, type PrepareInput, type RecordIdentity,
} from './shared.ts'

/** Cordis identity for the annotation sidecar and authenticated RPC endpoints. */
export const name = 'conversation-annotations'
/** Services required for durable preparation, admission checks, and trusted file retries. */
export const inject = ['connection', 'storageDomain', 'sessionQuery', 'sessions', 'agents', 'fileUploads', 'attachments']

// Stored records go through the very same pure DTO parser as browser responses.
const recordSchema = z.unknown().transform((value, ctx): PreparedRecord => {
  try { return parsePreparedRecord(value) } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid annotation record.' })
    return z.NEVER
  }
})
interface StoredAttempt {
  readonly record: PreparedRecord
  readonly files: readonly { readonly index: number; readonly ref: FileAttachmentRef }[]
}
const storedSchema = z.object({
  record: recordSchema,
  files: z.array(z.object({
    index: z.number().int().nonnegative(),
    ref: z.object({
      attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/).transform(value => value as AttachmentId),
      name: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    }).strict(),
  }).strict()),
}).strict().superRefine(({ record, files }, context) => {
  const indices = record.attempt.attachments.flatMap((attachment, index) => attachment.type === 'file' ? [index] : [])
  if (indices.length !== files.length || files.some((file, index) => file.index !== indices[index])) {
    context.addIssue({ code: 'custom', message: 'Stored file references do not match the frozen attachment order.' })
  }
})
/** Plugin-owned preparation records and trusted attachment references, stored atomically. */
export const annotationDomain = {
  name: 'conversation_annotations', version: 1,
  tables: { attempts: { valueSchema: storedSchema } },
} satisfies DomainSpec

class ObservationIntegrityError extends Error {}
function key(identity: RecordIdentity): string { return JSON.stringify([identity.sessionId, identity.requestId]) }
function hasRequest(message: UserMessage, requestId: SessionRequestId): boolean {
  return 'rpcId' in message.source && message.source.rpcId === requestId
}
function isOwnedUser(event: SessionEvent, inherited: number, requestId: SessionRequestId): event is SessionEvent<'user/message'> {
  return event.seq >= inherited && event.type === 'user/message' && event.surfaceOp === 'append'
    && !event.sourceEventSeqs?.length && hasRequest(event.data, requestId)
}
/** Admission is proved by an owned original echo or durable owned Inbox insertion, never inherited echoes. */
function admission(observation: SessionObservation, requestId: SessionRequestId): { accepted: boolean; messageId?: MessageId } {
  let accepted = false
  let messageId: MessageId | undefined
  for (const event of observation.events) {
    if (isOwnedUser(event, observation.inheritedEventCount, requestId)) {
      if (messageId !== undefined && messageId !== event.data.id) throw new ObservationIntegrityError('Conflicting owned prompt identities.')
      accepted = true
      messageId = event.data.id
    } else if (event.seq >= observation.inheritedEventCount && event.type === 'agent/inbox/spliced') {
      if (event.data.inserted.some(message => hasRequest(message, requestId))) accepted = true
    }
  }
  return { accepted, ...(messageId === undefined ? {} : { messageId }) }
}
/**
 * Strongest public Host source check: full immutable replay, original completed
 * assistant body, exact event seq/message identity, and no conflicting origins.
 * Opaque surface id/revision and visible offsets cannot be reconstructed by a
 * public Host API. This intentionally does NOT certify Markdown normalization,
 * table-cell membership, code-block exclusion, or exact visible substring truth.
 * Those remain the operator Client's controlled ChatText selection authority.
 */
function validateSources(input: PrepareInput, observation: SessionObservation): void {
  if (observation.header.id !== input.attempt.sessionId) throw new Error('Observation belongs to a different Session.')
  for (const annotation of input.snapshot.annotations) {
    const event = observation.events[annotation.seq]
    if (!event || event.seq !== annotation.seq || event.type !== 'assistant/message' || event.surfaceOp !== 'append'
      || event.data.interrupted
      || event.data.message.id !== annotation.anchor.messageId || !event.data.message.content.some(block => block.type === 'text' && block.text.trim())) {
      throw new Error('Annotation source is not an original completed assistant body.')
    }
    // Fork-inherited real assistant history is allowed. Conflicting identities
    // anywhere in that Session are not interpreted as the requested origin.
    if (observation.events.some(other => other.seq !== event.seq && other.type === 'assistant/message'
      && other.data.message.id === event.data.message.id)) throw new Error('Conflicting assistant source identity.')
  }
}

/**
 * Own the preparation domain and authenticated endpoints for one plugin lifetime.
 * @param ctx - Host context providing durable storage, Session observation, and file ownership.
 * @returns Completion of domain validation and endpoint registration.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(annotationDomain)
    const table: KvTable<string, StoredAttempt> = domain.table('attempts')
    const stop = new AbortController()
    const tails = new Map<SessionId, Promise<unknown>>()
    const active = new Set<Promise<unknown>>()
    let closing = false
    // Reject malformed key/value pairs instead of ever silently mixing sessions.
    try {
      const unsettledSessions = new Set<SessionId>()
      for (const [storedKey, { record }] of table.entries()) {
        if (storedKey !== key(record.attempt)) throw new Error('Annotation record key does not match its envelope.')
        if (record.status === 'uncertain') {
          if (unsettledSessions.has(record.attempt.sessionId)) throw new Error('Stored Session has multiple unsettled attempts.')
          unsettledSessions.add(record.attempt.sessionId)
        }
      }
    } catch (error) { await domain.close(); throw error }

    function serial<T>(sessionId: SessionId, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new Error('Annotation Host is unloading.'))
      const previous = tails.get(sessionId) ?? Promise.resolve()
      const task = previous.catch((error: unknown) => {
        // The preceding caller owns its failure; this operation still runs.
        void error
      }).then(async () => { signal.throwIfAborted(); return operation() })
      tails.set(sessionId, task)
      active.add(task)
      // Explicit rejection branch avoids an unhandled finally-derived promise.
      const finished = () => { active.delete(task); if (tails.get(sessionId) === task) tails.delete(sessionId) }
      void task.then(finished, finished)
      return task
    }
    async function observe<T>(sessionId: SessionId, signal: AbortSignal, read: (observation: SessionObservation) => T): Promise<T> {
      const live = ctx.sessions.get(sessionId)
      const observation = await ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
      try {
        signal.throwIfAborted()
        if (observation.header.id !== sessionId) throw new ObservationIntegrityError('Observation belongs to another Session.')
        if (observation.header.origin === 'subagent') throw new Error('Annotations require an ordinary Session.')
        const result = read(observation)
        if (observation.source === 'live') {
          if (!live || ctx.sessions.get(sessionId) !== live
            || !await ctx.sessions.flush(live) || ctx.sessions.get(sessionId) !== live) {
            throw new Error('Session persistence could not confirm this observation. Retry with the same request identity.')
          }
        }
        signal.throwIfAborted()
        return result
      } finally { observation[Symbol.dispose]() }
    }
    function required(identity: RecordIdentity): PreparedRecord {
      const record = table.get(key(identity))?.record
      if (!record) throw new Error('Unknown prepared annotation attempt.')
      return record
    }
    async function replace(record: PreparedRecord, status: PreparedRecord['status'], messageId?: MessageId): Promise<PreparedRecord> {
      if (record.messageId !== undefined && messageId !== undefined && record.messageId !== messageId) throw new ObservationIntegrityError('Conflicting durable prompt binding.')
      const binding = status === 'accepted' ? messageId ?? record.messageId : undefined
      const next = parsePreparedRecord({ schemaVersion: 1, attempt: record.attempt, snapshot: record.snapshot, status,
        ...(binding === undefined ? {} : { messageId: binding }) })
      if (canonicalJSON(next) !== canonicalJSON(record)) {
        const stored = table.get(key(record.attempt))
        if (!stored) throw new Error('Prepared annotation attempt disappeared.')
        await table.put(key(record.attempt), { record: next, files: stored.files })
      }
      return next
    }
    const handler: ConnectionRpcHandler = async (endpoint, payload, callerSignal, peer: PeerScope) => {
      // Only the authenticated Web/Desktop page may use these endpoints;
      // an independent API Peer is denied even when its principal is the owner.
      if (peer !== ctx.connection.browserPeer) return { ok: false, error: { code: 'forbidden', message: 'Only the Web or Desktop page may access annotations.', details: {} } }
      const signal = AbortSignal.any([callerSignal, stop.signal])
      // Absence is known only inside the serialized prepare, before put starts.
      const preparation = { absent: false }
      try {
        if (endpoint === 'prepare') {
          const input = parsePrepareInput(payload)
          const value = await serial(input.attempt.sessionId, signal, async () => {
            const stored = table.get(key(input.attempt))?.record
            preparation.absent = stored === undefined
            if (stored) {
              if (canonicalJSON({ attempt: stored.attempt, snapshot: stored.snapshot }) !== canonicalJSON(input)) throw new Error('Request identity already has a different immutable envelope.')
              if (stored.status !== 'rejected') return stored
            }
            for (const [, { record }] of table.entries()) {
              if (record.attempt.sessionId === input.attempt.sessionId && record.attempt.requestId !== input.attempt.requestId && record.status === 'uncertain') throw new Error('Another annotation attempt is unsettled in this Session.')
            }
            if (!stored) await observe(input.attempt.sessionId, signal, (observation) => { validateSources(input, observation) })
            signal.throwIfAborted()
            const record = parsePreparedRecord({ schemaVersion: 1, ...input, status: 'uncertain' })
            // Once put starts cancellation cannot roll back a durable write.
            // A lost response means uncertain; retry the identical envelope.
            const priorFiles = table.get(key(input.attempt))?.files
            const files: StoredAttempt['files'] = priorFiles ?? input.attempt.attachments.flatMap((attachment, index) => {
              if (attachment.type !== 'file') return []
              const agent = ctx.agents.get(input.attempt.sessionId)
              if (!agent || agent.session.header.origin === 'subagent') throw new Error('File uploads require a live ordinary Session.')
              const ref = ctx.fileUploads.resolve(agent, attachment.receiptId)
              if (!ref) throw new Error('File receipt is missing or belongs to another Session. Upload the file before preparing annotations.')
              return [{ index, ref: { ...ref } }]
            })
            preparation.absent = false
            await table.put(key(input.attempt), { record, files })
            return record
          })
          return { ok: true, value }
        }
        if (endpoint === 'restage') {
          const identity = parseRecordIdentity(payload)
          const value = await serial(identity.sessionId, signal, async () => {
            const stored = table.get(key(identity))
            if (!stored) throw new Error('Unknown prepared annotation attempt.')
            const attachments = [...stored.record.attempt.attachments]
            for (const { index, ref } of stored.files) {
              signal.throwIfAborted()
              const upload = await ctx.fileUploads.uploadStream({
                sessionId: identity.sessionId,
                data: ctx.attachments.readFileStream(ref),
                name: ref.name,
                signal,
              })
              if (canonicalJSON(upload.file) !== canonicalJSON(ref)) throw new ObservationIntegrityError('Restaged file differs from the prepared attachment.')
              attachments[index] = { type: 'file', receiptId: upload.receiptId }
            }
            signal.throwIfAborted()
            return attachments
          })
          return { ok: true, value }
        }
        if (endpoint === 'list') {
          const { sessionId } = parseListInput(payload)
          const value = await serial(sessionId, signal, () => Promise.resolve(
            Array.from(table.entries(), ([, { record }]) => record)
              .filter(record => record.attempt.sessionId === sessionId),
          ))
          return { ok: true, value }
        }
        if (endpoint === 'read') {
          const identity = parseReadInput(payload)
          const value = await serial(identity.sessionId, signal, async () => {
            const record = table.get(key(identity))?.record
            if (!record) return null
            if (identity.messageId !== undefined) {
              // A requested message must be a real owned original user/message;
              // an Inbox insertion or old message without rpcId is insufficient.
              const valid = await observe(identity.sessionId, signal, observation =>
                admission(observation, identity.requestId).messageId === identity.messageId)
              signal.throwIfAborted()
              if (!valid) return null
              return replace(record, 'accepted', identity.messageId)
            }
            return record
          })
          return { ok: true, value }
        }
        if (endpoint === 'settle' || endpoint === 'reconcile') {
          const settlement = endpoint === 'settle' ? parseSettleInput(payload) : undefined
          const identity = settlement ?? parseRecordIdentity(payload)
          const value = await serial(identity.sessionId, signal, async () => {
            const record = required(identity)
            let proof: { accepted: boolean; messageId?: MessageId } = { accepted: false }
            try { proof = await observe(identity.sessionId, signal, observation => admission(observation, identity.requestId)) }
            catch (error) {
              signal.throwIfAborted()
              if (error instanceof ObservationIntegrityError) throw error
              // Failed persistence or unavailable history cannot certify rejection.
              if (record.status === 'accepted') return record
              return replace(record, 'uncertain')
            }
            signal.throwIfAborted()
            if (proof.accepted) return replace(record, 'accepted', proof.messageId)
            if (endpoint === 'reconcile') {
              // Prior positive acceptance knowledge is monotonic even if history
              // is temporarily unavailable. Mere absence is not negative proof.
              if (record.status === 'accepted') return record
              if (record.status === 'rejected' && Array.from(table.entries()).some(([, { record: other }]) =>
                other.attempt.sessionId === identity.sessionId && other.attempt.requestId !== identity.requestId && other.status === 'uncertain')) {
                throw new Error('Another annotation attempt is unsettled in this Session.')
              }
              return replace(record, 'uncertain')
            }
            // This classification is supplied by the trusted operator's ordinary
            // submission adapter, NOT independently invented authorization proof.
            // A positively accepted record is not undone by delayed callbacks.
            if (record.status === 'accepted') return record
            const status = settlement?.status === 'rejected' ? 'rejected' : 'uncertain'
            if (status === 'uncertain' && record.status === 'rejected' && Array.from(table.entries()).some(([, { record: other }]) =>
              other.attempt.sessionId === identity.sessionId && other.attempt.requestId !== identity.requestId && other.status === 'uncertain')) {
              throw new Error('Another annotation attempt is unsettled in this Session.')
            }
            return replace(record, status)
          })
          return { ok: true, value }
        }
        return { ok: false, error: { code: 'not-found', message: 'Unknown annotation endpoint.', details: {} } }
      } catch (error) {
        return { ok: false, error: { code: preparation.absent ? PREPARE_ABSENT_CODE : signal.aborted ? 'cancelled' : 'annotation-error', message: signal.aborted ? 'Annotation operation cancelled.' : error instanceof Error ? error.message : 'Annotation operation failed.', details: {} } }
      }
    }
    let unregister: (() => Promise<void>)
    try { unregister = ctx.connection.rpc.handle(CHANNEL, handler) } catch (error) { await domain.close(); throw error }
    return async () => {
      closing = true
      stop.abort(new Error('Annotation Host is unloading.'))
      try { await unregister() } finally {
        try { await Promise.allSettled([...active]) } finally { await domain.close() }
      }
    }
  })
}
