/**
 * Fakes for the client phase: the `/codex-oauth` endpoints, the desktop
 * browser-open call, and the page's own control of time.
 *
 * Nothing here reaches a Host, a browser, or a real credential store. Each fake
 * answers the way the committed Host contract says its endpoint does, so a test
 * can assert on this half's behavior rather than on a transport's.
 *
 * The installed `SlotRegistry` and `LocaleRuntime` are used as they are by
 * `plugin.test.ts`: registration is checked against the real ledger, not
 * against a stand-in. The client bundle itself imports no DSH runtime value.
 */

import {
  CODEX_AUTHORIZATION_ORIGIN,
  CODEX_AUTHORIZATION_PATH,
  CODEX_AUTHORIZATION_REDIRECT_URI,
  CODEX_OAUTH_CHANNEL,
  CODEX_OAUTH_PROTOCOL_VERSION,
  type CodexOAuthAttemptRequest,
  type CodexOAuthAttemptView,
  type CodexOAuthBeginResult,
  type CodexOAuthCancelReason,
  type CodexOAuthCancelRequest,
  type CodexOAuthCapabilityGap,
  type CodexOAuthEnableRouteRequest,
  type CodexOAuthEnableRouteResult,
  type CodexOAuthErrorCode,
  type CodexOAuthLogoutResult,
  type CodexOAuthStatusResult,
} from '../../src/shared/index.ts'
import { codexOAuthAttemptId, codexOAuthOwnerToken } from '../../src/shared/identities.ts'
import { nativeSchema } from './native-seams.client.ts'
import { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CodexOAuthClientFailure, type CodexOAuthEndpoint } from '../../src/client/channel.ts'
import { CODEX_OAUTH_LOCALE_NAMESPACE, en, zh } from '../../src/client/locales.ts'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const STATE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

/** Identity the wire accepts as both halves of an attempt credential. */
export const CODEX_ATTEMPT_ID = codexOAuthAttemptId('attempt-identity-0001')
export const CODEX_OWNER_TOKEN = codexOAuthOwnerToken('owner-token-0000000001')

/** A second identity, for answers that must be recognized as belonging to some other attempt. */
export const CODEX_ATTEMPT_ID_2 = codexOAuthAttemptId('attempt-identity-0002')
export const CODEX_OWNER_TOKEN_2 = codexOAuthOwnerToken('owner-token-0000000002')

/** Poll cadence the Host returns; also the interval a test advances its clock by. */
export const POLL_INTERVAL_MS = 500

/**
 * The authorization request the installed official flow builds.
 * @param mutate - field-level mutation applied to the official request.
 * @returns the authorization URL string.
 */
export function officialAuthorizeUrl(mutate: (url: URL) => void = () => {}): string {
  const url = new URL(`${CODEX_AUTHORIZATION_ORIGIN}${CODEX_AUTHORIZATION_PATH}`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', CODEX_AUTHORIZATION_REDIRECT_URI)
  url.searchParams.set('scope', 'openid profile email offline_access')
  url.searchParams.set('code_challenge', CODE_CHALLENGE)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', STATE)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', 'pi')
  mutate(url)
  return url.toString()
}

/** Route and record facts one `status` answer reports. */
export interface StatusFacts {
  available?: boolean
  gap?: CodexOAuthCapabilityGap | null
  stored?: boolean
  configured?: boolean
  namespaceRevision?: number | null
}

/**
 * One `status` answer.
 * @param facts - the facts this answer reports, defaulting to a usable, unconfigured-OAuth instance.
 * @returns the status result.
 */
export function statusFixture(facts: StatusFacts = {}): CodexOAuthStatusResult {
  return {
    protocolVersion: CODEX_OAUTH_PROTOCOL_VERSION,
    capability: { available: facts.available ?? true, gap: facts.gap ?? null },
    record: { stored: facts.stored ?? false },
    route: {
      configured: facts.configured ?? true,
      namespaceRevision: facts.namespaceRevision === undefined ? 7 : facts.namespaceRevision,
    },
  }
}

