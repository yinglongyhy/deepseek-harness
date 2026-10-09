import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import { ProviderInfoService, codexQuota, deepseekBalance } from '../../src/host/provider-info.ts'
import { parseProviderInfoResult } from '../../src/shared/provider-info.ts'

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', () => ({ openaiCodexProvider: () => ({ auth: { oauth: { refresh } } }) }))

const balance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }] }
const window = (used: number, seconds: number) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: 2_000_000_000 })
const quota = { rate_limit: { primary_window: window(18, 18_000), secondary_window: window(39, 604_800) }, access_token: 'server-secret' }
const grant = (): CredentialRecord => ({ kind: 'grant', payload: { type: 'oauth', access: 'access-secret', refresh: 'refresh-secret', accountId: 'account-1', expires: Date.now() + 3_600_000 } })

function bench() {
  const ctx = new Context()
  const descriptors = [
    { ns: 'deepseek-config', value: { apiKeyEnv: 'MY_DEEPSEEK_KEY', baseURL: 'https://api.deepseek.com' } },
    { ns: 'llm-pi-ai', value: { providers: { 'openai-codex': {} } } },
  ]
  const entries = [
    { provider: 'deepseek-official', settingsNs: 'deepseek-config', settingsPath: [] },
    { provider: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'] },
  ]
  let record: CredentialRecord | undefined = grant()
  let key = 'deepseek-secret'
  let serialized = Promise.resolve()
  const credentials = {
    resolve: vi.fn(async () => ({ value: key })),
    readRecord: vi.fn(async () => record),
    modifyRecord: vi.fn((_key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      const result = serialized.then(async () => { record = (await mutate(record)) ?? record; return record })
      serialized = result.then(() => undefined, () => undefined)
      return result
    }),
  }
  ctx.provide('llm', { listConfigurableProviders: () => entries } as never)
  ctx.provide('settings', { describe: () => descriptors } as never)
  ctx.provide('credentials', credentials as never)
  const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return new Response(JSON.stringify(url.includes('deepseek') ? balance : quota))
  })
  const service = new ProviderInfoService(ctx, { refreshIntervalMs: 60_000, requestTimeoutMs: 1_000, request })
  const read = async (provider: string) => {
    const answer = await service.handle({ provider })
    return answer.ok ? parseProviderInfoResult(answer.value)?.info : undefined
  }
  return { ctx, descriptors, entries, credentials, request, service, read,
    setRecord: (value: CredentialRecord | undefined) => { record = value },
    setKey: (value: string) => { key = value },
    getRecord: () => record,
  }
}

afterEach(() => { vi.useRealTimers(); refresh.mockReset() })

