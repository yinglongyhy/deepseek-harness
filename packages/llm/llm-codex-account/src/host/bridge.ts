/**
 * The Host half of the `/codex-oauth` channel.
 *
 * One class answers every endpoint. `begin` starts the official flow in the
 * background and returns at once, so the starting call is never the thing that
 * waits on a browser; the flow's own notices and questions are reduced to two
 * facts — an authorization URL, and a login method — and never forwarded as
 * text. `query` and `cancel` require both halves of the attempt identity the
 * Host minted, and every bound (deadline, idle lease, retention) is enforced
 * without asking the page whether it is still there.
 *
 * Nothing here implements OAuth. The code exchange, the PKCE and state checks,
 * the callback listener, and the credential write all stay in the official
 * `llm-pi-ai` / pi-ai flow reached through `ctx.authorization`, and this bridge
 * never makes an outbound request of its own. Settling an attempt withdraws it,
 * so the seam observes a teardown — including the teardown of an attempt this
 * bridge diagnosed as incompatible, which is why the diagnosis is carried as a
 * code on this channel rather than as a thrown failure.
 *
 * The operations that change the record plane — `begin`, `logout`,
 * and `enable-route` — read state, await an official service, and
 * only then act, so each claims the instance exclusively before its first await
 * and releases it afterwards. Without that gate a logout that already checked
 * for a running login could delete the grant a login committed while the check
 * was awaiting. The claim is this plugin's own instance only: another process
 * reaching the official seam directly is outside what this bridge can serialize.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt, AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { ConnectionRpcHandler, ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  CODEX_CALLBACK_PORT,
  CODEX_OAUTH_PROTOCOL_VERSION,
  CODEX_OAUTH_SETTINGS_NAMESPACE,
  CODEX_PROVIDER_ID,
  isAllowedAuthorizationUrl,
  isTerminalAttemptState,
  parseCodexOAuthAttemptRequest,
  parseCodexOAuthBeginRequest,
  parseCodexOAuthCancelRequest,
  parseCodexOAuthEmptyRequest,
  parseCodexOAuthEnableRouteRequest,
  parseCodexOAuthOperation,
  type CodexOAuthAttemptRequest,
  type CodexOAuthAttemptView,
  type CodexOAuthBeginResult,
  type CodexOAuthCancelRequest,
  type CodexOAuthCapabilityGap,
  type CodexOAuthEnableRouteRequest,
  type CodexOAuthEnableRouteResult,
  type CodexOAuthErrorCode,
  type CodexOAuthLogoutResult,
  type CodexOAuthStatusResult,
  type CodexOAuthTuning,
} from '../shared/index.ts'
import { AttemptRegistry, type CodexOAuthAttemptRecord } from './attempts.ts'
import { callbackHostFrom, probeCallbackPort, type CallbackPortProbe } from './probe.ts'
import { codexBrowserMethodOf, isHiddenManualCodePrompt, withdrawablePrompt } from './interaction.ts'
import { routeEnableOps, routeFactsOf } from './route.ts'
import { CodexOAuthBridgeFailure } from './failure.ts'

/** The authorization method the official Codex flow offers first, and the one a browser login uses. */
const CODEX_OAUTH_METHOD = 'oauth'

/**
 * The one message every refusal carries. The code is the contract, the Client
 * localizes from it, and this text names no provider, URL, or credential.
 */
const REFUSAL_MESSAGE = 'the Codex sign-in request was refused'

/** The callback-port availability check the bridge runs before starting a flow. */
export type CallbackPortCheck = (host: string, port: number) => Promise<CallbackPortProbe>

/** What one bridge instance runs on. */
export interface CodexOAuthBridgeOptions {
  /** Validated deployment timing. */
  readonly tuning: CodexOAuthTuning
  /**
   * Callback-port check; a deployment omits it and gets the real loopback probe.
   * A test supplies its own so it never depends on whether the real callback
   * port happens to be free on the machine running it.
   */
  readonly probe?: CallbackPortCheck
}

/** The `/codex-oauth` endpoint set over the official services. */
export class CodexOAuthBridge {
  private readonly registry: AttemptRegistry
  private readonly credentialKey: ReturnType<typeof recordKeyFor>
  private readonly tuning: CodexOAuthTuning
  private readonly probe: CallbackPortCheck

  /** Whether this instance has been withdrawn, independently of its attempts. */
  private disposed = false

