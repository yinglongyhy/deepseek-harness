import { describe, expect, it } from 'vitest'
import { parseProviderInfoResult } from '../../src/shared/provider-info.ts'

const result = { refreshIntervalMs: 60_000, info: { provider: 'openai-codex', queriedAt: 1, week: { remainingPercent: 61, resetsAt: null } } }

describe('provider information wire', () => {
  it('accepts missing windows, real zero values and unavailable information', () => {
    expect(parseProviderInfoResult(result)).toEqual(result)
    const zero = { refreshIntervalMs: 60_000, info: { provider: 'deepseek-official', currency: 'CNY', balance: '0.00', queriedAt: 1 } }
    expect(parseProviderInfoResult(zero)).toEqual(zero)
    expect(parseProviderInfoResult({ refreshIntervalMs: 60_000, info: null })).toEqual({ refreshIntervalMs: 60_000, info: null })
  })

  it.each([
    { ...result, access: 'secret' },
    { ...result, info: { ...result.info, token: 'secret' } },
    { ...result, info: { ...result.info, week: { ...result.info.week, token: 'secret' } } },
    { ...result, info: { ...result.info, week: { remainingPercent: -1, resetsAt: null } } },
    { ...result, info: { ...result.info, week: { remainingPercent: Number.NaN, resetsAt: null } } },
    { ...result, info: { ...result.info, week: { remainingPercent: 0, resetsAt: -1 } } },
    { ...result, info: { provider: 'openai-codex', queriedAt: 1 } },
    { ...result, info: { provider: 'deepseek-account', queriedAt: 1 } },
    { ...result, refreshIntervalMs: 0 },
    { ...result, refreshIntervalMs: Number.POSITIVE_INFINITY },
    { ...result, info: { ...result.info, queriedAt: Number.NaN } },
    { ...result, info: { provider: 'deepseek-official', queriedAt: 1, balance: '0', currency: 'EUR' } },
  ])('rejects widened or malformed responses %j', (value) => {
    expect(parseProviderInfoResult(value)).toBeUndefined()
  })
})
