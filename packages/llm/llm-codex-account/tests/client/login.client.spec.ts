import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexOAuthAttemptView, CodexOAuthCancelRequest } from '../../src/shared/index.ts'
import { CodexOAuthLogin, type CodexOAuthLoginState } from '../../src/client/login.ts'
import {
  CODEX_ATTEMPT_ID,
  CODEX_ATTEMPT_ID_2,
  CODEX_OWNER_TOKEN,
  CODEX_OWNER_TOKEN_2,
  FakeCodexOAuthEndpoint,
  FakeOpener,
  POLL_INTERVAL_MS,
  authorizedView,
  beginFixture,
  cancelledView,
  deferred,
  failedView,
  initiatingView,
  officialAuthorizeUrl,
  tick,
  waitingView,
  type FakeAnswer,
} from './seams.client.ts'

const URL = officialAuthorizeUrl()

/** One login machine with its scripted endpoints and recorded state changes. */
interface LoginHarness {
  readonly endpoint: FakeCodexOAuthEndpoint
  readonly opener: FakeOpener
  readonly login: CodexOAuthLogin
  readonly states: CodexOAuthLoginState[]
  readonly settlements: { count: number }
}

function harness(): LoginHarness {
  const endpoint = new FakeCodexOAuthEndpoint()
  const opener = new FakeOpener()
  const states: CodexOAuthLoginState[] = []
  const settlements = { count: 0 }
  const login = new CodexOAuthLogin({
    endpoint,
    open: opener.open,
    onChange: (state) => { states.push(state) },
    onSettled: () => { settlements.count += 1 },
  })
  return { endpoint, opener, login, states, settlements }
}

/** The begin answer of a second attempt, so a test can tell two identities apart. */
function secondAttempt(): FakeAnswer<ReturnType<typeof beginFixture>> {
  return {
    value: {
      attemptId: CODEX_ATTEMPT_ID_2,
      ownerToken: CODEX_OWNER_TOKEN_2,
      state: 'initiating',
      pollIntervalMs: POLL_INTERVAL_MS,
    },
  }
}

