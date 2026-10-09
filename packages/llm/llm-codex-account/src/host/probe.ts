/**
 * Availability probe for the loopback port the official Codex OAuth flow binds.
 *
 * The official flow swallows a failed `listen` (it substitutes a stub callback
 * server and keeps waiting), so a port already in use would otherwise surface as
 * an attempt that never progresses. Probing here turns that into an immediate,
 * diagnosable refusal. The probe binds and immediately releases the port; it is
 * an availability check, never an OAuth callback server, and it leaves no
 * listener behind.
 */

import { createServer } from 'node:net'

/** Host the official flow binds when its environment override is unset. */
const DEFAULT_CALLBACK_HOST = '127.0.0.1'

/** Whether the loopback port may be probed. */
export type CallbackPortProbe = 'available' | 'unavailable' | 'not-probed'

/**
 * The callback host the official flow will bind, read the way that flow reads
 * it: the inherited process environment, first non-empty value, default
 * otherwise. The deployment's launch snapshot is deliberately not consulted —
 * it is not what the OAuth listener sees.
 * @param env - process environment to read.
 * @returns the host the official listener will bind.
 */
export function callbackHostFrom(env: NodeJS.ProcessEnv): string {
  const value = env['PI_OAUTH_CALLBACK_HOST']
  return value === undefined || value === '' ? DEFAULT_CALLBACK_HOST : value
}

/**
 * Whether a host names this machine's loopback interface.
 *
 * Only such a host may be probed: binding anything else would open a listener
 * on an external interface, and this plugin serves the local desktop alone.
 * @param host - callback host from {@link callbackHostFrom}.
 * @returns true for loopback names and addresses.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare === 'localhost' || bare === '::1') return true
  const octets = bare.split('.')
  return octets.length === 4 && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

/**
 * Bind and immediately release one loopback port.
 *
 * The result is a snapshot, not a reservation: another process may take the
 * port between this probe and the official flow's own `listen`, which is why
 * the attempt still carries a bounded deadline.
 * @param host - callback host the official flow will bind.
 * @param port - callback port the official flow will bind.
 * @returns whether the port could be bound, or that it was not probed.
 */
export async function probeCallbackPort(host: string, port: number): Promise<CallbackPortProbe> {
  if (!isLoopbackHost(host)) return 'not-probed'
  return new Promise<CallbackPortProbe>((resolve) => {
    const server = createServer()
    // A listener that never bound owns no handle, so this path only reports.
    server.once('error', () => { resolve('unavailable') })
    server.listen({ host, port }, () => {
      server.close(() => { resolve('available') })
    })
  })
}
