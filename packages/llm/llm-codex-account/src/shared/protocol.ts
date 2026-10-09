/**
 * Fixed wire vocabulary of the Codex OAuth login bridge.
 *
 * Both faces bundle this module verbatim, so it stays browser safe: plain
 * values and platform globals only, with no Node builtin and no DSH runtime
 * import. A DSH value import here would either inline a second runtime
 * identity or request a module-table row this bundle does not declare.
 */

/** Version of the `/codex-oauth` wire contract. */
export const CODEX_OAUTH_PROTOCOL_VERSION = 2

/** Independent RPC channel of this bundle. The reserved shared `/api` channel is never used. */
export const CODEX_OAUTH_CHANNEL = '/codex-oauth'

/** The only provider this bridge serves. */
export const CODEX_PROVIDER_ID = 'openai-codex'

/** Settings namespace that owns the `openai-codex` route. */
export const CODEX_OAUTH_SETTINGS_NAMESPACE = 'llm-pi-ai'

/** The `llm-pi-ai` provider leaf whose route the bridge may enable. */
export const CODEX_OAUTH_PROVIDER_PATH = ['providers', CODEX_PROVIDER_ID] as const

/** Sole authorization origin the Client may hand to the system browser. */
export const CODEX_AUTHORIZATION_ORIGIN = 'https://auth.openai.com'

/** Callback the authorization request must target; fixed by the official OAuth implementation. */
export const CODEX_AUTHORIZATION_REDIRECT_URI = 'http://localhost:1455/auth/callback'

/** Sole authorization path the Client may hand to the system browser. */
export const CODEX_AUTHORIZATION_PATH = '/oauth/authorize'

/** Upper bound on an accepted authorization URL. The official request is well under 1 KiB. */
export const CODEX_AUTHORIZATION_URL_MAX_LENGTH = 2048

/** Loopback port the official OAuth implementation binds. Not overridable by this plugin. */
export const CODEX_CALLBACK_PORT = 1455

/** Endpoints of the fixed channel. */
export const CODEX_OAUTH_OPERATIONS = [
  'status',
  'begin',
  'query',
  'cancel',
  'logout',
  'enable-route',
] as const

/** One endpoint of the fixed channel. */
export type CodexOAuthOperation = (typeof CODEX_OAUTH_OPERATIONS)[number]

/** Attempt lifecycle: two pending states, three terminal states. */
export const CODEX_OAUTH_ATTEMPT_STATES = ['initiating', 'waiting-browser', 'authorized', 'cancelled', 'failed'] as const

/** One attempt's lifecycle state. */
export type CodexOAuthAttemptState = (typeof CODEX_OAUTH_ATTEMPT_STATES)[number]

/** Attempt states a successful `begin` may report. */
export type CodexOAuthPendingAttemptState = Extract<CodexOAuthAttemptState, 'initiating' | 'waiting-browser'>

/** Attempt states that never change again. */
export const CODEX_OAUTH_TERMINAL_ATTEMPT_STATES = ['authorized', 'cancelled', 'failed'] as const

/**
 * Whether an attempt has settled.
 * @param state - attempt state to classify.
 * @returns true for a terminal state.
 */
export function isTerminalAttemptState(state: CodexOAuthAttemptState): boolean {
  return (CODEX_OAUTH_TERMINAL_ATTEMPT_STATES as readonly CodexOAuthAttemptState[]).includes(state)
}

/** Why an attempt reached `cancelled`. */
export const CODEX_OAUTH_CANCEL_REASONS = ['user', 'browser-open-failed', 'page-closed', 'timeout', 'unload'] as const

/** One reason an attempt was cancelled. */
export type CodexOAuthCancelReason = (typeof CODEX_OAUTH_CANCEL_REASONS)[number]

/** Cancel reasons a Client may report; `timeout` and `unload` are produced by the Host alone. */
export const CODEX_OAUTH_CLIENT_CANCEL_REASONS = ['user', 'browser-open-failed', 'page-closed'] as const

