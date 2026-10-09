/** Internal branded identities for the Codex OAuth wire protocol. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity naming one Host-owned OAuth attempt. */
export type CodexOAuthAttemptId = Branded<'codex-oauth-attempt-id'>

/** Opaque capability authorizing its holder to query or cancel one attempt. */
export type CodexOAuthOwnerToken = Branded<'codex-oauth-owner-token'>

/**
 * Brand an attempt id that the caller has validated.
 * @param value - validated attempt identity.
 * @returns the unchanged attempt identity with its compile-time brand.
 */
export function codexOAuthAttemptId(value: string): CodexOAuthAttemptId {
  return value as CodexOAuthAttemptId
}

/**
 * Brand an ownership token that the caller has validated.
 * @param value - validated ownership token.
 * @returns the unchanged token with its compile-time brand.
 */
export function codexOAuthOwnerToken(value: string): CodexOAuthOwnerToken {
  return value as CodexOAuthOwnerToken
}
