/**
 * Deployment timing of login and provider information.
 *
 * These values are read from this plugin's own Config section rather than
 * hard-coded, and the schema bounds each one so a mistyped value fails the
 * plugin load instead of reaching a timer. They are ordinary (non-volatile)
 * fields: a change takes effect on the next plugin load, which is what a
 * deployment parameter means here.
 */

import z from '@deepseek-ai/schemastery'
import {
  CODEX_OAUTH_POLL_INTERVAL_BOUNDS,
  CODEX_OAUTH_TUNING_DEFAULTS,
  type CodexOAuthTuning,
} from '../shared/index.ts'

/** Ceiling on the deadline and retention windows: a bounded login must not outlive a day. */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * How much room the attempt lease keeps over the poll cadence. A page that
 * polls on the cadence it was handed must never be leased out, so the lease has
 * to cover several missed polls rather than exactly one.
 */
const LEASE_POLL_RATIO = 4

/** Host configuration of the Codex login bridge. */
export interface Config {
  /** Cache lifetime for provider balance and quota summaries. */
  readonly providerInfoRefreshIntervalMs: number
  /** Maximum time allowed to fetch provider information, including credential refresh. */
  readonly providerInfoRequestTimeoutMs: number
  /** Poll cadence the Client is told to use while an attempt is pending. */
  readonly pollIntervalMs: number
  /** Total lifetime of one attempt before the Host withdraws it. */
  readonly loginDeadlineMs: number
  /** Idle time without a `query` after which the Host treats the page as gone. */
  readonly attemptLeaseMs: number
  /** How long a settled attempt stays answerable before its identity is retired. */
  readonly attemptRetentionMs: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  providerInfoRefreshIntervalMs: z.natural().min(10_000).max(MAX_WINDOW_MS).default(60_000),
  providerInfoRequestTimeoutMs: z.natural().min(1).max(120_000).default(10_000),
  pollIntervalMs: z.natural()
    .min(CODEX_OAUTH_POLL_INTERVAL_BOUNDS.min)
    .max(CODEX_OAUTH_POLL_INTERVAL_BOUNDS.max)
    .default(CODEX_OAUTH_TUNING_DEFAULTS.pollIntervalMs),
  loginDeadlineMs: z.natural()
    .min(1)
    .max(MAX_WINDOW_MS)
    .default(CODEX_OAUTH_TUNING_DEFAULTS.loginDeadlineMs),
  attemptLeaseMs: z.natural()
    .min(1)
    .max(MAX_WINDOW_MS)
    .default(CODEX_OAUTH_TUNING_DEFAULTS.attemptLeaseMs),
  attemptRetentionMs: z.natural()
    .min(1)
    .max(MAX_WINDOW_MS)
    .default(CODEX_OAUTH_TUNING_DEFAULTS.attemptRetentionMs),
})

/**
 * Take the validated tuning the bridge runs on.
 *
 * The per-field schema bounds cannot express a relation between fields, so the
 * lease/poll relation is checked here, where a violation fails the plugin load
 * with the entry that has to be corrected.
 * @param config - resolved plugin configuration.
 * @returns the timing the bridge installs.
 * @throws {TypeError} when the lease or retention is too short for the poll cadence.
 */
export function resolveCodexOAuthTuning(config: Config): CodexOAuthTuning {
  const tuning: CodexOAuthTuning = {
    pollIntervalMs: config.pollIntervalMs,
    loginDeadlineMs: config.loginDeadlineMs,
    attemptLeaseMs: config.attemptLeaseMs,
    attemptRetentionMs: config.attemptRetentionMs,
  }
  if (tuning.attemptLeaseMs < tuning.pollIntervalMs * LEASE_POLL_RATIO) {
    throw new TypeError(
      `codex-oauth: attemptLeaseMs (${String(tuning.attemptLeaseMs)}) must be at least `
      + `${String(LEASE_POLL_RATIO)} poll intervals (${String(tuning.pollIntervalMs)}), or a page polling on`
      + ' the cadence it was handed would be leased out mid-login',
    )
  }
  if (tuning.attemptRetentionMs < tuning.pollIntervalMs) {
    throw new TypeError(
      `codex-oauth: attemptRetentionMs (${String(tuning.attemptRetentionMs)}) must cover at least one poll`
      + ` interval (${String(tuning.pollIntervalMs)}), or a settled attempt could be retired before its page`
      + ' asks about it',
    )
  }
  return tuning
}
