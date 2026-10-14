import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage, { storageBackendServiceKey, type StorageBackend } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { Peer, type ConnectionRpcHandler, type ConnectionRpcHandlerResult, type PeerScope } from '@deepseek-ai/dsh-client-connection'
import SessionStore, { SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { AnnotationId } from '../src/draft.ts'
import type { ChatTextSurfaceId, ChatTextRevision } from '@deepseek-ai/dsh-client-ui-chat'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type { ConversationContributionId } from '@deepseek-ai/dsh-client-ui-conversation'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import * as Host from '../src/host.ts'
import { CHANNEL, OWNER_ID, PREPARE_ABSENT_CODE, formatAnnotations, type AnnotationSnapshot, type CapturedAnnotation, type PreparedRecord, type PrepareInput } from '../src/shared.ts'

// Real public SessionQuery observation/replay path; only unused full-text search
// is stubbed. This is not a Desktop/Loader/browser transport smoke test.
class ObservationQuery extends SessionQueryEngine {
  async searchSessions(): Promise<never> { throw new Error('Search unused by sidecar tests.') }
  async searchEvents(): Promise<never> { throw new Error('Search unused by sidecar tests.') }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes }); return { promise, resolve } }
const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    // Verify the absolute deletion target is our explicitly created temp tree.
    if (resolve(root) !== root || !root.startsWith(join(resolve(tmpdir()), 'dsh-annotation-host-'))) throw new Error('Unsafe test cleanup target.')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture(existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(resolve(tmpdir()), 'dsh-annotation-host-'))
  if (!existingRoot) roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Storage)
  const medium = new JsonStorageBackend(root)
  const state = { writes: 0, failWrites: 0, writeStarted: undefined as ReturnType<typeof deferred> | undefined,
    writeGate: undefined as ReturnType<typeof deferred> | undefined, unregisterGate: undefined as ReturnType<typeof deferred> | undefined,
    unitClosed: 0, unregisterStarted: false }
  // Fault injection wraps a REAL public JSON filesystem backend. DomainFacility
  // and its memory/durability sequencing are the real built SDK implementation.
  const backend: StorageBackend = { kv: { open: async (descriptor) => {
    const unit = await medium.kv.open(descriptor)
    return { ...unit, loadAll: () => unit.loadAll(), deleteRecord: (...args) => unit.deleteRecord(...args),
      setGlobal: value => unit.setGlobal(value), putRecord: async (...args) => {
        state.writes++; state.writeStarted?.resolve(); await state.writeGate?.promise
        if (state.failWrites > 0) { state.failWrites--; throw new Error('Injected filesystem durability failure.') }
        return unit.putRecord(...args)
      }, close: async () => { state.unitClosed++; await unit.close() } }
  } }, close: () => medium.close() }
  ctx.effect(() => () => medium.close())
  ctx.effect(() => ctx.storage.backend.register('json', backend))
  ctx.provide(storageBackendServiceKey('json'), backend)
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(ObservationQuery)
  const browserPeer = new Peer(ctx, { principal: { kind: 'owner' } })
  ctx.effect(() => () => browserPeer.dispose())
  const channels = new Map<string, ConnectionRpcHandler>()
  // Transport-independent carrier double with a real page Peer.
  const disposeConnectionAdapter = ctx.provide('connection', { browserPeer, rpc: { handle: (channel: string, handler: ConnectionRpcHandler) => {
    if (channels.has(channel)) throw new Error('Channel already registered.')
    channels.set(channel, handler)
    return async () => { state.unregisterStarted = true; await state.unregisterGate?.promise; channels.delete(channel) }
  } } })
  ctx.provide('agents', { get: (id: SessionId) => {
    const session = ctx.sessions.get(id)
    return session ? { id, session } : undefined
  } })
  const fileUploads = {
    resolve: vi.fn<(agent: unknown, receiptId: string) => import('@deepseek-ai/dsh-attachment').FileAttachmentRef | undefined>(() => undefined),
    uploadStream: vi.fn(),
  }
  const attachments = { readFileStream: vi.fn() }
  ctx.provide('fileUploads', fileUploads)
  ctx.provide('attachments', attachments)
  const removeFlush = ctx.on('session/flush', async () => {})
  const plugin = await ctx.plugin(Host)
  const sessions = ctx.get('sessions')
  if (!sessions) throw new Error('Session store did not load.')
  const session = sessions.create(SessionId('s'))
  function assistant(target: Session = session, content = 'hello 😀 table', interrupted = false) {
    const turn = target.seq + 1
    target.append('turn/start', { turn }); target.append('step/start', { turn, step: 1 })
    const message = createAssistantMessage({ content: [{ type: 'text', text: content }], source: { provider: 'test', model: 'test' } })
    const event = target.append('assistant/message', { turn, step: 1, message, stream: [], ...(interrupted ? { interrupted: true as const } : {}) }, { surfaceOp: 'append' })
    target.append('step/end', { turn, step: 1 }); target.append('turn/end', { turn, reason: { kind: 'completed' } })
    return event
  }
  const source = assistant()
  function prepare(requestId = 'r', target = session, sourceEvent = source): PrepareInput {
    const snapshot: AnnotationSnapshot = { revision: 1, annotations: [{ id: brandString<AnnotationId>('a'), revision: 1, seq: sourceEvent.seq, comment: 'Explain this\n请解释',
      anchor: { kind: 'conversation', sessionId: target.id, messageId: sourceEvent.data.message.id, blockId: brandString<ChatTextSurfaceId>('opaque-surface'), revision: brandString<ChatTextRevision>('opaque-revision'), start: 0, end: 5, selectedText: 'hello' } }] }
    return assemble(snapshot, requestId, target.id)
  }
  async function call(
    endpoint: string, payload: unknown, signal = new AbortController().signal, peer: PeerScope = browserPeer,
  ): Promise<ConnectionRpcHandlerResult> {
    const handler = channels.get(CHANNEL)
    if (!handler) throw new Error('Channel is not registered.')
    return handler(endpoint, payload, signal, peer)
  }
  async function ok<T = PreparedRecord>(endpoint: string, payload: unknown): Promise<T> {
    const result = await call(endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  function user(requestId = 'r', legacy = false) {
    return createUserMessage({ content: [{ type: 'text', text: 'actual prompt' }], source: legacy ? { kind: 'user' as const } : { kind: 'user' as const, rpcId: brandString<SessionRequestId>(requestId) } })
  }
  return {
    ctx, root, state, plugin, channels, sessions, session, source, assistant, prepare,
    call, ok, user, browserPeer, disposeConnectionAdapter, removeFlush, fileUploads, attachments,
  }
}

function assemble(snapshot: AnnotationSnapshot, requestId: string, sessionId: string): PrepareInput {
  const text = formatAnnotations(snapshot)
  return { snapshot, attempt: { sessionId: SessionId(sessionId), requestId: brandString<SessionRequestId>(requestId), source: 'click', mode: 'queue', text: 'Prompt\n' + text, attachments: [], contributions: [{ id: OWNER_ID, revision: snapshot.revision, text }] } }
}
function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reordered(v)]))
  return value
}

