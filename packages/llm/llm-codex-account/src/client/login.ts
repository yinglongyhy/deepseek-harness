/**
 * One login attempt as this page runs it.
 *
 * The attempt credential the Host minted lives in this object and nowhere else:
 * it is never persisted, never rendered, and dropped the moment the attempt
 * settles or the page releases it. The poll cadence is the one the Host
 * returned, and the Host's own deadline and idle lease stay the fallback for a
 * page that disappears mid-login — releasing this page cancels best-effort and
 * then stops caring.
 *
 * The authorization page is opened once, when the official URL first appears;
 * every later open is the user's own action. A `null` return from the open call
 * means nothing (the desktop shell answers `deny` after `shell.openExternal`),
 * so only a synchronous throw counts as an open failure.
 *
 * Every answer is checked twice before it may change anything: it must belong
 * to the attempt this machine still owns, and the machine must still be the one
 * that asked. A late answer of a cancelled attempt, or a Host answer naming a
 * different attempt, is dropped instead of settling this page's state.
 */

import {
  isAllowedAuthorizationUrl,
  type CodexOAuthAttemptRequest,
  type CodexOAuthAttemptView,
  type CodexOAuthBeginResult,
  type CodexOAuthCancelReason,
  type CodexOAuthClientCancelReason,
  type CodexOAuthErrorCode,
} from '../shared/index.ts'
import { failureCodeOf, type CodexOAuthEndpoint } from './channel.ts'

/** Consecutive failed polls after which this page stops claiming the attempt is alive. */
const MAX_POLL_FAILURES = 3

/** What the card shows about the login attempt. */
export type CodexOAuthLoginState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  /** The attempt is live; `authUrl` is the official URL once it exists, null while the flow starts. */
  | { readonly kind: 'pending'; readonly authUrl: string | null }
  | { readonly kind: 'authorized' }
  | { readonly kind: 'cancelled'; readonly reason: CodexOAuthCancelReason }
  | { readonly kind: 'failed'; readonly code: CodexOAuthErrorCode }

/** What one login attempt runs on. */
export interface CodexOAuthLoginOptions {
  /** The attempt operations this page may call. */
  readonly endpoint: Pick<CodexOAuthEndpoint, 'begin' | 'query' | 'cancel'>
  /** Hands an accepted authorization URL to the desktop shell. */
  readonly open: (url: string) => void
  /** Called on every state change. */
  readonly onChange: (state: CodexOAuthLoginState) => void
  /**
   * Called when an attempt settles, whatever it settled as. A cancelled or
   * failed login can still have left a committed record behind, so the caller
   * rereads the official facts rather than trusting this page's outcome.
   */
  readonly onSettled: () => void
}

/** The login attempt machine. Every method is safe to call in any state. */
export class CodexOAuthLogin {
  private state: CodexOAuthLoginState = { kind: 'idle' }
  private attempt: CodexOAuthAttemptRequest | undefined
  private pollIntervalMs = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private pollFailures = 0
  private openRequested = false
  /** Invalidates every in-flight call of a released page. */
  private generation = 0

  /**
   * @param options - the attempt operations, the open call, and the state sinks.
   */
  constructor(private readonly options: CodexOAuthLoginOptions) {}

  /**
   * Read the latest state published by this attempt.
   * @returns The current login state.
   */
  getState(): CodexOAuthLoginState {
    return this.state
  }

  /** Start one attempt here, and return once its first poll has answered. */
  async start(): Promise<void> {
    if (this.attempt !== undefined || this.state.kind === 'starting' || this.state.kind === 'pending') return
    const generation = ++this.generation
    this.openRequested = false
    this.pollFailures = 0
    this.setState({ kind: 'starting' })
    let begun: CodexOAuthBeginResult
    try {
      begun = await this.options.endpoint.begin()
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(failureCodeOf(error))
      return
    }
    if (generation !== this.generation) {
      void this.cancelOnHost({ attemptId: begun.attemptId, ownerToken: begun.ownerToken }, 'page-closed')
      return
    }
    this.attempt = { attemptId: begun.attemptId, ownerToken: begun.ownerToken }
    this.pollIntervalMs = begun.pollIntervalMs
    await this.poll()
  }

  /** Open the authorization page again because the user asked for it. */
  reopen(): void {
    const state = this.state
    if (state.kind !== 'pending' || state.authUrl === null) return
    const url = state.authUrl
    if (!isAllowedAuthorizationUrl(url)) {
      void this.cancel('browser-open-failed')
      return
    }
    try {
      this.options.open(url)
    } catch {
      void this.cancel('browser-open-failed')
    }
  }

  /**
   * Withdraw the attempt this page owns, reporting why. Never rejects.
   * @param reason - the reason to report to the Host and in the local state.
   * @returns A promise that settles after best-effort cancellation completes.
   */
  async cancel(reason: CodexOAuthClientCancelReason): Promise<void> {
    const generation = ++this.generation
    this.stopPolling()
    const attempt = this.attempt
    this.attempt = undefined
    this.openRequested = false
    if (attempt === undefined) {
      // Nothing this page owns: a settled attempt keeps the outcome the Host
      // reported, while a start still in flight becomes the cancellation asked for.
      if (this.state.kind === 'starting' || this.state.kind === 'pending') this.settle({ kind: 'cancelled', reason })
      return
    }
    try {
      const view = await this.options.endpoint.cancel({ ...attempt, reason })
      if (generation !== this.generation) return
      this.applyTerminal(view, attempt, reason)
    } catch (error) {
      if (generation !== this.generation) return
      this.fail(failureCodeOf(error))
    }
  }

