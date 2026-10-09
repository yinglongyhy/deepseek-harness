import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'
import type { CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import {
  CODEX_CALLBACK_PORT,
  CODEX_OAUTH_PROTOCOL_VERSION,
  parseCodexOAuthAttemptView,
  parseCodexOAuthBeginResult,
  parseCodexOAuthEnableRouteResult,
  parseCodexOAuthLogoutResult,
  parseCodexOAuthStatusResult,
  type CodexOAuthAttemptView,
  type CodexOAuthBeginResult,
  type CodexOAuthEnableRouteResult,
  type CodexOAuthLogoutResult,
  type CodexOAuthParseResult,
} from '../../src/shared/index.ts'
import type { CodexOAuthAttemptId, CodexOAuthOwnerToken } from '../../src/shared/identities.ts'
import type { CallbackPortProbe } from '../../src/host/probe.ts'
import {
  CODEX_MANUAL_PROMPT,
  CODEX_METHOD_PROMPT,
  codexDirectoryEntry,
  createHarness,
  deferred,
  descriptor,
  officialAuthorizeUrl,
  type BridgeHarness,
} from './seams.ts'

const OFFICIAL_URL = officialAuthorizeUrl()

/** A flow body that never settles, standing in for a login waiting on a browser. */
const pendingFlow = async (): Promise<void> =>{  await new Promise<void>(() => {}) }

beforeEach(() => {
  delete process.env['PI_OAUTH_CALLBACK_HOST']
})

afterEach(() => {
  delete process.env['PI_OAUTH_CALLBACK_HOST']
  vi.useRealTimers()
})

/** Let pending microtasks run, without depending on a timer. */
async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** Let the background runner reach its next await. */
async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** The value of a success answer, validated by the Client's own parser so Host and Client cannot disagree. */
function answer<T>(
  result: ConnectionRpcHandlerResult,
  parse: (value: unknown) => CodexOAuthParseResult<T>,
): T {
  if (!result.ok) throw new Error(`expected a value, got the refusal ${result.error.code}`)
  const parsed = parse(result.value)
  if (!parsed.ok) throw new Error(`the Host answered a value the Client refuses (${parsed.code}): ${JSON.stringify(result.value)}`)
  return parsed.value
}

/** The refusal code of an answer, or undefined for a success. */
function refusal(result: ConnectionRpcHandlerResult): string | undefined {
  return result.ok ? undefined : result.error.code
}

/** Start one attempt and return its identity. */
async function beginAttempt(harness: BridgeHarness): Promise<CodexOAuthBeginResult> {
  return answer(await harness.call('begin', { provider: 'openai-codex' }), parseCodexOAuthBeginResult)
}

/** The exact credential payload the wire declares for `query` and `cancel`. */
function credentialOf(begin: CodexOAuthBeginResult): { attemptId: CodexOAuthAttemptId; ownerToken: CodexOAuthOwnerToken } {
  return { attemptId: begin.attemptId, ownerToken: begin.ownerToken }
}

/** The attempt view an owned query returns. */
async function queryAttempt(harness: BridgeHarness, credential: CodexOAuthBeginResult): Promise<CodexOAuthAttemptView> {
  return answer(await harness.call('query', credentialOf(credential)), parseCodexOAuthAttemptView)
}

describe('channel dispatch', () => {
  it('refuses an endpoint this bundle does not own', async () => {
    const harness = createHarness()
    expect(refusal(await harness.call('authorize-anything', {}))).toBe('invalid-request')
    expect(refusal(await harness.call('', {}))).toBe('invalid-request')
  })

  it('refuses a payload the wire does not declare', async () => {
    const harness = createHarness()
    expect(refusal(await harness.call('status', { extra: true }))).toBe('invalid-request')
    expect(refusal(await harness.call('begin', {}))).toBe('invalid-request')
    expect(refusal(await harness.call('query', { attemptId: 'x'.repeat(32) }))).toBe('invalid-request')
    expect(refusal(await harness.call('cancel', { attemptId: 'x'.repeat(32), ownerToken: 'y'.repeat(32), reason: 'timeout' })))
      .toBe('invalid-request')
    expect(refusal(await harness.call('enable-route', { namespaceRevision: 1, removeApiKeyEnv: true }))).toBe('invalid-request')
    expect(refusal(await harness.call('models', { extra: true }))).toBe('invalid-request')
    expect(refusal(await harness.call('save-models', { namespaceRevision: 1 }))).toBe('invalid-request')
    expect(refusal(await harness.call('save-models', { namespaceRevision: 1, modelIds: [] }))).toBe('invalid-request')
  })

  it('serves the Codex provider alone', async () => {
    const harness = createHarness()
    expect(refusal(await harness.call('begin', { provider: 'anthropic' }))).toBe('provider-unsupported')
  })

  it('carries no provider text in a refusal', async () => {
    const harness = createHarness()
    const result = await harness.call('begin', { provider: 'anthropic' })
    expect(JSON.stringify(result)).not.toMatch(/anthropic/)
  })
})

describe('status', () => {
  it('reports a composed login as available at the protocol version the Client speaks', async () => {
    const harness = createHarness()
    const status = answer(await harness.call('status'), parseCodexOAuthStatusResult)
    expect(status.protocolVersion).toBe(CODEX_OAUTH_PROTOCOL_VERSION)
    expect(status.capability).toEqual({ available: true, gap: null })
    expect(status.record.stored).toBe(false)
    expect(status.route).toEqual({ configured: false, namespaceRevision: null })
  })

  it('names the first missing dependency in the order a login needs it', async () => {
    expect(answer(await createHarness({ connection: false }).call('status'), parseCodexOAuthStatusResult).capability)
      .toEqual({ available: false, gap: 'connection-unavailable' })
    expect(answer(await createHarness({ authorization: false }).call('status'), parseCodexOAuthStatusResult).capability)
      .toEqual({ available: false, gap: 'authorization-unavailable' })
    expect(answer(await createHarness({ credentials: false }).call('status'), parseCodexOAuthStatusResult).capability)
      .toEqual({ available: false, gap: 'credentials-unavailable' })
    expect(answer(await createHarness({ settings: false }).call('status'), parseCodexOAuthStatusResult).capability)
      .toEqual({ available: false, gap: 'settings-unavailable' })
  })

  it('reports the official Codex flow itself as the missing dependency when none is registered', async () => {
    const harness = createHarness()
    harness.authorization.registered = false
    const status = answer(await harness.call('status'), parseCodexOAuthStatusResult)
    expect(status.capability).toEqual({ available: false, gap: 'codex-flow-unavailable' })
  })

  it('reads credential presence from the official store, never its contents', async () => {
    const harness = createHarness()
    expect(answer(await harness.call('status'), parseCodexOAuthStatusResult).record.stored).toBe(false)
    harness.credentials.stored = true
    expect(answer(await harness.call('status'), parseCodexOAuthStatusResult).record.stored).toBe(true)
    expect(harness.credentials.calls).toEqual(['describeRecord', 'describeRecord'])
  })

  it('reads the route from the settings section the official directory names', async () => {
    const harness = createHarness({
      directory: [codexDirectoryEntry('llm-pi-ai-custom')],
      descriptors: [descriptor({
        ns: 'llm-pi-ai-custom',
        value: { providers: { 'openai-codex': { apiKeyEnv: 'K' } } },
        revision: 4,
      })],
    })
    expect(answer(await harness.call('status'), parseCodexOAuthStatusResult).route)
      .toEqual({ configured: true, namespaceRevision: 4 })
  })

  it('reports the route as unreadable when no settings section exists', async () => {
    const harness = createHarness({ settings: false })
    expect(answer(await harness.call('status'), parseCodexOAuthStatusResult).route.namespaceRevision).toBeNull()
  })

  it('shows a page nothing about another page attempt', async () => {
    const harness = createHarness()
    harness.authorization.flow = (interaction) => {
      interaction.notify({ message: 'Sign in', url: OFFICIAL_URL })
      return pendingFlow()
    }
    const credential = await beginAttempt(harness)
    await flush()
    const status = await harness.call('status')
    expect(status.ok).toBe(true)
    const rendered = JSON.stringify(status)
    expect(rendered).not.toContain(credential.attemptId)
    expect(rendered).not.toContain(credential.ownerToken)
    expect(rendered).not.toContain(OFFICIAL_URL)
  })

  it('answers a transport failure rather than letting an unexpected throw reach the transport', async () => {
    const harness = createHarness()
    harness.credentials.describeRecord = () => Promise.reject(new Error('access_token=leaked-value'))
    const status = await harness.call('status')
    expect(refusal(status)).toBe('transport-failed')
    expect(JSON.stringify(status)).not.toContain('leaked-value')
  })
})

describe('begin', () => {
  it('refuses when no official Codex flow is registered', async () => {
    const harness = createHarness()
    harness.authorization.registered = false
    expect(refusal(await harness.call('begin', { provider: 'openai-codex' }))).toBe('capability-unavailable')
    expect(harness.authorization.started).toBe(0)
  })

  it('answers with the identity and cadence before the flow reaches a browser', async () => {
    const harness = createHarness({ tuning: { pollIntervalMs: 500 } })
    harness.authorization.flow = pendingFlow
    const credential = await beginAttempt(harness)
    expect(credential.state).toBe('initiating')
    expect(credential.pollIntervalMs).toBe(500)
    expect(harness.authorization.started).toBe(1)
  })

  it('refuses a second login while one is running, without starting another', async () => {
    const harness = createHarness()
    harness.authorization.flow = pendingFlow
    await beginAttempt(harness)
    expect(refusal(await harness.call('begin', { provider: 'openai-codex' }))).toBe('busy')
    expect(harness.authorization.started).toBe(1)
  })

  it('reports the official seam busy signal as its own busy refusal', async () => {
    const harness = createHarness()
    harness.authorization.begin = () => {
      const error = new Error('already running')
      Object.assign(error, { code: 'ALREADY_IN_FLIGHT' })
      return Promise.reject(error)
    }
    const credential = await beginAttempt(harness)
    await flush()
    expect((await queryAttempt(harness, credential)).state).toBe('failed')
    expect((await queryAttempt(harness, credential)).errorCode).toBe('busy')
  })

  it('refuses a login whose loopback callback port cannot be bound', async () => {
    const harness = createHarness({ probe: () => Promise.resolve('unavailable') })
    expect(refusal(await harness.call('begin', { provider: 'openai-codex' }))).toBe('callback-port-unavailable')
    expect(harness.authorization.started).toBe(0)
  })

  it('refuses a login whose callback host is not loopback instead of probing it', async () => {
    const harness = createHarness({ probe: () => Promise.resolve('not-probed') })
    expect(refusal(await harness.call('begin', { provider: 'openai-codex' }))).toBe('callback-port-unavailable')
    expect(harness.authorization.started).toBe(0)
  })

  it('asks the callback-port check about the inherited host and the fixed port', async () => {
    const asked: Array<{ host: string; port: number }> = []
    const harness = createHarness({
      probe: (host, port) => {
        asked.push({ host, port })
        return Promise.resolve('available')
      },
    })
    process.env['PI_OAUTH_CALLBACK_HOST'] = 'localhost'
    harness.authorization.flow = pendingFlow
    expect((await beginAttempt(harness)).state).toBe('initiating')
    expect(asked).toEqual([{ host: 'localhost', port: CODEX_CALLBACK_PORT }])
  })

  it('runs the real loopback probe by default and refuses a host it must not bind', async () => {
    process.env['PI_OAUTH_CALLBACK_HOST'] = '192.0.2.10'
    const harness = createHarness({ probe: null })
    expect(refusal(await harness.call('begin', { provider: 'openai-codex' }))).toBe('callback-port-unavailable')
    expect(harness.authorization.started).toBe(0)
    // The configured host is not echoed anywhere a Client or a log can read it.
    expect(harness.logs.map(entry => entry.text).join('\n')).not.toContain('192.0.2.10')
  })

  it('answers the official login-method question with the browser method', async () => {
    const harness = createHarness()
    const answers: string[] = []
    harness.authorization.flow = async (interaction) => {
      answers.push(await interaction.prompt(CODEX_METHOD_PROMPT))
      interaction.notify({ message: 'Sign in', url: OFFICIAL_URL })
      await pendingFlow()
    }
    const credential = await beginAttempt(harness)
    await flush()
    expect(answers).toEqual(['browser'])
    expect((await queryAttempt(harness, credential)).state).toBe('waiting-browser')
  })

  it('refuses an incompatibly shaped login-method question instead of guessing an option', async () => {
    const harness = createHarness()
    harness.authorization.flow = async (interaction) => {
      await interaction.prompt({
        kind: 'select',
        message: 'Select OpenAI Codex login method:',
        options: [{ id: 'device_code', label: 'Device code login (headless)' }],
      })
    }
    const credential = await beginAttempt(harness)
    await flush()
    const view = await queryAttempt(harness, credential)
    expect(view.state).toBe('failed')
    expect(view.errorCode).toBe('login-method-unsupported')
  })

  it('refuses a question kind this browser-only bridge does not answer', async () => {
    const harness = createHarness()
    harness.authorization.flow = async (interaction) => {
      await interaction.prompt({ kind: 'secret', message: 'Paste the API key:' })
    }
    const credential = await beginAttempt(harness)
    await flush()
    expect((await queryAttempt(harness, credential)).errorCode).toBe('login-method-unsupported')
  })

  it('holds the hidden manual-code question pending while the callback finishes the login', async () => {
    const harness = createHarness()
    const callbackLanded = deferred()
    let withdrawn: unknown
    harness.authorization.flow = async (interaction) => {
      interaction.notify({ message: 'Sign in', url: OFFICIAL_URL })
      const manually = new AbortController()
      const hidden = interaction.prompt({ ...CODEX_MANUAL_PROMPT, signal: manually.signal })
      hidden.catch((error: unknown) => { withdrawn = error })
      // The loopback callback lands once the browser visit finishes; the flow
      // then withdraws the question it was racing.
      await callbackLanded.settled
      manually.abort()
      await hidden.catch(() => {})
    }
    const credential = await beginAttempt(harness)
    expect((await queryAttempt(harness, credential)).state).toBe('waiting-browser')
    callbackLanded.resolve(undefined)
    await flush()
    expect((await queryAttempt(harness, credential)).state).toBe('authorized')
    expect((withdrawn as Error).name).toBe('AbortError')
  })

  it('tears the hidden question down when the attempt is withdrawn', async () => {
    const harness = createHarness()
    let withdrawn: unknown
    harness.authorization.flow = async (interaction) => {
      const manually = new AbortController()
      try {
        await interaction.prompt({ ...CODEX_MANUAL_PROMPT, signal: manually.signal })
      } catch (error) {
        withdrawn = error
        throw error
      }
    }
    const credential = await beginAttempt(harness)
    await flush()
    const cancelled = answer(await harness.call('cancel', { ...credentialOf(credential), reason: 'user' }), parseCodexOAuthAttemptView)
    expect(cancelled.state).toBe('cancelled')
    await flush()
    expect((withdrawn as Error).name).toBe('AbortError')
    expect(harness.authorization.running).toBe(false)
  })
})

describe('query', () => {
  it('demands both halves of the attempt identity', async () => {
    const harness = createHarness()
    harness.authorization.flow = pendingFlow
    const credential = await beginAttempt(harness)
    expect(refusal(await harness.call('query', { attemptId: 'z'.repeat(32), ownerToken: credential.ownerToken })))
      .toBe('attempt-unknown')
    const wrongToken = credential.ownerToken.slice(0, -1) + (credential.ownerToken.endsWith('x') ? 'y' : 'x')
    expect(refusal(await harness.call('query', { attemptId: credential.attemptId, ownerToken: wrongToken })))
      .toBe('attempt-forbidden')
  })

  it('carries the authorization URL only while the attempt waits for the browser', async () => {
    const harness = createHarness()
    harness.authorization.flow = pendingFlow
    const credential = await beginAttempt(harness)
    expect(await queryAttempt(harness, credential)).toMatchObject({ state: 'initiating', authUrl: null })
    harness.authorization.interaction?.notify({ message: 'Sign in', url: OFFICIAL_URL })
    expect(await queryAttempt(harness, credential)).toMatchObject({ state: 'waiting-browser', authUrl: OFFICIAL_URL })
  })

  it('keeps a polled attempt alive past its lease', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.authorization.flow = pendingFlow
    const credential = await beginAttempt(harness)
    for (let poll = 0; poll < 4; poll += 1) {
      vi.advanceTimersByTime(harness.tuning.attemptLeaseMs - 1)
      await queryAttempt(harness, credential)
    }
    expect((await queryAttempt(harness, credential)).state).toBe('initiating')
  })

  it('reports an attempt that outlived the login deadline', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.authorization.flow = pendingFlow
    const credential = await beginAttempt(harness)
    const step = harness.tuning.loginDeadlineMs / 6
    for (let poll = 0; poll < 5; poll += 1) {
      vi.advanceTimersByTime(step)
      await queryAttempt(harness, credential)
    }
    vi.advanceTimersByTime(step)
    expect(await queryAttempt(harness, credential)).toMatchObject({ state: 'cancelled', cancelReason: 'timeout' })
    expect(harness.logs.some(entry => entry.text.includes('timeout'))).toBe(true)
  })

  it('reports an attempt its page abandoned', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.authorization.flow = pendingFlow
    const credential = await beginAttempt(harness)
    vi.advanceTimersByTime(harness.tuning.attemptLeaseMs)
    expect(await queryAttempt(harness, credential)).toMatchObject({ state: 'cancelled', cancelReason: 'page-closed' })
  })

  it('answers a retired attempt to its owner alone', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.authorization.flow = pendingFlow
    const credential = await beginAttempt(harness)
    vi.advanceTimersByTime(harness.tuning.loginDeadlineMs + harness.tuning.attemptRetentionMs)
    // A stranger is told even less than that the identity once existed.
    expect(refusal(await harness.call('query', {
      attemptId: credential.attemptId,
      ownerToken: 'x'.repeat(32),
    }))).toBe('attempt-forbidden')
    expect(refusal(await harness.call('query', credentialOf(credential)))).toBe('attempt-expired')
  })
})

