/**
 * Wire validation shared by both faces. The Host runs the request parsers at
 * its endpoint entry and the Client runs the result parsers before it renders
 * anything, so a malformed or widened payload is refused on the face that
 * receives it.
 *
 * Parsers accept only the declared keys: an unexpected field is a validation
 * failure rather than ignored data, which is what keeps provider text and
 * credential material from arriving through a newer Host.
 */

import {
  CODEX_OAUTH_ATTEMPT_STATES,
  CODEX_OAUTH_CANCEL_REASONS,
  CODEX_OAUTH_CAPABILITY_GAPS,
  CODEX_OAUTH_CLIENT_CANCEL_REASONS,
  CODEX_OAUTH_ERROR_CODES,
  CODEX_OAUTH_OPERATIONS,
  CODEX_OAUTH_PROTOCOL_VERSION,
  CODEX_PROVIDER_ID,
  isAllowedAuthorizationUrl,
  type CodexOAuthAttemptState,
  type CodexOAuthErrorCode,
  type CodexOAuthOperation,
} from './protocol.ts'
import { codexOAuthAttemptId, codexOAuthOwnerToken } from './identities.ts'
import { CODEX_OAUTH_POLL_INTERVAL_BOUNDS } from './tuning.ts'
import type {
  CodexOAuthAttemptRequest,
  CodexOAuthAttemptView,
  CodexOAuthBeginRequest,
  CodexOAuthBeginResult,
  CodexOAuthCancelRequest,
  CodexOAuthEmptyRequest,
  CodexOAuthEnableRouteRequest,
  CodexOAuthEnableRouteResult,
  CodexOAuthLogoutResult,
  CodexOAuthStatusResult,
} from './wire.ts'

/** Outcome of validating one wire value. */
export type CodexOAuthParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CodexOAuthErrorCode }

const INVALID: CodexOAuthParseResult<never> = { ok: false, code: 'invalid-request' }

/** Random-identity shape both halves of an attempt credential share. */
const IDENTITY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/** The one attempt state in which the official authorization URL is actionable. */
const WAITING_BROWSER: CodexOAuthAttemptState = 'waiting-browser'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function memberOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** Reject any key the shape does not declare, so widened payloads fail closed. */
function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record)
  return own.length === keys.length && own.every(key => keys.includes(key))
}

