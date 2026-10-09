import { describe, expect, expectTypeOf, it } from 'vitest'
import type { CodexOAuthCancelRequest } from '../../src/shared/index.ts'
import {
  parseCodexOAuthAttemptRequest,
  parseCodexOAuthAttemptView,
  parseCodexOAuthBeginRequest,
  parseCodexOAuthBeginResult,
  parseCodexOAuthCancelRequest,
  parseCodexOAuthEmptyRequest,
  parseCodexOAuthEnableRouteRequest,
  parseCodexOAuthEnableRouteResult,
  parseCodexOAuthLogoutResult,
  parseCodexOAuthOperation,
  parseCodexOAuthStatusResult,
  resolveCodexOAuthErrorCode,
} from '../../src/shared/index.ts'

const ATTEMPT_ID = 'A1b2C3d4E5f6G7h8I9j0K1l2'
const OWNER_TOKEN = 'Z9y8X7w6V5u4T3s2R1q0P9o8'

function officialAuthorizeUrl(): string {
  const url = new URL('https://auth.openai.com/oauth/authorize')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', 'app_EMoamEEZ73f0CkXaXp7hrann')
  url.searchParams.set('redirect_uri', 'http://localhost:1455/auth/callback')
  url.searchParams.set('scope', 'openid profile email offline_access')
  url.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', 'a1b2c3d4e5f60718293a4b5c6d7e8f90')
  return url.toString()
}

const AUTH_URL = officialAuthorizeUrl()

const STATUS_RESULT = {
  protocolVersion: 2,
  capability: { available: true, gap: null },
  record: { stored: false },
  route: { configured: false, namespaceRevision: 7 },
}

const INITIATING_VIEW = {
  attemptId: ATTEMPT_ID,
  state: 'initiating',
  authUrl: null,
  cancelReason: null,
  errorCode: null,
}

function invalid(result: { ok: boolean }): boolean {
  return ! result.ok
}

describe('endpoint names', () => {
  it('accepts the owned endpoints and refuses anything else', () => {
    expect(parseCodexOAuthOperation('status')).toBe('status')
    expect(parseCodexOAuthOperation('enable-route')).toBe('enable-route')
    expect(parseCodexOAuthOperation('models')).toBeUndefined()
    expect(parseCodexOAuthOperation('save-models')).toBeUndefined()
    expect(parseCodexOAuthOperation('signout')).toBeUndefined()
    expect(parseCodexOAuthOperation('attempt')).toBeUndefined()
    expect(parseCodexOAuthOperation('')).toBeUndefined()
  })
})

describe('parameterless requests', () => {
  it('accepts an absent body and an empty object, and refuses any parameter', () => {
    expect(parseCodexOAuthEmptyRequest(undefined)).toEqual({ ok: true, value: {} })
    expect(parseCodexOAuthEmptyRequest({})).toEqual({ ok: true, value: {} })
    expect(invalid(parseCodexOAuthEmptyRequest({ provider: 'openai-codex' }))).toBe(true)
    expect(invalid(parseCodexOAuthEmptyRequest([]))).toBe(true)
    expect(invalid(parseCodexOAuthEmptyRequest('status'))).toBe(true)
  })
})

