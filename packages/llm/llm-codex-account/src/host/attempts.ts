/**
 * Host-owned registry of Codex login attempts.
 *
 * One login is one attempt: the Host mints an opaque id and a capability token,
 * runs the official flow in the background, and answers `query`/`cancel` only
 * for the page that holds both halves of that identity. Every bound the design
 * asks for lives here as a timer — the total deadline, the idle lease a page
 * keeps alive by polling, and the retention window a settled attempt stays
 * answerable in — so an attempt cannot outlive the deadline, an abandoned page
 * cannot hold the official key forever, and retained state cannot grow without
 * limit.
 *
 * Settling always aborts the attempt's own controller. That is what lets a
 * cancelled login tear the official flow down instead of leaving it waiting on
 * a prompt nobody will answer.
 *
 * Unloading is final: `dispose()` marks every attempt cancelled with the
 * `unload` reason, withdraws it, and takes the bounds out of service, so a flow
 * that reports back afterwards settles nothing and arms nothing.
 */

import { randomBytes } from 'node:crypto'
import {
  isTerminalAttemptState,
  type CodexOAuthAttemptState,
  type CodexOAuthAttemptView,
  type CodexOAuthCancelReason,
  type CodexOAuthErrorCode,
  type CodexOAuthTuning,
} from '../shared/index.ts'
import { codexOAuthAttemptId, codexOAuthOwnerToken, type CodexOAuthAttemptId, type CodexOAuthOwnerToken } from '../shared/identities.ts'
import { CodexOAuthBridgeFailure } from './failure.ts'

/** Full views of settled attempts kept before the oldest is retired. */
const RETAINED_ATTEMPT_LIMIT = 8

/** Retired identities kept so a late caller learns the attempt expired rather than that it never existed. */
const RETIRED_IDENTITY_LIMIT = 8

/** Random identity the wire accepts for both halves of an attempt credential. */
const IDENTITY_BYTES = 24

/** The three bounds enforced per attempt. */
type AttemptBound = 'deadline' | 'lease' | 'retention'

/** One login attempt, as the Host holds it. */
export interface CodexOAuthAttemptRecord {
  /** Server-minted attempt identity. */
  readonly attemptId: CodexOAuthAttemptId
  /** Capability token only the initiating page holds. */
  readonly ownerToken: CodexOAuthOwnerToken
  /** Withdraws the official attempt; aborted whenever this record settles. */
  readonly controller: AbortController
  /** Lifecycle state; the terminal value never changes again. */
  state: CodexOAuthAttemptState
  /** Official authorization URL while the attempt waits for the browser. */
  authUrl: string | null
  /** Why the attempt was cancelled. */
  cancelReason: CodexOAuthCancelReason | null
  /** Safe code of the failure that ended the attempt. */
  errorCode: CodexOAuthErrorCode | null
  /** When the attempt started, for lifecycle diagnostics. */
  readonly startedAt: number
}

/** What one lookup found. */
export type CodexOAuthAttemptLookup =
  | { readonly kind: 'live'; readonly record: CodexOAuthAttemptRecord }
  | { readonly kind: 'retired' }

/** Lifecycle bounds the registry enforces, and the diagnostic each release reports. */
export interface AttemptRegistryOptions {
  readonly tuning: CodexOAuthTuning
  /** Reports a bound releasing an attempt that was still pending. */
  readonly onReleased: (record: CodexOAuthAttemptRecord, reason: CodexOAuthCancelReason) => void
}

/** Attempts of one Host plugin instance, with their identities, bounds, and state. */
export class AttemptRegistry {
  private readonly records = new Map<CodexOAuthAttemptId, CodexOAuthAttemptRecord>()
  private readonly retired = new Map<CodexOAuthAttemptId, CodexOAuthOwnerToken>()
  private readonly timers = new Map<CodexOAuthAttemptId, Map<AttemptBound, NodeJS.Timeout>>()
  private unloaded = false

  constructor(private readonly options: AttemptRegistryOptions) {}

  /** The pending attempt, or undefined when none is running. */
  get active(): CodexOAuthAttemptRecord | undefined {
    for (const record of this.records.values()) {
      if (!isTerminalAttemptState(record.state)) return record
    }
    return undefined
  }

