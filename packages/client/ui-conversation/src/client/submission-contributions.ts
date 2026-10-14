/** Owner registrations, immutable requests, and admission settlement for ordinary sends. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  CapturedConversationSubmission, ConversationSubmissionAttempt, ConversationSubmissionStatus,
  ConversationSubmissions, FrozenSubmissionContribution, SubmissionContribution, SubmissionContributionsState,
} from './contract/contributions.ts'
import type { DraftAttachmentId, SubmitAttachment, SubmitOutcome } from './contract/input.ts'
import type { InputSubmitMode } from './contract/composer-submission.ts'

interface Owner {
  readonly contribution: SubmissionContribution
  active: boolean
  readonly operations: Set<Promise<unknown>>
  readonly controllers: Set<AbortController>
  readonly reservations: Map<SessionRequestId, number>
  off?: () => void
}
interface CaptureRecord {
  readonly owners: readonly Owner[]
  readonly controller: AbortController
  readonly unlink: Set<() => void>
}
interface AttemptRecord {
  readonly attempt: ConversationSubmissionAttempt
  owners: readonly Owner[]
  readonly captureController: AbortController | undefined
  status?: ConversationSubmissionStatus
  prepared: boolean
  settled?: boolean
  acceptedSettledIds?: Set<SubmissionContribution['id']>
  admissionPossible: boolean
  pending?: Promise<SubmitOutcome>
}

async function drainOperations(operations: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(operations)
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length > 0) throw new AggregateError(failures, `conversation submission disposal failed: ${failures.map(String).join('; ')}`)
}

function sameAttachment(left: SubmitAttachment, right: SubmitAttachment): boolean {
  switch (left.type) {
    case 'image':
      return right.type === 'image'
        && left.mediaType === right.mediaType
        && left.data === right.data
        && left.name === right.name
    case 'file':
      return right.type === 'file' && left.receiptId === right.receiptId
    default:
      return assertNever(left)
  }
}

function sameSubmissionAttempt(left: ConversationSubmissionAttempt, right: ConversationSubmissionAttempt): boolean {
  return left.sessionId === right.sessionId
    && left.requestId === right.requestId
    && left.source === right.source
    && left.mode === right.mode
    && left.text === right.text
    && left.attachments.length === right.attachments.length
    && left.attachments.every((attachment, index) => {
      const other = right.attachments[index]
      return other !== undefined && sameAttachment(attachment, other)
    })
    && left.contributions.length === right.contributions.length
    && left.contributions.every((contribution, index) => {
      const other = right.contributions[index]
      return other !== undefined
        && contribution.id === other.id
        && contribution.revision === other.revision
        && contribution.text === other.text
    })
}

/** Internal registry assembled once by the Conversation plugin. */
export class SubmissionContributionRegistry implements ConversationSubmissions {
  private readonly owners = new Map<SessionId, Map<string, Owner>>()
  private readonly stores = new Map<SessionId, SnapshotStore<SubmissionContributionsState>>()
  private readonly captures = new WeakMap<CapturedConversationSubmission, CaptureRecord>()
  private readonly attempts = new Map<SessionRequestId, AttemptRecord>()
  private readonly operations = new Set<Promise<unknown>>()
  private disposed = false
  private disposal?: Promise<void>

  /**
   * Read reactive ordinary-send eligibility for a Session.
   * @param sessionId - target Session.
   * @returns its stable eligibility source.
   */
  storeFor(sessionId: SessionId): SnapshotStore<SubmissionContributionsState> {
    let store = this.stores.get(sessionId)
    if (store === undefined) {
      store = createSnapshotStore<SubmissionContributionsState>({ hasContent: false })
      this.stores.set(sessionId, store)
    }
    return store
  }