describe('cancel', () => {
  it('leaves an attempt another page owns untouched', async () => {
    const harness = createHarness()
    harness.authorization.flow = pendingFlow
    const credential = await beginAttempt(harness)
    harness.authorization.interaction?.notify({ message: 'Sign in', url: OFFICIAL_URL })
    expect(refusal(await harness.call('cancel', { ...credentialOf(credential), ownerToken: 'x'.repeat(32), reason: 'user' })))
      .toBe('attempt-forbidden')
    expect((await queryAttempt(harness, credential)).state).toBe('waiting-browser')
  })

  it('settles the attempt with the reason its page reported', async () => {
    const harness = createHarness()
    harness.authorization.flow = pendingFlow
    const credential = await beginAttempt(harness)
    const view = answer(await harness.call('cancel', { ...credentialOf(credential), reason: 'browser-open-failed' }), parseCodexOAuthAttemptView)
    expect(view).toMatchObject({ state: 'cancelled', cancelReason: 'browser-open-failed', authUrl: null, errorCode: null })
  })

  it('is idempotent and never overwrites a settled outcome', async () => {
    const harness = createHarness()
    harness.authorization.flow = pendingFlow
    const credential = await beginAttempt(harness)
    answer(await harness.call('cancel', { ...credentialOf(credential), reason: 'user' }), parseCodexOAuthAttemptView)
    const again = answer(await harness.call('cancel', { ...credentialOf(credential), reason: 'page-closed' }), parseCodexOAuthAttemptView)
    expect(again).toMatchObject({ state: 'cancelled', cancelReason: 'user' })
  })

  it('does not undo a login the official flow already authorized', async () => {
    const harness = createHarness()
    harness.authorization.flow = async () => {}
    const credential = await beginAttempt(harness)
    await flush()
    expect((await queryAttempt(harness, credential)).state).toBe('authorized')
    expect(answer(await harness.call('cancel', { ...credentialOf(credential), reason: 'user' }), parseCodexOAuthAttemptView).state)
      .toBe('authorized')
  })
})

