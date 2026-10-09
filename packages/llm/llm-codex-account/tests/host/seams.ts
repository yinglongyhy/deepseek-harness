/**
 * Fakes for the official services the Host bridge reads, plus the shapes the
 * installed pi-ai Codex flow actually produces.
 *
 * Nothing here reaches the network, a profile, or a real credential store: each
 * fake records what the bridge asked it to do and answers the way the official
 * service would, so a test can assert on the bridge's behavior rather than on a
 * library's.
 */

import { Context } from '@deepseek-ai/cordis'
import type { AuthorizationEntry, AuthorizationInteraction, AuthorizationOutcome, AuthorizationPrompt, AuthorizationRequest } from '@deepseek-ai/dsh-authorization'
import { Peer, type ConnectionRpcHandler, type ConnectionRpcHandlerResult, type HostConnectionRpc, type PeerScope } from '@deepseek-ai/dsh-client-connection'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecordInfo } from '@deepseek-ai/dsh-credentials'
import type { LlmConfigurableProvider, LlmDiscoveredModel, LlmModelDiscoveryRequest, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SettingsDescriptor, SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import {
  CODEX_AUTHORIZATION_ORIGIN,
  CODEX_AUTHORIZATION_PATH,
  CODEX_AUTHORIZATION_REDIRECT_URI,
  CODEX_OAUTH_TUNING_DEFAULTS,
  type CodexOAuthTuning,
} from '../../src/shared/index.ts'
import { CodexOAuthBridge, type CallbackPortCheck } from '../../src/host/bridge.ts'
import { Config } from '../../src/host/config.ts'
import type { Config as CodexOAuthConfig } from '../../src/host/config.ts'

/**
 * The plugin configuration a Loader resolves: the schema's own defaults with the
 * supplied overrides applied, validated rather than hand-built.
 * @param overrides - tuning fields the test moves away from the defaults.
 * @returns the validated configuration a plugin load receives.
 */
export function tuningConfig(overrides: Partial<CodexOAuthTuning> = {}): CodexOAuthConfig {
  return Config({ providerInfoRefreshIntervalMs: 60_000, providerInfoRequestTimeoutMs: 10_000,
    ...CODEX_OAUTH_TUNING_DEFAULTS, ...overrides })
}

/** The credential record the bridge is allowed to address. */
export const CODEX_RECORD_KEY = credentialKey('llm-pi-ai', 'openai-codex')

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const STATE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

/** The authorization request the installed official flow builds, with field-level mutations. */
export function officialAuthorizeUrl(mutate: (url: URL) => void = () => {}): string {
  const url = new URL(`${CODEX_AUTHORIZATION_ORIGIN}${CODEX_AUTHORIZATION_PATH}`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', CODEX_AUTHORIZATION_REDIRECT_URI)
  url.searchParams.set('scope', 'openid profile email offline_access')
  url.searchParams.set('code_challenge', CODE_CHALLENGE)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', STATE)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', 'pi')
  mutate(url)
  return url.toString()
}

/** The login-method question the installed flow asks, copied from its own option ids. */
export const CODEX_METHOD_PROMPT: AuthorizationPrompt = {
  kind: 'select',
  message: 'Select OpenAI Codex login method:',
  options: [
    { id: 'browser', label: 'Browser login (default)' },
    { id: 'device_code', label: 'Device code login (headless)' },
  ],
}

/** The hidden manual-code question the installed flow asks beside its callback. */
export const CODEX_MANUAL_PROMPT: AuthorizationPrompt = {
  kind: 'text',
  message: 'Complete login in your browser, or paste the authorization code / redirect URL here:',
  placeholder: CODEX_AUTHORIZATION_REDIRECT_URI,
}

/** One captured log record, flattened for substring assertions. */
export interface CapturedLog {
  readonly type: string
  readonly text: string
}

/** Capture every record the plugin logs through the root context, at every severity. */
export function captureLogs(ctx: Context): CapturedLog[] {
  const captured: CapturedLog[] = []
  ctx.logger.exporter({
    // Without an explicit threshold an exporter receives records below its own level only.
    levels: { default: 3 },
    export: (message) => {
      captured.push({ type: message.type, text: message.args.map(argument => String(argument)).join(' ') })
    },
  })
  return captured
}

/** A fake `ctx.authorization` running a test-supplied flow body. */
export class FakeAuthorization {
  /** What the next attempt runs; resolving means the official flow committed its record. */
  flow: (interaction: AuthorizationInteraction, signal: AbortSignal) => Promise<void> = async () => {}

  /** The interaction the last attempt was handed. */
  interaction: AuthorizationInteraction | undefined

  /** Whether the official seam offers a Codex flow; false makes it unknown. */
  registered = true

  /** Whether an official attempt is running right now. */
  running = false

  /** How many attempts the bridge started. */
  started = 0

  /** The key the seam asked about, recorded so the test can prove only Codex was addressed. */
  described: string[] = []

  describe(key: string): AuthorizationEntry | undefined {
    this.described.push(key)
    if (!this.registered) return undefined
    return {
      key: CODEX_RECORD_KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      inFlight: this.running,
    }
  }

  async begin(request: AuthorizationRequest): Promise<AuthorizationOutcome> {
    this.started += 1
    this.interaction = request.interaction
    this.running = true
    try {
      await this.flow(request.interaction, request.signal ?? new AbortController().signal)
      return { status: 'authorized' }
    } catch (error) {
      // The official seam turns a withdrawn attempt and a declined question into
      // an outcome; only a genuine failure reaches the caller.
      if (request.signal?.aborted === true) return { status: 'cancelled' }
      throw error
    } finally {
      this.running = false
    }
  }
}

/** A fake `ctx.credentials` holding only the Codex record. */
export class FakeCredentials {
  stored = false

  readonly calls: string[] = []

  /** Whether deletes are refused, standing in for a read-only store. */
  deleteRefused = false

  async describeRecord(): Promise<CredentialRecordInfo> {
    this.calls.push('describeRecord')
    return { configured: this.stored, writable: true }
  }

  async deleteRecord(): Promise<void> {
    this.calls.push('deleteRecord')
    if (this.deleteRefused) throw new Error('the store is read-only')
    this.stored = false
  }
}

/** How a fake settings write answers. */
export type SettingsWriteOutcome = 'apply' | 'conflict' | 'refuse'

/** A fake `ctx.settings` over one hand-built descriptor. */
export class FakeSettings {
  readonly writable = true
  descriptors: SettingsDescriptor[] = []

  readonly writes: Array<{ ns: string; ops: readonly SettingsPathOp[]; expectedRevision: number | undefined }> = []

  outcome: SettingsWriteOutcome = 'apply'

  /** A write held mid-call, so a test can observe what the bridge does while it is awaited. */
  hold: Promise<void> | undefined = undefined

  describe(): SettingsDescriptor[] {
    return this.descriptors
  }

  async mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> {
    this.writes.push({ ns, ops, expectedRevision })
    await this.hold
    if (this.outcome === 'conflict') {
      throw new SettingsConflictError(ns as SettingsNamespace, expectedRevision ?? 0, (expectedRevision ?? 0) + 1)
    }
    if (this.outcome === 'refuse') throw new Error('the profile is read-only')
    const descriptor = this.descriptors.find(row => row.ns === ns)
    if (descriptor === undefined) throw new Error(`no configurable plugin entry "${ns}"`)
    descriptor.revision += 1
    descriptor.user = applyOps(descriptor.user ?? {}, ops)
    descriptor.value = applyOps(descriptor.value, ops)
  }
}

/** Apply path ops to a plain value the way the settings store does, for a fake that must stay observable. */
function applyOps(root: unknown, ops: readonly SettingsPathOp[]): Record<string, unknown> {
  const next = structuredClone(root) as Record<string, unknown>
  for (const op of ops) {
    const container = op.path.slice(0, -1).reduce<Record<string, unknown>>((node, key) => {
      const child: unknown = node[key]
      if (typeof child !== 'object' || child === null) {
        const created: Record<string, unknown> = {}
        node[key] = created
        return created
      }
      return child as Record<string, unknown>
    }, next)
    const leaf = op.path[op.path.length - 1]
    if (leaf === undefined) continue
    if (op.op === 'set') container[leaf] = structuredClone(op.value)
    else Reflect.deleteProperty(container, leaf)
  }
  return next
}

/**
 * A fake `ctx.llm`: a configurable-provider directory plus the discovery path
 * the bridge reads the Codex catalog through.
 */
export interface FakeLlm extends Pick<LlmRuntime, 'listConfigurableProviders' | 'discoverModels'> {
  /** The catalog discovery answers with, in order. */
  catalog: LlmDiscoveredModel[]
  /** Every discovery call, so a test can prove the route's own namespace was addressed. */
  readonly discoveries: Array<{ readonly ns: string; readonly request: LlmModelDiscoveryRequest }>
  /** A discovery held mid-call, so a test can observe what the bridge does while it is awaited. */
  hold: Promise<void> | undefined
  /** Set to make discovery fail the way an adapter without an answer would. */
  failure: unknown
}

/** A fake `ctx.llm` whose directory names the supplied providers. */
export function fakeLlm(directory: readonly LlmConfigurableProvider[]): FakeLlm {
  const discoveries: FakeLlm['discoveries'] = []
  const llm: FakeLlm = {
    catalog: [],
    discoveries,
    hold: undefined,
    failure: undefined,
    listConfigurableProviders: () => [...directory],
    discoverModels: async (ns: string, request: LlmModelDiscoveryRequest): Promise<LlmDiscoveredModel[]> => {
      discoveries.push({ ns, request })
      await llm.hold
      if (llm.failure !== undefined) throw llm.failure
      return llm.catalog.map(model => ({ ...model }))
    },
  }
  return llm
}

/** The directory entry the official adapter registers for the Codex route. */
export function codexDirectoryEntry(settingsNs = 'llm-pi-ai'): LlmConfigurableProvider {
  return {
    provider: 'openai-codex',
    displayName: 'OpenAI Codex',
    settingsNs,
    settingsPath: ['providers', 'openai-codex'],
    declared: false,
  }
}

/** What the harness exposes about one mounted bridge. */
export interface BridgeHarness {
  readonly ctx: Context
  readonly logs: CapturedLog[]
  readonly authorization: FakeAuthorization
  readonly credentials: FakeCredentials
  readonly settings: FakeSettings
  readonly llm: FakeLlm
  readonly tuning: CodexOAuthTuning
  /** Call one channel endpoint the way the transport would. */
  readonly call: (endpoint: string, payload?: unknown) => Promise<ConnectionRpcHandlerResult>
  /** Unload the bridge the way the plugin's disposer does. */
  readonly dispose: () => void
}

/** Which official services a harness mounts. */
export interface HarnessOptions {
  readonly tuning?: Partial<CodexOAuthTuning>
  readonly authorization?: boolean
  readonly credentials?: boolean
  readonly settings?: boolean
  readonly llm?: boolean
  readonly connection?: boolean
  readonly descriptors?: SettingsDescriptor[]
  readonly directory?: readonly LlmConfigurableProvider[]
  /** Models the fake LLM runtime's discovery offers for the Codex route. */
  readonly catalog?: readonly LlmDiscoveredModel[]
  /**
   * Callback-port check; a harness answers `available` unless a test says
   * otherwise, and `null` leaves the bridge's own real probe in place.
   */
  readonly probe?: CallbackPortCheck | null
}

/** Build an owner connection peer for direct bridge calls. */
export function testPeerScope(ctx: Context): PeerScope {
  return new Peer(ctx, { principal: { kind: 'owner' } })
}

/**
 * Mount a bridge over fake official services.
 * @param options - which services exist, and with what tuning.
 * @returns the context, the fakes, and the channel call.
 */
export function createHarness(options: HarnessOptions = {}): BridgeHarness {
  const ctx = new Context()
  const logs = captureLogs(ctx)
  const authorization = new FakeAuthorization()
  const credentials = new FakeCredentials()
  const settings = new FakeSettings()
  settings.descriptors = options.descriptors ?? []
  if (options.connection !== false) ctx.provide('connection', new FakeConnection())
  if (options.authorization !== false) ctx.provide('authorization', authorization)
  if (options.credentials !== false) ctx.provide('credentials', credentials)
  if (options.settings !== false) ctx.provide('settings', settings)
  const llm = fakeLlm(options.directory ?? [codexDirectoryEntry()])
  llm.catalog = [...(options.catalog ?? [])]
  if (options.llm !== false) ctx.provide('llm', llm)
  const tuning = { ...CODEX_OAUTH_TUNING_DEFAULTS, ...options.tuning }
  const bridge = new CodexOAuthBridge(ctx, options.probe === null
    ? { tuning }
    : { tuning, probe: options.probe ?? (() => Promise.resolve('available')) })
  return {
    ctx,
    logs,
    authorization,
    credentials,
    settings,
    llm,
    tuning,
    call: async (endpoint, payload) => await bridge.handle(
      endpoint,
      payload,
      new AbortController().signal,
      testPeerScope(ctx),
    ),
    dispose: () => { bridge.dispose() },
  }
}

/** A channel registration captured from a fake Connection service. */
export interface CapturedChannel {
  readonly channel: string
  readonly handler: ConnectionRpcHandler
}

/** A fake Connection service that records the channel the plugin registers. */
export class FakeConnection {
  readonly channels: CapturedChannel[] = []

  get rpc(): HostConnectionRpc {
    return {
      handle: (channel, handler) => {
        const entry: CapturedChannel = { channel, handler }
        this.channels.push(entry)
        return () => {
          const index = this.channels.indexOf(entry)
          if (index >= 0) this.channels.splice(index, 1)
          return Promise.resolve()
        }
      },
      intercept: () => {
        throw new Error('this plugin must not intercept the shared channel')
      },
    }
  }
}

/** One settings descriptor with the fields the bridge reads. */
export function descriptor(
  overrides: Partial<Omit<SettingsDescriptor, 'ns'>> & { ns?: string } = {},
): SettingsDescriptor {
  return {
    autoGenerate: false,
    schema: {},
    value: { providers: {} },
    user: { providers: {} },
    base: { providers: {} },
    revision: 1,
    applies: 'live',
    ...overrides,
    ns: (overrides.ns ?? 'llm-pi-ai') as SettingsNamespace,
  }
}

/** The `error.code` of one channel answer, or undefined for a success. */
export function errorCode(result: ConnectionRpcHandlerResult): string | undefined {
  return result.ok ? undefined : result.error.code
}

/** A promise a test settles by hand, with its resolver. */
export interface Deferred<T> {
  readonly settled: Promise<T>
  readonly resolve: (value: T) => void
}

/**
 * A hand-settled promise, so a test can hold an official service mid-call and
 * observe what the bridge does while it is awaited.
 * @returns the promise and its resolver.
 */
export function deferred<T>(): Deferred<T> {
  let release = (_value: T): void => {}
  const settled = new Promise<T>((resolve) => { release = resolve })
  return { settled, resolve: (value) => { release(value) } }
}
