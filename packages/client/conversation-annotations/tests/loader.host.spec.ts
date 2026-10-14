import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ChatTextRevision, ChatTextSurfaceId } from '@deepseek-ai/dsh-client-ui-chat'
import type { AnnotationId } from '../src/draft.ts'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import { Peer, type ConnectionRpcHandler, type ConnectionRpcHandlerResult, type PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import * as Annotations from '../src/host.ts'
import { CHANNEL, OWNER_ID, formatAnnotations, type AnnotationSnapshot, type PrepareInput } from '../src/shared.ts'

interface RuntimeState {
  readonly handlers: Map<string, ConnectionRpcHandler>
  readonly agents: Map<SessionId, Agent>
  readonly browserPeer: Peer
  readonly rpcReady: Promise<void>
  readonly markRpcReady: () => void
}

/** Supplies only carrier and identity services that are external to this composition. */
function externalProviders(state: RuntimeState) {
  const connection = {
    name: 'test-connection',
    apply(ctx: Context) {
      const connection: Pick<HostConnectionHandle, 'browserPeer' | 'rpc' | 'fetch'> = {
        browserPeer: state.browserPeer,
        rpc: { handle(channel, handler) {
          if (state.handlers.has(channel)) throw new Error(`Duplicate RPC channel ${channel}.`)
          state.handlers.set(channel, handler)
          state.markRpcReady()
          return async () => { state.handlers.delete(channel) }
        }, intercept: () => async () => {} },
        fetch: { register: () => async () => {} },
      }
      const serviceName: string = 'connection'
      ctx.provide(serviceName, connection)
      ctx.effect(() => () => state.browserPeer.dispose())
    },
  }
  const agents = {
    name: 'test-agents',
    apply(ctx: Context) {
      const serviceName: string = 'agents'
      ctx.provide(serviceName, { get: (id: SessionId) => state.agents.get(id) })
    },
  }
  const commands = {
    name: 'test-commands',
    apply(ctx: Context) {
      const commands: Pick<CommandRuntime, 'registerFileReceiptResolver'> = {
        registerFileReceiptResolver: () => () => {},
      }
      const serviceName: string = 'commands'
      ctx.provide(serviceName, commands)
    },
  }
  return { connection, agents, commands }
}

class TestSessionQuery extends SessionQueryEngine {
  async searchSessions(): Promise<never> { throw new Error('Search is not used by this composition.') }
  async searchEvents(): Promise<never> { throw new Error('Search is not used by this composition.') }
}

let root: string | undefined
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) {
    const target = resolve(root)
    if (target !== root || !target.startsWith(join(resolve(tmpdir()), 'dsh-annotation-loader-'))) {
      throw new Error('Unsafe Loader test cleanup target.')
    }
    await rm(target, { recursive: true, force: true })
  }
  root = undefined
})

async function loadComposition(): Promise<{ ctx: Context; state: RuntimeState }> {
  root ??= await mkdtemp(join(resolve(tmpdir()), 'dsh-annotation-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storage'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'sessions'))}`,
    '    compression: none',
    "- name: '@deepseek-ai/dsh-session-query'",
    "- name: '@deepseek-ai/dsh-attachment-local'",
    '  config:',
    `    dshHome: ${JSON.stringify(join(root, 'home'))}`,
    "- name: '@deepseek-ai/dsh-client-file-upload'",
    '- name: test:connection',
    '- name: test:agents',
    '- name: test:commands',
    "- name: '@deepseek-ai/dsh-client-conversation-annotations'",
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  let markFileUploadsReady!: () => void
  const fileUploadsReady = new Promise<void>((resolveReady) => { markFileUploadsReady = resolveReady })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  let markRpcReady!: () => void
  const rpcReady = new Promise<void>((resolveReady) => { markRpcReady = resolveReady })
  const state: RuntimeState = {
    handlers: new Map(), agents: new Map(), browserPeer: new Peer(ctx, { principal: { kind: 'owner' } }), rpcReady, markRpcReady,
  }
  const providers = externalProviders(state)
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', JsonStorage],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-session-query', TestSessionQuery],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
    ['@deepseek-ai/dsh-client-file-upload', FileUploads],
    ['@deepseek-ai/dsh-client-conversation-annotations', Annotations],
    ['test:connection', providers.connection],
    ['test:agents', providers.agents],
    ['test:commands', providers.commands],
  ])
  Object.defineProperty(ctx.loader, 'internal', { configurable: true, writable: true, value: {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader module ${specifier}.`)
      return modules.get(specifier)
    },
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  ctx.inject(['fileUploads'], markFileUploadsReady)
  await Promise.all([fileUploadsReady, state.rpcReady])
  return { ctx, state }
}

function call(
  state: RuntimeState, endpoint: string, payload: unknown, peer: PeerScope = state.browserPeer,
): Promise<ConnectionRpcHandlerResult> {
  const handler = state.handlers.get(CHANNEL)
  if (!handler) throw new Error('Conversation annotations RPC handler is not mounted.')
  return handler(endpoint, payload, new AbortController().signal, peer)
}

function input(session: Session, requestId: SessionRequestId, assistantSeq: SessionSeqType, assistantId: MessageId): PrepareInput {
  const snapshot: AnnotationSnapshot = {
    revision: 1,
    annotations: [{
      id: brandString<AnnotationId>('annotation-1'), revision: 1, seq: assistantSeq, comment: 'Explain this',
      anchor: {
        kind: 'conversation', sessionId: session.id, messageId: assistantId,
        blockId: brandString<ChatTextSurfaceId>('surface-text-1'),
        revision: brandString<ChatTextRevision>('surface-revision-1'),
        start: 0, end: 5, selectedText: 'hello',
      },
    }],
  }
  const text = formatAnnotations(snapshot)
  return {
    snapshot,
    attempt: {
      sessionId: session.id,
      requestId,
      source: 'click',
      mode: 'queue',
      text: `Prompt\n${text}`,
      attachments: [],
      contributions: [{ id: OWNER_ID, revision: snapshot.revision, text }],
    },
  }
}

