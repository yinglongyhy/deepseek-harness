import type { ClientConnectionRpc, ConnectionRpcFailure } from '@deepseek-ai/dsh-client-connection/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { canonicalJSON, CHANNEL, parseAnnotationAttempt, parsePreparedRecord, parsePreparedRecords } from '../shared.ts'
import type { AnnotationAttachment, AnnotationAttempt, PrepareInput, PreparedRecord } from '../shared.ts'

/** Endpoint failure preserving the Host's stable code and structured details. */
export class AnnotationRpcError extends Error {
  constructor(readonly failure: ConnectionRpcFailure) {
    super(failure.message)
    this.name = 'AnnotationRpcError'
  }
}

/** Plugin-owned DTO transport; request correlation remains inside Connection. */
export class AnnotationChannel {
  constructor(private readonly rpc: ClientConnectionRpc) {}

  private async call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const result = await this.rpc.call(CHANNEL, endpoint, payload, signal)
    if (!result.ok) throw new AnnotationRpcError(result.error)
    return result.value
  }

  private addressed(value: unknown, sessionId: SessionId, requestId: SessionRequestId): PreparedRecord {
    const record = parsePreparedRecord(value)
    if (record.attempt.sessionId !== sessionId || record.attempt.requestId !== requestId) throw new Error('Annotation response identity mismatch.')
    return record
  }

  /** Persists and verifies one immutable annotation submission envelope.
   * @param input - Submission attempt and frozen annotation snapshot.
   * @param signal - Optional cancellation signal.
   * @returns The Host-accepted prepared record.
   * @throws AnnotationRpcError with the Host code; transport and invalid responses leave preparation unknown.
   */
  async prepare(input: PrepareInput, signal?: AbortSignal): Promise<PreparedRecord> {
    const record = this.addressed(await this.call('prepare', input, signal), input.attempt.sessionId, input.attempt.requestId)
    if (canonicalJSON({ attempt: record.attempt, snapshot: record.snapshot }) !== canonicalJSON(input)) throw new Error('Annotation response content mismatch.')
    return record
  }

  /** Lists persisted annotation submissions for a Session.
   * @param sessionId - Session to query.
   * @param signal - Optional cancellation signal.
   * @returns Prepared records belonging to the Session.
   * @throws On transport failure or a response containing another Session's record.
   */
  async list(sessionId: SessionId, signal?: AbortSignal): Promise<readonly PreparedRecord[]> {
    const records = parsePreparedRecords(await this.call('list', { sessionId }, signal))
    if (records.some(record => record.attempt.sessionId !== sessionId)) throw new Error('Annotation response session mismatch.')
    return records
  }

  /** Reads the record associated with a submitted USER message.
   * @param sessionId - Owning Session id.
   * @param requestId - Original submission request id.
   * @param messageId - Submitted USER message id.
   * @param signal - Optional cancellation signal.
   * @returns The matching record, or `null` when none exists.
   * @throws On transport failure or a response with mismatched identity.
   */
  async read(
    sessionId: SessionId, requestId: SessionRequestId, messageId: MessageId, signal?: AbortSignal,
  ): Promise<PreparedRecord | null> {
    const value = await this.call('read', { sessionId, requestId, messageId }, signal)
    if (value === null) return null
    const record = this.addressed(value, sessionId, requestId)
    if (record.status === 'accepted' && record.messageId !== messageId) throw new Error('Annotation response message mismatch.')
    return record
  }

  /** Records the admission outcome for one submission.
   * @param sessionId - Owning Session id.
   * @param requestId - Original submission request id.
   * @param status - Admission status to persist.
   * @param signal - Optional cancellation signal.
   * @returns The updated prepared record.
   * @throws On transport failure or a response with mismatched identity.
   */
  async settle(sessionId: SessionId, requestId: SessionRequestId, status: PreparedRecord['status'], signal?: AbortSignal): Promise<PreparedRecord> {
    return this.addressed(await this.call('settle', { sessionId, requestId, status }, signal), sessionId, requestId)
  }

  /** Reconciles a submission with the Host's current admission state.
   * @param sessionId - Owning Session id.
   * @param requestId - Original submission request id.
   * @param signal - Optional cancellation signal.
   * @returns The current prepared record.
   * @throws On transport failure or a response with mismatched identity.
   */
  async reconcile(sessionId: SessionId, requestId: SessionRequestId, signal?: AbortSignal): Promise<PreparedRecord> {
    return this.addressed(await this.call('reconcile', { sessionId, requestId }, signal), sessionId, requestId)
  }

  /** Refreshes Host-owned file receipts without changing the retry envelope.
   * @param attempt - Retained submission attempt to restage.
   * @param signal - Optional cancellation signal.
   * @returns Restaged attachments matching the original attachment content.
   * @throws On transport failure or when refreshed attachments do not match the original envelope.
   */
  async restage(attempt: AnnotationAttempt, signal?: AbortSignal): Promise<readonly AnnotationAttachment[]> {
    const value = await this.call('restage', { sessionId: attempt.sessionId, requestId: attempt.requestId }, signal)
    const refreshed = parseAnnotationAttempt({ ...attempt, attachments: value }).attachments
    if (refreshed.length !== attempt.attachments.length || refreshed.some((item, index) => {
      const original = attempt.attachments[index]
      return !original || original.type !== item.type
        || (original.type === 'image' && canonicalJSON(original) !== canonicalJSON(item))
    })) throw new Error('Restaged attachment content mismatch.')
    return refreshed
  }
}
