/**
 * The Codex provider card's state.
 *
 * Everything the card shows is an official fact read from the Host: capability
 * and record presence from `status`, the route facts from the same answer, and
 * the login attempt from its own poll. Nothing here infers OAuth state from the
 * page's API-key join, and nothing here writes a model configuration the user
 * did not explicitly ask for.
 *
 * Two lifetimes are kept apart. Occurrences of the card are reference-counted,
 * so the first one to unmount cannot cancel an attempt a still-mounted one is
 * waiting on. The page lifetime is a generation that every answer must still
 * match: an unmount, a re-establishment, or the plugin's own disposal drops the
 * answers and reads in flight, so a late reply can neither publish into a newer
 * mount nor start a request for a page that is gone.
 *
 * The snapshot is replaced only when something changed, so the React binding can
 * read it through `useSyncExternalStore` without churning.
 */

import type { CodexOAuthCapabilityGap, CodexOAuthErrorCode, CodexOAuthStatusResult } from '../shared/index.ts'
import { failureCodeOf, type CodexOAuthEndpoint } from './channel.ts'
import { CodexOAuthLogin, type CodexOAuthLoginState } from './login.ts'

/** The route facts of one `status` answer. */
export type CodexOAuthRouteFacts = CodexOAuthStatusResult['route']

/** The official facts the card renders, or why they could not be read. */
export type CodexOAuthStatusState =
  | { readonly kind: 'loading' }
  | {
    readonly kind: 'ready'
    readonly available: boolean
    /** The first missing official dependency, or null when every one is present. */
    readonly gap: CodexOAuthCapabilityGap | null
    /** Whether the official credential record exists. Presence only, never a claim that the account works. */
    readonly recordStored: boolean
    readonly route: CodexOAuthRouteFacts
  }
  | { readonly kind: 'failed'; readonly code: CodexOAuthErrorCode }

/** Progress or failure for a route write initiated by this page. */
export type CodexOAuthRouteActionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'writing' }
  | { readonly kind: 'failed'; readonly code: CodexOAuthErrorCode }

/** The local sign-out's own progress. */
export type CodexOAuthLogoutState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirming' }
  | { readonly kind: 'running' }
  | { readonly kind: 'removed' }
  | { readonly kind: 'failed'; readonly code: CodexOAuthErrorCode }

/** Everything the card renders. */
export interface CodexOAuthCardSnapshot {
  readonly status: CodexOAuthStatusState
  readonly login: CodexOAuthLoginState
  readonly route: CodexOAuthRouteActionState
  readonly logout: CodexOAuthLogoutState
  readonly catalogSaving: boolean
  readonly catalogVersion: number
}

/** What one card instance runs on. */
export interface CodexOAuthCardOptions {
  /** The `/codex-oauth` endpoint set. */
  readonly endpoint: CodexOAuthEndpoint
  /** Hands an accepted authorization URL to the desktop shell. */
  readonly open: (url: string) => void
}

const INITIAL: CodexOAuthCardSnapshot = {
  status: { kind: 'loading' },
  login: { kind: 'idle' },
  route: { kind: 'idle' },
  logout: { kind: 'idle' },
  catalogSaving: false,
  catalogVersion: 0,
}

/**
 * The one login attempt of this page the automatic route enable may still belong
 * to.
 *
 * The flag is what keeps the enable to the page's own new login: a mount, a
 * refresh, or a reconnect can show an already-stored record, and an old
 * presence is not a validity claim, so neither may write. A cancel request ends
 * the attempt's claim even when the official flow committed anyway.
 */
interface CodexOAuthAutoEnable {
  /** Whether the one automatic write of this attempt already happened. */
  enabled: boolean
  /** Whether the user asked to cancel this attempt, whatever it settles as. */
  cancelling: boolean
}

/** The card controller behind the `settings.section` entry. */
export class CodexOAuthCard {
  private readonly listeners = new Set<() => void>()
  private readonly login: CodexOAuthLogin
  private snapshot: CodexOAuthCardSnapshot = INITIAL
  /** The attempt the automatic route enable may still belong to, if this page started one. */
  private auto: CodexOAuthAutoEnable | undefined
  /** The model save this page has in flight, so a route write is ordered after it rather than raced. */
  private modelWrite: Promise<void> | undefined
  /** Latest status read wins, so a stale answer never overwrites a newer one. */
  private statusGeneration = 0
  /** Invalidates every in-flight answer of a page that mounted, unmounted, or was disposed. */
  private lifecycle = 0
  /** Mounted occurrences of this card. */
  private mounted = 0
  /** Whether the plugin unloaded this controller for good. */
  private released = false

  /**
   * @param options - the channel endpoints and the browser-open call.
   */
  constructor(private readonly options: CodexOAuthCardOptions) {
    this.login = new CodexOAuthLogin({
      endpoint: options.endpoint,
      open: options.open,
      onChange: (login) => {
        // A new attempt is the only thing that arms the automatic route enable again.
        if (login.kind === 'starting') this.auto = { enabled: false, cancelling: false }
        this.publish({ login })
      },
      onSettled: () => { void this.settleLogin() },
    })

  }

