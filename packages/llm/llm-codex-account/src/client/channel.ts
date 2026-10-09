/**
 * The browser half's typed face over the independent `/codex-oauth` channel.
 *
 * Every call goes through the shared wire validators before the card sees a
 * value, and every refusal becomes one code from the shared vocabulary. The
 * Host's `message` field, a transport error, and anything else the wire carries
 * as text are dropped here: the card localizes from the code alone, so provider
 * text can never reach the page through an error path.
 */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import {
  CODEX_OAUTH_CHANNEL,
  CODEX_PROVIDER_ID,
  parseCodexOAuthAttemptView,
  parseCodexOAuthBeginResult,
  parseCodexOAuthEnableRouteResult,
  parseCodexOAuthLogoutResult,
  parseCodexOAuthStatusResult,
  resolveCodexOAuthErrorCode,
  type CodexOAuthAttemptRequest,
  type CodexOAuthAttemptView,
  type CodexOAuthBeginResult,
  type CodexOAuthCancelRequest,
  type CodexOAuthEnableRouteRequest,
  type CodexOAuthEnableRouteResult,
  type CodexOAuthErrorCode,
  type CodexOAuthLogoutResult,
  type CodexOAuthParseResult,
  type CodexOAuthStatusResult,
} from '../shared/index.ts'

/** A refusal this half diagnosed, addressed by the one code the vocabulary defines. */
export class CodexOAuthClientFailure extends Error {
  /**
   * @param code - the code the card localizes.
   */
  constructor(
    /** Code the card localizes. */
    readonly code: CodexOAuthErrorCode,
  ) {
    super(code)
    this.name = 'CodexOAuthClientFailure'
  }
}

/**
 * Read a safe localization code from any thrown value.
 * @param error - the value caught by the caller.
 * @returns Its Codex error code, or `transport-failed` for an unrecognized value.
 */
export function failureCodeOf(error: unknown): CodexOAuthErrorCode {
  return error instanceof CodexOAuthClientFailure ? error.code : 'transport-failed'
}

/** The channel's operations, as the card consumes them. */
export interface CodexOAuthEndpoint {
  status(): Promise<CodexOAuthStatusResult>
  begin(): Promise<CodexOAuthBeginResult>
  query(request: CodexOAuthAttemptRequest): Promise<CodexOAuthAttemptView>
  cancel(request: CodexOAuthCancelRequest): Promise<CodexOAuthAttemptView>
  logout(): Promise<CodexOAuthLogoutResult>
  enableRoute(request: CodexOAuthEnableRouteRequest): Promise<CodexOAuthEnableRouteResult>
}

/** Sends validated requests over the dedicated Codex OAuth RPC channel. */
export class CodexOAuthChannel implements CodexOAuthEndpoint {
  /** @param rpc - the connection RPC caller. */
  constructor(private readonly rpc: ClientConnectionRpc) {}

  status(): Promise<CodexOAuthStatusResult> {
    return this.call('status', {}, parseCodexOAuthStatusResult)
  }

  begin(): Promise<CodexOAuthBeginResult> {
    return this.call('begin', { provider: CODEX_PROVIDER_ID }, parseCodexOAuthBeginResult)
  }

  query(request: CodexOAuthAttemptRequest): Promise<CodexOAuthAttemptView> {
    return this.call('query', request, parseCodexOAuthAttemptView)
  }

  cancel(request: CodexOAuthCancelRequest): Promise<CodexOAuthAttemptView> {
    return this.call('cancel', request, parseCodexOAuthAttemptView)
  }

  logout(): Promise<CodexOAuthLogoutResult> {
    return this.call('logout', {}, parseCodexOAuthLogoutResult)
  }

  enableRoute(request: CodexOAuthEnableRouteRequest): Promise<CodexOAuthEnableRouteResult> {
    return this.call('enable-route', request, parseCodexOAuthEnableRouteResult)
  }

  private async call<T>(
    endpoint: string,
    payload: unknown,
    parse: (value: unknown) => CodexOAuthParseResult<T>,
  ): Promise<T> {
    let result: Awaited<ReturnType<ClientConnectionRpc['call']>>
    try {
      result = await this.rpc.call(CODEX_OAUTH_CHANNEL, endpoint, payload)
    } catch {
      throw new CodexOAuthClientFailure('transport-failed')
    }
    if (!result.ok) throw new CodexOAuthClientFailure(resolveCodexOAuthErrorCode(result.error.code))
    const parsed = parse(result.value)
    if (!parsed.ok) throw new CodexOAuthClientFailure(parsed.code)
    return parsed.value
  }
}