  /**
   * Register one independently disposable draft owner.
   * @param sessionId - target Session.
   * @param contribution - owner draft and callbacks.
   * @returns a disposer that closes callbacks synchronously and awaits active operations.
   */
  register(sessionId: SessionId, contribution: SubmissionContribution): () => Promise<void> {
    if (this.disposed) throw new Error('conversation contributions disposed')
    let entries = this.owners.get(sessionId)
    if (entries === undefined) {
      entries = new Map()
      this.owners.set(sessionId, entries)
    }
    if (entries.has(contribution.id)) throw new Error(`duplicate contribution "${contribution.id}"`)
    const owner: Owner = { contribution, active: true, operations: new Set(), controllers: new Set(), reservations: new Map() }
    entries.set(contribution.id, owner)
    const off = contribution.state.subscribe(() => { this.publish(sessionId) })
    owner.off = off
    this.publish(sessionId)
    let disposal: Promise<void> | undefined
    return () => {
      if (disposal !== undefined) return disposal
      owner.active = false
      off()
      entries.delete(contribution.id)
      this.publish(sessionId)
      for (const controller of owner.controllers) controller.abort()
      disposal = drainOperations([...owner.operations])
      return disposal
    }
  }

  private publish(sessionId: SessionId): void {
    const owners = [...this.owners.get(sessionId)?.values() ?? []]
    const states = owners.map(owner => owner.contribution.state.getSnapshot())
    const pending = owners.some((owner) => {
      const state = owner.contribution.state.getSnapshot()
      return state.hasContent && [...owner.reservations.values()].includes(state.revision)
    })
    const blockReason = states.find(state => state.blockReason !== undefined)?.blockReason
    const hasContent = states.some(state => state.hasContent)
    const store = this.storeFor(sessionId)
    const previous = store.getSnapshot()
    if (previous.hasContent === hasContent && previous.blockReason === blockReason && (previous.pending ?? false) === pending) return
    store.set({ hasContent, ...blockReason === undefined ? {} : { blockReason }, ...pending ? { pending } : {} })
  }

  /**
   * Freeze editor, attachment identities, and every content-bearing owner before serialization.
   * @param sessionId - target Session.
   * @param text - editor snapshot.
   * @param attachmentIds - ordered draft ids.
   * @param mode - delivery mode.
   * @param source - initiating gesture.
   * @returns the synchronous frozen capture; blocked or reserved content throws.
   */
  capture(sessionId: SessionId, text: string, attachmentIds: readonly DraftAttachmentId[], mode: InputSubmitMode, source: ConversationSubmissionAttempt['source']): CapturedConversationSubmission {
    if (this.disposed) throw new Error('conversation contributions disposed')
    if (this.storeFor(sessionId).getSnapshot().pending === true) throw new Error('conversation submission admission pending')
    const owners = [...this.owners.get(sessionId)?.values() ?? []]
    const frozen: FrozenSubmissionContribution[] = []
    const selected: Owner[] = []
    for (const owner of owners) {
      const state = owner.contribution.state.getSnapshot()
      if (state.blockReason !== undefined) throw new Error(state.blockReason)
      if (!state.hasContent) continue
      selected.push(owner)
      frozen.push(Object.freeze({ id: owner.contribution.id, revision: state.revision, text: state.text }))
    }
    const capture = Object.freeze({
      sessionId, requestId: randomUUID() as SessionRequestId, source, mode, text,
      attachmentIds: Object.freeze([...attachmentIds]), contributions: Object.freeze(frozen),
    })
    const controller = new AbortController()
    this.captures.set(capture, { owners: selected, controller, unlink: new Set() })
    controller.signal.addEventListener('abort', () => { this.finishCapture(capture) }, { once: true })
    for (const owner of selected) {
      owner.controllers.add(controller)
      const frozen = capture.contributions.find(contribution => contribution.id === owner.contribution.id)
      if (frozen !== undefined) owner.reservations.set(capture.requestId, frozen.revision)
    }
    this.publish(sessionId)
    return capture
  }