describe('logout', () => {
  it('removes the local record and reports that it did', async () => {
    const harness = createHarness()
    harness.credentials.stored = true
    const result: CodexOAuthLogoutResult = answer(await harness.call('logout'), parseCodexOAuthLogoutResult)
    expect(result).toEqual({ removed: true })
    expect(harness.credentials.calls).toEqual(['describeRecord', 'deleteRecord'])
    expect(harness.credentials.stored).toBe(false)
  })

  it('reports an absent record without touching the store', async () => {
    const harness = createHarness()
    expect(answer(await harness.call('logout'), parseCodexOAuthLogoutResult)).toEqual({ removed: false })
    expect(harness.credentials.calls).toEqual(['describeRecord'])
  })

  it('refuses to delete a record under a running login', async () => {
    const harness = createHarness()
    harness.credentials.stored = true
    harness.authorization.flow = pendingFlow
    await beginAttempt(harness)
    expect(refusal(await harness.call('logout'))).toBe('logout-blocked')
    expect(harness.credentials.calls).toEqual([])
  })

  it('refuses to delete a record under an official attempt this bridge did not start', async () => {
    const harness = createHarness()
    harness.credentials.stored = true
    harness.authorization.running = true
    expect(refusal(await harness.call('logout'))).toBe('logout-blocked')
    expect(harness.credentials.calls).toEqual([])
  })

  it('refuses without a credential store', async () => {
    expect(refusal(await createHarness({ credentials: false }).call('logout'))).toBe('capability-unavailable')
  })
})

