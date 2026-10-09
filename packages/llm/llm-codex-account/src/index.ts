/**
 * Host face of the Codex OAuth bundle.
 *
 * The plugin declares the two services the channel itself needs — the Connection
 * RPC registry and the HTTP server its routes mount on — and registers the
 * independent `/codex-oauth` channel. Everything the login actually uses
 * (`ctx.authorization`, `ctx.credentials`, `ctx.settings`, `ctx.llm`) is read
 * per operation instead of being required at load, so a composition that lacks
 * one still mounts this plugin and can be told which dependency is missing.
 */

import type { Context } from '@deepseek-ai/cordis'
import { CODEX_OAUTH_CHANNEL } from './shared/index.ts'
import { CodexOAuthBridge } from './host/bridge.ts'
import { resolveCodexOAuthTuning } from './host/config.ts'
import type { Config } from './host/config.ts'
import { PROVIDER_INFO_ENDPOINT } from './shared/provider-info.ts'
import { ProviderInfoService } from './host/provider-info.ts'

export { Config } from './host/config.ts'

/** Loader entry id, matching the row this bundle inserts in `cordis.patch.yml`. */
export const name = '@deepseek-ai/dsh-llm-codex-account'

/** The channel registry and the route carrier its own channel mounts on. */
export const inject: string[] = ['connection', 'webServer']

/**
 * Host plugin body.
 * @param ctx - Host root context.
 * @param config - resolved plugin configuration; malformed tuning fails the load here.
 */
export function apply(ctx: Context, config: Config): void {
  const connection = ctx.connection
  const bridge = new CodexOAuthBridge(ctx, { tuning: resolveCodexOAuthTuning(config) })
  const info = new ProviderInfoService(ctx, {
    refreshIntervalMs: config.providerInfoRefreshIntervalMs,
    requestTimeoutMs: config.providerInfoRequestTimeoutMs,
  })
  ctx.effect(() => () => { info.dispose() }, '@deepseek-ai/dsh-llm-codex-account: provider information')
  for (const event of ['credentials/record-updated', 'credentials/reference-updated', 'settings/document-updated', 'llm/adapters-updated'] as const) {
    ctx.on(event, info.invalidate)
  }
  ctx.effect(
    () => connection.rpc.handle(CODEX_OAUTH_CHANNEL, (endpoint, payload, signal, peer) =>
      endpoint === PROVIDER_INFO_ENDPOINT ? info.handle(payload, signal) : bridge.handle(endpoint, payload, signal, peer)),
    `@deepseek-ai/dsh-llm-codex-account: ${CODEX_OAUTH_CHANNEL} channel`,
  )
  ctx.effect(() => () => { bridge.dispose() }, '@deepseek-ai/dsh-llm-codex-account: login attempts')
}