  /**
   * Give up this page's ownership: stop polling and release the attempt. A
   * `begin` still in flight releases the identity it minted when it answers.
   */
  release(): void {
    this.generation += 1
    this.stopPolling()
    const attempt = this.attempt
    this.attempt = undefined
    this.openRequested = false
    if (attempt !== undefined) void this.cancelOnHost(attempt, 'page-closed')
    if (this.state.kind === 'starting' || this.state.kind === 'pending') this.setState({ kind: 'idle' })
  }

  /**
   * Return to idle from a settled state. The local record a completed attempt
   * described may be gone, so the card must not keep reporting that outcome.
   */
  reset(): void {
    if (this.state.kind === 'starting' || this.state.kind === 'pending') return
    this.setState({ kind: 'idle' })
  }

  private async poll(): Promise<void> {
    const attempt = this.attempt
    if (attempt === undefined) return
    const generation = this.generation
    let view: CodexOAuthAttemptView
    try {
      view = await this.options.endpoint.query(attempt)
    } catch (error) {
      if (generation !== this.generation) return
      const code = failureCodeOf(error)
      if (code !== 'transport-failed') {
        // The Host answered; only its answer's code matters, and a refused
        // attempt is terminal however many polls this page would have left.
        this.fail(code)
        return
      }
      this.pollFailures += 1
      if (this.pollFailures < MAX_POLL_FAILURES) {
        this.schedule()
        return
      }
      this.fail(code)
      return
    }
    if (generation !== this.generation) return
    this.pollFailures = 0
    this.applyPoll(view, attempt)
  }

  /** Project one poll answer, scheduling the next poll while the attempt stays pending. */
  private applyPoll(view: CodexOAuthAttemptView, attempt: CodexOAuthAttemptRequest): void {
    if (!this.answers(view, attempt)) return
    switch (view.state) {
      case 'initiating':
        if (view.authUrl !== null || view.cancelReason !== null || view.errorCode !== null) {
          this.fail('transport-failed')
          return
        }
        this.setState({ kind: 'pending', authUrl: null })
        this.schedule()
        return
      case 'waiting-browser': {
        const url = view.authUrl
        if (url === null) {
          this.fail('transport-failed')
          return
        }
        if (!isAllowedAuthorizationUrl(url)) {
          void this.cancel('browser-open-failed')
          return
        }
        this.waitForBrowser(url)
        return
      }
      default:
        this.applyTerminal(view, attempt, undefined)
    }
  }

  /**
   * Project a settled view of the attempt this page asked about.
   *
   * A view that still reports a pending attempt is answered with a failure:
   * this page holds no credential to poll it with, and the alternative —
   * re-opening the authorization page during a cancel — is the one thing a
   * cancel must not do.
   * @param view - the settled view.
   * @param attempt - the attempt this page asked about.
   * @param cancelledReason - reason the caller gave, when it was this page's cancel.
   */
  private applyTerminal(
    view: CodexOAuthAttemptView,
    attempt: CodexOAuthAttemptRequest,
    cancelledReason: CodexOAuthCancelReason | undefined,
  ): void {
    if (!this.answers(view, attempt)) return
    switch (view.state) {
      case 'authorized':
        this.settle({ kind: 'authorized' })
        return
      case 'cancelled': {
        const reason = view.cancelReason ?? cancelledReason ?? null
        if (reason === null) {
          this.fail('transport-failed')
          return
        }
        this.settle({ kind: 'cancelled', reason })
        return
      }
      case 'failed': {
        const code = view.errorCode
        if (code === null) {
          this.fail('transport-failed')
          return
        }
        this.settle({ kind: 'failed', code })
        return
      }
      default:
        this.fail('transport-failed')
    }
  }

  /** Whether an answer names the attempt this page asked about. */
  private answers(view: CodexOAuthAttemptView, attempt: CodexOAuthAttemptRequest): boolean {
    if (view.attemptId === attempt.attemptId) return true
    this.fail('transport-failed')
    return false
  }

  /** Show the official URL and open it once; later opens belong to the user. */
  private waitForBrowser(url: string): void {
    this.setState({ kind: 'pending', authUrl: url })
    if (!this.openRequested) {
      this.openRequested = true
      try {
        this.options.open(url)
      } catch {
        void this.cancel('browser-open-failed')
        return
      }
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.timer !== undefined || this.attempt === undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.poll()
    }, this.pollIntervalMs)
  }

  private stopPolling(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private settle(state: CodexOAuthLoginState): void {
    this.stopPolling()
    this.attempt = undefined
    this.openRequested = false
    this.setState(state)
    this.options.onSettled()
  }

  private fail(code: CodexOAuthErrorCode): void {
    this.settle({ kind: 'failed', code })
  }

  /** Release an attempt without owning its answer; the Host's own bounds are the fallback. */
  private async cancelOnHost(attempt: CodexOAuthAttemptRequest, reason: CodexOAuthClientCancelReason): Promise<void> {
    try {
      await this.options.endpoint.cancel({ ...attempt, reason })
    } catch {
      // Releasing is best-effort by design: an unknown identity on a restarted
      // Host is answered by the Host deadline, not by this page.
    }
  }

  private setState(state: CodexOAuthLoginState): void {
    if (sameState(this.state, state)) return
    this.state = state
    this.options.onChange(state)
  }
}

/** Whether two states are the same value, so a repeated poll does not churn the card. */
function sameState(left: CodexOAuthLoginState, right: CodexOAuthLoginState): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'pending':
      return right.kind === 'pending' && left.authUrl === right.authUrl
    case 'cancelled':
      return right.kind === 'cancelled' && left.reason === right.reason
    case 'failed':
      return right.kind === 'failed' && left.code === right.code
    default:
      return true
  }
}
