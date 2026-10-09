import { describe, expect, it } from 'vitest'
import type { ClientConnectionRpc, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import {
  CODEX_OAUTH_CHANNEL,
  CODEX_OAUTH_PROTOCOL_VERSION,
  CODEX_PROVIDER_ID,
  type CodexOAuthAttemptView,
  type CodexOAuthErrorCode,
} from '../../src/shared/index.ts'
import {
  CodexOAuthChannel,
  CodexOAuthClientFailure,
  failureCodeOf,
} from '../../src/client/channel.ts'
import {
  CODEX_ATTEMPT_ID,
  CODEX_OWNER_TOKEN,
  authorizedView,
  beginFixture,
  cancelledView,
  statusFixture,
} from './seams.client.ts'

/** One recorded call of the page's RPC caller. */
interface RpcCall {
  readonly channel: string
  readonly endpoint: string
  readonly payload: unknown
}

/** The page's RPC caller, answering one scripted result and recording every call. */
class FakeRpc implements ClientConnectionRpc {
  readonly calls: RpcCall[] = []
  answer: ConnectionRpcResult<unknown> = { ok: true, value: statusFixture() }
  rejects = false

  call(channel: string, endpoint: string, payload: unknown): Promise<ConnectionRpcResult<unknown>> {
    this.calls.push({ channel, endpoint, payload })
    if (this.rejects) return Promise.reject(new Error('SECRET transport text'))
    return Promise.resolve(this.answer)
  }
}

function channelOf(answer: ConnectionRpcResult<unknown>): { rpc: FakeRpc; channel: CodexOAuthChannel } {
  const rpc = new FakeRpc()
  rpc.answer = answer
  return { rpc, channel: new CodexOAuthChannel(rpc) }
}

/** Await one refusal and return its code, failing the test when the call resolved. */
async function refusalCode(run: () => Promise<unknown>): Promise<CodexOAuthErrorCode> {
  try {
    await run()
  } catch (error) {
    return failureCodeOf(error)
  }
  throw new Error('expected this call to be refused')
}

describe('codex oauth client channel', () => {
  it('speaks the independent channel and parses a status answer', async () => {
    const { rpc, channel } = channelOf({ ok: true, value: statusFixture({ stored: true, namespaceRevision: 3 }) })
    const status = await channel.status()
    expect(rpc.calls).toEqual([{ channel: CODEX_OAUTH_CHANNEL, endpoint: 'status', payload: {} }])
    expect(status.protocolVersion).toBe(CODEX_OAUTH_PROTOCOL_VERSION)
    expect(status.record.stored).toBe(true)
    expect(status.route.namespaceRevision).toBe(3)
  })

  it('names the provider on begin and never the shared API channel', async () => {
    const { rpc, channel } = channelOf({ ok: true, value: beginFixture() })
    const begun = await channel.begin()
    expect(rpc.calls[0]).toEqual({ channel: '/codex-oauth', endpoint: 'begin', payload: { provider: CODEX_PROVIDER_ID } })
    expect(rpc.calls.map(call => call.channel)).not.toContain('/api')
    expect(begun.attemptId.length).toBeGreaterThan(15)
  })

  it('carries the attempt credential and the caller reason on query and cancel', async () => {
    const { rpc, channel } = channelOf({ ok: true, value: authorizedView() })
    await channel.query({ attemptId: CODEX_ATTEMPT_ID, ownerToken: CODEX_OWNER_TOKEN })
    expect(rpc.calls[0]?.payload).toEqual({ attemptId: 'attempt-identity-0001', ownerToken: 'owner-token-0000000001' })
    const cancelled: CodexOAuthAttemptView = cancelledView('user')
    rpc.answer = { ok: true, value: cancelled }
    const view = await channel.cancel({
      attemptId: CODEX_ATTEMPT_ID,
      ownerToken: CODEX_OWNER_TOKEN,
      reason: 'user',
    })
    expect(rpc.calls[1]?.payload).toEqual({
      attemptId: CODEX_ATTEMPT_ID,
      ownerToken: CODEX_OWNER_TOKEN,
      reason: 'user',
    })
    expect(view.cancelReason).toBe('user')
  })

  it('sends only the revision fence on enable-route', async () => {
    const { rpc, channel } = channelOf({ ok: true, value: { configured: true, namespaceRevision: 8 } })
    await channel.enableRoute({ namespaceRevision: 7 })
    expect(rpc.calls[0]?.payload).toEqual({ namespaceRevision: 7 })
  })

  it('keeps the Host code and drops the Host message', async () => {
    const { channel } = channelOf({
      ok: false,
      error: { code: 'busy', message: 'SECRET provider text', details: { token: 'SECRET' } },
    })
    let caught: unknown
    try {
      await channel.status()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodexOAuthClientFailure)
    expect(failureCodeOf(caught)).toBe('busy')
    expect(`${String(caught)}${(caught as Error).stack ?? ''}`).not.toContain('SECRET')
  })

  it('narrows an unknown refusal code and a failed transport to transport-failed', async () => {
    const unknown = channelOf({ ok: false, error: { code: 'not-a-code', message: '', details: {} } })
    expect(await refusalCode(() => unknown.channel.status())).toBe('transport-failed')
    const broken = new FakeRpc()
    broken.rejects = true
    const channel = new CodexOAuthChannel(broken)
    expect(await refusalCode(() => channel.status())).toBe('transport-failed')
  })

  it('refuses a widened or version-mismatched success value', async () => {
    const widened = channelOf({ ok: true, value: { ...statusFixture(), attemptId: 'leaked' } })
    expect(await refusalCode(() => widened.channel.status())).toBe('invalid-request')
    const stale = channelOf({
      ok: true,
      value: { ...statusFixture(), protocolVersion: CODEX_OAUTH_PROTOCOL_VERSION + 1 },
    })
    expect(await refusalCode(() => stale.channel.status())).toBe('invalid-request')
  })

  it('refuses an attempt view whose authorization URL is not the official request', async () => {
    const hostile = channelOf({ ok: true, value: { ...authorizedView(), authUrl: null, state: 'waiting-browser' } })
    expect(await refusalCode(() => hostile.channel.query({
      attemptId: CODEX_ATTEMPT_ID,
      ownerToken: CODEX_OWNER_TOKEN,
    }))).toBe('invalid-request')
  })
})
