/**
 * Bounded, sanitized account information from the official provider endpoints.
 * @module @deepseek-ai/dsh-llm-codex-account/host/provider-info
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { Config as DeepSeekConfig, plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import type { ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'
import { infoProvider, objectOf, validBalance, type InfoProvider, type ProviderInfo, type ProviderInfoResult, type QuotaWindow } from '../shared/provider-info.ts'

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_KEY = recordKeyFor('openai-codex')
const oauth = openaiCodexProvider().auth.oauth

/** Request limits and optional Fetch implementation for provider information. */
export interface ProviderInfoOptions {
  /** Cache lifetime for successful and unavailable results. */
  readonly refreshIntervalMs: number
  /** Maximum time allowed for credential refresh and upstream Fetch. */
  readonly requestTimeoutMs: number
  /** Fetch implementation; defaults to the Host's global Fetch. */
  readonly request?: typeof fetch
}

interface RequestAuth {
  readonly url: string
  readonly headers: Record<string, string>
}

function profileFor(ctx: Context, provider: InfoProvider): Record<string, unknown> | undefined {
  const entry = ctx.get('llm')?.listConfigurableProviders().find(row => row.provider === provider)
  if (entry === undefined) return undefined
  const descriptor = ctx.get('settings')?.describe().find(row => row.ns === entry.settingsNs)
  let profile: unknown = descriptor?.value
  for (const segment of entry.settingsPath) profile = objectOf(profile)?.[segment]
  return objectOf(profile)
}

function oauthCredential(record: CredentialRecord | undefined): OAuthCredential | undefined {
  const payload = record?.kind === 'grant' ? objectOf(record.payload) : undefined
  if (payload?.['type'] !== 'oauth' || typeof payload['access'] !== 'string' || payload['access'].length === 0
    || typeof payload['refresh'] !== 'string' || payload['refresh'].length === 0
    || typeof payload['expires'] !== 'number' || !Number.isSafeInteger(payload['expires'])) return undefined
  return { ...payload, type: 'oauth', access: payload['access'], refresh: payload['refresh'], expires: payload['expires'] }
}

async function codexAuth(ctx: Context, signal: AbortSignal): Promise<RequestAuth | undefined> {
  const profile = profileFor(ctx, 'openai-codex')
  if (profile === undefined || profile['apiKeyEnv'] !== undefined || profile['baseURL'] !== undefined || profile['api'] !== undefined) return undefined
  const credentials = ctx.get('credentials')
  if (credentials === undefined || oauth === undefined) return undefined
  let credential = oauthCredential(await credentials.readRecord(CODEX_KEY))
  if (credential === undefined) return undefined
  if (credential.expires < Date.now() + 300_000) {
    // Use the adapter's record key and lock for refresh, never a parallel token store.
    const record = await credentials.modifyRecord(CODEX_KEY, async (current) => {
      const latest = oauthCredential(current)
      if (latest === undefined) return undefined
      signal.throwIfAborted()
      if (latest.expires >= Date.now() + 300_000) return undefined
      const refreshed = await oauth.refresh(latest, signal)
      let payload: unknown
      try { payload = JSON.parse(JSON.stringify(refreshed)) }
      catch { throw new Error('provider-info-invalid-credential') }
      const replacement: CredentialRecord = { kind: 'grant', payload }
      if (oauthCredential(replacement) === undefined) throw new Error('provider-info-invalid-credential')
      return replacement
    })
    credential = oauthCredential(record)
  }
  if (credential === undefined || credential.expires <= Date.now()) return undefined
  const accountId = credential['accountId']
  if (typeof accountId !== 'string' || accountId.length === 0) return undefined
  return { url: CODEX_USAGE_URL, headers: { Authorization: `Bearer ${credential.access}`, 'ChatGPT-Account-Id': accountId } }
}

async function deepseekAuth(ctx: Context): Promise<RequestAuth | undefined> {
  const profile = profileFor(ctx, 'deepseek-official')
  if (profile === undefined) return undefined
  const environment = launchEnvironmentOf(ctx)
  const options = resolveAdapterOptions(plainOptions(DeepSeekConfig(profile)), environment)
  const endpoint = URL.parse(options.baseURL)
  if (endpoint === null || endpoint.origin !== 'https://api.deepseek.com' || endpoint.username !== '' || endpoint.password !== '') return undefined
  const credentials = ctx.get('credentials')
  const key = credentials === undefined
    ? environment.get(options.apiKeyEnv)?.value
    : (await credentials.resolve(credentialRef(options.apiKeyEnv)))?.value
  if (key === undefined || key.length === 0) return undefined
  return { url: DEEPSEEK_BALANCE_URL, headers: { Authorization: `Bearer ${key}` } }
}

/** Select the preferred supported currency from a DeepSeek balance response.
 * @param payload - decoded response from the official balance endpoint.
 * @param queriedAt - timestamp assigned to the summary.
 * @returns a sanitized balance summary, or null when no supported balance exists.
 */
export function deepseekBalance(payload: unknown, queriedAt: number): ProviderInfo | null {
  const rows = objectOf(payload)?.['balance_infos']
  if (!Array.isArray(rows)) return null
  const balances = rows.flatMap((value) => {
    const row = objectOf(value)
    const currency = row?.['currency']
    const balance = row?.['total_balance']
    return (currency === 'CNY' || currency === 'USD') && validBalance(balance) ? [{ currency, balance }] : []
  })
  const preferred = balances.find(row => row.currency === 'CNY') ?? balances[0]
  if (preferred === undefined) return null
  return { provider: 'deepseek-official', currency: preferred.currency as 'CNY' | 'USD', balance: preferred.balance, queriedAt }
}

