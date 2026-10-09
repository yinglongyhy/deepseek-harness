/**
 * Timing this bundle exposes instead of hard-coding at each call site. The
 * Host Config schema takes these as its defaults and the Client reads the
 * cadence the Host hands back with `begin`, so both faces cannot silently
 * disagree about a deployment's tuning.
 */

/** Deployment-tunable timing of the login bridge. */
export interface CodexOAuthTuning {
  /** Client poll cadence for `query` while an attempt is pending. */
  pollIntervalMs: number
  /** Host-side limit on one attempt's total lifetime. */
  loginDeadlineMs: number
  /** Host-side idle lease after which an unqueried attempt is released. */
  attemptLeaseMs: number
  /** Host-side retention of a terminal attempt view for late `query` calls. */
  attemptRetentionMs: number
}

/** Inclusive bounds a poll interval must satisfy to be usable by a browser timer. */
export const CODEX_OAUTH_POLL_INTERVAL_BOUNDS = { min: 250, max: 30_000 } as const

/** Defaults the Host Config schema starts from. */
export const CODEX_OAUTH_TUNING_DEFAULTS: CodexOAuthTuning = {
  pollIntervalMs: 1_000,
  loginDeadlineMs: 300_000,
  attemptLeaseMs: 60_000,
  attemptRetentionMs: 300_000,
}
