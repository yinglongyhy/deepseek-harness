import { describe, expect, it } from 'vitest'
import {
  CODEX_AUTHORIZATION_ORIGIN,
  CODEX_AUTHORIZATION_PATH,
  CODEX_AUTHORIZATION_REDIRECT_URI,
  CODEX_AUTHORIZATION_URL_MAX_LENGTH,
  CODEX_CALLBACK_PORT,
  CODEX_OAUTH_ATTEMPT_STATES,
  CODEX_OAUTH_CANCEL_REASONS,
  CODEX_OAUTH_CHANNEL,
  CODEX_OAUTH_CLIENT_CANCEL_REASONS,
  CODEX_OAUTH_ERROR_CODES,
  CODEX_OAUTH_OPERATIONS,
  CODEX_OAUTH_PROTOCOL_VERSION,
  CODEX_OAUTH_PROVIDER_PATH,
  CODEX_OAUTH_SETTINGS_NAMESPACE,
  CODEX_OAUTH_TERMINAL_ATTEMPT_STATES,
  CODEX_OAUTH_TUNING_DEFAULTS,
  CODEX_PROVIDER_ID,
  isAllowedAuthorizationUrl,
  isTerminalAttemptState,
} from '../../src/shared/index.ts'

const TRANSPORT_ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

describe('channel identity', () => {
  it('fixes the protocol version and the independent channel', () => {
    expect(CODEX_OAUTH_PROTOCOL_VERSION).toBe(2)
    expect(CODEX_OAUTH_CHANNEL).toBe('/codex-oauth')
    expect(CODEX_OAUTH_CHANNEL).not.toBe('/api')
  })

  it('spells every endpoint as one legal transport segment', () => {
    expect(CODEX_OAUTH_OPERATIONS).toEqual([
      'status', 'begin', 'query', 'cancel', 'logout', 'enable-route',
    ])
    for (const operation of CODEX_OAUTH_OPERATIONS) {
      expect(operation).toMatch(TRANSPORT_ENDPOINT_SEGMENT)
      expect(operation).not.toBe('.')
      expect(operation).not.toBe('..')
    }
  })

  it('serves only the Codex provider and route', () => {
    expect(CODEX_PROVIDER_ID).toBe('openai-codex')
    expect(CODEX_OAUTH_SETTINGS_NAMESPACE).toBe('llm-pi-ai')
    expect(CODEX_OAUTH_PROVIDER_PATH).toEqual(['providers', 'openai-codex'])
  })
})

describe('attempt lifecycle', () => {
  it('keeps the declared state order', () => {
    expect(CODEX_OAUTH_ATTEMPT_STATES).toEqual([
      'initiating', 'waiting-browser', 'authorized', 'cancelled', 'failed',
    ])
  })

  it('classifies exactly the three settlement states as terminal', () => {
    expect(CODEX_OAUTH_TERMINAL_ATTEMPT_STATES).toEqual(['authorized', 'cancelled', 'failed'])
    expect(CODEX_OAUTH_ATTEMPT_STATES.filter(isTerminalAttemptState))
      .toEqual(['authorized', 'cancelled', 'failed'])
  })

  it('restricts a client report to the three client-observable cancel reasons', () => {
    expect(CODEX_OAUTH_CLIENT_CANCEL_REASONS).toEqual(['user', 'browser-open-failed', 'page-closed'])
    expect(CODEX_OAUTH_CANCEL_REASONS).toEqual(['user', 'browser-open-failed', 'page-closed', 'timeout', 'unload'])
    expect(CODEX_OAUTH_CANCEL_REASONS).toContain('browser-open-failed')
  })
})

describe('error codes', () => {
  it('exposes each rule as a distinct safe code', () => {
    for (const code of [
      'invalid-request', 'transport-failed', 'capability-unavailable', 'provider-unsupported', 'busy',
      'attempt-unknown', 'attempt-forbidden', 'attempt-expired', 'login-failed', 'login-method-unsupported',
      'callback-port-unavailable', 'logout-blocked', 'route-revision-conflict',
      'route-write-failed',
    ]) {
      expect(CODEX_OAUTH_ERROR_CODES).toContain(code)
    }
  })

  it('carries no free-form provider message in the vocabulary', () => {
    for (const code of CODEX_OAUTH_ERROR_CODES) {
      expect(code).toMatch(/^[a-z][a-z-]*$/)
    }
  })
})