/** Convert the official Codex usage response into recognized quota windows.
 * @param payload - decoded response from the official usage endpoint.
 * @param queriedAt - timestamp assigned to the summary.
 * @returns sanitized quota windows, or null when the response has none.
 */
export function codexQuota(payload: unknown, queriedAt: number): ProviderInfo | null {
  const limits = objectOf(objectOf(payload)?.['rate_limit'])
  if (limits === undefined) return null
  let fiveHour: QuotaWindow | undefined
  let week: QuotaWindow | undefined
  for (const value of [limits['primary_window'], limits['secondary_window']]) {
    const window = objectOf(value)
    const used = window?.['used_percent']
    const seconds = window?.['limit_window_seconds']
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue
    const reset = window?.['reset_at']
    const resetsAt = typeof reset === 'number' && Number.isSafeInteger(reset) && reset >= 0 && reset <= 8_640_000_000_000 ? reset * 1000 : null
    const quota = { remainingPercent: 100 - used, resetsAt }
    if (seconds === 18_000) fiveHour = quota
    if (seconds === 604_800) week = quota
  }
  if (fiveHour === undefined && week === undefined) return null
  return { provider: 'openai-codex', queriedAt,
    ...fiveHour === undefined ? {} : { fiveHour }, ...week === undefined ? {} : { week } }
}

async function readJson(request: typeof fetch, auth: RequestAuth, signal: AbortSignal): Promise<unknown> {
  const response = await request(auth.url, { method: 'GET', headers: { Accept: 'application/json', ...auth.headers }, redirect: 'error', signal })
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new Error('provider-info-unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 65_536) throw new Error('provider-info-invalid-response')
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

/** Fetches provider account summaries with bounded requests and sanitized results. */
export class ProviderInfoService {
  private generation = 0
  private readonly lifetime = new AbortController()
  private readonly cache = new Map<InfoProvider, { identity: string; expires: number; info: ProviderInfo | null }>()
  private readonly pending = new Map<string, Promise<ProviderInfo | null>>()

  /** @param ctx - Host context providing settings, credentials, and provider registrations.
   * @param options - request bounds and optional Fetch implementation.
   */
  constructor(private readonly ctx: Context, private readonly options: ProviderInfoOptions) {}

  /** Invalidate cached summaries and discard in-flight results from the prior generation. */
  readonly invalidate = (): void => {
    this.generation++
    this.cache.clear()
    this.pending.clear()
  }

  /** Abort outstanding work and clear cached provider information. */
  dispose(): void {
    this.lifetime.abort()
    this.invalidate()
  }

  /**
   * Return one provider summary without forwarding upstream text or credentials.
   * @param payload - decoded provider information request.
   * @param requestSignal - signal withdrawn when the RPC caller cancels.
   * @returns the validated summary result, or null information on unavailable data.
   */
  async handle(payload: unknown, requestSignal?: AbortSignal): Promise<ConnectionRpcHandlerResult> {
    const row = objectOf(payload)
    const provider = infoProvider(row?.['provider'])
    if (row === undefined || Object.keys(row).length !== 1 || provider === undefined) {
      return { ok: false, error: { code: 'invalid-request', message: 'the provider information request was refused', details: {} } }
    }
    let info: ProviderInfo | null = null
    try { info = await this.read(provider, requestSignal) }
    catch (error) { void error /* Upstream details may contain credentials; return unavailable data instead. */ }
    const result: ProviderInfoResult = { info, refreshIntervalMs: this.options.refreshIntervalMs }
    return { ok: true, value: result }
  }

  private async read(provider: InfoProvider, requestSignal?: AbortSignal, retry = false): Promise<ProviderInfo | null> {
    if (this.lifetime.signal.aborted || requestSignal?.aborted === true) return null
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
    const signal = requestSignal === undefined
      ? AbortSignal.any([this.lifetime.signal, timeout])
      : AbortSignal.any([this.lifetime.signal, requestSignal, timeout])
    const generation = this.generation
    const auth = provider === 'deepseek-official' ? await deepseekAuth(this.ctx) : await codexAuth(this.ctx, signal)
    if (signal.aborted) return null
    if (generation !== this.generation) return retry ? null : this.read(provider, requestSignal, true)
    if (auth === undefined) return null
    const identity = createHash('sha256').update(JSON.stringify(auth)).digest('hex')
    const cached = this.cache.get(provider)
    if (cached?.identity === identity && cached.expires > Date.now()) return cached.info
    const key = `${provider}:${identity}:${generation}`
    // A caller-owned signal must not cancel another RPC's shared request.
    if (requestSignal !== undefined) return this.query(provider, auth, signal, identity, generation)
    const existing = this.pending.get(key)
    if (existing !== undefined) return existing
    const request = this.query(provider, auth, signal, identity, generation)
    this.pending.set(key, request)
    try { return await request }
    finally { if (this.pending.get(key) === request) this.pending.delete(key) }
  }

  private async query(
    provider: InfoProvider,
    auth: RequestAuth,
    signal: AbortSignal,
    identity: string,
    generation: number,
  ): Promise<ProviderInfo | null> {
    let info: ProviderInfo | null = null
    try {
      const payload = await readJson(this.options.request ?? globalThis.fetch, auth, signal)
      info = provider === 'deepseek-official' ? deepseekBalance(payload, Date.now()) : codexQuota(payload, Date.now())
    } catch (error) { void error /* A failed request is cached briefly rather than retried by every mounted footer. */ }
    if (generation !== this.generation || this.lifetime.signal.aborted) return null
    this.cache.set(provider, { identity, expires: Date.now() + this.options.refreshIntervalMs, info })
    return info
  }
}