/** One `begin` answer. */
export function beginFixture(pollIntervalMs: number = POLL_INTERVAL_MS): CodexOAuthBeginResult {
  return {
    attemptId: CODEX_ATTEMPT_ID,
    ownerToken: CODEX_OWNER_TOKEN,
    state: 'initiating',
    pollIntervalMs,
  }
}

export function initiatingView(): CodexOAuthAttemptView {
  return { attemptId: CODEX_ATTEMPT_ID, state: 'initiating', authUrl: null, cancelReason: null, errorCode: null }
}

export function waitingView(authUrl: string): CodexOAuthAttemptView {
  return { attemptId: CODEX_ATTEMPT_ID, state: 'waiting-browser', authUrl, cancelReason: null, errorCode: null }
}

export function authorizedView(): CodexOAuthAttemptView {
  return { attemptId: CODEX_ATTEMPT_ID, state: 'authorized', authUrl: null, cancelReason: null, errorCode: null }
}

export function cancelledView(reason: CodexOAuthCancelReason): CodexOAuthAttemptView {
  return { attemptId: CODEX_ATTEMPT_ID, state: 'cancelled', authUrl: null, cancelReason: reason, errorCode: null }
}

export function failedView(code: CodexOAuthErrorCode): CodexOAuthAttemptView {
  return { attemptId: CODEX_ATTEMPT_ID, state: 'failed', authUrl: null, cancelReason: null, errorCode: code }
}

/** One endpoint answer: a value, or the safe code the channel would refuse with. */
export type FakeAnswer<T> = { readonly value: T } | { readonly failure: CodexOAuthErrorCode }

/** A scripted answer, immediate or settled later by the test. */
export type Maybe<T> = T | Promise<T>

/** Unwrap one answer the way the channel does. */
export function unwrap<T>(answer: FakeAnswer<T>): T {
  if ('failure' in answer) throw new CodexOAuthClientFailure(answer.failure)
  return answer.value
}

/**
 * The `/codex-oauth` endpoints as a scripted stand-in, recording every call.
 *
 * A scripted answer function receives the request and the call's ordinal, so a
 * test can make the first poll report one thing and the next another without
 * inventing a scheduler.
 */
export class FakeCodexOAuthEndpoint implements CodexOAuthEndpoint {
  readonly calls: Array<{ readonly endpoint: string; readonly payload: unknown }> = []
  statusAnswer: () => Maybe<FakeAnswer<CodexOAuthStatusResult>> = () => ({ value: statusFixture() })
  beginAnswer: () => Maybe<FakeAnswer<CodexOAuthBeginResult>> = () => ({ value: beginFixture() })
  queryAnswer: (request: CodexOAuthAttemptRequest, ordinal: number) => Maybe<FakeAnswer<CodexOAuthAttemptView>> = () => ({
    value: initiatingView(),
  })
  cancelAnswer: (request: CodexOAuthCancelRequest) => Maybe<FakeAnswer<CodexOAuthAttemptView>> = request => ({
    value: cancelledView(request.reason),
  })
  logoutAnswer: () => Maybe<FakeAnswer<CodexOAuthLogoutResult>> = () => ({ value: { removed: true } })
  enableRouteAnswer: (request: CodexOAuthEnableRouteRequest) => Maybe<FakeAnswer<CodexOAuthEnableRouteResult>> = request => ({
    value: { configured: true, namespaceRevision: request.namespaceRevision + 1 },
  })
  /** How many `query` calls were made, which is what a poll-cadence test counts. */
  get queries(): number {
    return this.calls.filter(call => call.endpoint === 'query').length
  }

  async status(): Promise<CodexOAuthStatusResult> {
    this.calls.push({ endpoint: 'status', payload: {} })
    return unwrap(await this.statusAnswer())
  }

  async begin(): Promise<CodexOAuthBeginResult> {
    this.calls.push({ endpoint: 'begin', payload: {} })
    return unwrap(await this.beginAnswer())
  }