describe('authorization URL gate', () => {
  const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
  const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  const STATE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

  function officialAuthorizeUrl(mutate: (url: URL) => void = () => {}): string {
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

  it('accepts the request the official flow builds', () => {
    expect(CODEX_AUTHORIZATION_ORIGIN).toBe('https://auth.openai.com')
    expect(CODEX_AUTHORIZATION_PATH).toBe('/oauth/authorize')
    expect(CODEX_AUTHORIZATION_REDIRECT_URI).toBe('http://localhost:1455/auth/callback')
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl())).toBe(true)
  })

  it('refuses a downgrade, a foreign host, a lookalike host, or a foreign path', () => {
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl().replace('https://', 'http://'))).toBe(false)
    expect(isAllowedAuthorizationUrl('https://evil.example/oauth/authorize')).toBe(false)
    expect(isAllowedAuthorizationUrl('https://auth.openai.com.evil.example/oauth/authorize')).toBe(false)
    expect(isAllowedAuthorizationUrl('https://auth.openai.com/oauth/token')).toBe(false)
    expect(isAllowedAuthorizationUrl('https://auth.openai.com/')).toBe(false)
    expect(isAllowedAuthorizationUrl('https://auth.openai.com/oauth/authorize/../../evil')).toBe(false)
  })

  it('refuses userinfo and a fragment', () => {
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) => { url.username = 'attacker' }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) => { url.password = 'attacker' }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) => { url.hash = 'x' }))).toBe(false)
  })

  it('requires the PKCE request shape the installed flow builds', () => {
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.set('response_type', 'token') }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.set('code_challenge_method', 'plain') }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.delete('code_challenge_method') }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.delete('code_challenge') }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.set('code_challenge', '') }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.delete('state') }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.set('state', '') }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.set('redirect_uri', 'http://localhost:1455/') }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.set('redirect_uri', 'https://evil.example/auth/callback') }))).toBe(false)
  })

  it('refuses a repeated security parameter', () => {
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.append('state', 'other') }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.append('code_challenge', 'other') }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.append('response_type', 'code') }))).toBe(false)
    expect(isAllowedAuthorizationUrl(officialAuthorizeUrl((url) =>{  url.searchParams.append('redirect_uri', CODEX_AUTHORIZATION_REDIRECT_URI) }))).toBe(false)
  })

  it('refuses an over-long URL, a non-HTTP scheme, and a value that is not a URL', () => {
    const overlong = officialAuthorizeUrl((url) =>{  url.searchParams.set('state', 'x'.repeat(CODEX_AUTHORIZATION_URL_MAX_LENGTH)) })
    expect(overlong.length).toBeGreaterThan(CODEX_AUTHORIZATION_URL_MAX_LENGTH)
    expect(isAllowedAuthorizationUrl(overlong)).toBe(false)
    expect(isAllowedAuthorizationUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedAuthorizationUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedAuthorizationUrl('not a url')).toBe(false)
    expect(isAllowedAuthorizationUrl('')).toBe(false)
  })
})

describe('tuning defaults', () => {
  it('polls well inside the attempt lease', () => {
    expect(CODEX_OAUTH_TUNING_DEFAULTS.attemptLeaseMs).toBeGreaterThan(CODEX_OAUTH_TUNING_DEFAULTS.pollIntervalMs)
    expect(CODEX_OAUTH_TUNING_DEFAULTS.loginDeadlineMs).toBeGreaterThan(CODEX_OAUTH_TUNING_DEFAULTS.attemptLeaseMs)
    expect(CODEX_OAUTH_TUNING_DEFAULTS.attemptRetentionMs).toBeGreaterThan(0)
  })

  it('leaves the callback port to the official implementation', () => {
    expect(CODEX_CALLBACK_PORT).toBe(1455)
  })
})