describe('status', () => {
  it('accepts the capability, record, and route metadata', () => {
    expect(parseCodexOAuthStatusResult(STATUS_RESULT)).toEqual({ ok: true, value: STATUS_RESULT })
    expect(parseCodexOAuthStatusResult({
      ...STATUS_RESULT,
      capability: { available: false, gap: 'codex-flow-unavailable' },
      route: { configured: false, namespaceRevision: null },
    }).ok).toBe(true)
  })

  it('refuses attempt identity, capability text, or any widened field', () => {
    expect(invalid(parseCodexOAuthStatusResult({ ...STATUS_RESULT, attemptId: ATTEMPT_ID }))).toBe(true)
    expect(invalid(parseCodexOAuthStatusResult({ ...STATUS_RESULT, ownerToken: OWNER_TOKEN }))).toBe(true)
    expect(invalid(parseCodexOAuthStatusResult({ ...STATUS_RESULT, busy: false }))).toBe(true)
    expect(invalid(parseCodexOAuthStatusResult({
      ...STATUS_RESULT,
      capability: { available: false, gap: 'codex-flow-unavailable', message: 'raw provider text' },
    }))).toBe(true)
  })

  it('refuses an unknown gap, a version other than the fixed one, and a malformed revision', () => {
    expect(invalid(parseCodexOAuthStatusResult({
      ...STATUS_RESULT,
      capability: { available: false, gap: 'mystery' },
    }))).toBe(true)
    expect(invalid(parseCodexOAuthStatusResult({ ...STATUS_RESULT, protocolVersion: 0 }))).toBe(true)
    expect(invalid(parseCodexOAuthStatusResult({ ...STATUS_RESULT, protocolVersion: 1 }))).toBe(true)
    expect(invalid(parseCodexOAuthStatusResult({ ...STATUS_RESULT, protocolVersion: '1' }))).toBe(true)
    expect(invalid(parseCodexOAuthStatusResult({
      ...STATUS_RESULT,
      route: { configured: false, namespaceRevision: -1 },
    }))).toBe(true)
    expect(invalid(parseCodexOAuthStatusResult({
      ...STATUS_RESULT,
      route: { configured: false, namespaceRevision: Number.MAX_SAFE_INTEGER + 1 },
    }))).toBe(true)
    expect(invalid(parseCodexOAuthStatusResult({
      ...STATUS_RESULT,
      route: { configured: false, namespaceRevision: 7.5 },
    }))).toBe(true)
    expect(invalid(parseCodexOAuthStatusResult({ status: 'ok' }))).toBe(true)
  })
})

describe('begin', () => {
  it('accepts only a Codex request', () => {
    expect(parseCodexOAuthBeginRequest({ provider: 'openai-codex' })).toEqual({
      ok: true,
      value: { provider: 'openai-codex' },
    })
    expect(parseCodexOAuthBeginRequest({ provider: 'anthropic' })).toEqual({
      ok: false,
      code: 'provider-unsupported',
    })
    expect(invalid(parseCodexOAuthBeginRequest({}))).toBe(true)
    expect(invalid(parseCodexOAuthBeginRequest({ provider: 'openai-codex', method: 'device_code' }))).toBe(true)
    expect(invalid(parseCodexOAuthBeginRequest({ provider: 7 }))).toBe(true)
  })

  it('accepts a server-minted identity with a pending state and a poll cadence', () => {
    expect(parseCodexOAuthBeginResult({
      attemptId: ATTEMPT_ID,
      ownerToken: OWNER_TOKEN,
      state: 'initiating',
      pollIntervalMs: 1_000,
    }).ok).toBe(true)
    expect(parseCodexOAuthBeginResult({
      attemptId: ATTEMPT_ID,
      ownerToken: OWNER_TOKEN,
      state: 'waiting-browser',
      pollIntervalMs: 250,
    }).ok).toBe(true)
  })

  it('refuses a short identity, a terminal state, an unusable cadence, or any widening', () => {
    const base = {
      attemptId: ATTEMPT_ID,
      ownerToken: OWNER_TOKEN,
      state: 'initiating',
      pollIntervalMs: 1_000,
    }
    expect(invalid(parseCodexOAuthBeginResult({ ...base, attemptId: 'short' }))).toBe(true)
    expect(invalid(parseCodexOAuthBeginResult({ ...base, ownerToken: '' }))).toBe(true)
    expect(invalid(parseCodexOAuthBeginResult({ ...base, state: 'authorized' }))).toBe(true)
    expect(invalid(parseCodexOAuthBeginResult({ ...base, pollIntervalMs: 0 }))).toBe(true)
    expect(invalid(parseCodexOAuthBeginResult({ ...base, pollIntervalMs: 30_001 }))).toBe(true)
    expect(invalid(parseCodexOAuthBeginResult({ ...base, pollIntervalMs: 1_000.5 }))).toBe(true)
    expect(invalid(parseCodexOAuthBeginResult({ ...base, authUrl: AUTH_URL }))).toBe(true)
    expect(invalid(parseCodexOAuthBeginResult({ ...base, notice: { message: 'raw' } }))).toBe(true)
  })
})