  /**
   * Link caller cancellation to the reserved capture lifecycle.
   * @param capture - reserved draft.
   * @param signal - caller cancellation.
   * @returns the capture-owned signal for arbitration, serialization, and admission.
   */
  bindCapture(capture: CapturedConversationSubmission, signal?: AbortSignal): AbortSignal {
    const record = this.captures.get(capture)
    if (record === undefined) throw new Error('unknown submission capture')
    if (signal !== undefined && signal !== record.controller.signal) {
      const abort = (): void => { record.controller.abort() }
      signal.addEventListener('abort', abort, { once: true })
      record.unlink.add(() => { signal.removeEventListener('abort', abort) })
      if (signal.aborted) abort()
    }
    return record.controller.signal
  }

  /**
   * Cancel the capture and release reservations unless admission remains uncertain.
   * @param capture - completed or abandoned draft.
   */
  releaseCapture(capture: CapturedConversationSubmission): void {
    this.captures.get(capture)?.controller.abort()
    this.finishCapture(capture)
  }

  private finishCapture(capture: CapturedConversationSubmission): void {
    const record = this.captures.get(capture)
    if (record === undefined) return
    for (const off of record.unlink) off()
    record.unlink.clear()
    for (const owner of record.owners) {
      owner.controllers.delete(record.controller)
      if (this.attempts.get(capture.requestId)?.status !== 'uncertain') owner.reservations.delete(capture.requestId)
    }
    this.publish(capture.sessionId)
  }

  /**
   * Track asynchronous work using the reserved capture's controller; the caller owns capture release or handoff.
   * @param capture - synchronous reservation.
   * @param signal - shell cancellation.
   * @param execute - arbitration, serialization, or admission work.
   * @returns the tracked result; owner disposal waits for its completion.
   */
  trackCapture<T>(capture: CapturedConversationSubmission, signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const currentSignal = this.bindCapture(capture, signal)
    const record = this.captures.get(capture)
    if (record === undefined) throw new Error('unknown submission capture')
    const operation = Promise.resolve().then(() => {
      if (this.disposed || currentSignal.aborted || record.owners.some(owner => !owner.active)) throw new Error('submission cancelled before serialization')
      return execute(currentSignal)
    }).finally(() => {
      this.operations.delete(operation)
      for (const owner of record.owners) owner.operations.delete(operation)
    })
    this.operations.add(operation)
    for (const owner of record.owners) owner.operations.add(operation)
    return operation
  }

  /**
   * Read retained request content without asserting durable preparation or Host admission.
   * @param requestId - request identity.
   * @returns its complete immutable request, when retained.
   */
  attemptFor(requestId: SessionRequestId): ConversationSubmissionAttempt | undefined {
    return this.attempts.get(requestId)?.attempt
  }

  /**
   * Restore caller-validated immutable content without certifying any owner's durable preparation.
   * Matching replacement owners rebind only after captured work drains; retry prepares them before admission.
   * Equality ignores object property order but preserves array order and exact submitted values.
   * @param attempt - the complete persisted request content.
   * @returns an immutable copy; conflicting requestId reuse throws.
   */
  restore(attempt: ConversationSubmissionAttempt): ConversationSubmissionAttempt {
    return this.retain(attempt)
  }

  private retain(
    attempt: ConversationSubmissionAttempt, capturedOwners?: readonly Owner[], captureController?: AbortController,
  ): ConversationSubmissionAttempt {
    if (this.disposed) throw new Error('conversation contributions disposed')
    const existing = this.attempts.get(attempt.requestId)
    if (existing !== undefined) {
      if (!sameSubmissionAttempt(existing.attempt, attempt)) throw new Error('requestId reused with different submission content')
      this.rebindOwners(existing)
      return existing.attempt
    }
    const immutable = Object.freeze({
      ...attempt,
      attachments: Object.freeze(attempt.attachments.map(attachment => Object.freeze({ ...attachment }))),
      contributions: Object.freeze(attempt.contributions.map(contribution => Object.freeze({ ...contribution }))),
    })
    const owners = capturedOwners ?? immutable.contributions.flatMap((contribution) => {
      const owner = this.owners.get(attempt.sessionId)?.get(contribution.id)
      return owner === undefined ? [] : [owner]
    })
    this.attempts.set(immutable.requestId, { attempt: immutable, owners, captureController, status: 'uncertain', prepared: false, admissionPossible: capturedOwners === undefined })
    for (const owner of owners) {
      const frozen = immutable.contributions.find(contribution => contribution.id === owner.contribution.id)
      if (frozen !== undefined) owner.reservations.set(immutable.requestId, frozen.revision)
    }
    this.publish(immutable.sessionId)
    return immutable
  }

