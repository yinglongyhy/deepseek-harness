import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', () => ({ openaiCodexProvider: () => ({ auth: { oauth: { refresh } } }) }))
import { CODEX_OAUTH_CHANNEL, parseCodexOAuthStatusResult } from '../../src/shared/index.ts'
import { apply, Config, inject, name } from '../../src/index.ts'
import { FakeConnection, testPeerScope, tuningConfig } from './seams.ts'

/** A root context with the channel's two required services provided. */
function hostContext(): { ctx: Context; connection: FakeConnection } {
  const ctx = new Context()
  const connection = new FakeConnection()
  ctx.provide('connection', connection)
  ctx.provide('webServer', {})
  return { ctx, connection }
}

function loadPlugin(ctx: Context, config = tuningConfig()) {
  return ctx.plugin({ name, inject, Config, apply }, config)
}

describe('host plugin', () => {
  it('declares its loader identity and the services the channel needs', () => {
    expect(name).toBe('@deepseek-ai/dsh-llm-codex-account')
    expect(inject).toContain('connection')
    expect(inject).toContain('webServer')
  })

  it('registers the independent channel and never the shared one', async () => {
    const { ctx, connection } = hostContext()
    const fiber = loadPlugin(ctx)
    await fiber.await()
    try {
      expect(connection.channels.map(entry => entry.channel)).toEqual([CODEX_OAUTH_CHANNEL])
      expect(connection.channels.map(entry => entry.channel)).not.toContain('/api')
    } finally {
      await fiber.dispose()
    }
  })

  it('answers on the channel it registered', async () => {
    const { ctx, connection } = hostContext()
    const fiber = loadPlugin(ctx)
    await fiber.await()
    try {
      const handler = connection.channels[0]?.handler
      expect(handler).toBeDefined()
      const result = await handler?.('status', {}, new AbortController().signal, testPeerScope(ctx))
      expect(result?.ok && parseCodexOAuthStatusResult(result.value).ok).toBe(true)
    } finally {
      await fiber.dispose()
    }
  })

  it('fails the load on a tuning a page polling on cadence would outlive', async () => {
    const { ctx } = hostContext()
    const fiber = loadPlugin(ctx, tuningConfig({ attemptLeaseMs: 1_000 }))
    await expect(fiber.await()).rejects.toThrow(/attemptLeaseMs/)
    expect(ctx.get('connection')).toBeDefined()
  })

  it('withdraws the channel when the plugin unloads', async () => {
    const { ctx, connection } = hostContext()
    const fiber = loadPlugin(ctx)
    await fiber.await()
    expect(connection.channels.map(entry => entry.channel)).toEqual([CODEX_OAUTH_CHANNEL])
    await fiber.dispose()
    expect(connection.channels).toEqual([])
  })
})