  async query(request: CodexOAuthAttemptRequest): Promise<CodexOAuthAttemptView> {
    const ordinal = this.queries
    this.calls.push({ endpoint: 'query', payload: request })
    return unwrap(await this.queryAnswer(request, ordinal))
  }

  async cancel(request: CodexOAuthCancelRequest): Promise<CodexOAuthAttemptView> {
    this.calls.push({ endpoint: 'cancel', payload: request })
    return unwrap(await this.cancelAnswer(request))
  }

  async logout(): Promise<CodexOAuthLogoutResult> {
    this.calls.push({ endpoint: 'logout', payload: {} })
    return unwrap(await this.logoutAnswer())
  }

  async enableRoute(request: CodexOAuthEnableRouteRequest): Promise<CodexOAuthEnableRouteResult> {
    this.calls.push({ endpoint: 'enable-route', payload: request })
    return unwrap(await this.enableRouteAnswer(request))
  }


}

/** The browser-open call as a recorder. `null` is the desktop shell's normal answer, not a failure. */
export class FakeOpener {
  readonly urls: string[] = []
  /** Set to make the open call throw, which is the only reportable open failure. */
  fails = false

  readonly open = (url: string): null => {
    this.urls.push(url)
    if (this.fails) throw new Error('the desktop shell refused this open')
    return null
  }
}

/** A promise a test settles by hand. */
export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

/**
 * One externally settled promise.
 * @returns the promise and its settlement handles.
 */
export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Let every already-resolved promise continuation run. */
export async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** The registration options one settings.section entry carries. */
export interface SlotRegistration {
  readonly name: string
  readonly id: string
  readonly order?: number
  readonly label?: string | (() => string)
  readonly locale?: string
  readonly inject?: (sessionId: never) => object
}

/** The slot registry as the plugin uses it: it records the injection and the registration. */
export class FakeSlotRegistry {
  readonly injected: string[] = []
  readonly registrations: Array<{ readonly options: SlotRegistration; readonly component: unknown }> = []
  private readonly declarations = new Set<string>()
  private readonly waits = new Map<string, Set<{ start: () => void; stop: () => void }>>()

  declare(key: string): () => void {
    if (this.declarations.has(key)) throw new Error(`already declared: ${key}`)
    this.declarations.add(key)
    for (const wait of this.waits.get(key) ?? []) wait.start()
    return () => {
      if (!this.declarations.delete(key)) return
      for (const wait of this.waits.get(key) ?? []) wait.stop()
    }
  }

  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void {
    this.injected.push(key)
    let disposers: Array<() => void> | undefined
    const wait = {
      start: () => {
        if (disposers !== undefined) return
        const effect = callback()
        disposers = typeof effect === 'function' ? [effect] : [...effect]
      },
      stop: () => {
        for (const dispose of [...disposers ?? []].reverse()) dispose()
        disposers = undefined
      },
    }
    const waits = this.waits.get(key) ?? new Set()
    waits.add(wait)
    this.waits.set(key, waits)
    if (this.declarations.has(key)) wait.start()
    return () => { wait.stop(); waits.delete(wait) }
  }

  register(options: SlotRegistration, component: unknown): () => void {
    if (!this.declarations.has(options.name)) throw new Error(`not declared: ${options.name}`)
    const entry = { options, component }
    this.registrations.push(entry)
    return () => {
      const index = this.registrations.indexOf(entry)
      if (index >= 0) this.registrations.splice(index, 1)
    }
  }

  /** The component the plugin registered, or undefined while it registered none. */
  get component(): unknown {
    return this.registrations[0]?.component
  }
}

/** The locale service as the plugin uses it: a namespace with its dictionaries. */
export class FakeLocaleService {
  readonly registered: Array<{ readonly ns: string; readonly dicts: Record<string, Record<string, string>> }> = []
  private snapshot = { active: 'zh', revision: 0 }
  private readonly listeners = new Set<() => void>()
  private readonly bound = new Map<string, (key: string, params?: Record<string, unknown>) => string>()