  private rebindOwners(record: AttemptRecord): void {
    // Captured serialization, admission, and settlement keep their original owner identities until quiescent.
    if (record.pending !== undefined || record.owners.some(owner => owner.operations.size > 0)
      || (record.captureController !== undefined && !record.captureController.signal.aborted)) return
    const owners = record.attempt.contributions.flatMap((contribution) => {
      const owner = this.owners.get(record.attempt.sessionId)?.get(contribution.id)
      return owner === undefined ? [] : [owner]
    })
    if (owners.length === record.owners.length && owners.every((owner, index) => owner === record.owners[index])) return
    for (const owner of record.owners) owner.reservations.delete(record.attempt.requestId)
    record.owners = owners
    record.prepared = false
    if (record.status === 'uncertain') {
      for (const owner of owners) {
        const frozen = record.attempt.contributions.find(contribution => contribution.id === owner.contribution.id)
        if (frozen !== undefined) owner.reservations.set(record.attempt.requestId, frozen.revision)
      }
    }
    this.publish(record.attempt.sessionId)
  }

  /**
   * Compose the complete request while retaining its original captured owners.
   * @param capture - synchronous draft capture.
   * @param text - serialized editor text.
   * @param attachments - serialized attachment snapshot.
   * @returns the immutable composed attempt, not yet durably prepared.
   */
  materialize(
    capture: CapturedConversationSubmission,
    text: string,
    attachments: readonly SubmitAttachment[],
  ): ConversationSubmissionAttempt {
    const record = this.captures.get(capture)
    if (record === undefined || record.controller.signal.aborted || record.owners.some(owner => !owner.active)) throw new Error('submission capture unavailable')
    return this.retain({
      sessionId: capture.sessionId, requestId: capture.requestId, source: capture.source, mode: capture.mode,
      text: [text, ...capture.contributions.map(contribution => contribution.text)].filter(part => part !== '').join('\n\n'),
      attachments, contributions: capture.contributions,
    }, record.owners, record.controller)
  }

  /**
   * Reserve matching revisions and track serialization through admission and teardown.
   * @param capture - synchronous draft version.
   * @param signal - caller cancellation.
   * @param serialize - complete text and attachment serialization.
   * @param admit - Host admission callback.
   * @returns a tracked, classified send.
   */
  submit(
    capture: CapturedConversationSubmission,
    signal: AbortSignal | undefined,
    serialize: () => Promise<{ text: string; attachments: readonly SubmitAttachment[] }>,
    admit: (attempt: ConversationSubmissionAttempt, signal: AbortSignal) => Promise<ConversationSubmissionStatus>,
  ): Promise<SubmitOutcome> {
    const currentSignal = this.bindCapture(capture, signal)
    const record = this.captures.get(capture)
    if (record === undefined) throw new Error('unknown submission capture')
    const { owners } = record
    const operation = Promise.resolve().then(async (): Promise<SubmitOutcome> => {
      try {
        if (this.disposed || currentSignal.aborted || owners.some(owner => !owner.active)) throw new Error('submission cancelled before serialization')
        const serialized = await serialize()
        const attempt = this.materialize(capture, serialized.text, serialized.attachments)
        return await this.run(attempt, currentSignal, admissionSignal => admit(attempt, admissionSignal))
      } catch (error) {
        return { kind: 'error', admission: 'rejected', text: error instanceof Error ? error.message : String(error) }
      }
    }).finally(() => {
      this.operations.delete(operation)
      for (const owner of owners) owner.operations.delete(operation)
      this.releaseCapture(capture)
    })
    this.operations.add(operation)
    for (const owner of owners) {
      owner.operations.add(operation)
    }
    this.publish(capture.sessionId)
    return operation
  }