describe('provider response projection', () => {
  it('uses total balance, prefers CNY and keeps a zero balance', () => {
    expect(deepseekBalance(balance, 7)).toEqual({ provider: 'deepseek-official', currency: 'CNY', balance: '12.34', queriedAt: 7 })
    expect(deepseekBalance({ balance_infos: [{ currency: 'USD', total_balance: '4' }, { currency: 'CNY', total_balance: '0' }] }, 7)).toMatchObject({ currency: 'CNY', balance: '0' })
    expect(deepseekBalance({ balance_infos: [{ currency: 'USD', total_balance: '2.5' }] }, 7)).toMatchObject({ currency: 'USD', balance: '2.5' })
  })

  it.each([{}, { balance_infos: null }, { balance_infos: [{ currency: 'CNY', total_balance: 'Infinity' }] }, { balance_infos: [{ currency: 'CNY', total_balance: '-1' }] }])('does not manufacture a balance from malformed payload %j', (value) => {
    expect(deepseekBalance(value, 7)).toBeNull()
  })

  it('identifies quota windows by duration, not primary/secondary position', () => {
    const expected = { provider: 'openai-codex', queriedAt: 7,
      fiveHour: { remainingPercent: 82, resetsAt: 2_000_000_000_000 }, week: { remainingPercent: 61, resetsAt: 2_000_000_000_000 } }
    expect(codexQuota(quota, 7)).toEqual(expected)
    expect(codexQuota({ rate_limit: { secondary_window: window(18, 18_000), primary_window: window(39, 604_800) } }, 7)).toEqual(expected)
  })

  it('keeps zero remaining, hides missing windows and ignores unrelated quotas', () => {
    const payload = {
      rate_limit: { primary_window: null, secondary_window: window(100, 604_800) },
      code_review_rate_limit: { primary_window: window(0, 18_000) },
    }
    expect(codexQuota(payload, 7)).toEqual({
      provider: 'openai-codex', queriedAt: 7, week: { remainingPercent: 0, resetsAt: 2_000_000_000_000 },
    })
    expect(codexQuota({ rate_limit: { primary_window: { used_percent: 2, limit_window_seconds: 18_000 } } }, 7))
      .toMatchObject({ fiveHour: { remainingPercent: 98, resetsAt: null } })
  })

  it.each([{}, { rate_limit: null }, { rate_limit: { primary_window: window(101, 18_000) } }, { rate_limit: { primary_window: window(0, 300) } }])('hides unavailable or malformed quota %j', (value) => {
    expect(codexQuota(value, 7)).toBeNull()
  })
})