describe('independent Host public SDK composition', () => {
  it.each(['source', 'receipt'] as const)('certifies absent preparation for a pre-write %s rejection', async (failure) => {
    const h = await fixture(); const original = h.prepare()
    const input = failure === 'source' ? assemble({ ...original.snapshot, annotations: original.snapshot.annotations.map(annotation => ({
      ...annotation, anchor: { ...annotation.anchor, messageId: brandString<MessageId>('missing-source') },
    })) }, 'r', 's') : { ...original, attempt: { ...original.attempt, attachments: [{ type: 'file' as const, receiptId: brandString<FileUploadReceiptId>('missing-receipt') }] } }
    expect(await h.call('prepare', input)).toMatchObject({ ok: false, error: { code: PREPARE_ABSENT_CODE } })
    expect(h.state.writes).toBe(0)
    expect(await h.ok('list', { sessionId: 's' })).toEqual([])
  })
  it('refuses preparation without a persistence listener and after a failed flush', async () => {
    const h = await fixture()
    h.removeFlush()
    expect(await h.call('prepare', h.prepare())).toMatchObject({ ok: false, error: { code: PREPARE_ABSENT_CODE } })
    expect(await h.ok('list', { sessionId: 's' })).toEqual([])
    h.ctx.on('session/flush', () => { throw new Error('disk unavailable') })
    expect(await h.call('prepare', h.prepare())).toMatchObject({ ok: false, error: { code: PREPARE_ABSENT_CODE } })
    expect(await h.ok('list', { sessionId: 's' })).toEqual([])
  })
  it('does not prepare against an owner lost while the persistence barrier waits', async () => {
    const h = await fixture()
    const entered = deferred(); const gate = deferred()
    h.removeFlush()
    h.ctx.on('session/flush', async () => { entered.resolve(); await gate.promise })
    const get = h.sessions.get.bind(h.sessions)
    let present = true
    const lookup = vi.spyOn(h.sessions, 'get').mockImplementation(id => id === h.session.id && !present ? undefined : get(id))
    const preparing = h.call('prepare', h.prepare())
    try {
      await entered.promise
      present = false
      gate.resolve()
      expect(await preparing).toMatchObject({ ok: false })
    } finally {
      gate.resolve()
      lookup.mockRestore()
    }
    expect(await h.ok('list', { sessionId: 's' })).toEqual([])
  })
  it('does not promote an ACK or memory echo without durable admission evidence', async () => {
    const h = await fixture()
    await h.ok('prepare', h.prepare())
    expect(await h.ok('settle', { sessionId: 's', requestId: 'r', status: 'accepted' })).toMatchObject({ status: 'uncertain' })
    h.session.append('user/message', h.user(), { surfaceOp: 'append' })
    h.removeFlush()
    expect(await h.ok('reconcile', { sessionId: 's', requestId: 'r' })).toMatchObject({ status: 'uncertain' })
    h.ctx.on('session/flush', () => { throw new Error('disk unavailable') })
    expect(await h.ok('settle', { sessionId: 's', requestId: 'r', status: 'accepted' })).toMatchObject({ status: 'uncertain' })
  })
  it('restages only Host-resolved prepared file references without changing the immutable attempt', async () => {
    const h = await fixture()
    const ref = { attachmentId: `sha256:${'a'.repeat(64)}` as import('@deepseek-ai/dsh-attachment').AttachmentId, name: 'report.txt', bytes: 3 }
    h.fileUploads.resolve.mockReturnValue(ref)
    const original = h.prepare()
    const input: PrepareInput = { ...original, attempt: { ...original.attempt, attachments: [{ type: 'file', receiptId: brandString<FileUploadReceiptId>('original-receipt') }] } }
    const prepared = await h.ok('prepare', input)
    const data = (async function* () { yield new Uint8Array([1, 2, 3]) })()
    h.attachments.readFileStream.mockReturnValue(data)
    h.fileUploads.uploadStream.mockResolvedValue({ receiptId: 'fresh-receipt', file: ref })
    expect(await h.ok('restage', { sessionId: 's', requestId: 'r' })).toEqual([{ type: 'file', receiptId: 'fresh-receipt' }])
    expect(h.attachments.readFileStream).toHaveBeenCalledWith(ref)
    expect(h.fileUploads.uploadStream).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's', name: 'report.txt', data }))
    expect(await h.ok('read', { sessionId: 's', requestId: 'r' })).toEqual(prepared)
    expect(await h.call('restage', { sessionId: 'other', requestId: 'r' })).toMatchObject({ ok: false })
    expect(await h.call('restage', { sessionId: 's', requestId: 'r', ref })).toMatchObject({ ok: false })
    h.fileUploads.uploadStream.mockRejectedValue(new Error('stored attachment is missing'))
    expect(await h.call('restage', { sessionId: 's', requestId: 'r' })).toMatchObject({ ok: false })
    expect(await h.ok('read', { sessionId: 's', requestId: 'r' })).toEqual(prepared)
  })
  it('durably prepares uncertain without admission and freezes the complete envelope', async () => {
    const h = await fixture(); const input = h.prepare()
    const record = await h.ok('prepare', input)
    expect(record).toEqual({ schemaVersion: 1, ...input, status: 'uncertain' })
    expect(Object.isFrozen(record.snapshot.annotations[0]?.anchor)).toBe(true)
    expect(await h.ok('read', { sessionId: 's', requestId: 'r' })).toEqual(record)
    expect(await h.ok<PreparedRecord[]>('list', { sessionId: 's' })).toEqual([record])
    expect(await h.ok('reconcile', { sessionId: 's', requestId: 'r' })).toEqual(record)
    expect(h.state.writes).toBe(1)
  })
  it('serializes competing attempts and allows independent Sessions without cross-read leakage', async () => {
    const h = await fixture(); const other = h.sessions.create(SessionId('other')); const source = h.assistant(other)
    const results = await Promise.all([h.call('prepare', h.prepare('a')), h.call('prepare', h.prepare('b')), h.call('prepare', h.prepare('a', other, source))])
    expect(results.map(r => r.ok)).toEqual([true, false, true])
    expect(await h.ok<PreparedRecord[]>('list', { sessionId: 's' })).toHaveLength(1)
    expect(await h.ok<PreparedRecord[]>('list', { sessionId: 'other' })).toHaveLength(1)
    expect(await h.ok('read', { sessionId: 's', requestId: 'b' })).toBeNull()
  })
  it('makes reordered identical retries idempotent and rejects every changed envelope field', async () => {
    const h = await fixture(); const input = h.prepare(); await h.ok('prepare', input)
    await h.ok('prepare', reordered(input)); expect(h.state.writes).toBe(1)
    const changedSnapshot = { ...input.snapshot, annotations: input.snapshot.annotations.map(a => ({ ...a, comment: 'changed' })) }
    const changes: PrepareInput[] = [
      { ...input, attempt: { ...input.attempt, text: 'different\n' + formatAnnotations(input.snapshot) } },
      { ...input, attempt: { ...input.attempt, mode: 'steer' } },
      { ...input, attempt: { ...input.attempt, source: 'enter' } },
      { ...input, attempt: { ...input.attempt, attachments: [{ type: 'file', receiptId: brandString<FileUploadReceiptId>('changed') }] } },
      { ...input, attempt: { ...input.attempt, contributions: [...input.attempt.contributions, { id: brandString<ConversationContributionId>('other'), revision: 0, text: 'other text' }] } },
      assemble(changedSnapshot, 'r', 's'),
    ]
    for (const changed of changes) {
      const result = await h.call('prepare', changed)
      expect(result).toMatchObject({ ok: false })
      if (result.ok) throw new Error('Changed immutable envelope was accepted.')
      expect(result.error.message.includes('immutable')).toBe(true)
      expect(result.error.code).toBe('annotation-error')
    }
    expect(h.state.writes).toBe(1)
  })
  it('retains a prepared identity durably when the caller loses its acknowledgement', async () => {
    const h = await fixture(); const input = h.prepare()
    // Delivery loses the reply; the caller has no accepted preparation response.
    await h.call('prepare', input)
    await h.ctx.fiber.dispose()
    const restarted = await fixture(h.root)
    expect(await restarted.ok('list', { sessionId: 's' })).toEqual([{ schemaVersion: 1, ...input, status: 'uncertain' }])
    expect(await restarted.ok('prepare', input)).toEqual({ schemaVersion: 1, ...input, status: 'uncertain' })
    expect(restarted.state.writes).toBe(0)
  })
  it('recovers exact snapshots after a complete durable backend restart', async () => {
    const h = await fixture(); const input = h.prepare(); const stored = await h.ok('prepare', input)
    await h.ctx.fiber.dispose()
    const restarted = await fixture(h.root)
    expect(await restarted.ok('read', { sessionId: 's', requestId: 'r' })).toEqual(stored)
    // Source visibility can disappear; an identical durable retry remains valid.
    expect(await restarted.ok('prepare', reordered(input))).toEqual(stored)
    expect(restarted.state.writes).toBe(0)
  })
  it('does not mutate memory on failed durable preparation or failed settlement', async () => {
    const h = await fixture(); h.state.failWrites = 1
    expect(await h.call('prepare', h.prepare())).toMatchObject({ ok: false, error: { code: 'annotation-error' } })
    expect(await h.ok<PreparedRecord[]>('list', { sessionId: 's' })).toEqual([])
    const stored = await h.ok('prepare', h.prepare()); h.state.failWrites = 1
    h.session.append('user/message', h.user(), { surfaceOp: 'append' })
    expect(await h.call('settle', { sessionId: 's', requestId: 'r', status: 'accepted' })).toMatchObject({ ok: false })
    expect(await h.ok('read', { sessionId: 's', requestId: 'r' })).toEqual(stored)
    expect((await h.ok('settle', { sessionId: 's', requestId: 'r', status: 'accepted' })).status).toBe('accepted')
  })
  it('reconciles a lost ACK from complete old owned user history, never the visible window', async () => {
    const h = await fixture(); await h.ok('prepare', h.prepare()); const message = h.user()
    h.session.append('user/message', message, { surfaceOp: 'append' })
    for (let n = 0; n < 80; n++) h.session.append('assistant/attempt', { turn: 1, step: n + 1, stream: [] })
    expect(await h.ok('reconcile', { sessionId: 's', requestId: 'r' })).toMatchObject({ status: 'accepted', messageId: message.id })
    expect(await h.ok('read', { sessionId: 's', requestId: 'r', messageId: message.id })).toMatchObject({ status: 'accepted' })
  })
  it.each(['next-turn', 'next-step'] as const)('recovers lost ACK from durable %s Inbox insertion without fabricating a user message id', async (target) => {
    const h = await fixture(); await h.ok('prepare', h.prepare())
    h.session.append('agent/inbox/spliced', { target, start: 0, inserted: [h.user()] })
    h.session.append('agent/inbox/spliced', { target, start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    const record = await h.ok('reconcile', { sessionId: 's', requestId: 'r' })
    expect(record.status).toBe('accepted'); expect(record.messageId).toBeUndefined()
    expect(await h.ok('read', { sessionId: 's', requestId: 'r', messageId: 'invented' })).toBeNull()
  })
  it('never guesses a legacy rpcId, inherited ownership, or a replacement echo', async () => {
    const h = await fixture()
    const inheritedUser = h.user(); h.session.append('user/message', inheritedUser, { surfaceOp: 'append' })
    h.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [h.user()] })
    const child = h.sessions.fork(h.session, undefined, SessionId('child'))
    await h.ok('prepare', h.prepare('r', child)) // Inherited assistant source IS selectable.
    expect((await h.ok('reconcile', { sessionId: 'child', requestId: 'r' })).status).toBe('uncertain')
    expect(await h.ok('read', { sessionId: 'child', requestId: 'r', messageId: inheritedUser.id })).toBeNull()
    const legacy = h.user('r', true); const event = child.append('user/message', legacy, { surfaceOp: 'append' })
    const replacement = h.user(); child.append('user/message', replacement, { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
    expect((await h.ok('reconcile', { sessionId: 'child', requestId: 'r' })).status).toBe('uncertain')
    expect(await h.ok('read', { sessionId: 'child', requestId: 'r', messageId: legacy.id })).toBeNull()
    expect(await h.ok('read', { sessionId: 'child', requestId: 'r', messageId: replacement.id })).toBeNull()
  })
  it('rejects forged, missing, interrupted, empty-body, and foreign assistant identities', async () => {
    const h = await fixture(); const input = h.prepare(); const interrupted = h.assistant(h.session, 'hello', true); const empty = h.assistant(h.session, '')
    const a = input.snapshot.annotations[0]!
    const variants: CapturedAnnotation[] = [
      { ...a, seq: SessionSeq(999) }, { ...a, seq: SessionSeq(0) }, { ...a, anchor: { ...a.anchor, messageId: brandString<MessageId>('forged') } },
      { ...a, seq: interrupted.seq, anchor: { ...a.anchor, messageId: interrupted.data.message.id } },
      { ...a, seq: empty.seq, anchor: { ...a.anchor, messageId: empty.data.message.id } },
      { ...a, anchor: { ...a.anchor, sessionId: SessionId('foreign') } },
    ]
    for (const annotation of variants) expect(await h.call('prepare', assemble({ ...input.snapshot, annotations: [annotation] }, 'r', 's'))).toMatchObject({ ok: false })
    expect(await h.ok<PreparedRecord[]>('list', { sessionId: 's' })).toEqual([])
  })
  it('validates the public source boundary without pretending opaque revision and visible offsets are raw Markdown offsets', async () => {
    const h = await fixture(); const input = h.prepare()
    const snapshot: AnnotationSnapshot = { ...input.snapshot, annotations: input.snapshot.annotations.map(a => ({ ...a, anchor: { ...a.anchor, start: 100, end: 105, revision: brandString<ChatTextRevision>('operator-visible-opaque') } })) }
    // Intentional, documented boundary: exact source identity is verified; Host
    // cannot publicly reconstruct renderer-visible revision/offset authenticity.
    expect((await h.ok('prepare', assemble(snapshot, 'r', 's'))).status).toBe('uncertain')
  })
  it('rejects an independent owner API Peer at every endpoint and releases browser observation leases', async () => {
    const h = await fixture(); const releases = vi.fn()
    const read = h.ctx.sessionQuery.observeSession.bind(h.ctx.sessionQuery)
    vi.spyOn(h.ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const observation = await read(...args)
      const release = observation[Symbol.dispose].bind(observation)
      return { ...observation, [Symbol.dispose]: () => { releases(); release() } }
    })
    const apiPeer = new Peer(h.ctx, { principal: { kind: 'owner' }, interactions: 'none' })
    await h.ok('prepare', h.prepare())
    const writes = h.state.writes
    try {
      for (const endpoint of ['prepare', 'restage', 'list', 'read', 'settle', 'reconcile']) {
        const payload = endpoint === 'prepare' ? h.prepare('api-request') : { sessionId: 's', requestId: 'r', status: 'rejected' }
        expect(await h.call(endpoint, payload, undefined, apiPeer)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      }
      expect(h.state.writes).toBe(writes)
      expect(releases).toHaveBeenCalledTimes(1)
      expect(await h.ok<PreparedRecord[]>('list', { sessionId: 's' })).toHaveLength(1)
      await h.ok('reconcile', { sessionId: 's', requestId: 'r' })
      expect(releases).toHaveBeenCalledTimes(2)
    } finally { await apiPeer.dispose() }
  })
  it('awaits channel unregister, drains in-flight durable writes, closes one domain, and permits remount', async () => {
    const h = await fixture(); h.state.writeStarted = deferred(); h.state.writeGate = deferred(); h.state.unregisterGate = deferred()
    const preparing = h.call('prepare', h.prepare()); await h.state.writeStarted.promise
    let unloaded = false; const unload = h.plugin.dispose().then(() => { unloaded = true })
    await Promise.resolve(); expect(h.state.unitClosed).toBe(0)
    h.state.unregisterGate.resolve(); await Promise.resolve(); expect(unloaded).toBe(false)
    h.state.writeGate.resolve(); expect((await preparing).ok).toBe(true); await unload
    expect(h.channels.size).toBe(0); expect(h.state.unitClosed).toBe(1)
    const mounted = await h.ctx.plugin(Host)
    expect((await h.ok('read', { sessionId: 's', requestId: 'r' })).status).toBe('uncertain')
    await mounted.dispose(); expect(h.channels.size).toBe(0); expect(h.state.unitClosed).toBe(2)
  })
  it('cancels queued attempts before write and keeps rejected-retry reservation strict', async () => {
    const h = await fixture(); const cancelled = new AbortController(); cancelled.abort()
    expect(await h.call('prepare', h.prepare(), cancelled.signal)).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(h.state.writes).toBe(0)
    const input = h.prepare(); await h.ok('prepare', input); await h.ok('settle', { sessionId: 's', requestId: 'r', status: 'rejected' })
    await h.ok('prepare', h.prepare('other'))
    expect(await h.call('prepare', input)).toMatchObject({ ok: false })
    expect(await h.call('reconcile', { sessionId: 's', requestId: 'r' })).toMatchObject({ ok: false })
    expect(await h.call('settle', { sessionId: 's', requestId: 'r', status: 'uncertain' })).toMatchObject({ ok: false })
    expect((await h.ok<PreparedRecord[]>('list', { sessionId: 's' })).filter(r => r.status === 'uncertain')).toHaveLength(1)
  })
  it('rejects conflicting owned user identities instead of guessing a binding or accepting a callback', async () => {
    const h = await fixture(); await h.ok('prepare', h.prepare())
    const first = h.user(); const second = h.user()
    h.session.append('user/message', first, { surfaceOp: 'append' })
    h.session.append('user/message', second, { surfaceOp: 'append' })
    expect(await h.call('read', { sessionId: 's', requestId: 'r', messageId: first.id })).toMatchObject({ ok: false })
    expect(await h.call('reconcile', { sessionId: 's', requestId: 'r' })).toMatchObject({ ok: false })
    expect(await h.call('settle', { sessionId: 's', requestId: 'r', status: 'accepted' })).toMatchObject({ ok: false })
    expect((await h.ok('read', { sessionId: 's', requestId: 'r' })).status).toBe('uncertain')
  })
  it.each(['wrong-key', 'multiple-unsettled'] as const)('rejects authoritative %s stored corruption and closes the startup handle', async (corruption) => {
    const h = await fixture(); await h.plugin.dispose()
    const domain = await h.ctx.storageDomain.open(Host.annotationDomain)
    const table = domain.table('attempts')
    const first: PreparedRecord = { schemaVersion: 1, ...h.prepare(), status: 'uncertain' }
    await table.put(corruption === 'wrong-key' ? 'unrelated-key' : JSON.stringify(['s', 'r']), { record: first, files: [] })
    if (corruption === 'multiple-unsettled') await table.put(JSON.stringify(['s', 'other']), { record: { schemaVersion: 1, ...h.prepare('other'), status: 'uncertain' }, files: [] })
    await domain.close()
    const priorCloses = h.state.unitClosed
    await expect(h.ctx.plugin(Host)).rejects.toThrow(corruption === 'wrong-key' ? 'key' : 'multiple unsettled')
    expect(h.state.unitClosed).toBe(priorCloses + 1)
    expect(h.channels.size).toBe(0)
  })
  it('cancels a queued retry and retries a definitively rejected immutable envelope without duplicating durable identity', async () => {
    const h = await fixture(); h.state.writeStarted = deferred(); h.state.writeGate = deferred()
    const first = h.call('prepare', h.prepare()); await h.state.writeStarted.promise
    const controller = new AbortController(); const retry = h.call('prepare', h.prepare(), controller.signal)
    controller.abort(); h.state.writeGate.resolve()
    expect((await first).ok).toBe(true)
    expect(await retry).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(h.state.writes).toBe(1)
    await h.ok('settle', { sessionId: 's', requestId: 'r', status: 'rejected' })
    expect((await h.ok('prepare', h.prepare())).status).toBe('uncertain')
    expect(await h.ok<PreparedRecord[]>('list', { sessionId: 's' })).toHaveLength(1)
  })
  it('returns uncertain, not rejected, when complete history is unavailable', async () => {
    const h = await fixture(); await h.ok('prepare', h.prepare())
    vi.spyOn(h.ctx.sessionQuery, 'observeSession').mockRejectedValue(new Error('Unavailable persisted history'))
    expect((await h.ok('reconcile', { sessionId: 's', requestId: 'r' })).status).toBe('uncertain')
  })
  it('preserves accepted positive knowledge despite missing history and delayed rejection callbacks', async () => {
    const h = await fixture(); await h.ok('prepare', h.prepare())
    h.session.append('user/message', h.user(), { surfaceOp: 'append' })
    await h.ok('settle', { sessionId: 's', requestId: 'r', status: 'accepted' })
    vi.spyOn(h.ctx.sessionQuery, 'observeSession').mockRejectedValue(new Error('Temporarily unavailable history'))
    expect((await h.ok('reconcile', { sessionId: 's', requestId: 'r' })).status).toBe('accepted')
    expect((await h.ok('settle', { sessionId: 's', requestId: 'r', status: 'rejected' })).status).toBe('accepted')
  })
})