function success(result: ConnectionRpcHandlerResult): unknown {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

describe('conversation annotations through a real Loader composition', () => {
  it('waits for Session flush, persists ordinary prompt text and prepared files, then reconciles and restages after restart', async () => {
    const { ctx, state } = await loadComposition()
    const session = ctx.sessions.create(SessionId('annotation-loader-session'))
    const agent = { id: session.id, session } as Agent
    state.agents.set(session.id, agent)
    const writeHandle = await ctx.sessionPersistence.create(session.header)
    const turn = session.seq + 1
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    const assistant = createAssistantMessage({ content: [{ type: 'text', text: 'hello from a real persisted assistant message' }], source: { provider: 'fixture', model: 'fixture' } })
    const assistantEvent = session.append('assistant/message', {
      turn, step: 1, message: assistant, stream: [],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })

    const fileUploads = ctx.get('fileUploads')
    if (fileUploads === undefined) throw new Error('FileUploads service was not registered.')
    const uploaded = await fileUploads.uploadStream({
      sessionId: session.id,
      name: 'source.txt',
      data: (async function* () { yield new TextEncoder().encode('durable annotation attachment') })(),
    })
    const requestId = brandString<SessionRequestId>('ordinary-user-request')
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: 'Please explain the annotated passage.' }],
      source: { kind: 'user', rpcId: requestId },
    })
    session.append('user/message', userMessage, { surfaceOp: 'append' })
    const noFiles = input(session, requestId, assistantEvent.seq, assistant.id)
    const original: PrepareInput = {
      ...noFiles,
      attempt: { ...noFiles.attempt, attachments: [{ type: 'file', receiptId: uploaded.receiptId }] },
    }

    let releaseFlush!: () => void
    let flushStarted!: () => void
    const started = new Promise<void>((resolveStarted) => { flushStarted = resolveStarted })
    const gate = new Promise<void>((resolveGate) => { releaseFlush = resolveGate })
    ctx.on('session/flush', async () => { flushStarted(); await gate })
    const preparing = call(state, 'prepare', original)
    await started
    let prepared = false
    void preparing.then(() => { prepared = true })
    await Promise.resolve()
    expect(prepared).toBe(false)
    releaseFlush()
    const preparedRecord = success(await preparing)
    expect(preparedRecord).toMatchObject({
      status: 'uncertain', attempt: { attachments: [{ type: 'file', receiptId: uploaded.receiptId }] },
    })

    const staged = await ctx.sessionPersistence.open(session.id, 'read')
    const persisted = await staged.read()
    await staged.close()
    expect(persisted.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'user'
      && event.data.content.some(part => part.type === 'text' && part.text === 'Please explain the annotated passage.'))).toBe(true)
    expect(persisted.events.some(event => event.type === 'assistant/message'
      && event.data.message.id === assistant.id
      && event.data.message.content.some(part => part.type === 'text' && part.text === 'hello from a real persisted assistant message'))).toBe(true)
    await writeHandle.close()

    await Promise.all(contexts.splice(0).map(item => item.fiber.dispose()))
    const cold = await loadComposition()
    const coldRead = await cold.ctx.sessionPersistence.open(session.id, 'read')
    const coldLog = await coldRead.read()
    await coldRead.close()
    const restoredSession = cold.ctx.sessions.create(SessionId(session.id), { seed: coldLog.events })
    cold.state.agents.set(restoredSession.id, { id: restoredSession.id, session: restoredSession } as Agent)
    const reconciled = success(await call(cold.state, 'reconcile', { sessionId: session.id, requestId }))
    expect(reconciled).toMatchObject({ status: 'accepted' })
    const attachments = success(await call(cold.state, 'restage', { sessionId: session.id, requestId }))
    expect(attachments).toHaveLength(1)
    expect(attachments).toMatchObject([{ type: 'file' }])
    expect(attachments).not.toMatchObject([{ receiptId: uploaded.receiptId }])

    const replayed = await cold.ctx.sessionPersistence.open(session.id, 'read')
    const afterRestage = await replayed.read()
    await replayed.close()
    expect(afterRestage.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(success(await call(cold.state, 'read', { sessionId: session.id, requestId }))).toMatchObject({
      status: 'accepted', attempt: { attachments: [{ type: 'file', receiptId: uploaded.receiptId }] },
    })
  })

  it('rejects an independent owner API Peer without creating a durable record', async () => {
    const { ctx, state } = await loadComposition()
    const session = ctx.sessions.create(SessionId('foreign-peer-session'))
    const turn = 1
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    const assistant = createAssistantMessage({ content: [{ type: 'text', text: 'hello' }], source: { provider: 'fixture', model: 'fixture' } })
    const event = session.append('assistant/message', { turn, step: 1, message: assistant, stream: [] }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    const apiPeer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
    try {
      const result = await call(state, 'prepare', input(session, brandString<SessionRequestId>('foreign-request'), event.seq, assistant.id), apiPeer)
      expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(success(await call(state, 'list', { sessionId: session.id }))).toEqual([])
    } finally { await apiPeer.dispose() }
  })
})