describe('provider information Host queries', () => {
  it('uses the official route settings/ref and keeps credentials inside Host headers', async () => {
    const app = bench()
    expect(await app.read('deepseek-official')).toMatchObject({ balance: '12.34' })
    expect(app.credentials.resolve).toHaveBeenCalledWith('MY_DEEPSEEK_KEY')
    const requestCall = app.request.mock.calls[0]
    expect(requestCall?.[0]).toBe('https://api.deepseek.com/user/balance')
    expect(requestCall?.[1]).toMatchObject({ method: 'GET', redirect: 'error', headers: { Accept: 'application/json', Authorization: 'Bearer deepseek-secret' } })
    expect(requestCall?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(await app.service.handle({ provider: 'deepseek-official' }))).not.toContain('secret')
  })

  it('queries OAuth usage with the grant account, without refreshing a valid token', async () => {
    const app = bench()
    expect(await app.read('openai-codex')).toMatchObject({ fiveHour: { remainingPercent: 82 }, week: { remainingPercent: 61 } })
    expect(app.request).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({ headers: { Accept: 'application/json', Authorization: 'Bearer access-secret', 'ChatGPT-Account-Id': 'account-1' } }))
    expect(refresh).not.toHaveBeenCalled()
    expect(JSON.stringify(await app.service.handle({ provider: 'openai-codex' }))).not.toContain('secret')
  })

  it('uses public pi-ai refresh under the same record lock and rechecks after acquiring it', async () => {
    const app = bench()
    app.setRecord({ kind: 'grant', payload: { type: 'oauth', access: 'old', refresh: 'old-refresh', accountId: 'account-1', expires: 0 } })
    refresh.mockImplementation(async () => ({ type: 'oauth', access: 'new-access', refresh: 'new-refresh', accountId: 'account-1', expires: Date.now() + 3_600_000 }))
    await Promise.all([app.read('openai-codex'), app.read('openai-codex')])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(app.credentials.modifyRecord).toHaveBeenCalledWith(recordKeyFor('openai-codex'), expect.any(Function))
    expect(app.getRecord()).toMatchObject({ kind: 'grant', payload: { access: 'new-access', refresh: 'new-refresh' } })
    expect(app.request).toHaveBeenCalledTimes(1)
  })

  it('continues with refreshed credentials after the official record-update notification', async () => {
    const app = bench()
    app.ctx.on('credentials/record-updated', app.service.invalidate)
    app.setRecord({ kind: 'grant', payload: { type: 'oauth', access: 'old', refresh: 'old-refresh', accountId: 'account-1', expires: 0 } })
    refresh.mockResolvedValue({ type: 'oauth', access: 'new-access', refresh: 'new-refresh', accountId: 'account-1', expires: Date.now() + 3_600_000 })
    const modify = app.credentials.modifyRecord.getMockImplementation()!
    app.credentials.modifyRecord.mockImplementationOnce(async (key, mutate) => {
      const result = await modify(key, mutate)
      app.ctx.emit('credentials/record-updated', key)
      return result
    })
    expect(await app.read('openai-codex')).toMatchObject({ fiveHour: { remainingPercent: 82 } })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(app.request).toHaveBeenCalledTimes(1)
    expect(app.request.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer new-access' })
  })

  it('never replaces an existing grant with a malformed refresh response', async () => {
    const app = bench()
    const record: CredentialRecord = { kind: 'grant', payload: { type: 'oauth', access: 'old', refresh: 'old-refresh', accountId: 'account-1', expires: 0 } }
    app.setRecord(record)
    refresh.mockResolvedValue({ type: 'oauth', refresh: 'bad-response' })
    expect(await app.read('openai-codex')).toBeNull()
    expect(app.getRecord()).toEqual(record)
    expect(app.request).not.toHaveBeenCalled()
  })

  it('bounds retries if credentials keep changing while auth is resolved', async () => {
    const app = bench()
    app.credentials.resolve.mockImplementation(async () => { app.service.invalidate(); return { value: 'new-secret' } })
    expect(await app.read('deepseek-official')).toBeNull()
    expect(app.credentials.resolve).toHaveBeenCalledTimes(2)
    expect(app.request).not.toHaveBeenCalled()
  })

  it('does not replace a deleted or concurrently rotated grant while waiting for the lock', async () => {
    const app = bench()
    app.setRecord({ kind: 'grant', payload: { type: 'oauth', access: 'old', refresh: 'old-refresh', accountId: 'account-1', expires: 0 } })
    app.credentials.modifyRecord.mockImplementationOnce(async (_key, mutate) => {
      app.setRecord(undefined)
      await mutate(undefined)
      return undefined
    })
    expect(await app.read('openai-codex')).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
    expect(app.request).not.toHaveBeenCalled()
  })

  it('retains the saved grant on a failed refresh and exposes no upstream text', async () => {
    const app = bench()
    const record: CredentialRecord = { kind: 'grant', payload: { type: 'oauth', access: 'old', refresh: 'old-refresh', accountId: 'account-1', expires: 0 } }
    app.setRecord(record)
    refresh.mockRejectedValue(new Error('refresh-secret server response'))
    expect(await app.read('openai-codex')).toBeNull()
    expect(app.getRecord()).toEqual(record)
    expect(app.request).not.toHaveBeenCalled()
  })

  it.each([{ apiKeyEnv: 'OPENAI_API_KEY' }, { baseURL: 'https://proxy.example' }, { api: 'openai-responses' }])('skips unsupported Codex authentication or endpoint overrides %j', async (profile) => {
    const app = bench()
    app.descriptors[1]!.value.providers = { 'openai-codex': profile }
    expect(await app.read('openai-codex')).toBeNull()
    expect(app.credentials.readRecord).not.toHaveBeenCalled()
    expect(app.request).not.toHaveBeenCalled()
  })

  it('skips missing routes, missing credentials, foreign origins and unsupported providers', async () => {
    const app = bench()
    app.descriptors[0]!.value = { apiKeyEnv: 'MY_DEEPSEEK_KEY', baseURL: 'https://proxy.example/anthropic' }
    expect(await app.read('deepseek-official')).toBeNull()
    app.setRecord(undefined)
    expect(await app.read('openai-codex')).toBeNull()
    app.entries.splice(0)
    expect(await app.read('deepseek-official')).toBeNull()
    expect((await app.service.handle({ provider: 'deepseek-account' })).ok).toBe(false)
    expect((await app.service.handle({ provider: 'deepseek-official', apiKey: 'secret' })).ok).toBe(false)
    expect(app.request).not.toHaveBeenCalled()
  })

  it('coalesces simultaneous reads and expires cached values', async () => {
    vi.useFakeTimers()
    const app = bench()
    await Promise.all([app.read('deepseek-official'), app.read('deepseek-official')])
    expect(app.request).toHaveBeenCalledTimes(1)
    await app.read('deepseek-official')
    expect(app.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_001)
    await app.read('deepseek-official')
    expect(app.request).toHaveBeenCalledTimes(2)
  })

  it('invalidates caches on an identity change and discards late replies after invalidation', async () => {
    const app = bench()
    await app.read('deepseek-official')
    app.setKey('other-secret')
    await app.read('deepseek-official')
    expect(app.request).toHaveBeenCalledTimes(2)
    let resolve!: (response: Response) => void
    app.service.invalidate()
    app.request.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done }))
    const old = app.read('deepseek-official')
    await vi.waitFor(() => { expect(app.request).toHaveBeenCalledTimes(3) })
    app.service.invalidate()
    resolve(new Response(JSON.stringify(balance)))
    expect(await old).toBeNull()
    await app.read('deepseek-official')
    expect(app.request).toHaveBeenCalledTimes(4)
  })

  it.each([401, 403, 429, 500])('hides HTTP %i failures and cancels response bodies', async (status) => {
    const app = bench()
    const response = new Response('server-secret', { status })
    const cancel = vi.spyOn(response.body!, 'cancel')
    app.request.mockResolvedValueOnce(response)
    expect(await app.read('openai-codex')).toBeNull()
    expect(cancel).toHaveBeenCalled()
  })

  it('withdraws an upstream request when its RPC caller cancels', async () => {
    const app = bench()
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    app.request.mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener('abort', () =>{  reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    }))
    const result = app.service.handle({ provider: 'deepseek-official' }, controller.signal)
    await vi.waitFor(() => { expect(requestSignal).toBeDefined() })
    controller.abort()
    const response = await result
    expect(requestSignal?.aborted).toBe(true)
    expect(response.ok && parseProviderInfoResult(response.value)?.info).toBeNull()
  })

  it('does not let one cancelled RPC withdraw another RPC request', async () => {
    const app = bench()
    const firstController = new AbortController()
    const requests: Array<{ signal: AbortSignal | undefined; resolve: (value: Response) => void }> = []
    app.request.mockImplementation((_input, init) => new Promise<Response>((resolve) => {
      const signal = init?.signal ?? undefined
      requests.push({ signal, resolve })
      signal?.addEventListener('abort', () => { resolve(new Response('cancelled', { status: 500 })) }, { once: true })
    }))
    const first = app.service.handle({ provider: 'deepseek-official' }, firstController.signal)
    const second = app.service.handle({ provider: 'deepseek-official' }, new AbortController().signal)
    await vi.waitFor(() => { expect(requests).toHaveLength(2) })
    firstController.abort()
    requests[1]?.resolve(new Response(JSON.stringify(balance)))
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.ok && parseProviderInfoResult(firstResult.value)?.info).toBeNull()
    const secondInfo = secondResult.ok ? parseProviderInfoResult(secondResult.value)?.info : undefined
    expect(secondInfo).toMatchObject({ provider: 'deepseek-official', currency: 'CNY', balance: '12.34' })
    expect(typeof secondInfo?.queriedAt).toBe('number')
  })

  it('hides malformed and oversized responses and skips queries after disposal', async () => {
    const app = bench()
    app.request.mockResolvedValueOnce(new Response('not json'))
    expect(await app.read('deepseek-official')).toBeNull()
    app.service.invalidate()
    app.request.mockResolvedValueOnce(new Response('x'.repeat(65_537)))
    expect(await app.read('deepseek-official')).toBeNull()
    app.service.dispose()
    await app.read('openai-codex')
    expect(app.request).toHaveBeenCalledTimes(2)
  })
})