describe('enable-route', () => {
  const CODEX_ROUTE = { op: 'set', path: ['providers', 'openai-codex'], value: {} }

  it('adds the one provider leaf under the revision the page read', async () => {
    const harness = createHarness({ descriptors: [descriptor({ revision: 3 })] })
    const result: CodexOAuthEnableRouteResult = answer(
      await harness.call('enable-route', { namespaceRevision: 3 }),
      parseCodexOAuthEnableRouteResult,
    )
    expect(result.configured).toBe(true)
    expect(harness.settings.writes).toEqual([{ ns: 'llm-pi-ai', ops: [CODEX_ROUTE], expectedRevision: 3 }])
  })

  it('leaves an existing route exactly as it is', async () => {
    const harness = createHarness({
      descriptors: [descriptor({
        revision: 5,
        value: { providers: { 'openai-codex': { displayName: 'Codex', models: { 'gpt-5': {} } }, anthropic: {} } },
      })],
    })
    const result = answer(
      await harness.call('enable-route', { namespaceRevision: 5 }),
      parseCodexOAuthEnableRouteResult,
    )
    expect(result.namespaceRevision).toBe(5)
    expect(harness.settings.writes).toEqual([])
  })

  it('refuses to replace an existing malformed provider value', async () => {
    const harness = createHarness({
      descriptors: [descriptor({ revision: 5, value: { providers: { 'openai-codex': 'preserve' } } })],
    })
    expect(refusal(await harness.call('enable-route', { namespaceRevision: 5 }))).toBe('route-write-failed')
    expect(harness.settings.writes).toEqual([])
  })

  it('checks the revision fence even when an existing route needs no write', async () => {
    const harness = createHarness({
      descriptors: [descriptor({ revision: 9, value: { providers: { 'openai-codex': {} } } })],
    })
    expect(refusal(await harness.call('enable-route', { namespaceRevision: 4 })))
      .toBe('route-revision-conflict')
    expect(harness.settings.writes).toEqual([])
  })

  it('refuses a page acting on a revision the section has left behind', async () => {
    const harness = createHarness({ descriptors: [descriptor({ revision: 9 })] })
    harness.settings.outcome = 'conflict'
    expect(refusal(await harness.call('enable-route', { namespaceRevision: 4 })))
      .toBe('route-revision-conflict')
  })

  it('reports a refused write without provider text', async () => {
    const harness = createHarness({ descriptors: [descriptor({ revision: 2 })] })
    harness.settings.outcome = 'refuse'
    const result = await harness.call('enable-route', { namespaceRevision: 2 })
    expect(refusal(result)).toBe('route-write-failed')
    expect(JSON.stringify(result)).not.toContain('read-only')
  })

  it('refuses to change the route under a running login', async () => {
    const harness = createHarness({ descriptors: [descriptor({ revision: 1 })] })
    harness.authorization.flow = pendingFlow
    await beginAttempt(harness)
    expect(refusal(await harness.call('enable-route', { namespaceRevision: 1 })))
      .toBe('busy')
    expect(harness.settings.writes).toEqual([])
  })

  it('refuses without a settings service or a configurable section', async () => {
    expect(refusal(await createHarness({ settings: false }).call(
      'enable-route',
      { namespaceRevision: 1 },
    ))).toBe('capability-unavailable')
    expect(refusal(await createHarness({ descriptors: [] }).call(
      'enable-route',
      { namespaceRevision: 1 },
    ))).toBe('capability-unavailable')
  })
})