  /** Whether a record-plane operation holds the instance right now. */
  private claimed = false

  /**
   * @param ctx - the plugin context the official services are read from.
   * @param options - validated deployment timing and the callback-port check.
   */
  constructor(
    private readonly ctx: Context,
    options: CodexOAuthBridgeOptions,
  ) {
    this.tuning = options.tuning
    this.probe = options.probe ?? probeCallbackPort
    this.registry = new AttemptRegistry({
      tuning: options.tuning,
      onReleased: (record, reason) => {
        this.ctx.logger.warn(
          'codex-oauth: released a pending login attempt %s ms after it started (%s)',
          Date.now() - record.startedAt,
          reason,
        )
      },
    })
    this.credentialKey = recordKeyFor(CODEX_PROVIDER_ID)
  }

  /**
   * One channel call: validate the endpoint and its payload, then answer.
   *
   * Every failure leaves as a code from the fixed vocabulary. An unexpected
   * throw is caught here rather than escaping to the transport, whose generic
   * failure handler would render the thrown text into its response.
   */
  readonly handle: ConnectionRpcHandler = async (endpoint, payload) => {
    try {
      return await this.dispatch(endpoint, payload)
    } catch (error) {
      const code = error instanceof CodexOAuthBridgeFailure ? error.code : 'transport-failed'
      this.logRefusal(code, error)
      return this.refusal(code)
    }
  }

  /** Withdraw this bridge and every attempt it holds. The channel route itself is a plugin effect. */
  dispose(): void {
    this.disposed = true
    this.registry.dispose()
  }

  /** Refuse new mutations, including those resumed after an awaited read, once withdrawn. */
  private assertAlive(): void {
    if (this.disposed) {
      throw new CodexOAuthBridgeFailure('capability-unavailable', 'this Codex sign-in bridge was unloaded')
    }
  }

  private async dispatch(endpoint: string, payload: unknown): Promise<ConnectionRpcHandlerResult> {
    switch (parseCodexOAuthOperation(endpoint)) {
      case 'status': {
        const request = parseCodexOAuthEmptyRequest(payload)
        if (!request.ok) return this.refusal(request.code)
        return { ok: true, value: await this.status() }
      }
      case 'begin': {
        const request = parseCodexOAuthBeginRequest(payload)
        if (!request.ok) return this.refusal(request.code)
        return { ok: true, value: await this.exclusive('busy', () => this.begin()) }
      }
      case 'query': {
        const request = parseCodexOAuthAttemptRequest(payload)
        if (!request.ok) return this.refusal(request.code)
        return { ok: true, value: this.query(request.value) }
      }
      case 'cancel': {
        const request = parseCodexOAuthCancelRequest(payload)
        if (!request.ok) return this.refusal(request.code)
        return { ok: true, value: this.cancel(request.value) }
      }
      case 'logout': {
        const request = parseCodexOAuthEmptyRequest(payload)
        if (!request.ok) return this.refusal(request.code)
        return { ok: true, value: await this.exclusive('logout-blocked', () => this.logout()) }
      }
      case 'enable-route': {
        const request = parseCodexOAuthEnableRouteRequest(payload)
        if (!request.ok) return this.refusal(request.code)
        return { ok: true, value: await this.exclusive('busy', () => this.enableRoute(request.value)) }
      }
      default:
        return this.refusal('invalid-request')
    }
  }

  /**
   * Run one record-plane operation exclusively.
   *
   * The claim is taken before the operation's first await, and a second caller
   * is refused rather than queued: every operation here decides from state it
   * read before awaiting, so interleaving two of them is what would make one of
   * those reads stale.
   * @param onConflict - the refusal code this operation reports when the instance is taken.
   * @param operation - the operation to run while the claim is held.
   * @returns whatever the operation returned.
   */
  private async exclusive<T>(onConflict: CodexOAuthErrorCode, operation: () => Promise<T>): Promise<T> {
    this.assertAlive()
    if (this.claimed) {
      throw new CodexOAuthBridgeFailure(onConflict, 'another operation is changing the Codex record state')
    }
    this.claimed = true
    try {
      return await operation()
    } finally {
      this.claimed = false
    }
  }

  /** Official capability, credential presence, and route facts, safe to show any page. */
  private async status(): Promise<CodexOAuthStatusResult> {
    const credentials = this.ctx.get('credentials')
    const record = credentials === undefined ? undefined : await credentials.describeRecord(this.credentialKey)
    return {
      protocolVersion: CODEX_OAUTH_PROTOCOL_VERSION,
      capability: this.capability(),
      record: { stored: record?.configured === true },
      route: this.routeFacts(),
    }
  }