/** The payloads of every cancel call the machine made. */
function cancels(endpoint: FakeCodexOAuthEndpoint): CodexOAuthCancelRequest[] {
  return endpoint.calls
    .filter(call => call.endpoint === 'cancel')
    .map(call => call.payload as CodexOAuthCancelRequest)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('codex oauth login attempt', () => {
  it('opens the authorization page once and keeps polling without opening it again', async () => {
    const app = harness()
    app.endpoint.queryAnswer = (_request, ordinal) => ({
      value: ordinal === 0 ? initiatingView() : waitingView(URL),
    })
    await app.login.start()
    expect(app.login.getState()).toEqual({ kind: 'pending', authUrl: null })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(app.opener.urls).toEqual([URL])
    expect(app.login.getState()).toEqual({ kind: 'pending', authUrl: URL })
    const afterSecondPoll = app.states.length
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(app.endpoint.queries).toBe(6)
    expect(app.opener.urls).toEqual([URL])
    expect(app.states.length).toBe(afterSecondPoll)
    expect(cancels(app.endpoint)).toEqual([])
  })

  it('reopens the authorization page only when the user asks', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: waitingView(URL) })
    await app.login.start()
    expect(app.opener.urls).toEqual([URL])
    app.login.reopen()
    app.login.reopen()
    expect(app.opener.urls).toEqual([URL, URL, URL])
    expect(cancels(app.endpoint)).toEqual([])
  })

  it('sends every attempt call with the credential the Host minted, and nothing else', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    await app.login.start()
    expect(app.endpoint.calls[1]?.payload).toEqual({ attemptId: CODEX_ATTEMPT_ID, ownerToken: CODEX_OWNER_TOKEN })
    expect(JSON.stringify(app.states)).not.toContain(CODEX_OWNER_TOKEN)
  })

  it('opens nothing when the official URL fails the shared gate, and stops the attempt', async () => {
    const app = harness()
    const repeated = officialAuthorizeUrl((url) => {
      url.searchParams.set('state', 'state-one')
      url.searchParams.append('state', 'state-two')
    })
    app.endpoint.queryAnswer = () => ({
      value: { attemptId: CODEX_ATTEMPT_ID, state: 'waiting-browser', authUrl: repeated, cancelReason: null, errorCode: null },
    })
    await app.login.start()
    expect(app.opener.urls).toEqual([])
    expect(app.login.getState()).toEqual({ kind: 'cancelled', reason: 'browser-open-failed' })
    expect(cancels(app.endpoint)).toEqual([
      { attemptId: CODEX_ATTEMPT_ID, ownerToken: CODEX_OWNER_TOKEN, reason: 'browser-open-failed' },
    ])
  })

  it('reports an open failure only when the open call throws', async () => {
    const app = harness()
    app.opener.fails = true
    app.endpoint.queryAnswer = () => ({ value: waitingView(URL) })
    await app.login.start()
    expect(app.login.getState()).toEqual({ kind: 'cancelled', reason: 'browser-open-failed' })
    expect(cancels(app.endpoint).map(call => call.reason)).toEqual(['browser-open-failed'])
  })

  it('reports authorized once and stops polling', async () => {
    const app = harness()
    app.endpoint.queryAnswer = (_request, ordinal) => ({ value: ordinal === 0 ? waitingView(URL) : authorizedView() })
    await app.login.start()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(app.login.getState()).toEqual({ kind: 'authorized' })
    expect(app.settlements.count).toBe(1)
    const queries = app.endpoint.queries
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    expect(app.endpoint.queries).toBe(queries)
  })

  it('asks for a fresh reading of the official facts after every settled outcome', async () => {
    const outcomes: CodexOAuthAttemptView[] = [
      authorizedView(),
      cancelledView('timeout'),
      failedView('login-failed'),
    ]
    for (const outcome of outcomes) {
      const app = harness()
      app.endpoint.queryAnswer = () => ({ value: outcome })
      await app.login.start()
      expect(app.settlements.count).toBe(1)
    }
  })

  it('reports the Host cancellation reason and the Host failure code', async () => {
    const cancelled = harness()
    cancelled.endpoint.queryAnswer = () => ({ value: cancelledView('timeout') })
    await cancelled.login.start()
    expect(cancelled.login.getState()).toEqual({ kind: 'cancelled', reason: 'timeout' })

    const failed = harness()
    failed.endpoint.queryAnswer = () => ({ value: failedView('callback-port-unavailable') })
    await failed.login.start()
    expect(failed.login.getState()).toEqual({ kind: 'failed', code: 'callback-port-unavailable' })
  })

  it('surfaces a refused begin without starting a poll', async () => {
    const app = harness()
    app.endpoint.beginAnswer = () => ({ failure: 'busy' })
    await app.login.start()
    expect(app.login.getState()).toEqual({ kind: 'failed', code: 'busy' })
    expect(app.endpoint.queries).toBe(0)
  })

  it('reports a refused attempt code at once and a broken transport only after its bound', async () => {
    const refused = harness()
    refused.endpoint.queryAnswer = () => ({ failure: 'attempt-forbidden' })
    await refused.login.start()
    expect(refused.login.getState()).toEqual({ kind: 'failed', code: 'attempt-forbidden' })
    expect(refused.endpoint.queries).toBe(1)

    const broken = harness()
    broken.endpoint.queryAnswer = () => ({ failure: 'transport-failed' })
    await broken.login.start()
    expect(broken.login.getState()).toEqual({ kind: 'starting' })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(broken.login.getState()).toEqual({ kind: 'starting' })
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(broken.login.getState()).toEqual({ kind: 'failed', code: 'transport-failed' })
    const queries = broken.endpoint.queries
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(broken.endpoint.queries).toBe(queries)
  })

  it('cancels with the user reason and stops polling', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    await app.login.start()
    await app.login.cancel('user')
    expect(cancels(app.endpoint)).toEqual([
      { attemptId: CODEX_ATTEMPT_ID, ownerToken: CODEX_OWNER_TOKEN, reason: 'user' },
    ])
    expect(app.login.getState()).toEqual({ kind: 'cancelled', reason: 'user' })
    const queries = app.endpoint.queries
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(app.endpoint.queries).toBe(queries)
  })

  it('never reopens the authorization page when a cancel answer still reports a pending attempt', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    await app.login.start()
    app.endpoint.cancelAnswer = () => ({ value: waitingView(URL) })
    await app.login.cancel('user')
    expect(app.opener.urls).toEqual([])
    expect(app.login.getState()).toEqual({ kind: 'failed', code: 'transport-failed' })
  })

  it('starts only one attempt while one is pending', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    await app.login.start()
    await app.login.start()
    expect(app.endpoint.calls.filter(call => call.endpoint === 'begin')).toHaveLength(1)
  })

  it('releases the page by cancelling with page-closed and stopping the poll', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    await app.login.start()
    app.login.release()
    expect(app.login.getState()).toEqual({ kind: 'idle' })
    expect(cancels(app.endpoint).map(call => call.reason)).toEqual(['page-closed'])
    const queries = app.endpoint.queries
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(app.endpoint.queries).toBe(queries)
  })

  it('releases the identity a begin minted after the page is gone', async () => {
    const app = harness()
    const begin = deferred<FakeAnswer<ReturnType<typeof beginFixture>>>()
    app.endpoint.beginAnswer = () => begin.promise
    const starting = app.login.start()
    await tick()
    app.login.release()
    begin.resolve({ value: beginFixture() })
    await starting
    expect(app.endpoint.queries).toBe(0)
    expect(app.login.getState()).toEqual({ kind: 'idle' })
    expect(cancels(app.endpoint)).toEqual([
      { attemptId: CODEX_ATTEMPT_ID, ownerToken: CODEX_OWNER_TOKEN, reason: 'page-closed' },
    ])
  })

  it('drops a stale cancel answer instead of settling the attempt that replaced it', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    await app.login.start()
    const pending = deferred<FakeAnswer<CodexOAuthAttemptView>>()
    app.endpoint.cancelAnswer = () => pending.promise
    const cancelling = app.login.cancel('user')
    app.login.release()
    app.endpoint.beginAnswer = secondAttempt
    app.endpoint.queryAnswer = () => ({ value: { ...waitingView(URL), attemptId: CODEX_ATTEMPT_ID_2 } })
    await app.login.start()
    expect(app.login.getState()).toEqual({ kind: 'pending', authUrl: URL })
    pending.resolve({ value: cancelledView('user') })
    await cancelling
    expect(app.login.getState()).toEqual({ kind: 'pending', authUrl: URL })
  })

  it('drops a failed stale cancel instead of failing the attempt that replaced it', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    await app.login.start()
    const pending = deferred<FakeAnswer<CodexOAuthAttemptView>>()
    app.endpoint.cancelAnswer = () => pending.promise
    const cancelling = app.login.cancel('user')
    app.login.release()
    app.endpoint.beginAnswer = secondAttempt
    app.endpoint.queryAnswer = () => ({ value: { ...waitingView(URL), attemptId: CODEX_ATTEMPT_ID_2 } })
    await app.login.start()
    pending.reject(new Error('the transport died'))
    await cancelling
    expect(app.login.getState()).toEqual({ kind: 'pending', authUrl: URL })
  })

  it('refuses a poll answer that names another attempt, and opens nothing for it', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: { ...waitingView(URL), attemptId: CODEX_ATTEMPT_ID_2 } })
    await app.login.start()
    expect(app.opener.urls).toEqual([])
    expect(app.login.getState()).toEqual({ kind: 'failed', code: 'transport-failed' })
  })

  it('refuses a cancel answer that names another attempt', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    await app.login.start()
    app.endpoint.cancelAnswer = () => ({ value: { ...cancelledView('user'), attemptId: CODEX_ATTEMPT_ID_2 } })
    await app.login.cancel('user')
    expect(app.login.getState()).toEqual({ kind: 'failed', code: 'transport-failed' })
  })

  it('drops the attempt credential once the attempt settles', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: authorizedView() })
    await app.login.start()
    app.login.reopen()
    await app.login.cancel('user')
    expect(cancels(app.endpoint)).toEqual([])
    expect(app.login.getState()).toEqual({ kind: 'authorized' })
  })
})
