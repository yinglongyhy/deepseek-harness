import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexOAuthCancelReason, CodexOAuthTuning } from '../../src/shared/index.ts'
import { codexOAuthAttemptId, codexOAuthOwnerToken } from '../../src/shared/identities.ts'
import { AttemptRegistry } from '../../src/host/attempts.ts'
import { CodexOAuthBridgeFailure } from '../../src/host/failure.ts'

const TUNING: CodexOAuthTuning = {
  pollIntervalMs: 1_000,
  loginDeadlineMs: 300_000,
  attemptLeaseMs: 60_000,
  attemptRetentionMs: 300_000,
}

const IDENTITY = /^[A-Za-z0-9_-]{16,128}$/
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize?state=abc'

afterEach(() => {
  vi.useRealTimers()
})

/** One registry over a fresh release journal. */
function harness(): { registry: AttemptRegistry; released: CodexOAuthCancelReason[] } {
  const released: CodexOAuthCancelReason[] = []
  const registry = new AttemptRegistry({
    tuning: TUNING,
    onReleased: (_record, reason) => { released.push(reason) },
  })
  return { registry, released }
}

describe('attempt identity', () => {
  it('mints one wire-shaped identity per half, distinct between attempts', () => {
    vi.useFakeTimers()
    const { registry } = harness()
    const first = registry.begin()
    expect(first.attemptId).toMatch(IDENTITY)
    expect(first.ownerToken).toMatch(IDENTITY)
    expect(first.attemptId).not.toBe(first.ownerToken)
    expect(first.state).toBe('initiating')
    expect(first.authUrl).toBeNull()
    expect(first.controller.signal.aborted).toBe(false)
    registry.authorized(first)
    const second = registry.begin()
    expect(second.attemptId).not.toBe(first.attemptId)
    expect(second.ownerToken).not.toBe(first.ownerToken)
  })

  it('holds one pending attempt at a time', () => {
    vi.useFakeTimers()
    const { registry } = harness()
    const record = registry.begin()
    expect(() => registry.begin()).toThrow(CodexOAuthBridgeFailure)
    try {
      registry.begin()
    } catch (error) {
      expect((error as CodexOAuthBridgeFailure).code).toBe('busy')
    }
    registry.cancelled(record, 'user')
    expect(registry.begin().state).toBe('initiating')
  })

  it('checks the capability token rather than the attempt id alone', () => {
    vi.useFakeTimers()
    const { registry } = harness()
    const record = registry.begin()
    expect(registry.owns(record, record.ownerToken)).toBe(true)
    expect(registry.owns(record, codexOAuthOwnerToken(`${record.ownerToken}x`))).toBe(false)
  })

  it('answers an unknown identity with nothing and a retired one with its retirement', () => {
    vi.useFakeTimers()
    const { registry } = harness()
    expect(registry.lookup(codexOAuthAttemptId('a'.repeat(32)))).toBeUndefined()
    const record = registry.begin()
    registry.authorized(record)
    vi.advanceTimersByTime(TUNING.attemptRetentionMs)
    expect(registry.lookup(record.attemptId)).toEqual({ kind: 'retired' })
  })
})

describe('attempt bounds', () => {
  it('shows the authorization URL only while the attempt waits for the browser', () => {
    vi.useFakeTimers()
    const { registry } = harness()
    const record = registry.begin()
    expect(registry.view(record)).toMatchObject({ state: 'initiating', authUrl: null })
    registry.waitForBrowser(record, AUTHORIZE_URL)
    expect(registry.view(record)).toMatchObject({ state: 'waiting-browser', authUrl: AUTHORIZE_URL })
    registry.authorized(record)
    expect(registry.view(record)).toMatchObject({ state: 'authorized', authUrl: null, cancelReason: null, errorCode: null })
  })

  it('keeps the lease while the page polls on its cadence', () => {
    vi.useFakeTimers()
    const { registry, released } = harness()
    const record = registry.begin()
    for (let poll = 0; poll < 4; poll += 1) {
      vi.advanceTimersByTime(TUNING.attemptLeaseMs - 1)
      registry.touch(record)
    }
    expect(released).toEqual([])
    expect(registry.view(record).state).toBe('initiating')
  })

  it('releases an attempt whose page stopped polling', () => {
    vi.useFakeTimers()
    const { registry, released } = harness()
    const record = registry.begin()
    vi.advanceTimersByTime(TUNING.attemptLeaseMs)
    expect(released).toEqual(['page-closed'])
    expect(registry.view(record)).toMatchObject({ state: 'cancelled', cancelReason: 'page-closed', authUrl: null })
    expect(record.controller.signal.aborted).toBe(true)
  })

  it('releases an attempt that outlived the login deadline even while it is polled', () => {
    vi.useFakeTimers()
    const { registry, released } = harness()
    const record = registry.begin()
    for (let step = 0; step < 6; step += 1) {
      vi.advanceTimersByTime(TUNING.loginDeadlineMs / 6)
      registry.touch(record)
    }
    expect(released).toEqual(['timeout'])
    expect(registry.view(record)).toMatchObject({ state: 'cancelled', cancelReason: 'timeout' })
  })

  it('lets a settled attempt keep its outcome and releases it once', () => {
    vi.useFakeTimers()
    const { registry, released } = harness()
    const record = registry.begin()
    registry.authorized(record)
    registry.cancelled(record, 'user')
    expect(registry.view(record).state).toBe('authorized')
    vi.advanceTimersByTime(TUNING.loginDeadlineMs + TUNING.attemptLeaseMs)
    expect(released).toEqual([])
    expect(registry.view(record).state).toBe('authorized')
  })

  it('stops a released attempt from being released again', () => {
    vi.useFakeTimers()
    const { registry, released } = harness()
    registry.begin()
    vi.advanceTimersByTime(TUNING.attemptLeaseMs)
    vi.advanceTimersByTime(TUNING.attemptRetentionMs)
    expect(released).toEqual(['page-closed'])
  })

  it('retains settled views under a fixed bound, retiring the oldest identity first', () => {
    vi.useFakeTimers()
    const { registry } = harness()
    const attempts = []
    for (let index = 0; index < 10; index += 1) {
      const record = registry.begin()
      registry.authorized(record)
      attempts.push(record)
    }
    const live = attempts.filter(record => registry.lookup(record.attemptId)?.kind === 'live')
    const retired = attempts.filter(record => registry.lookup(record.attemptId)?.kind === 'retired')
    expect(live).toHaveLength(8)
    expect(retired).toHaveLength(2)
    expect(retired[0]?.attemptId).toBe(attempts[0]?.attemptId)
    expect(retired[1]?.attemptId).toBe(attempts[1]?.attemptId)
  })

  it('drops every bound and controller when the plugin unloads', () => {
    vi.useFakeTimers()
    const { registry, released } = harness()
    const record = registry.begin()
    registry.dispose()
    expect(record.controller.signal.aborted).toBe(true)
    vi.advanceTimersByTime(TUNING.loginDeadlineMs + TUNING.attemptRetentionMs)
    expect(released).toEqual([])
    expect(registry.lookup(record.attemptId)).toBeUndefined()
    expect(registry.active).toBeUndefined()
  })
})