  get active(): string { return this.snapshot.active }
  set active(active: string) {
    if (active === this.snapshot.active) return
    this.publish(active)
  }
  readonly getLocale = () => this.snapshot
  readonly getSnapshot = () => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(active = this.snapshot.active): void {
    this.snapshot = { active, revision: this.snapshot.revision + 1 }
    for (const listener of this.listeners) listener()
  }

  register(ns: string, dicts: Record<string, Record<string, string>>): () => void {
    const entry = { ns, dicts }
    this.registered.push(entry)
    this.publish()
    return () => {
      const index = this.registered.indexOf(entry)
      if (index >= 0) { this.registered.splice(index, 1); this.publish() }
    }
  }

  /**
   * Bind one namespace to a translate over its registered dictionary.
   * @param ns - dictionary namespace.
   * @returns a function stable per namespace, reading the dictionary at call time.
   */
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string {
    let translate = this.bound.get(ns)
    if (translate === undefined) {
      translate = (key, params) => interpolate(this.registered.find(entry => entry.ns === ns)?.dicts[this.active]?.[key] ?? key, params)
      this.bound.set(ns, translate)
    }
    return translate
  }
}

/**
 * The page's RPC caller over a scripted endpoint, framed the way the Host frames
 * its answers: a refusal carries one safe code and a fixed message.
 */
export class FakePageRpc implements ClientConnectionRpc {
  readonly calls: Array<{ readonly channel: string; readonly endpoint: string; readonly payload: unknown }> = []
  readonly server = new FakeCodexOAuthEndpoint()

  async call(channel: string, endpoint: string, payload: unknown): Promise<ConnectionRpcResult<unknown>> {
    this.calls.push({ channel, endpoint, payload })
    if (channel !== CODEX_OAUTH_CHANNEL) {
      return { ok: false, error: { code: 'invalid-request', message: 'the request was refused', details: {} } }
    }
    try {
      return { ok: true, value: await this.answer(endpoint, payload) }
    } catch (error) {
      const code = error instanceof CodexOAuthClientFailure ? error.code : 'transport-failed'
      return { ok: false, error: { code, message: 'the request was refused', details: {} } }
    }
  }

  private answer(endpoint: string, payload: unknown): Promise<unknown> {
    switch (endpoint) {
      case 'status':
        return this.server.status()
      case 'begin':
        return this.server.begin()
      case 'query':
        return this.server.query(payload as CodexOAuthAttemptRequest)
      case 'cancel':
        return this.server.cancel(payload as CodexOAuthCancelRequest)
      case 'logout':
        return this.server.logout()
      case 'enable-route':
        return this.server.enableRoute(payload as CodexOAuthEnableRouteRequest)
      default:
        throw new CodexOAuthClientFailure('invalid-request')
    }
  }
}

/** The three services the client half reads, over a real cordis context. */
export interface ClientBench {
  readonly ctx: Context
  readonly slots: FakeSlotRegistry
  readonly locale: FakeLocaleService
  readonly rpc: FakePageRpc
}

/**
 * A client context whose three required services are the fakes above.
 * @returns the context and its services.
 */
export function clientBench(): ClientBench {
  const ctx = new Context()
  const slots = new FakeSlotRegistry()
  slots.declare('settings.section')
  slots.declare('conversation.composer.dock')
  const locale = new FakeLocaleService()
  const rpc = new FakePageRpc()
  nativeSchema(ctx)
  ctx.provide('remote.llm', {} as never)
  ctx.provide('remote.settings', {} as never)
  ctx.provide('connection', { rpc } as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  return { ctx, slots, locale, rpc }
}

/**
 * Bind this plugin's dictionaries the way the page's locale service binds them.
 * @param id - dictionary to translate with.
 * @returns a translate function over that dictionary, showing the key when it is missing.
 */
export function translate(id: 'zh' | 'en'): TranslateNS<typeof CODEX_OAUTH_LOCALE_NAMESPACE> {
  const dict: Record<string, string> = id === 'zh' ? zh : en
  return (key: string, params?: Record<string, unknown>) => interpolate(dict[key] ?? key, params)
}

function interpolate(text: string, params?: Record<string, unknown>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params?.[key]
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value) : match
  })
}