  /** Whether the official Codex login can run, and the first missing dependency when it cannot. */
  private capability(): CodexOAuthStatusResult['capability'] {
    const gap = this.capabilityGap()
    return { available: gap === null, gap }
  }

  /** The first missing dependency, in the order one login needs it. */
  private capabilityGap(): CodexOAuthCapabilityGap | null {
    if (this.ctx.get('connection') === undefined) return 'connection-unavailable'
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) return 'authorization-unavailable'
    if (authorization.describe(this.credentialKey) === undefined) return 'codex-flow-unavailable'
    if (this.ctx.get('credentials') === undefined) return 'credentials-unavailable'
    if (this.ctx.get('settings') === undefined) return 'settings-unavailable'
    return null
  }

  /** The route facts, or the shape that says the route cannot be read. */
  private routeFacts(): CodexOAuthStatusResult['route'] {
    const descriptor = this.routeDescriptor()
    if (descriptor === undefined) {
      return { configured: false, namespaceRevision: null }
    }
    return routeFactsOf(descriptor)
  }

  /**
   * The settings entry that owns the Codex route.
   *
   * The namespace is taken from the official configurable-provider directory,
   * because a deployment may address the adapter under an id of its own; the
   * documented default is the fallback when that directory is unavailable.
   */
  private routeDescriptor(): SettingsDescriptor | undefined {
    const settings = this.ctx.get('settings')
    if (settings === undefined) return undefined
    const ns = this.routeNamespace()
    return settings.describe().find((row: SettingsDescriptor) => row.ns === ns)
  }

  /** The namespace the official adapter files this route under, which is also the one its discovery serves. */
  private routeNamespace(): string {
    const directory = this.ctx.get('llm')?.listConfigurableProviders() ?? []
    return directory.find((candidate: LlmConfigurableProvider) => candidate.provider === CODEX_PROVIDER_ID)
      ?.settingsNs ?? CODEX_OAUTH_SETTINGS_NAMESPACE
  }

  /**
   * Start one official browser authorization.
   *
   * The call returns as soon as the attempt exists; the flow keeps running in
   * the background and is observed through `query` until one of its bounds
   * releases it. A callback port this machine cannot bind is refused before the
   * flow starts, because the official flow swallows that failure and would
   * otherwise wait forever for a callback that cannot arrive.
   */
  private async begin(): Promise<CodexOAuthBeginResult> {
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined || this.ctx.get('credentials') === undefined
      || authorization.describe(this.credentialKey) === undefined) {
      throw new CodexOAuthBridgeFailure(
        'capability-unavailable',
        'this composition offers no Codex authorization flow or no credential store',
      )
    }
    if (this.registry.active !== undefined || authorization.describe(this.credentialKey)?.inFlight === true) {
      throw new CodexOAuthBridgeFailure('busy', 'an authorization for the Codex record is already running')
    }
    await this.assertCallbackPort()
    const record = this.registry.begin()
    void this.runOfficialFlow(record, authorization)
    return {
      attemptId: record.attemptId,
      ownerToken: record.ownerToken,
      state: 'initiating',
      pollIntervalMs: this.tuning.pollIntervalMs,
    }
  }

  /**
   * Refuse a login whose callback cannot arrive.
   *
   * Two things are checked, and both must hold before the official flow starts.
   * The configured host has to be a loopback address at all — a deployment that
   * points the callback somewhere else is outside this local-desktop bridge, and
   * probing it would mean listening on that interface — and the loopback port
   * has to be bindable right now, because the official flow swallows a failed
   * `listen` and would wait forever for a callback nobody can deliver.
   */
  private async assertCallbackPort(): Promise<void> {
    const host = callbackHostFrom(process.env)
    if (await this.probe(host, CODEX_CALLBACK_PORT) === 'available') return
    throw new CodexOAuthBridgeFailure(
      'callback-port-unavailable',
      'the loopback callback this local-desktop bridge needs is not available (the configured host must be'
      + ' loopback and its port bindable)',
    )
  }

  /**
   * Drive the official flow and settle the attempt exactly once.
   *
   * The runner never rejects: whatever the flow throws is either a diagnosis
   * this bridge made or the official failure of that login, and both belong in
   * the attempt's own state.
   */
  private async runOfficialFlow(record: CodexOAuthAttemptRecord, authorization: AuthorizationService): Promise<void> {
    try {
      const outcome = await authorization.begin({
        key: this.credentialKey,
        method: CODEX_OAUTH_METHOD,
        signal: record.controller.signal,
        interaction: this.interactionFor(record),
      })
      if (outcome.status === 'authorized') this.registry.authorized(record)
      else this.registry.cancelled(record, 'user')
    } catch (error) {
      if (isTerminalAttemptState(record.state)) return
      const code = failureCodeOf(error)
      this.registry.failed(record, code)
      this.logRefusal(code, error)
    }
  }

  /** The surface one attempt talks to the human through. */
  private interactionFor(record: CodexOAuthAttemptRecord): AuthorizationInteraction {
    return {
      notify: (notice) => { this.onNotice(record, notice) },
      prompt: prompt => this.onPrompt(record, prompt),
    }
  }

  /**
   * Take the one thing a notice may carry across: a gate-approved authorization
   * URL for the page to open.
   *
   * The notice's message is deliberately dropped — it is provider text, and the
   * Client renders its own localized copy. A URL the gate refuses ends the
   * attempt: the bridge will not hand a page an address it cannot vouch for, and
   * an official flow that had no acceptable URL to offer cannot complete.
   */
  private onNotice(record: CodexOAuthAttemptRecord, notice: AuthorizationNotice): void {
    const url = notice.url
    if (url === undefined) return
    if (isAllowedAuthorizationUrl(url)) {
      if (record.authUrl === null) this.registry.waitForBrowser(record, url)
      return
    }
    if (record.state !== 'initiating') return
    this.registry.failed(record, 'login-failed')
    this.ctx.logger.warn('codex-oauth: the official flow offered an authorization URL this bridge does not accept')
  }

  /**
   * Answer, hold, or refuse one question from the official flow.
   *
   * A question that is neither the login-method choice nor the manual-code
   * prompt is reported as incompatible rather than guessed at, and the returned
   * rejection is what unwinds the flow.
   */
  private onPrompt(record: CodexOAuthAttemptRecord, prompt: AuthorizationPrompt): Promise<string> {
    if (isTerminalAttemptState(record.state)) {
      return Promise.reject(new DOMException('the Codex sign-in attempt is over', 'AbortError'))
    }
    const browserMethod = codexBrowserMethodOf(prompt)
    if (browserMethod !== undefined) return Promise.resolve(browserMethod)
    if (isHiddenManualCodePrompt(prompt)) return withdrawablePrompt(record.controller.signal, prompt.signal)
    this.registry.failed(record, 'login-method-unsupported')
    return Promise.reject(new CodexOAuthBridgeFailure(
      'login-method-unsupported',
      'the official Codex flow asked a question this browser-only bridge does not answer',
    ))
  }

  /** The current state of an attempt its owner asked about, renewing its lease. */
  private query(request: CodexOAuthAttemptRequest): CodexOAuthAttemptView {
    const record = this.owned(request)
    this.registry.touch(record)
    return this.registry.view(record)
  }

  /** Withdraw an attempt its owner no longer wants, reporting the caller's reason. */
  private cancel(request: CodexOAuthCancelRequest): CodexOAuthAttemptView {
    const record = this.owned(request)
    this.registry.cancelled(record, request.reason)
    return this.registry.view(record)
  }

  /**
   * Delete the local Codex record.
   *
   * Refused while an attempt is running anywhere in this composition: the
   * official flow commits a grant at the end of a run, so a delete racing that
   * commit would either remove the record the user just created or report a
   * login that no longer has one.
   */
  private async logout(): Promise<CodexOAuthLogoutResult> {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new CodexOAuthBridgeFailure('capability-unavailable', 'this composition mounts no credential store')
    }
    if (this.registry.active !== undefined || this.authorizationInFlight()) {
      throw new CodexOAuthBridgeFailure('logout-blocked', 'a login attempt is running, so the record must not be deleted')
    }
    const record = await credentials.describeRecord(this.credentialKey)
    this.assertAlive()
    if (!record.configured) return { removed: false }
    await credentials.deleteRecord(this.credentialKey)
    return { removed: true }
  }

  /** Make the existing `llm-pi-ai` route usable, without rewriting anything around it. */
  private async enableRoute(request: CodexOAuthEnableRouteRequest): Promise<CodexOAuthEnableRouteResult> {
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      throw new CodexOAuthBridgeFailure('capability-unavailable', 'this composition mounts no settings service')
    }
    if (this.registry.active !== undefined || this.authorizationInFlight()) {
      throw new CodexOAuthBridgeFailure('busy', 'a login attempt is running, so the route must not change under it')
    }
    const descriptor = this.routeDescriptor()
    if (descriptor === undefined) {
      throw new CodexOAuthBridgeFailure('capability-unavailable', 'the llm-pi-ai settings entry is not configurable')
    }
    const ops = routeEnableOps(descriptor)
    if (ops.length === 0) {
      if (!routeFactsOf(descriptor).configured) {
        throw new CodexOAuthBridgeFailure('route-write-failed', 'the existing provider setting cannot be replaced')
      }
      // Nothing to write, but the page's revision is still checked: an existing
      // route must not bypass the fence the write path enforces.
      if (descriptor.revision !== request.namespaceRevision) {
        throw new CodexOAuthBridgeFailure(
          'route-revision-conflict',
          'the llm-pi-ai section changed since this page read it',
        )
      }
      return { configured: true, namespaceRevision: descriptor.revision }
    }
    try {
      await settings.mutate(descriptor.ns, ops, request.namespaceRevision)
    } catch (error) {
      if (error instanceof SettingsConflictError) {
        throw new CodexOAuthBridgeFailure(
          'route-revision-conflict',
          'the llm-pi-ai section changed since this page read it',
        )
      }
      throw new CodexOAuthBridgeFailure('route-write-failed', 'the settings write was refused')
    }
    const after = settings.describe().find((row: SettingsDescriptor) => row.ns === descriptor.ns)
    if (after === undefined) {
      throw new CodexOAuthBridgeFailure('capability-unavailable', 'the llm-pi-ai settings entry disappeared while writing')
    }
    return { configured: true, namespaceRevision: after.revision }
  }

  /** The attempt a caller proved it owns, or the refusal that says why not. */
  private owned(request: CodexOAuthAttemptRequest): CodexOAuthAttemptRecord {
    const found = this.registry.lookup(request.attemptId)
    if (found === undefined) throw new CodexOAuthBridgeFailure('attempt-unknown', 'no such attempt')
    if (found.kind === 'retired') {
      // A retired attempt is answered to its owner alone: whether an identity
      // exists at all is itself not something a stranger on this channel learns.
      if (!this.registry.ownsRetired(request.attemptId, request.ownerToken)) {
        throw new CodexOAuthBridgeFailure('attempt-forbidden', 'the attempt belongs to another page')
      }
      throw new CodexOAuthBridgeFailure('attempt-expired', 'the attempt was retired')
    }
    if (!this.registry.owns(found.record, request.ownerToken)) {
      throw new CodexOAuthBridgeFailure('attempt-forbidden', 'the attempt belongs to another page')
    }
    return found.record
  }

  private authorizationInFlight(): boolean {
    return this.ctx.get('authorization')?.describe(this.credentialKey)?.inFlight === true
  }

  private refusal(code: CodexOAuthErrorCode): ConnectionRpcHandlerResult {
    return { ok: false, error: { code, message: REFUSAL_MESSAGE, details: {} } }
  }

  /**
   * Report a refusal without the refused text.
   *
   * This bridge's own diagnostics are safe by construction and are logged as
   * written. Everything else is logged as the stable code alone: a caught error
   * is provider-shaped, and even its `name` is text this bridge did not write —
   * a thumbprint of the refusal is worth less than the chance of putting a token
   * in a log.
   */
  private logRefusal(code: CodexOAuthErrorCode, error: unknown): void {
    if (error instanceof CodexOAuthBridgeFailure) {
      this.ctx.logger.warn('codex-oauth: %s — %s', code, error.message)
      return
    }
    this.ctx.logger.warn('codex-oauth: %s', code)
  }
}

/** Map one thrown value onto the safe code this channel reports. */
function failureCodeOf(error: unknown): CodexOAuthErrorCode {
  if (error instanceof CodexOAuthBridgeFailure) return error.code
  const code: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined
  if (code === 'ALREADY_IN_FLIGHT') return 'busy'
  if (code === 'NO_FLOW') return 'capability-unavailable'
  if (code === 'UNKNOWN_METHOD') return 'login-method-unsupported'
  return 'login-failed'
}