function isAttemptIdentity(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_PATTERN.test(value)
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPollInterval(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= CODEX_OAUTH_POLL_INTERVAL_BOUNDS.min
    && value <= CODEX_OAUTH_POLL_INTERVAL_BOUNDS.max
}

/**
 * Validate one endpoint name.
 * @param value - path segment the transport already accepted.
 * @returns the operation, or undefined for an endpoint this bundle does not own.
 */
export function parseCodexOAuthOperation(value: string): CodexOAuthOperation | undefined {
  return memberOf(CODEX_OAUTH_OPERATIONS, value) ? value : undefined
}

/**
 * Validate a payload for an operation that carries no parameters.
 * @param payload - decoded request payload; absent and `null` mean an empty body.
 * @returns the empty request, or a validation failure.
 */
export function parseCodexOAuthEmptyRequest(payload: unknown): CodexOAuthParseResult<CodexOAuthEmptyRequest> {
  if (payload === undefined || payload === null) return { ok: true, value: {} }
  if (!isRecord(payload) || Object.keys(payload).length !== 0) return INVALID
  return { ok: true, value: {} }
}

/**
 * Validate a `status` result.
 * @param value - decoded result payload.
 * @returns the status view, or a validation failure.
 */
export function parseCodexOAuthStatusResult(value: unknown): CodexOAuthParseResult<CodexOAuthStatusResult> {
  if (!isRecord(value)) return INVALID
  if (!hasOnlyKeys(value, ['protocolVersion', 'capability', 'record', 'route'])) return INVALID
  const { protocolVersion, capability, record, route } = value
  if (protocolVersion !== CODEX_OAUTH_PROTOCOL_VERSION) return INVALID
  const sections = parseStatusSections(capability, record, route)
  if (sections === undefined) return INVALID
  return {
    ok: true,
    value: {
      protocolVersion,
      capability: sections.capability,
      record: sections.record,
      route: sections.route,
    },
  }
}

/** The three metadata sections of a `status` result, or undefined when any of them is malformed. */
function parseStatusSections(
  capability: unknown,
  record: unknown,
  route: unknown,
): Pick<CodexOAuthStatusResult, 'capability' | 'record' | 'route'> | undefined {
  if (!isRecord(capability) || !hasOnlyKeys(capability, ['available', 'gap'])) return undefined
  const available = capability.available
  const gap = capability.gap
  if (typeof available !== 'boolean') return undefined
  if (gap !== null && !memberOf(CODEX_OAUTH_CAPABILITY_GAPS, gap)) return undefined
  if (!isRecord(record) || !hasOnlyKeys(record, ['stored'])) return undefined
  const stored = record.stored
  if (typeof stored !== 'boolean') return undefined
  if (!isRecord(route) || !hasOnlyKeys(route, ['configured', 'namespaceRevision'])) return undefined
  const configured = route.configured
  const namespaceRevision = route.namespaceRevision
  if (typeof configured !== 'boolean') return undefined
  if (namespaceRevision !== null && !isRevision(namespaceRevision)) return undefined
  return {
    capability: { available, gap: gap },
    record: { stored },
    route: { configured, namespaceRevision },
  }
}

/**
 * Validate a `begin` request. The endpoint serves Codex alone, so a foreign
 * provider is refused here with its own code rather than passed to the bridge.
 * @param payload - decoded request payload.
 * @returns the request, or a validation failure.
 */
export function parseCodexOAuthBeginRequest(payload: unknown): CodexOAuthParseResult<CodexOAuthBeginRequest> {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ['provider'])) return INVALID
  const provider = payload.provider
  if (typeof provider !== 'string') return INVALID
  if (provider !== CODEX_PROVIDER_ID) return { ok: false, code: 'provider-unsupported' }
  return { ok: true, value: { provider } }
}

/**
 * Validate a `begin` result.
 * @param value - decoded result payload.
 * @returns the attempt identity and initial state, or a validation failure.
 */
export function parseCodexOAuthBeginResult(value: unknown): CodexOAuthParseResult<CodexOAuthBeginResult> {
  if (!isRecord(value)) return INVALID
  if (!hasOnlyKeys(value, ['attemptId', 'ownerToken', 'state', 'pollIntervalMs'])) return INVALID
  const { attemptId, ownerToken, state, pollIntervalMs } = value
  if (!isAttemptIdentity(attemptId) || !isAttemptIdentity(ownerToken)) return INVALID
  if (state !== 'initiating' && state !== 'waiting-browser') return INVALID
  if (!isPollInterval(pollIntervalMs)) return INVALID
  return {
    ok: true,
    value: { attemptId: codexOAuthAttemptId(attemptId), ownerToken: codexOAuthOwnerToken(ownerToken), state, pollIntervalMs },
  }
}

/**
 * Validate a `query` or `cancel` request.
 * @param payload - decoded request payload.
 * @returns the attempt credential, or a validation failure.
 */
export function parseCodexOAuthAttemptRequest(payload: unknown): CodexOAuthParseResult<CodexOAuthAttemptRequest> {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ['attemptId', 'ownerToken'])) return INVALID
  const { attemptId, ownerToken } = payload
  if (!isAttemptIdentity(attemptId) || !isAttemptIdentity(ownerToken)) return INVALID
  return {
    ok: true,
    value: { attemptId: codexOAuthAttemptId(attemptId), ownerToken: codexOAuthOwnerToken(ownerToken) },
  }
}

/**
 * Validate an attempt view.
 * @param value - decoded `query` or `cancel` result payload.
 * @returns the view, or a validation failure.
 */
