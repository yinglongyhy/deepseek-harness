/** Generic, text-only additions to ordinary composer submissions. */
import type { ConversationContributionId } from '../../contribution-identity.ts'
export type { ConversationContributionId } from '../../contribution-identity.ts'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { DraftAttachmentId, SubmitAttachment } from './input.ts'
import type { InputSubmitMode } from './composer-submission.ts'

/** One owner's current draft; revision changes whenever its submitted content changes. */
export interface SubmissionContributionState {
  readonly hasContent: boolean
  /** Already-localized saving or validation reason; blocks ordinary submissions. */
  readonly blockReason?: string
  readonly revision: number
  /** Model-visible text, persisted through the ordinary user/message event. */
  readonly text: string
}

/** Synchronously captured owner text and version, independent of later draft edits. */
export interface FrozenSubmissionContribution {
  readonly id: ConversationContributionId
  readonly revision: number
  readonly text: string
}

/** Immutable request available to prepare before any Host admission call. */
export interface ConversationSubmissionAttempt {
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
  readonly source: 'click' | 'enter' | 'programmatic'
  readonly mode: InputSubmitMode
  /** Final composed text, including all frozen contributions. */
  readonly text: string
  readonly attachments: readonly SubmitAttachment[]
  readonly contributions: readonly FrozenSubmissionContribution[]
}

/** Accepted is Host admission, not model completion; uncertain must not restore a new-id draft. */
export type ConversationSubmissionStatus = 'accepted' | 'rejected' | 'uncertain'

/** Owner-scoped contribution. Callbacks must compare the supplied revision before clearing a draft. */
export interface SubmissionContribution {
  readonly id: ConversationContributionId
  readonly state: ObservableSnapshot<SubmissionContributionState>
  /**
   * Persist business data keyed by attempt.sessionId/requestId before admission.
   * Preparation must be idempotent: a failed multi-owner preparation can be retried with the same immutable request.
   * @param attempt - immutable complete request, safe to persist.
   * @param contribution - this owner's frozen version.
   * @param signal - cancellation on scope teardown or submission cancellation.
   * @returns completion of durable preparation; rejection prevents Host admission.
   */
  prepare(attempt: ConversationSubmissionAttempt, contribution: FrozenSubmissionContribution, signal: AbortSignal): Promise<void>
  /**
   * Observe settlement; failures are reported without changing admission, and teardown waits for running callbacks.
   * Accepted callbacks that finish successfully are not repeated; failed callbacks can retry locally.
   * @param attempt - the same immutable request supplied to prepare.
   * @param contribution - this owner's frozen version, not its current draft.
   * @param status - Host admission classification.
   * @returns optional asynchronous cleanup completion.
   */
  settle(
    attempt: ConversationSubmissionAttempt,
    contribution: FrozenSubmissionContribution,
    status: ConversationSubmissionStatus,
  ): void | Promise<void>
}

/** Stable per-session composer eligibility source. */
export interface SubmissionContributionsState {
  readonly hasContent: boolean
  readonly blockReason?: string
  /** The current contribution revision is already in flight or has uncertain admission. */
  readonly pending?: boolean
}

/** Public immutable-attempt recovery face. History lookup remains owned by the caller. */
export interface ConversationSubmissions {
  /**
   * Read ordinary submission eligibility for a Session.
   * @param sessionId - addressed Session.
   * @returns its stable eligibility observable.
   */
  storeFor(sessionId: SessionId): ObservableSnapshot<SubmissionContributionsState>
  /**
   * Read retained request content without asserting durable preparation or Host admission.
   * @param requestId - request identity.
   * @returns the immutable request, if captured or restored.
   */
  attemptFor(requestId: SessionRequestId): ConversationSubmissionAttempt | undefined
  /**
   * Restore immutable request content without certifying durable preparation.
   * Register matching owners before restore; replacements bind after captured operations drain and prepare again before retry admission.
   * Missing owners prevent retry admission. Restored admission starts uncertain; conflicting reuse of an id throws.
   * @param attempt - complete request content validated by the caller's persistence reader.
   * @returns the retained immutable request for retry or reconciliation.
   */
  restore(attempt: ConversationSubmissionAttempt): ConversationSubmissionAttempt
  /**
   * Resolve admission using Host history rpcId or authoritative rejection evidence.
   * Missing history alone means uncertain, not rejected. Settlement failures reject this operation while retaining admission.
   * @param requestId - previously prepared/restored identity.
   * @param resolve - caller-owned full-history or admission query.
   * @returns the resolved status.
   */
  reconcile(
    requestId: SessionRequestId,
    resolve: (attempt: ConversationSubmissionAttempt) => Promise<ConversationSubmissionStatus>,
  ): Promise<ConversationSubmissionStatus>
}

/** Package-private synchronous ordinary-send capture, made before asynchronous chip/attachment serialization. */
export interface CapturedConversationSubmission {
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
  readonly source: ConversationSubmissionAttempt['source']
  readonly mode: InputSubmitMode
  readonly text: string
  readonly attachmentIds: readonly DraftAttachmentId[]
  readonly contributions: readonly FrozenSubmissionContribution[]
}