  /**
   * Start one attempt and arm its bounds.
   * @returns the new record, in its initial state.
   * @throws {CodexOAuthBridgeFailure} code `busy` when an attempt is already pending.
   */
  begin(): CodexOAuthAttemptRecord {
    if (this.unloaded) {
      throw new CodexOAuthBridgeFailure('capability-unavailable', 'this plugin instance has been unloaded')
    }
    if (this.active !== undefined) {
      throw new CodexOAuthBridgeFailure('busy', 'an attempt is already pending for this plugin instance')
    }
    const record: CodexOAuthAttemptRecord = {
      attemptId: codexOAuthAttemptId(mintIdentity()),
      ownerToken: codexOAuthOwnerToken(mintIdentity()),
      controller: new AbortController(),
      state: 'initiating',
      authUrl: null,
      cancelReason: null,
      errorCode: null,
      startedAt: Date.now(),
    }
    this.records.set(record.attemptId, record)
    this.arm(record.attemptId, 'deadline', this.options.tuning.loginDeadlineMs, () => {
      this.release(record, 'timeout')
    })
    this.arm(record.attemptId, 'lease', this.options.tuning.attemptLeaseMs, () => {
      this.release(record, 'page-closed')
    })
    return record
  }

  /**
   * Find one attempt by the identity a caller presented.
   * @param attemptId - attempt identity from the wire.
   * @returns the live record, a retired identity, or undefined when neither is known.
   */
  lookup(attemptId: CodexOAuthAttemptId): CodexOAuthAttemptLookup | undefined {
    const record = this.records.get(attemptId)
    if (record !== undefined) return { kind: 'live', record }
    return this.retired.has(attemptId) ? { kind: 'retired' } : undefined
  }

  /**
   * Whether a caller holds this attempt's capability token.
   * @param record - the attempt presented.
   * @param ownerToken - capability token from the wire.
   * @returns true only for the initiating page's token.
   */
  owns(record: CodexOAuthAttemptRecord, ownerToken: CodexOAuthOwnerToken): boolean {
    return record.ownerToken === ownerToken
  }

  /**
   * Whether a caller holds the capability token of an attempt whose view is gone.
   * @param attemptId - attempt identity from the wire.
   * @param ownerToken - capability token from the wire.
   * @returns true only for the page that started the retired attempt.
   */
  ownsRetired(attemptId: CodexOAuthAttemptId, ownerToken: CodexOAuthOwnerToken): boolean {
    return this.retired.get(attemptId) === ownerToken
  }

  /**
   * Record that the official flow produced the authorization URL to open.
   * @param record - the attempt.
   * @param authUrl - gate-approved authorization URL.
   */
  waitForBrowser(record: CodexOAuthAttemptRecord, authUrl: string): void {
    if (record.state !== 'initiating') return
    record.state = 'waiting-browser'
    record.authUrl = authUrl
  }

  /**
   * Renew the idle lease of an attempt its page is still polling.
   * @param record - the attempt the page asked about.
   */
  touch(record: CodexOAuthAttemptRecord): void {
    if (isTerminalAttemptState(record.state)) return
    this.arm(record.attemptId, 'lease', this.options.tuning.attemptLeaseMs, () => {
      this.release(record, 'page-closed')
    })
  }

  /** Settle an attempt the official flow authorized.
   * @param record - the attempt whose official flow succeeded.
   */
  authorized(record: CodexOAuthAttemptRecord): void {
    this.settle(record, { state: 'authorized', cancelReason: null, errorCode: null })
  }

  /** Settle an attempt the human or the page withdrew.
   * @param record - the attempt being withdrawn.
   * @param reason - the cancellation source reported to its owner.
   */
  cancelled(record: CodexOAuthAttemptRecord, reason: CodexOAuthCancelReason): void {
    this.settle(record, { state: 'cancelled', cancelReason: reason, errorCode: null })
  }

  /** Settle an attempt that failed, reporting the diagnosed code.
   * @param record - the attempt that failed.
   * @param code - the safe failure code exposed to its owner.
   */
  failed(record: CodexOAuthAttemptRecord, code: CodexOAuthErrorCode): void {
    this.settle(record, { state: 'failed', cancelReason: null, errorCode: code })
  }

  /**
   * Withdraw every attempt and take every bound out of service.
   *
   * The attempts are settled as `unload` before they are dropped, so a flow that
   * reports back after the plugin unloaded finds a terminal record and cannot
   * settle it again — or arm the retention bound of an instance that is gone.
   */
  dispose(): void {
    this.unloaded = true
    for (const record of this.records.values()) {
      if (!isTerminalAttemptState(record.state)) {
        record.state = 'cancelled'
        record.cancelReason = 'unload'
        record.errorCode = null
        record.authUrl = null
      }
      if (!record.controller.signal.aborted) record.controller.abort()
    }
    for (const [attemptId] of this.timers) this.clearBounds(attemptId)
    this.records.clear()
    this.retired.clear()
  }