export function parseCodexOAuthAttemptView(value: unknown): CodexOAuthParseResult<CodexOAuthAttemptView> {
  if (!isRecord(value)) return INVALID
  if (!hasOnlyKeys(value, ['attemptId', 'state', 'authUrl', 'cancelReason', 'errorCode'])) return INVALID
  const { attemptId, state, authUrl, cancelReason, errorCode } = value
  if (!isAttemptIdentity(attemptId)) return INVALID
  if (!memberOf(CODEX_OAUTH_ATTEMPT_STATES, state)) return INVALID
  if (!matchesState(state, authUrl, WAITING_BROWSER)) return INVALID
  if (authUrl !== null && (typeof authUrl !== 'string' || !isAllowedAuthorizationUrl(authUrl))) return INVALID
  if (!matchesState(state, cancelReason, 'cancelled')) return INVALID
  if (cancelReason !== null && !memberOf(CODEX_OAUTH_CANCEL_REASONS, cancelReason)) return INVALID
  if (!matchesState(state, errorCode, 'failed')) return INVALID
  if (errorCode !== null && !memberOf(CODEX_OAUTH_ERROR_CODES, errorCode)) return INVALID
  return {
    ok: true,
    value: {
      attemptId: codexOAuthAttemptId(attemptId),
      state,
      authUrl: authUrl,
      cancelReason: cancelReason,
      errorCode: errorCode,
    },
  }
}

/**
 * Enforce a field's biconditional with the attempt state: a detail exists
 * exactly when the state that explains it does.
 * @param state - the attempt's state.
 * @param detail - the field only that state justifies.
 * @param owner - the state the detail belongs to.
 * @returns true when the detail's presence and the state agree.
 */
function matchesState(state: CodexOAuthAttemptState, detail: unknown, owner: CodexOAuthAttemptState): boolean {
  return detail === null ? state !== owner : state === owner
}

/**
 * Validate a `cancel` request.
 * @param payload - decoded request payload.
 * @returns the attempt credential plus reason, or a validation failure.
 */
export function parseCodexOAuthCancelRequest(payload: unknown): CodexOAuthParseResult<CodexOAuthCancelRequest> {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ['attemptId', 'ownerToken', 'reason'])) return INVALID
  const { attemptId, ownerToken, reason } = payload
  if (!isAttemptIdentity(attemptId) || !isAttemptIdentity(ownerToken)) return INVALID
  if (!memberOf(CODEX_OAUTH_CLIENT_CANCEL_REASONS, reason)) return INVALID
  return {
    ok: true,
    value: { attemptId: codexOAuthAttemptId(attemptId), ownerToken: codexOAuthOwnerToken(ownerToken), reason },
  }
}

/**
 * Validate a `logout` result.
 * @param value - decoded result payload.
 * @returns whether a record was removed, or a validation failure.
 */
export function parseCodexOAuthLogoutResult(value: unknown): CodexOAuthParseResult<CodexOAuthLogoutResult> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['removed'])) return INVALID
  const removed = value.removed
  if (typeof removed !== 'boolean') return INVALID
  return { ok: true, value: { removed } }
}

/**
 * Validate an `enable-route` request.
 * @param payload - decoded request payload.
 * @returns the revision fence, or a validation failure.
 */
export function parseCodexOAuthEnableRouteRequest(
  payload: unknown,
): CodexOAuthParseResult<CodexOAuthEnableRouteRequest> {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ['namespaceRevision'])) return INVALID
  const { namespaceRevision } = payload
  if (!isRevision(namespaceRevision)) return INVALID
  return { ok: true, value: { namespaceRevision } }
}

/**
 * Validate an `enable-route` result.
 * @param value - decoded result payload.
 * @returns the new revision, or a validation failure.
 */
export function parseCodexOAuthEnableRouteResult(
  value: unknown,
): CodexOAuthParseResult<CodexOAuthEnableRouteResult> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['configured', 'namespaceRevision'])) return INVALID
  const { configured, namespaceRevision } = value
  if (configured !== true) return INVALID
  if (!isRevision(namespaceRevision)) return INVALID
  return { ok: true, value: { configured: true, namespaceRevision } }
}

/**
 * Narrow a failure code from any source to one this bundle can localize.
 * @param value - `code` field of a decoded failure, or anything else.
 * @returns the known code, or `transport-failed` for an unknown one.
 */
export function resolveCodexOAuthErrorCode(value: unknown): CodexOAuthErrorCode {
  return memberOf(CODEX_OAUTH_ERROR_CODES, value) ? value : 'transport-failed'
}