/** One cancel reason a Client may report. */
export type CodexOAuthClientCancelReason = (typeof CODEX_OAUTH_CLIENT_CANCEL_REASONS)[number]

/** Named gaps in the official services this bridge depends on. */
export const CODEX_OAUTH_CAPABILITY_GAPS = [
  'authorization-unavailable',
  'credentials-unavailable',
  'codex-flow-unavailable',
  'settings-unavailable',
  'connection-unavailable',
] as const

/** One missing official capability. */
export type CodexOAuthCapabilityGap = (typeof CODEX_OAUTH_CAPABILITY_GAPS)[number]

/**
 * Safe failure codes exchanged on the channel. Every code is a stable
 * identifier the Client localizes; no provider text travels with it.
 *
 * - `invalid-request` — the payload failed wire validation.
 * - `transport-failed` — the call never produced a well-formed result.
 * - `capability-unavailable` — an official service or the Codex flow is absent.
 * - `provider-unsupported` — a request named a provider other than Codex.
 * - `busy` — the official seam already has an authorization in flight for this key.
 * - `attempt-unknown` — no attempt matches the presented identity.
 * - `attempt-forbidden` — the caller does not own the attempt.
 * - `attempt-expired` — the attempt lease or retention window elapsed.
 * - `login-failed` — the official flow settled without a committed credential.
 * - `login-method-unsupported` — the official flow offered no browser method.
 * - `callback-port-unavailable` — the loopback callback port could not be bound.
 * - `logout-blocked` — an attempt is active, so the record must not be deleted.
 * - `route-revision-conflict` — the settings revision moved since it was read.
 * - `route-write-failed` — the settings write was refused.
 */
export const CODEX_OAUTH_ERROR_CODES = [
  'invalid-request',
  'transport-failed',
  'capability-unavailable',
  'provider-unsupported',
  'busy',
  'attempt-unknown',
  'attempt-forbidden',
  'attempt-expired',
  'login-failed',
  'login-method-unsupported',
  'callback-port-unavailable',
  'logout-blocked',
  'route-revision-conflict',
  'route-write-failed',
] as const

/** One safe failure code. */
export type CodexOAuthErrorCode = (typeof CODEX_OAUTH_ERROR_CODES)[number]

/**
 * Whether a URL is the official OpenAI authorization page the Client may open.
 *
 * Applied before any browser open, so a compromised Host cannot turn this
 * bridge into an arbitrary-URL opener. The check pins the exact origin, path,
 * and PKCE request shape the installed official flow builds, refuses any
 * userinfo or fragment that could redirect the browser elsewhere, and refuses
 * a repeated security parameter so a smuggled second value cannot win.
 * @param value - candidate URL.
 * @returns true only for the official authorization request.
 */
export function isAllowedAuthorizationUrl(value: string): boolean {
  if (value.length === 0 || value.length > CODEX_AUTHORIZATION_URL_MAX_LENGTH) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.origin !== CODEX_AUTHORIZATION_ORIGIN) return false
  if (url.pathname !== CODEX_AUTHORIZATION_PATH) return false
  if (url.username !== '' || url.password !== '') return false
  if (url.hash !== '') return false
  const state = singleAuthorizationParameter(url, 'state')
  const challenge = singleAuthorizationParameter(url, 'code_challenge')
  return singleAuthorizationParameter(url, 'response_type') === 'code'
    && singleAuthorizationParameter(url, 'code_challenge_method') === 'S256'
    && singleAuthorizationParameter(url, 'redirect_uri') === CODEX_AUTHORIZATION_REDIRECT_URI
    && state !== undefined && state.length > 0
    && challenge !== undefined && challenge.length > 0
}

/** The one value of a security parameter, or undefined when it is absent or repeated. */
function singleAuthorizationParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name)
  return values.length === 1 ? values[0] : undefined
}