  /** The safe view of one attempt, as its owner sees it.
   * @param record - the attempt record to project.
   * @returns the wire-safe view without its owner token or credential data.
   */
  view(record: CodexOAuthAttemptRecord): CodexOAuthAttemptView {
    return {
      attemptId: record.attemptId,
      state: record.state,
      authUrl: record.state === 'waiting-browser' ? record.authUrl : null,
      cancelReason: record.state === 'cancelled' ? record.cancelReason : null,
      errorCode: record.state === 'failed' ? record.errorCode : null,
    }
  }

  /** Apply one terminal state once, then hold the attempt for a late `query`. */
  private settle(
    record: CodexOAuthAttemptRecord,
    settled: Pick<CodexOAuthAttemptRecord, 'state' | 'cancelReason' | 'errorCode'>,
  ): void {
    if (isTerminalAttemptState(record.state)) return
    record.state = settled.state
    record.cancelReason = settled.cancelReason
    record.errorCode = settled.errorCode
    // The wire admits an authorization URL in `waiting-browser` alone, and no
    // terminal state carries one.
    record.authUrl = null
    this.clearBound(record.attemptId, 'deadline')
    this.clearBound(record.attemptId, 'lease')
    if (!record.controller.signal.aborted) record.controller.abort()
    // An unloaded instance keeps no state: the outcome has no reader left.
    if (this.unloaded) return
    this.retireOverflow()
    this.arm(record.attemptId, 'retention', this.options.tuning.attemptRetentionMs, () => {
      this.retire(record)
    })
  }

  /** Release an attempt that outlived one of its bounds. */
  private release(record: CodexOAuthAttemptRecord, reason: CodexOAuthCancelReason): void {
    if (isTerminalAttemptState(record.state)) return
    this.options.onReleased(record, reason)
    this.cancelled(record, reason)
  }

  /** Bound retained views, oldest first; their identities stay for a late caller. */
  private retireOverflow(): void {
    for (const record of this.records.values()) {
      if (this.retainedCount() <= RETAINED_ATTEMPT_LIMIT) return
      if (isTerminalAttemptState(record.state)) this.retire(record)
    }
  }

  private retainedCount(): number {
    let count = 0
    for (const record of this.records.values()) {
      if (isTerminalAttemptState(record.state)) count += 1
    }
    return count
  }

  /** Forget a settled attempt's view, keeping only the identity a late caller is answered from. */
  private retire(record: CodexOAuthAttemptRecord): void {
    this.clearBounds(record.attemptId)
    if (!this.records.delete(record.attemptId)) return
    this.retired.set(record.attemptId, record.ownerToken)
    while (this.retired.size > RETIRED_IDENTITY_LIMIT) {
      for (const oldest of this.retired.keys()) {
        this.retired.delete(oldest)
        break
      }
    }
  }

  private arm(attemptId: CodexOAuthAttemptId, bound: AttemptBound, delayMs: number, fire: () => void): void {
    // A backstop for the invariant the three callers above keep: an unloaded
    // instance arms nothing.
    if (this.unloaded) return
    this.clearBound(attemptId, bound)
    const slots = this.timers.get(attemptId) ?? new Map<AttemptBound, NodeJS.Timeout>()
    slots.set(bound, setTimeout(() => {
      slots.delete(bound)
      fire()
    }, delayMs))
    this.timers.set(attemptId, slots)
  }

  private clearBound(attemptId: CodexOAuthAttemptId, bound: AttemptBound): void {
    const slots = this.timers.get(attemptId)
    const timer = slots?.get(bound)
    if (slots === undefined || timer === undefined) return
    clearTimeout(timer)
    slots.delete(bound)
  }

  private clearBounds(attemptId: CodexOAuthAttemptId): void {
    const slots = this.timers.get(attemptId)
    if (slots === undefined) return
    for (const timer of slots.values()) clearTimeout(timer)
    this.timers.delete(attemptId)
  }
}

/** One opaque wire identity. */
function mintIdentity(): string {
  return randomBytes(IDENTITY_BYTES).toString('base64url')
}
