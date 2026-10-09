import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { apply as applyConnection, inject as connectionInject } from '../src/index.ts'
import type { HostConnectionRpc } from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

const CHANNEL = '/account-channel'

/** Registers the Connection service without declaring the optional Web carrier. */
async function mountConnection(ctx: Context): Promise<void> {
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
}

/** Declares the carrier dependency so Cordis remounts this caller with it. */
function applyRpcConsumer(ctx: Context): void {
  ctx.connection.rpc.handle(CHANNEL, async () => ({ ok: true, value: { active: true } }))
}

async function mountConsumer(ctx: Context) {
  const fiber = ctx.plugin({ inject: ['connection', 'webServer'], apply: applyRpcConsumer })
  await fiber.await()
  return fiber
}

/** Asserts whether the active carrier already owns the channel route. */
function hasChannel(server: WebServer): boolean {
  try {
    server.register({ kind: 'prefix', path: CHANNEL, handler: () => {} })()
    return false
  } catch (error) {
    if (error instanceof Error && /duplicate prefix route/.test(error.message)) return true
    throw error
  }
}

/** Verifies the channel's route registration through the real carrier registry. */
function expectChannel(server: WebServer, occupied: boolean): void {
  expect(hasChannel(server)).toBe(occupied)
}

describe('Connection RPC carrier ownership', () => {
  it('scopes a sibling caller registration to its fiber across restart and carrier replacement', async () => {
    const ctx = new Context()
    provideBrowserCredentials(ctx)
    try {
      await mountConnection(ctx)
      const firstCarrierFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await firstCarrierFiber.await()
      const firstCarrier = ctx.get('webServer')
      if (firstCarrier === undefined) throw new Error('The first WebServer did not activate')
      expect(firstCarrier).toBeInstanceOf(WebServer)

      const firstConsumer = await mountConsumer(ctx)
      expectChannel(firstCarrier, true)
      await firstConsumer.dispose()
      expectChannel(firstCarrier, false)

      const restartedConsumer = await mountConsumer(ctx)
      expectChannel(firstCarrier, true)
      await restartedConsumer.dispose()
      expectChannel(firstCarrier, false)

      const replacingConsumer = await mountConsumer(ctx)
      await firstCarrierFiber.dispose()
      expectChannel(firstCarrier, false)
      const replacementFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await replacementFiber.await()
      const replacement = ctx.get('webServer')
      if (replacement === undefined) throw new Error('The replacement WebServer did not activate')
      await expect.poll(() => hasChannel(replacement)).toBe(true)
      expectChannel(firstCarrier, false)
      await replacingConsumer.dispose()
      expectChannel(replacement, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a missing carrier when a caller registers a dedicated channel', async () => {
    const ctx = new Context()
    provideBrowserCredentials(ctx)
    try {
      await mountConnection(ctx)
      let rpc: HostConnectionRpc | undefined
      const caller = ctx.plugin({
        inject: ['connection'],
        apply(callerCtx: Context) {
          rpc = callerCtx.connection.rpc
        },
      })
      await caller.await()
      expect(() => rpc?.handle(CHANNEL, async () => ({ ok: true, value: null })))
        .toThrow('connection: RPC channel "/account-channel" requires an active webServer service')
      await caller.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
