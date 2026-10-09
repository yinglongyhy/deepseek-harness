import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { callbackHostFrom, isLoopbackHost, probeCallbackPort } from '../../src/host/probe.ts'

/** Loopback listeners a test opened but did not close itself. */
const leftovers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of leftovers.splice(0)) await close()
})

/** Bind one loopback port and return it with the closer that releases it. */
async function bind(host = '127.0.0.1', port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer()
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  leftovers.push(close)
  const bound = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') reject(new Error('the test listener has no port'))
      else resolve(address.port)
    })
  })
  return { port: bound, close }
}

describe('callback host', () => {
  it('reads the inherited process override the way the official flow does', () => {
    expect(callbackHostFrom({})).toBe('127.0.0.1')
    expect(callbackHostFrom({ PI_OAUTH_CALLBACK_HOST: '' })).toBe('127.0.0.1')
    expect(callbackHostFrom({ PI_OAUTH_CALLBACK_HOST: 'localhost' })).toBe('localhost')
  })

  it('classifies loopback names and addresses only', () => {
    for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.invalid', '127.0.0.1.evil.example', '127.0.0.999']) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })
})

describe('callback port probe', () => {
  it('reports a free loopback port as available and leaves the port bindable', async () => {
    const first = await bind()
    await first.close()
    expect(await probeCallbackPort('127.0.0.1', first.port)).toBe('available')
    // The official flow can still take the port: the probe released it.
    const second = await bind('127.0.0.1', first.port)
    expect(second.port).toBe(first.port)
  })

  it('reports a bound port as unavailable', async () => {
    expect(await probeCallbackPort('127.0.0.1', (await bind()).port)).toBe('unavailable')
  })

  it('never binds a non-loopback host', async () => {
    expect(await probeCallbackPort('0.0.0.0', 1455)).toBe('not-probed')
    expect(await probeCallbackPort('192.168.1.10', 1455)).toBe('not-probed')
  })
})