/**
 * The three operations that change the record plane must not interleave: each
 * claims the instance before its first await and answers a second caller with
 * its own refusal code instead of queueing behind the first.
 */
describe('exclusive operations', () => {
  it('holds a logout out while a login is still asking about its callback port', async () => {
    const probe = deferred<CallbackPortProbe>()
    const harness = createHarness({ probe: () => probe.settled })
    const starting = harness.call('begin', { provider: 'openai-codex' })
    await tick()
    expect(refusal(await harness.call('logout'))).toBe('logout-blocked')
    probe.resolve('available')
    expect(answer(await starting, parseCodexOAuthBeginResult).state).toBe('initiating')
  })

  it('holds a login out while a logout is still reading the record it will delete', async () => {
    const read = deferred<CredentialRecordInfo>()
    const harness = createHarness()
    harness.credentials.stored = true
    harness.credentials.describeRecord = () => read.settled
    const loggingOut = harness.call('logout')
    await tick()
    expect(refusal(await harness.call('begin', { provider: 'openai-codex' }))).toBe('busy')
    expect(harness.authorization.started).toBe(0)
    read.resolve({ configured: true, writable: true })
    expect(answer(await loggingOut, parseCodexOAuthLogoutResult)).toEqual({ removed: true })
  })

  it('holds a login out while a route change is still writing', async () => {
    const write = deferred<undefined>()
    const harness = createHarness({ descriptors: [descriptor({ revision: 2 })] })
    harness.settings.hold = write.settled
    const enabling = harness.call('enable-route', { namespaceRevision: 2 })
    await tick()
    expect(refusal(await harness.call('begin', { provider: 'openai-codex' }))).toBe('busy')
    expect(harness.authorization.started).toBe(0)
    write.resolve(undefined)
    expect(answer(await enabling, parseCodexOAuthEnableRouteResult).configured).toBe(true)
  })

  it('leaves an attempt this bridge did not start to the official seam guard', async () => {
    const harness = createHarness()
    harness.authorization.running = true
    expect(refusal(await harness.call('begin', { provider: 'openai-codex' }))).toBe('busy')
    expect(refusal(await harness.call('enable-route', { namespaceRevision: 1 })))
      .toBe('busy')
    expect(refusal(await harness.call('logout'))).toBe('logout-blocked')
  })
})

