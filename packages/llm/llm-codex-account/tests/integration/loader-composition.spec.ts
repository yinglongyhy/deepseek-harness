/** Source-plane Loader composition for Codex account and its real Web transport. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '@deepseek-ai/dsh-client-connection'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as CodexAccount from '../../src/index.ts'
import { profileComposition } from '../../../../settings/settings/tests/profile-composition.ts'

const WEB_DEFAULTS = new URL('../../../../bundle/web-app/cordis.patch.yml', import.meta.url)

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  const currentContext = context
  const currentRoot = root
  context = undefined
  root = undefined
  try {
    await currentContext?.fiber.dispose()
  } finally {
    if (currentRoot !== undefined) await rm(currentRoot, { recursive: true, force: true })
  }
})

/** Load the target plugin alongside the actual Host services and profile services. */
async function loadComposition(): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-account-composition-'))
  const credentialsPath = join(root, '.credentials.yaml')
  const configPath = join(root, 'cordis.yml')
  await writeFile(credentialsPath, 'version: 1\nrefs: {}\nrecords: {}\n', { mode: 0o600 })
  await writeFile(configPath, [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    watch: false',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    '- id: webServer',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '- id: connection',
    "  name: '@deepseek-ai/dsh-client-connection'",
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '- id: llm-codex-account',
    "  name: '@deepseek-ai/dsh-llm-codex-account'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-llm-codex-account', CodexAccount],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  const settingsPath = await profileComposition(ctx, root, configPath)
  return { ctx, settingsPath }
}

/** Mint one real Connection cookie for an HTTP request to the real WebServer. */
function browserCookie(ctx: Context): { authority: string; cookie: string } {
  const connection = ctx.get('connection')
  if (connection === undefined) throw new Error('Connection did not load')
  const webServer = ctx.get('webServer')
  if (webServer === undefined) throw new Error('WebServer did not load')
  const authority = `${webServer.host}:${String(webServer.port)}`
  const launchUrl = new URL(connection.authenticatedUrl(`http://${authority}/`))
  let cookie: string | undefined
  const response: ConnectionIndexResponse = {
    writeHead(_status, headers) { cookie = headers?.['set-cookie'] },
    end() {},
  }
  const request: ConnectionIndexRequest = {
    headers: { host: authority },
    method: 'GET',
    url: `/${launchUrl.search}`,
  }
  connection.authorizeIndex(request, response)
  const value = cookie?.split(';', 1)[0]
  if (value === undefined) throw new Error('Connection did not issue its browser cookie')
  return { authority, cookie: value }
}

/** Send one JSON-RPC request through the authenticated, listening WebServer. */
async function sendRpc(ctx: Context, operation: string, payload: object): Promise<{ status: number | undefined; body: string }> {
  const { cookie } = browserCookie(ctx)
  const webServer = ctx.get('webServer')
  if (webServer === undefined) throw new Error('WebServer did not load')
  const body = JSON.stringify({ type: 'client-request', rpcId: `integration-${operation}`, method: operation, payload })
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: webServer.host,
      port: webServer.port,
      path: `/codex-oauth/${operation}`,
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (incoming) => {
      incoming.setEncoding('utf8')
      let text = ''
      incoming.on('data', (chunk: string) => { text += chunk })
      incoming.on('end', () => { resolve({ status: incoming.statusCode, body: text }) })
    })
    request.on('error', reject)
    request.end(body)
  })
}

/** Invoke one endpoint and decode its successful Connection RPC response. */
async function rpc<T>(ctx: Context, operation: string, payload: object): Promise<T> {
  const response = await sendRpc(ctx, operation, payload)
  if (response.status !== 200) throw new Error(`Codex endpoint returned ${String(response.status)}: ${response.body}`)
  const envelope: unknown = JSON.parse(response.body)
  if (typeof envelope !== 'object' || envelope === null || !('result' in envelope)) {
    throw new Error('Connection returned an invalid response envelope')
  }
  const result: unknown = envelope.result
  if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true || !('value' in result)) {
    throw new Error(`Codex ${operation} RPC failed: ${JSON.stringify(result)}`)
  }
  return result.value as T
}

/** Read a YAML mapping without asserting on unvalidated parser output. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

describe('Codex account real composition', () => {
  it('ships a Web default row without replacing Connection startup injection', async () => {
    const text = await readFile(WEB_DEFAULTS, 'utf8')
    const parsed: unknown = yaml.load(text, { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)
    const patchRows = Array.isArray(parsed) ? parsed : []
    const insert = patchRows.map(record).find(row => row !== undefined && 'insert' in row)
    const rows = insert?.insert
    expect(Array.isArray(rows)).toBe(true)
    const entries = Array.isArray(rows) ? rows.map(record) : []
    expect(entries.some(row => row?.id === 'llm-codex-account'
      && row.name === '@deepseek-ai/dsh-llm-codex-account')).toBe(true)
    const connection = entries.find(row => row?.id === 'connection')
    expect(connection?.inject).toEqual(['webStartup'])
  })

  it('registers pi-ai OAuth and persists route and credential changes over real transport', async () => {
    const { ctx, settingsPath } = await loadComposition()
    const authorization = ctx.get('authorization')
    const key = LlmPiAi.recordKeyFor('openai-codex')
    if (authorization === undefined) throw new Error('Authorization service did not load')
    const webServer = ctx.get('webServer')
    if (webServer === undefined) throw new Error('WebServer did not load')
    const targetFiber = [...(ctx.registry.get(CodexAccount)?.fibers ?? [])][0]
    if (targetFiber === undefined) throw new Error('Loader did not create the Codex account fiber')
    await targetFiber.await()
    const oauth = authorization.list().find(flow => flow.key === key)?.methods[0]
    expect(oauth?.id).toBe('oauth')
    expect(oauth?.label).toContain('ChatGPT')

    const initial = await rpc<{ capability: { available: boolean }; record: { stored: boolean }; route: { configured: boolean; namespaceRevision: number } }>(ctx, 'status', {})
    expect(initial.capability.available).toBe(true)
    expect(initial.record.stored).toBe(false)
    expect(initial.route.configured).toBe(false)

    await rpc(ctx, 'enable-route', { namespaceRevision: initial.route.namespaceRevision })
    const status = await rpc<{ route: { configured: boolean } }>(ctx, 'status', {})
    expect(status.route.configured).toBe(true)
    expect(await readFile(settingsPath, 'utf8')).toContain('openai-codex: {}')

    await ctx.credentials.modifyRecord(key, async () => ({
      kind: 'grant',
      payload: { type: 'oauth', access: 'integration-access-secret', refresh: 'integration-refresh-secret', expires: 1 },
    }))
    const logout = await rpc<{ removed: boolean }>(ctx, 'logout', {})
    expect(logout).toEqual({ removed: true })
    expect(await ctx.credentials.readRecord(key)).toBeUndefined()
    const safeStatus = await rpc(ctx, 'status', {})
    expect(JSON.stringify(safeStatus)).not.toContain('integration-access-secret')
    expect(JSON.stringify(safeStatus)).not.toContain('integration-refresh-secret')

    await targetFiber.dispose()
    const unavailable = await sendRpc(ctx, 'status', {})
    expect(unavailable.status).toBe(404)
    expect(await readFile(settingsPath, 'utf8')).toContain('openai-codex: {}')
  })
})
