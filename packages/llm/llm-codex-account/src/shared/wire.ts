/**
 * Request and result shapes of the `/codex-oauth` channel.
 *
 * Every result carries only safe metadata: capability gaps, a boolean record
 * presence, route facts, an attempt's lifecycle state, the official
 * authorization URL, and closed-vocabulary codes. Access tokens, refresh
 * tokens, authorization codes, and provider text have no field here, so they
 * cannot reach the Client by construction.
 */

import type { CodexOAuthAttemptId, CodexOAuthOwnerToken } from './identities.ts'
import type {
  CodexOAuthAttemptState,
  CodexOAuthCancelReason,
  CodexOAuthCapabilityGap,
  CodexOAuthClientCancelReason,
  CodexOAuthErrorCode,
  CodexOAuthPendingAttemptState,
} from './protocol.ts'

/** A request that carries no parameters. */
export type CodexOAuthEmptyRequest = Record<string, never>

/** `status`: official capability, credential record, and route metadata safe to show any page. */
export interface CodexOAuthStatusResult {
  /** Wire version the Host speaks; a mismatch means the Client bundle is stale. */
  protocolVersion: number
  capability: {
    available: boolean
    /** The first missing official service or flow, or null when every dependency is present. */
    gap: CodexOAuthCapabilityGap | null
  }
  record: {
    /** Whether the official credential record for `llm-pi-ai/openai-codex` exists. Presence only, never its contents. */
    stored: boolean
  }
  route: {
    /** Whether the `openai-codex` route is configured in the `llm-pi-ai` namespace. */
    configured: boolean
    /** Settings revision the route facts were read at, or null when the namespace is unavailable. */
    namespaceRevision: number | null
  }
}

/** `begin`: the provider is spelled so the endpoint can refuse anything but Codex. */
export interface CodexOAuthBeginRequest {
  provider: string
}

/** `begin`: the Host-minted identity of one login attempt. */
export interface CodexOAuthBeginResult {
  /** Server-minted attempt identity, opaque to the Client. */
  attemptId: CodexOAuthAttemptId
  /**
   * Capability token for `query` and `cancel`. The initiating page keeps it in
   * memory for the attempt's lifetime and never persists it: it is the only
   * proof of ownership, and it is not a per-OS-user security boundary.
   */
  ownerToken: CodexOAuthOwnerToken
  state: CodexOAuthPendingAttemptState
  /** Client poll cadence for `query`, taken from the Host Config so both faces agree. */
  pollIntervalMs: number
}

/** `query` and `cancel`: both halves of the attempt identity are required. */
export interface CodexOAuthAttemptRequest {
  attemptId: CodexOAuthAttemptId
  ownerToken: CodexOAuthOwnerToken
}

/** One attempt's safe state as shown to its owner. */
export interface CodexOAuthAttemptView {
  attemptId: CodexOAuthAttemptId
  state: CodexOAuthAttemptState
  /**
   * The official authorization URL while the attempt waits for the browser,
   * null in every other state. The Client opens it through the desktop
   * external-link mechanism and never claims to know whether the OS opened it.
   */
  authUrl: string | null
  /** Why the attempt was cancelled; non-null exactly when `state` is `cancelled`. */
  cancelReason: CodexOAuthCancelReason | null
  /** Safe failure code; non-null exactly when `state` is `failed`. */
  errorCode: CodexOAuthErrorCode | null
}

/** `cancel`: the caller owns the attempt and reports why it is being cancelled. */
export interface CodexOAuthCancelRequest extends CodexOAuthAttemptRequest {
  reason: CodexOAuthClientCancelReason
}

/** `logout`: the local credential record is deleted, never the provider-side grant. */
export interface CodexOAuthLogoutResult {
  /** Whether a record existed and was removed. */
  removed: boolean
}

/** `enable-route`: an explicit request against one observed settings revision. */
export interface CodexOAuthEnableRouteRequest {
  /** Revision returned by the `status` that the user acted on. */
  namespaceRevision: number
}

/** `enable-route`: the route leaf now exists and other configuration was preserved. */
export interface CodexOAuthEnableRouteResult {
  configured: true
  /** Settings revision after the write. */
  namespaceRevision: number
}