/** Unloading is final: no flow and no timer survives it, and a late settlement changes nothing. */
describe('unload', () => {
  it('does not delete a record when its description arrives after the plugin unloaded', async () => {
    const read = deferred<CredentialRecordInfo>()
    const harness = createHarness()
    harness.credentials.stored = true
    const describeRecord = vi.spyOn(harness.credentials, 'describeRecord').mockReturnValue(read.settled)
    const deleteRecord = vi.spyOn(harness.credentials, 'deleteRecord')
    const loggingOut = harness.call('logout')
    await tick()
    expect(describeRecord).toHaveBeenCalledTimes(1)
    harness.dispose()
    read.resolve({ configured: true, writable: true })
    expect(refusal(await loggingOut)).toBe('capability-unavailable')
    expect(deleteRecord).not.toHaveBeenCalled()
    expect(harness.credentials.stored).toBe(true)
  })

  it('refuses new record-plane operations after the plugin unloaded', async () => {
    const harness = createHarness({ descriptors: [descriptor({ revision: 2 })] })
    harness.credentials.stored = true
    harness.dispose()
    expect(refusal(await harness.call('logout'))).toBe('capability-unavailable')
    expect(refusal(await harness.call('enable-route', { namespaceRevision: 2 }))).toBe('capability-unavailable')
    expect(harness.credentials.calls).toEqual([])
    expect(harness.credentials.stored).toBe(true)
    expect(harness.settings.writes).toEqual([])
  })

  it('starts no flow when the plugin unloads while the callback port is being checked', async () => {
    vi.useFakeTimers()
    const probe = deferred<CallbackPortProbe>()
    const harness = createHarness({ probe: () => probe.settled })
    const starting = harness.call('begin', { provider: 'openai-codex' })
    await tick()
    harness.dispose()
    probe.resolve('available')
    expect(refusal(await starting)).toBe('capability-unavailable')
    expect(harness.authorization.started).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('arms nothing for a flow that reports back after the plugin unloaded', async () => {
    vi.useFakeTimers()
    const landed = deferred<undefined>()
    const harness = createHarness()
    harness.authorization.flow = async () => { await landed.settled }
    const credential = await beginAttempt(harness)
    harness.dispose()
    expect(vi.getTimerCount()).toBe(0)
    landed.resolve(undefined)
    await tick()
    expect(vi.getTimerCount()).toBe(0)
    expect(refusal(await harness.call('query', credentialOf(credential)))).toBe('attempt-unknown')
  })
})

describe('notice handling', () => {
  it('never forwards a notice message or a device code', async () => {
    const harness = createHarness()
    harness.authorization.flow = async (interaction) => {
      interaction.notify({ message: 'Enter this code on the verification page', code: 'ABCD-1234' })
      await pendingFlow()
    }
    const credential = await beginAttempt(harness)
    await flush()
    const view = await queryAttempt(harness, credential)
    expect(view).toMatchObject({ state: 'initiating', authUrl: null })
    expect(JSON.stringify(view)).not.toContain('ABCD-1234')
  })

  it('ends an attempt whose authorization URL fails the gate, without showing it to a page', async () => {
    const harness = createHarness()
    harness.authorization.flow = async (interaction) => {
      interaction.notify({ message: 'Sign in', url: 'https://evil.example/oauth/authorize?state=abc' })
      await pendingFlow()
    }
    const credential = await beginAttempt(harness)
    await flush()
    const view = await queryAttempt(harness, credential)
    expect(view).toMatchObject({ state: 'failed', errorCode: 'login-failed', authUrl: null })
    expect(JSON.stringify(view)).not.toContain('evil.example')
    expect(harness.logs.some(entry => entry.text.includes('does not accept'))).toBe(true)
  })

  it('does not accept a second URL once an allowed one is shown', async () => {
    const harness = createHarness()
    harness.authorization.flow = async (interaction) => {
      interaction.notify({ message: 'Sign in', url: OFFICIAL_URL })
      interaction.notify({ message: 'Or here', url: 'https://evil.example/oauth/authorize?state=abc' })
      await pendingFlow()
    }
    const credential = await beginAttempt(harness)
    await flush()
    expect(await queryAttempt(harness, credential)).toMatchObject({ state: 'waiting-browser', authUrl: OFFICIAL_URL })
  })
})

describe('failure reporting', () => {
  it('reports a provider failure as a code and keeps its text out of the answer and the log', async () => {
    const harness = createHarness()
    harness.authorization.flow = () => Promise.reject(new Error('token exchange failed: access_token=super-secret-value'))
    const credential = await beginAttempt(harness)
    await flush()
    const view = await queryAttempt(harness, credential)
    expect(view).toMatchObject({ state: 'failed', errorCode: 'login-failed' })
    expect(JSON.stringify(view)).not.toContain('super-secret-value')
    expect(harness.logs.map(entry => entry.text).join('\n')).not.toContain('super-secret-value')
  })

  it('logs the stable code alone for a failure it did not diagnose', async () => {
    const harness = createHarness()
    harness.authorization.flow = () => {
      const error = new Error('provider failure')
      error.name = 'Error access_token=secret-name-value'
      return Promise.reject(error)
    }
    const credential = await beginAttempt(harness)
    await flush()
    expect((await queryAttempt(harness, credential)).errorCode).toBe('login-failed')
    const logged = harness.logs.map(entry => entry.text).join('\n')
    expect(logged).toContain('login-failed')
    expect(logged).not.toContain('secret-name-value')
  })

  it('reports a flow that vanished between the capability check and the attempt', async () => {
    const harness = createHarness()
    harness.authorization.begin = () => {
      const error = new Error('no authorization flow is registered')
      Object.assign(error, { code: 'NO_FLOW' })
      return Promise.reject(error)
    }
    const credential = await beginAttempt(harness)
    await flush()
    expect((await queryAttempt(harness, credential)).errorCode).toBe('capability-unavailable')
  })
})
