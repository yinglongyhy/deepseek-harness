import { describe, expect, it } from 'vitest'
import { CODEX_OAUTH_POLL_INTERVAL_BOUNDS, CODEX_OAUTH_TUNING_DEFAULTS } from '../../src/shared/index.ts'
import { resolveCodexOAuthTuning } from '../../src/host/config.ts'
import { tuningConfig } from './seams.ts'

describe('codex login tuning', () => {
  it('starts from the shared tuning when the deployment configures nothing', () => {
    expect(resolveCodexOAuthTuning(tuningConfig())).toEqual(CODEX_OAUTH_TUNING_DEFAULTS)
  })

  it('keeps the poll cadence inside what the Client accepts', () => {
    expect(tuningConfig({ pollIntervalMs: CODEX_OAUTH_POLL_INTERVAL_BOUNDS.min }).pollIntervalMs)
      .toBe(CODEX_OAUTH_POLL_INTERVAL_BOUNDS.min)
    expect(tuningConfig({ pollIntervalMs: CODEX_OAUTH_POLL_INTERVAL_BOUNDS.max }).pollIntervalMs)
      .toBe(CODEX_OAUTH_POLL_INTERVAL_BOUNDS.max)
    expect(() => tuningConfig({ pollIntervalMs: CODEX_OAUTH_POLL_INTERVAL_BOUNDS.min - 1 })).toThrow()
    expect(() => tuningConfig({ pollIntervalMs: CODEX_OAUTH_POLL_INTERVAL_BOUNDS.max + 1 })).toThrow()
  })

  it('bounds the deadline and retention windows', () => {
    expect(() => tuningConfig({ loginDeadlineMs: 0 })).toThrow()
    expect(() => tuningConfig({ loginDeadlineMs: 24 * 60 * 60 * 1000 + 1 })).toThrow()
    expect(() => tuningConfig({ attemptRetentionMs: -1 })).toThrow()
    expect(() => tuningConfig({ attemptRetentionMs: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => tuningConfig({ attemptLeaseMs: 1.5 })).toThrow()
  })

  it('refuses a lease a page polling on its cadence would outlive', () => {
    expect(() => resolveCodexOAuthTuning(tuningConfig({ pollIntervalMs: 1_000, attemptLeaseMs: 1_001 })))
      .toThrow(/attemptLeaseMs/)
  })

  it('refuses a retention shorter than one poll interval', () => {
    expect(() => resolveCodexOAuthTuning(tuningConfig({ pollIntervalMs: 1_000, attemptRetentionMs: 999 })))
      .toThrow(/attemptRetentionMs/)
  })

  it('accepts a deployment that keeps the relations', () => {
    const tuning = resolveCodexOAuthTuning(tuningConfig({
      pollIntervalMs: 2_000,
      loginDeadlineMs: 60_000,
      attemptLeaseMs: 8_000,
      attemptRetentionMs: 4_000,
    }))
    expect(tuning).toEqual({
      pollIntervalMs: 2_000,
      loginDeadlineMs: 60_000,
      attemptLeaseMs: 8_000,
      attemptRetentionMs: 4_000,
    })
  })
})