  /**
   * Serialize operations per request and enforce durable preparation before Host admission.
   * @param attempt - immutable request.
   * @param signal - caller cancellation.
   * @param admit - Host admission only.
   * @param prepare - whether to repeat preparation even after prior success; unfinished preparation always repeats.
   * @returns the classified admission outcome.
   */
  run(
    attempt: ConversationSubmissionAttempt,
    signal: AbortSignal | undefined,
    admit: (signal: AbortSignal) => Promise<ConversationSubmissionStatus>,
    prepare = true,
  ): Promise<SubmitOutcome> {
    this.restore(attempt)
    const record = this.attempts.get(attempt.requestId)
    if (record === undefined) throw new Error('submission record missing')
    if (record.pending !== undefined) return record.pending
    if (record.status === 'accepted') return this.start(record, () => this.settledOutcome(record, 'accepted'))
    const controller = record.captureController !== undefined && !record.captureController.signal.aborted
      ? record.captureController
      : new AbortController()
    const abort = (): void => { controller.abort() }
    if (signal?.aborted === true) abort()
    signal?.addEventListener('abort', abort, { once: true })
    for (const owner of record.owners) owner.controllers.add(controller)
    return this.start(record, () => this.execute(record, controller, admit, prepare), () => {
      signal?.removeEventListener('abort', abort)
      for (const owner of record.owners) owner.controllers.delete(controller)
    })
  }

  private start(record: AttemptRecord, execute: () => Promise<SubmitOutcome>, cleanup?: () => void): Promise<SubmitOutcome> {
    // Reserve the request and every owner before invoking plugin code, including reentrant disposers.
    const operation = Promise.resolve().then(execute).finally(() => {
      cleanup?.()
      for (const owner of record.owners) {
        owner.operations.delete(operation)
        if (record.status !== 'uncertain') owner.reservations.delete(record.attempt.requestId)
      }
      this.operations.delete(operation)
      delete record.pending
      this.publish(record.attempt.sessionId)
    })
    record.pending = operation
    this.operations.add(operation)
    for (const owner of record.owners) {
      owner.operations.add(operation)
      const frozen = record.attempt.contributions.find(contribution => contribution.id === owner.contribution.id)
      if (frozen !== undefined) owner.reservations.set(record.attempt.requestId, frozen.revision)
    }
    this.publish(record.attempt.sessionId)
    return operation
  }

  private cancelled(signal: AbortSignal): boolean {
    return this.disposed || signal.aborted
  }

  private async execute(
    record: AttemptRecord,
    controller: AbortController,
    admit: (signal: AbortSignal) => Promise<ConversationSubmissionStatus>,
    prepare: boolean,
  ): Promise<SubmitOutcome> {
    let status: ConversationSubmissionStatus
    let message: string | undefined
    try {
      if (this.cancelled(controller.signal)) throw new Error('submission cancelled before preparation')
      if (record.owners.length !== record.attempt.contributions.length) throw new Error('submission contribution owner unavailable; register before restore')
      if (prepare || !record.prepared) {
        record.prepared = false
        const preparations = record.owners.map(async (owner) => {
          const frozen = record.attempt.contributions.find(contribution => contribution.id === owner.contribution.id)
          if (frozen === undefined || !owner.active) throw new Error('submission contribution removed')
          await owner.contribution.prepare(record.attempt, frozen, controller.signal)
        })
        const results = await Promise.allSettled(preparations)
        const failure = results.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
        record.prepared = true
      }
      if (this.cancelled(controller.signal) || record.owners.some(owner => !owner.active)) {
        throw new Error('submission cancelled before admission')
      }
    } catch (error) {
      status = record.admissionPossible && record.status === 'uncertain' ? 'uncertain' : 'rejected'
      message = error instanceof Error ? error.message : String(error)
      return this.settledOutcome(record, status, message)
    }
    try {
      record.admissionPossible = true
      status = await admit(controller.signal)
    } catch (error) {
      status = 'uncertain'
      message = error instanceof Error ? error.message : String(error)
    }
    return this.settledOutcome(record, status, message)
  }