  /** Subscribe to snapshot replacements. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The current snapshot; the same reference until something changes. */
  readonly getSnapshot = (): CodexOAuthCardSnapshot => this.snapshot

  /**
   * One occurrence mounted. Only the first one opens a page lifetime: a second
   * occurrence of the same card must not invalidate the calls the occurrence
   * already on screen is still waiting for.
   */
  attach(): void {
    if (this.released) return
    this.mounted += 1
    if (this.mounted > 1) return
    this.lifecycle += 1
    void this.readStatus()
    // The catalog is read beside the status and not through it: the installed
    // models this route offers are a fact of the deployment, so a page whose
    // login is still pending shows them all the same.
  }

  /**
   * One occurrence unmounted. The attempt is released by the last one to leave,
   * which is what keeps a second mounted card's login alive, and the decisions
   * that lifetime left in flight are dropped with it.
   */
  detach(): void {
    if (this.mounted === 0) return
    this.mounted -= 1
    if (this.mounted > 0) return
    this.lifecycle += 1
    this.login.release()
    this.resetDecisions()
    this.modelWrite = undefined
  }

  /** The plugin unloaded: release the page and drop every listener. */
  dispose(): void {
    this.released = true
    this.mounted = 0
    this.lifecycle += 1
    this.auto = undefined
    this.login.release()
    this.listeners.clear()
  }

  /**
   * The connection was re-established, possibly against a restarted Host.
   *
   * The attempt identity of the previous Host cannot be polled or reused, so it
   * is dropped and released best-effort — an unknown identity on the new Host
   * is answered with silence, never with a failure this page would report — and
   * the official facts are read again.
   */
  reconnect(): void {
    if (this.released) return
    this.lifecycle += 1
    this.auto = undefined
    this.login.release()
    this.login.reset()
    this.resetDecisions()
    this.modelWrite = undefined
    this.loadStatus()
  }

  /**
   * Refresh official account facts and the catalog revision.
   * @returns Nothing; the read continues asynchronously.
   */
  readonly loadStatus = (): void => {
    this.publish({ catalogVersion: this.snapshot.catalogVersion + 1 })
    void this.readStatus()
  }

  /**
   * Start a login attempt; any outcome is published through the snapshot.
   * @returns Nothing; the attempt continues asynchronously.
   */
  readonly startLogin = (): void => {
    if (this.released) return
    void this.login.start()
  }

  /**
   * Cancel the current attempt as a user request; any eventual Host result is published.
   * @returns Nothing; cancellation continues asynchronously.
   */
  readonly cancelLogin = (): void => {
    if (this.released) return
    if (this.auto !== undefined) this.auto.cancelling = true
    void this.login.cancel('user')
  }

  /**
   * Reopen the current attempt's validated authorization URL on explicit user action.
   * @returns Nothing; a refusal is published in the login snapshot.
   */
  readonly reopenAuthorization = (): void => {
    if (this.released) return
    this.login.reopen()
  }

  /**
   * Serialize one catalog save against automatic route enable.
   * @param write - the catalog operation to run.
   * @returns The operation's result; rejects if another save or route write is active.
   */
  async writeCatalog<T>(write: () => Promise<T>): Promise<T> {
    if (this.released || this.snapshot.catalogSaving || this.snapshot.route.kind === 'writing') {
      throw new Error('A settings write is already in progress.')
    }
    const lifecycle = this.lifecycle
    this.publish({ catalogSaving: true })
    const pending = Promise.resolve().then(write)
    const settled = pending.then(() => {}, () => {})
    this.modelWrite = settled
    try {
      return await pending
    } finally {
      if (this.modelWrite === settled) this.modelWrite = undefined
      if (lifecycle === this.lifecycle) this.publish({ catalogSaving: false })
    }
  }

  /**
   * Retry a failed automatic route write after an explicit user action.
   * @returns Nothing; the retry continues asynchronously.
   */
  readonly retryRouteWrite = (): void => {
    if (this.snapshot.route.kind === 'failed') void this.retryRoute()
  }

  /**
   * Open the confirmation state without changing the stored credential.
   * @returns Nothing.
   */
  readonly requestLogout = (): void => {
    this.publish({ logout: { kind: 'confirming' } })
  }

  /**
   * Dismiss the confirmation without changing the stored credential.
   * @returns Nothing.
   */
  readonly dismissLogout = (): void => {
    this.publish({ logout: { kind: 'idle' } })
  }

  /**
   * Confirm deletion of the local credential record.
   * @returns Nothing; the Host request continues asynchronously.
   */
  readonly confirmLogout = (): void => {
    void this.writeLogout()
  }

  private async readStatus(): Promise<void> {
    await this.readStatusAnswer()
  }