describe('query and cancel identity', () => {
  it('requires both halves of the attempt credential', () => {
    expect(parseCodexOAuthAttemptRequest({ attemptId: ATTEMPT_ID, ownerToken: OWNER_TOKEN })).toEqual({
      ok: true,
      value: { attemptId: ATTEMPT_ID, ownerToken: OWNER_TOKEN },
    })
    expect(invalid(parseCodexOAuthAttemptRequest({ attemptId: ATTEMPT_ID }))).toBe(true)
    expect(invalid(parseCodexOAuthAttemptRequest({ ownerToken: OWNER_TOKEN }))).toBe(true)
    expect(invalid(parseCodexOAuthAttemptRequest({ attemptId: ATTEMPT_ID, ownerToken: 'x' }))).toBe(true)
    expect(invalid(parseCodexOAuthAttemptRequest({
      attemptId: ATTEMPT_ID,
      ownerToken: OWNER_TOKEN,
      reason: 'user',
    }))).toBe(true)
  })

  it('accepts only a client-observable cancel reason', () => {
    for (const reason of ['user', 'browser-open-failed', 'page-closed']) {
      expect(parseCodexOAuthCancelRequest({ attemptId: ATTEMPT_ID, ownerToken: OWNER_TOKEN, reason }).ok).toBe(true)
    }
    expect(invalid(parseCodexOAuthCancelRequest({
      attemptId: ATTEMPT_ID,
      ownerToken: OWNER_TOKEN,
      reason: 'timeout',
    }))).toBe(true)
    expect(invalid(parseCodexOAuthCancelRequest({
      attemptId: ATTEMPT_ID,
      ownerToken: OWNER_TOKEN,
      reason: 'unload',
    }))).toBe(true)
    expect(invalid(parseCodexOAuthCancelRequest({ attemptId: ATTEMPT_ID, ownerToken: OWNER_TOKEN }))).toBe(true)
  })

  it('types the cancel request with the client reasons only', () => {
    expectTypeOf<CodexOAuthCancelRequest['reason']>()
      .toEqualTypeOf<'user' | 'browser-open-failed' | 'page-closed'>()
  })
})

describe('attempt view', () => {
  it('accepts a pending attempt without an authorization URL yet', () => {
    expect(parseCodexOAuthAttemptView(INITIATING_VIEW)).toEqual({ ok: true, value: INITIATING_VIEW })
  })

  it('binds the authorization URL to the browser-waiting state', () => {
    expect(parseCodexOAuthAttemptView({ ...INITIATING_VIEW, state: 'waiting-browser', authUrl: AUTH_URL }).ok)
      .toBe(true)
    expect(invalid(parseCodexOAuthAttemptView({ ...INITIATING_VIEW, state: 'waiting-browser' }))).toBe(true)
    expect(invalid(parseCodexOAuthAttemptView({ ...INITIATING_VIEW, authUrl: AUTH_URL }))).toBe(true)
    expect(invalid(parseCodexOAuthAttemptView({
      ...INITIATING_VIEW,
      state: 'waiting-browser',
      authUrl: 'https://evil.example/oauth/authorize',
    }))).toBe(true)
    expect(invalid(parseCodexOAuthAttemptView({
      ...INITIATING_VIEW,
      state: 'waiting-browser',
      authUrl: 'http://localhost:1455/auth/callback?code=secret',
    }))).toBe(true)
  })

  it('binds a cancel reason to cancellation and an error code to failure', () => {
    expect(parseCodexOAuthAttemptView({
      ...INITIATING_VIEW,
      state: 'cancelled',
      cancelReason: 'browser-open-failed',
    }).ok).toBe(true)
    expect(parseCodexOAuthAttemptView({
      ...INITIATING_VIEW,
      state: 'cancelled',
      cancelReason: 'timeout',
    }).ok).toBe(true)
    expect(invalid(parseCodexOAuthAttemptView({ ...INITIATING_VIEW, state: 'cancelled' }))).toBe(true)
    expect(invalid(parseCodexOAuthAttemptView({
      ...INITIATING_VIEW,
      state: 'authorized',
      cancelReason: 'user',
    }))).toBe(true)
    expect(parseCodexOAuthAttemptView({ ...INITIATING_VIEW, state: 'authorized' }).ok).toBe(true)
    expect(parseCodexOAuthAttemptView({
      ...INITIATING_VIEW,
      state: 'failed',
      errorCode: 'callback-port-unavailable',
    }).ok).toBe(true)
    expect(invalid(parseCodexOAuthAttemptView({ ...INITIATING_VIEW, state: 'failed' }))).toBe(true)
    expect(invalid(parseCodexOAuthAttemptView({
      ...INITIATING_VIEW,
      state: 'failed',
      errorCode: 'token exchange failed: invalid_grant',
    }))).toBe(true)
    expect(invalid(parseCodexOAuthAttemptView({ ...INITIATING_VIEW, state: 'mystery' }))).toBe(true)
  })

  it('refuses credential material and provider text in the view', () => {
    expect(invalid(parseCodexOAuthAttemptView({ ...INITIATING_VIEW, ownerToken: OWNER_TOKEN }))).toBe(true)
    expect(invalid(parseCodexOAuthAttemptView({ ...INITIATING_VIEW, accessToken: 'sk-x' }))).toBe(true)
    expect(invalid(parseCodexOAuthAttemptView({ ...INITIATING_VIEW, message: 'raw provider text' }))).toBe(true)
  })
})