  private async settledOutcome(record: AttemptRecord, status: ConversationSubmissionStatus, message?: string): Promise<SubmitOutcome> {
    try { await this.settle(record, status) } catch (error) {
      return { kind: 'error', admission: record.status ?? status, text: error instanceof Error ? error.message : String(error) }
    }
    return { kind: status === 'accepted' ? 'success' : 'error', admission: status, ...message === undefined ? {} : { text: message } }
  }

  private async settle(record: AttemptRecord, status: ConversationSubmissionStatus): Promise<void> {
    if (record.status === 'accepted' && record.settled === true) return
    status = record.status === 'accepted' ? 'accepted' : status
    record.status = status
    record.admissionPossible = status !== 'rejected'
    record.settled = false
    const results = await Promise.allSettled(record.owners.map(async (owner) => {
      if (!owner.active || this.disposed || (status === 'accepted' && record.acceptedSettledIds?.has(owner.contribution.id))) return
      const contribution = record.attempt.contributions.find(frozen => frozen.id === owner.contribution.id)
      if (contribution !== undefined) {
        await owner.contribution.settle(record.attempt, contribution, status)
        if (status === 'accepted') (record.acceptedSettledIds ??= new Set()).add(contribution.id)
      }
    }))
    const failures: unknown[] = []
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    if (status === 'accepted' && record.attempt.contributions.some(contribution => !record.acceptedSettledIds?.has(contribution.id))) {
      failures.push(new Error('accepted submission contribution settlement incomplete; register missing owners before recovery'))
    }
    if (failures.length > 0) throw new AggregateError(failures, `submission ${status}; contribution settlement failed: ${failures.map(String).join('; ')}`)
    record.settled = true
  }

  /**
   * Reconcile retained admission without competing with an existing retry or settlement.
   * @param requestId - retained request identity.
   * @param resolve - caller-owned authoritative lookup; missing history means uncertain.
   * @returns the admission classification; accepted admission never downgrades.
   */
  async reconcile(
    requestId: SessionRequestId,
    resolve: (attempt: ConversationSubmissionAttempt) => Promise<ConversationSubmissionStatus>,
  ): Promise<ConversationSubmissionStatus> {
    if (this.disposed) throw new Error('conversation contributions disposed')
    const record = this.attempts.get(requestId)
    if (record === undefined) throw new Error('unknown submission requestId')
    this.rebindOwners(record)
    if (record.status === 'accepted' && record.settled === true && record.pending === undefined) return 'accepted'
    const operation = record.pending ?? this.start(record, async () => {
      let status: ConversationSubmissionStatus
      if (record.status === 'accepted') status = 'accepted'
      else {
        try { status = await resolve(record.attempt) } catch (_error) { status = 'uncertain' }
      }
      await this.settle(record, status)
      return { kind: status === 'accepted' ? 'success' : 'error', admission: status }
    })
    const result = await operation
    if (result.admission === undefined) throw new Error('submission admission missing')
    return result.admission
  }

  /** Close all callbacks, abort active preparations, and wait for quiescence. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    for (const [sessionId, entries] of this.owners) {
      for (const owner of entries.values()) {
        owner.active = false
        owner.off?.()
        for (const controller of owner.controllers) controller.abort()
      }
      entries.clear()
      this.publish(sessionId)
    }
    this.disposal = drainOperations([...this.operations])
    return this.disposal
  }
}
