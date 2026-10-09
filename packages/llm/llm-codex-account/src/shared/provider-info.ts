/** @module @deepseek-ai/dsh-llm-codex-account/shared/provider-info */

/** RPC endpoint that returns sanitized account balance or quota information. */
export const PROVIDER_INFO_ENDPOINT = 'provider-info'

/** Provider identifiers supported by account information requests. */
export const INFO_PROVIDERS = ['deepseek-official', 'openai-codex'] as const

/** Provider identifier accepted by the account information protocol. */
export type InfoProvider = (typeof INFO_PROVIDERS)[number]

/** Remaining Codex quota and its optional reset time. */
export interface QuotaWindow {
  readonly remainingPercent: number
  readonly resetsAt: number | null
}

/** Sanitized balance or quota summary returned by the Host. */
export type ProviderInfo =
  | { readonly provider: 'deepseek-official'; readonly currency: 'CNY' | 'USD'; readonly balance: string; readonly queriedAt: number }
  | { readonly provider: 'openai-codex'; readonly fiveHour?: QuotaWindow; readonly week?: QuotaWindow; readonly queriedAt: number }

/** Provider information payload and the Host's polling interval. */
export interface ProviderInfoResult {
  readonly refreshIntervalMs: number
  readonly info: ProviderInfo | null
}

/** Narrow an untrusted provider identifier to the supported values.
 * @param value - decoded provider identifier.
 * @returns the supported provider, or undefined when the value is unrecognized.
 */
export function infoProvider(value: unknown): InfoProvider | undefined {
  return value === 'deepseek-official' || value === 'openai-codex' ? value : undefined
}

/** Return a non-array object suitable for field validation.
 * @param value - untrusted decoded value.
 * @returns the object, or undefined for null, arrays, and primitives.
 */
export function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Validate a finite, bounded decimal balance string.
 * @param value - untrusted balance value.
 * @returns true when the value is a non-negative decimal string within the size limit.
 */
export function validBalance(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && /^\d+(?:\.\d+)?$/.test(value)
    && Number.isFinite(Number(value))
}

function keysOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}

function quotaWindow(value: unknown): QuotaWindow | undefined {
  const row = objectOf(value)
  if (row === undefined || !keysOnly(row, ['remainingPercent', 'resetsAt'])) return undefined
  const { remainingPercent, resetsAt } = row
  if (typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) return undefined
  if (resetsAt !== null && !timestamp(resetsAt)) return undefined
  return { remainingPercent, resetsAt }
}

/** Validate the closed JSON result consumed by the Client.
 * @param value - untrusted RPC result value.
 * @returns the sanitized result, or undefined when any field is invalid or unexpected.
 */
export function parseProviderInfoResult(value: unknown): ProviderInfoResult | undefined {
  const row = objectOf(value)
  if (row === undefined || !keysOnly(row, ['refreshIntervalMs', 'info'])) return undefined
  const { refreshIntervalMs, info } = row
  if (typeof refreshIntervalMs !== 'number' || !Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 10_000 || refreshIntervalMs > 86_400_000) return undefined
  if (info === null) return { refreshIntervalMs, info: null }
  const data = objectOf(info)
  if (data === undefined || !timestamp(data['queriedAt'])) return undefined
  const queriedAt = data['queriedAt']
  if (data['provider'] === 'deepseek-official') {
    if (!keysOnly(data, ['provider', 'currency', 'balance', 'queriedAt'])) return undefined
    const currency = data['currency']
    if ((currency !== 'CNY' && currency !== 'USD') || !validBalance(data['balance'])) return undefined
    return { refreshIntervalMs, info: { provider: 'deepseek-official', currency, balance: data['balance'], queriedAt } }
  }
  if (data['provider'] !== 'openai-codex' || !keysOnly(data, ['provider', 'fiveHour', 'week', 'queriedAt'])) return undefined
  const fiveHour = data['fiveHour'] === undefined ? undefined : quotaWindow(data['fiveHour'])
  const week = data['week'] === undefined ? undefined : quotaWindow(data['week'])
  if ((data['fiveHour'] !== undefined && fiveHour === undefined) || (data['week'] !== undefined && week === undefined)) return undefined
  if (fiveHour === undefined && week === undefined) return undefined
  return { refreshIntervalMs, info: { provider: 'openai-codex', queriedAt,
    ...fiveHour === undefined ? {} : { fiveHour }, ...week === undefined ? {} : { week } } }
}