describe('logout', () => {
  it('reports only whether a local record was removed', () => {
    expect(parseCodexOAuthLogoutResult({ removed: true })).toEqual({ ok: true, value: { removed: true } })
    expect(parseCodexOAuthLogoutResult({ removed: false })).toEqual({ ok: true, value: { removed: false } })
    expect(invalid(parseCodexOAuthLogoutResult({ removed: 'yes' }))).toBe(true)
    expect(invalid(parseCodexOAuthLogoutResult({ revoked: true }))).toBe(true)
    expect(invalid(parseCodexOAuthLogoutResult({ removed: true, tokens: {} }))).toBe(true)
  })
})

describe('enable-route', () => {
  it('requires a revision fence and no override decision', () => {
    expect(parseCodexOAuthEnableRouteRequest({ namespaceRevision: 7 }))
      .toEqual({ ok: true, value: { namespaceRevision: 7 } })
    expect(parseCodexOAuthEnableRouteRequest({ namespaceRevision: 0 }).ok).toBe(true)
  })

  it('rejects the removed apiKeyEnv decision from protocol v1', () => {
    expect(parseCodexOAuthEnableRouteRequest({ namespaceRevision: 7, removeApiKeyEnvOverride: true }).ok).toBe(false)
    expect(parseCodexOAuthEnableRouteRequest({ namespaceRevision: 7, removeApiKeyEnvOverride: false }).ok).toBe(false)
  })

  it('refuses an unstable or fractional revision', () => {
    expect(invalid(parseCodexOAuthEnableRouteRequest({
      namespaceRevision: Number.MAX_SAFE_INTEGER + 1,
    }))).toBe(true)
    expect(invalid(parseCodexOAuthEnableRouteRequest({ namespaceRevision: 1.5 }))).toBe(true)
    expect(parseCodexOAuthEnableRouteRequest({ namespaceRevision: Number.MAX_SAFE_INTEGER }).ok)
      .toBe(true)
  })

  it('reports the post-write revision and nothing else', () => {
    expect(parseCodexOAuthEnableRouteResult({ configured: true, namespaceRevision: 8 }))
      .toEqual({ ok: true, value: { configured: true, namespaceRevision: 8 } })
    expect(invalid(parseCodexOAuthEnableRouteResult({ configured: false, namespaceRevision: 8 }))).toBe(true)
    expect(invalid(parseCodexOAuthEnableRouteResult({ configured: true }))).toBe(true)
    expect(invalid(parseCodexOAuthEnableRouteResult({ configured: true, namespaceRevision: 8, providers: {} }))).toBe(true)
  })
})

describe('failure code narrowing', () => {
  it('keeps a known code and replaces everything else with a transport failure', () => {
    expect(resolveCodexOAuthErrorCode('busy')).toBe('busy')
    expect(resolveCodexOAuthErrorCode('attempt-forbidden')).toBe('attempt-forbidden')
    expect(resolveCodexOAuthErrorCode('gateway/bad-request')).toBe('transport-failed')
    expect(resolveCodexOAuthErrorCode('invalid_grant: token exchange rejected')).toBe('transport-failed')
    expect(resolveCodexOAuthErrorCode(undefined)).toBe('transport-failed')
    expect(resolveCodexOAuthErrorCode({ code: 'busy' })).toBe('transport-failed')
  })
})