  /** One status read, reporting the answer it published so a caller may act on the same facts. */
  private async readStatusAnswer(): Promise<CodexOAuthStatusResult | undefined> {
    if (this.released) return undefined
    const generation = ++this.statusGeneration
    const lifecycle = this.lifecycle
    // Facts already on screen stay there while they are reread: blanking the
    // card for the duration of its own refresh would take the model panel and
    // every decision surface down with it.
    if (this.snapshot.status.kind !== 'ready') this.publish({ status: { kind: 'loading' } })
    let result: CodexOAuthStatusResult
    try {
      result = await this.options.endpoint.status()
    } catch (error) {
      if (!this.current(generation, lifecycle)) return undefined
      this.publish({ status: { kind: 'failed', code: failureCodeOf(error) } })
      return undefined
    }
    if (!this.current(generation, lifecycle)) return undefined
    this.publish({
      status: {
        kind: 'ready',
        available: result.capability.available,
        gap: result.capability.gap,
        recordStored: result.record.stored,
        route: result.route,
      },
    })
    return result
  }

  /**
   * Report one settled attempt, and enable the route for this page's own
   * successful login.
   *
   * The official facts are reread whatever the attempt settled as, because a
   * cancelled or failed attempt can still have left a committed record behind.
   * Only an `authorized` settlement arms the write, and only once per attempt:
   * a record this page did not just earn is a presence, never a validity claim.
   */
  private async settleLogin(): Promise<void> {
    const settled = this.login.getState()
    const auto = this.auto
    const enable = settled.kind === 'authorized' && auto !== undefined && !auto.enabled && !auto.cancelling
    if (auto !== undefined && enable) {
      auto.enabled = true
      await this.writeRoute(auto)
    } else {
      await this.readStatus()
    }
  }

  private async retryRoute(): Promise<void> {
    await this.writeRoute()
  }

  private async writeRoute(auto?: CodexOAuthAutoEnable): Promise<void> {
    if (this.released || this.snapshot.route.kind === 'writing') return
    const lifecycle = this.lifecycle
    this.publish({ route: { kind: 'writing' } })
    try {
      await this.modelWrite
      if (!this.live(lifecycle)) return
      if (auto !== undefined && (this.auto !== auto || auto.cancelling)) {
        this.publish({ route: { kind: 'idle' } })
        return
      }
      const answer = await this.options.endpoint.status()
      if (!this.live(lifecycle)) return
      if (auto !== undefined && (this.auto !== auto || auto.cancelling)) {
        this.publish({ route: { kind: 'idle' } })
        return
      }
      if (answer.route.namespaceRevision === null) {
        this.publish({ route: { kind: 'failed', code: 'capability-unavailable' } })
        return
      }
      if (!answer.route.configured) {
        await this.options.endpoint.enableRoute({ namespaceRevision: answer.route.namespaceRevision })
      }
    } catch (error) {
      if (lifecycle !== this.lifecycle) return
      this.publish({ route: { kind: 'failed', code: failureCodeOf(error) } })
      await this.readStatus()
      return
    }
    if (lifecycle !== this.lifecycle) return
    this.publish({ route: { kind: 'idle' } })
    this.loadStatus()
  }

  /** Delete the local record, only ever as the user's own explicit action. */
  private async writeLogout(): Promise<void> {
    if (this.released) return
    const lifecycle = this.lifecycle
    this.publish({ logout: { kind: 'running' } })
    let removed: boolean
    try {
      const answer = await this.options.endpoint.logout()
      removed = answer.removed
    } catch (error) {
      if (lifecycle !== this.lifecycle) return
      this.publish({ logout: { kind: 'failed', code: failureCodeOf(error) } })
      return
    }
    if (lifecycle !== this.lifecycle) return
    this.login.reset()
    this.publish({ logout: removed ? { kind: 'removed' } : { kind: 'idle' } })
    await this.readStatus()
  }

  /** Whether a write operation still belongs to the mounted page lifetime. */
  private live(lifecycle: number): boolean {
    return !this.released && lifecycle === this.lifecycle
  }

  /** Whether a read of this page lifetime may still publish. */
  private current(generation: number, lifecycle: number): boolean {
    return !this.released && generation === this.statusGeneration && lifecycle === this.lifecycle
  }

  /**
   * Return the decision surfaces a page lifetime left in flight to idle.
   *
   * A stale lifetime drops its own answers, so a decision that was still
   * `writing` or `running` when the page went away would otherwise stay on
   * screen as a card that is busy forever, and a stale confirmation would keep
   * asking a question about facts nobody read.
   */
  private resetDecisions(): void {
    const { route, logout } = this.snapshot
    const routeInFlight = route.kind === 'writing'
    const logoutInFlight = logout.kind === 'running' || logout.kind === 'confirming'
    if (!routeInFlight && !logoutInFlight && !this.snapshot.catalogSaving) return
    this.publish({
      catalogSaving: false,
      route: routeInFlight ? { kind: 'idle' } : route,
      logout: logoutInFlight ? { kind: 'idle' } : logout,
    })
  }

  private publish(patch: Partial<CodexOAuthCardSnapshot>): void {
    if (this.released) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}
