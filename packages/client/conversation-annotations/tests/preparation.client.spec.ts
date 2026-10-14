import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { AnnotationId } from '../src/draft.ts'
import type { ChatTextSurfaceId, ChatTextRevision } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { AnnotationClient } from '../src/client/controller.ts'
import { SubmissionContributionRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/submission-contributions.ts'
import {
  OWNER_ID, PREPARE_ABSENT_CODE, canonicalJSON, formatAnnotations, parsePrepareInput, parseRecordIdentity, parseSettleInput,
  type AnnotationSnapshot, type PreparedRecord, type PrepareInput,
} from '../src/shared.ts'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'

const clientDisposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of clientDisposers.splice(0)) await dispose()
  vi.restoreAllMocks()
})

function assemble(snapshot: AnnotationSnapshot, requestId: string, sessionId: string): PrepareInput {
  const text = formatAnnotations(snapshot)
  return { snapshot, attempt: { sessionId: brandString<SessionId>(sessionId), requestId: brandString<SessionRequestId>(requestId), source: 'click', mode: 'queue', text: 'Prompt\n' + text, attachments: [], contributions: [{ id: OWNER_ID, revision: snapshot.revision, text }] } }
}

// Wire-boundary outcomes only. Real Host persistence and pre-write error evidence
// are exercised separately by annotations.host.spec.ts without loading Client code.
function fixture() {
  const sessionId = brandString<SessionId>('s')
  const messageId = brandString<MessageId>('source')
  const records = new Map<SessionRequestId, PreparedRecord>()
  const admitted = new Set<SessionRequestId>()
  let canFlush = true
  const fileUploads = {
    resolve: vi.fn<(receipt: string) => { attachmentId: string; name: string; bytes: number } | undefined>(() => undefined),
    uploadStream: vi.fn(async () => ({ receiptId: 'fresh' })),
  }
  const session = { id: sessionId, append: (_type: string, user: { requestId: SessionRequestId }) => { admitted.add(user.requestId) } }
  function user(requestId: SessionRequestId) { return { requestId } }
  function prepare(): PrepareInput {
    return assemble({ revision: 1, annotations: [{ id: brandString<AnnotationId>('a'), revision: 1, seq: SessionSeq(1), comment: '',
      anchor: { kind: 'conversation', sessionId, messageId, blockId: brandString<ChatTextSurfaceId>('block'), revision: brandString<ChatTextRevision>('revision'), start: 0, end: 5, selectedText: 'hello' } }] }, 'r', sessionId)
  }
  function failure(code = 'annotation-error'): ConnectionRpcResult<never> {
    return { ok: false, error: { code, message: 'Annotation endpoint failed.', details: {} } }
  }
  async function call(endpoint: string, payload: unknown, _signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>> {
    if (endpoint === 'list') return { ok: true, value: [...records.values()] }
    if (endpoint === 'prepare') {
      const input = parsePrepareInput(payload)
      const existing = records.get(input.attempt.requestId)
      if (existing && canonicalJSON({ attempt: existing.attempt, snapshot: existing.snapshot }) !== canonicalJSON(input)) return failure()
      if (existing?.status === 'accepted' || existing?.status === 'uncertain') return { ok: true, value: existing }
      if (!existing && (!canFlush || input.snapshot.annotations.some(annotation => annotation.anchor.messageId !== messageId)
        || input.attempt.attachments.some(attachment => attachment.type === 'file' && !fileUploads.resolve(attachment.receiptId)))) return failure(PREPARE_ABSENT_CODE)
      const record: PreparedRecord = { schemaVersion: 1, ...input, status: 'uncertain' }
      records.set(input.attempt.requestId, record)
      return { ok: true, value: record }
    }
    const identity = endpoint === 'settle' ? parseSettleInput(payload) : parseRecordIdentity(payload)
    const record = records.get(identity.requestId)
    if (endpoint === 'read') return { ok: true, value: record ?? null }
    if (!record) return failure()
    if (endpoint === 'restage') {
      const attachments = await Promise.all(record.attempt.attachments.map(async attachment => attachment.type === 'file'
        ? { type: 'file', receiptId: (await fileUploads.uploadStream()).receiptId } : attachment))
      return { ok: true, value: attachments }
    }
    const settled: PreparedRecord = { ...record, status: admitted.has(identity.requestId) ? 'accepted'
      : endpoint === 'settle' ? parseSettleInput(payload).status : record.status }
    records.set(identity.requestId, settled)
    return { ok: true, value: settled }
  }
  async function ok(endpoint: string, payload: unknown) {
    const result = await call(endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  return { session, user, prepare, call, ok, fileUploads, removeFlush: () => { canFlush = false } }
}

async function clientFixture(h: Awaited<ReturnType<typeof fixture>>) {
  const registry = new SubmissionContributionRegistry()
  const faults = { losePrepareACK: false, prepareOffline: false, settleOffline: false }
  const call = vi.fn(async (_channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
    if ((endpoint === 'prepare' && faults.prepareOffline) || (endpoint === 'settle' && faults.settleOffline)) throw new Error('Transport disconnected.')
    const result = await h.call(endpoint, payload, signal)
    if (endpoint === 'prepare' && result.ok && faults.losePrepareACK) {
      faults.losePrepareACK = false
      throw new Error('Prepare ACK lost.')
    }
    return result
  })
  const retrySubmission = vi.fn((attempt: import('@deepseek-ai/dsh-client-ui-conversation/client').ConversationSubmissionAttempt, signal: AbortSignal) =>
    registry.run(attempt, signal, async () => {
      h.session.append('user/message', h.user(attempt.requestId))
      return 'accepted'
    }))
  const clientCtx = Object.assign(new Context(), {
    chatText: {
      selection: () => null, subscribe: () => async () => {}, geometry: () => null,
      register: () => ({ update: () => {}, dispose: async () => {} }),
    },
    sessions: { binding: () => ({ session: { getSnapshot: () => ({ subagent: null }) } }) },
    conversation: { submissions: registry, registerContribution: registry.register.bind(registry), retrySubmission },
  })
  vi.spyOn(clientCtx, 'get').mockImplementation(() => ({ rpc: { call } }) as never)
  const client = new AnnotationClient(clientCtx)
  clientDisposers.push(async () => { await client.dispose(); await registry.dispose(); await clientCtx.fiber.dispose() })
  const session = client.forSession(h.session.id)
  await vi.waitFor(() => { expect(session.getSnapshot().busy).toBe(false) })
  const annotation = h.prepare().snapshot.annotations[0]!
  function add(messageId = annotation.anchor.messageId) {
    const { anchor } = annotation
    session.add({ sessionId: h.session.id, messageId, seq: annotation.seq, surfaceId: anchor.blockId,
      revision: anchor.revision, completed: true, start: anchor.start, end: anchor.end, selectedText: anchor.selectedText })
  }
  function capture() { return registry.capture(h.session.id, 'Prompt', [], 'queue', 'click') }
  const admit = vi.fn(async (attempt: import('@deepseek-ai/dsh-client-ui-conversation/client').ConversationSubmissionAttempt) => {
    h.session.append('user/message', h.user(attempt.requestId))
    return 'accepted' as const
  })
  return { client, session, registry, faults, call, retrySubmission, add, capture, admit }
}

describe('Client and real submission registry preparation recovery', () => {
  it.each(['source', 'flush', 'receipt'] as const)('releases confirmed pre-write %s rejection for Clear and ordinary sends', async (failure) => {
    const h = fixture(); const c = await clientFixture(h)
    c.add(failure === 'source' ? brandString<MessageId>('missing-source') : undefined)
    if (failure === 'flush') h.removeFlush()
    const capture = c.capture()
    const attachments = failure === 'receipt' ? [{ type: 'file' as const, receiptId: 'missing-receipt' }] : []
    expect(await c.registry.submit(capture, undefined, async () => ({ text: 'Prompt', attachments }), c.admit)).toMatchObject({ admission: 'rejected' })
    expect(c.admit).not.toHaveBeenCalled()
    expect(await h.ok('list', { sessionId: h.session.id })).toEqual([])
    expect(c.session.getSnapshot()).toMatchObject({ pending: null, frozenIds: [] })
    expect(c.session.getSnapshot().error).toBeTruthy()
    expect(c.registry.storeFor(h.session.id).getSnapshot()).toMatchObject({ hasContent: true })
    expect(c.registry.storeFor(h.session.id).getSnapshot().blockReason).toBeUndefined()
    expect(c.registry.storeFor(h.session.id).getSnapshot().pending).toBeUndefined()
    expect(c.call.mock.calls.some(([, endpoint]) => endpoint === 'settle')).toBe(false)
    await c.session.reconcile()
    await c.session.retry()
    expect(c.retrySubmission).not.toHaveBeenCalled()
    c.session.clear()
    expect(c.session.getSnapshot().draft.annotations).toEqual([])
    const ordinary = c.capture()
    expect(ordinary.requestId).not.toBe(capture.requestId)
    expect(await c.registry.submit(ordinary, undefined, async () => ({ text: 'Prompt', attachments: [] }), c.admit)).toMatchObject({ admission: 'accepted' })
  })

  it('allows corrected attachments to resend the retained draft with a fresh request after confirmed absence', async () => {
    const h = fixture(); const c = await clientFixture(h); c.add()
    const first = c.capture()
    expect(await c.registry.submit(first, undefined, async () => ({ text: 'Prompt', attachments: [{ type: 'file', receiptId: 'expired' }] }), c.admit)).toMatchObject({ admission: 'rejected' })
    h.fileUploads.resolve.mockReturnValue({ attachmentId: brandString<import('@deepseek-ai/dsh-attachment').AttachmentId>(`sha256:${'a'.repeat(64)}`), name: 'file.txt', bytes: 3 })
    const corrected = c.capture()
    expect(corrected.requestId).not.toBe(first.requestId)
    expect(await c.registry.submit(corrected, undefined, async () => ({ text: 'Prompt', attachments: [{ type: 'file', receiptId: 'fresh' }] }), c.admit)).toMatchObject({ admission: 'accepted' })
    expect(c.admit).toHaveBeenCalledOnce()
    expect(c.session.getSnapshot()).toMatchObject({ pending: null, draft: { annotations: [] } })
    expect(await h.ok('read', { sessionId: h.session.id, requestId: corrected.requestId })).toMatchObject({ status: 'accepted' })
  })

  it('does not release restored unknown admission even after explicit Host absence evidence', async () => {
    const h = fixture(); const c = await clientFixture(h); c.add()
    const draft = c.session.getSnapshot().draft
    const snapshot = { revision: draft.revision, annotations: draft.annotations.map(annotation => c.session.captured(annotation.id)!) }
    const input = assemble(snapshot, 'restored-request', h.session.id)
    const attempt = c.registry.restore({ ...input.attempt, attachments: [{ type: 'file', receiptId: 'expired' }] })
    expect(await c.registry.run(attempt, undefined, async () => 'accepted')).toMatchObject({ admission: 'uncertain' })
    expect(c.session.getSnapshot().pending).toMatchObject({ status: 'uncertain', attempt })
    expect(await h.ok('list', { sessionId: h.session.id })).toEqual([])
    c.session.clear()
    expect(c.session.getSnapshot().draft.annotations).toHaveLength(1)
    expect(() => c.capture()).toThrow()
  })

  it('retains a lost prepare ACK and recovers the prepared record through Reconcile and same-id Retry', async () => {
    const h = fixture(); const c = await clientFixture(h); c.add()
    c.faults.losePrepareACK = true; c.faults.settleOffline = true
    const capture = c.capture()
    expect(await c.registry.submit(capture, undefined, async () => ({ text: 'Prompt', attachments: [] }), c.admit)).toMatchObject({ admission: 'rejected' })
    const original = c.registry.attemptFor(capture.requestId)
    expect(await h.ok('read', { sessionId: h.session.id, requestId: capture.requestId })).toMatchObject({ status: 'uncertain' })
    expect(c.session.getSnapshot().pending).toMatchObject({ attempt: original, status: 'uncertain' })
    c.session.clear()
    expect(c.session.getSnapshot().draft.annotations).toHaveLength(1)
    expect(() => c.capture()).toThrow()
    c.faults.settleOffline = false
    await c.session.reconcile()
    expect(c.session.getSnapshot().pending?.attempt.requestId).toBe(capture.requestId)
    expect(() => c.capture()).toThrow()
    await c.session.retry()
    expect(c.retrySubmission).toHaveBeenCalledWith(original, expect.any(AbortSignal), [])
    expect(c.session.getSnapshot()).toMatchObject({ pending: null, draft: { annotations: [] } })
    expect(await h.ok('read', { sessionId: h.session.id, requestId: capture.requestId })).toMatchObject({ status: 'accepted' })
  })

  it('does not treat generic transport errors, an empty recovery list, or failed Retry as absence evidence', async () => {
    const h = fixture(); const c = await clientFixture(h); c.add(); c.faults.prepareOffline = true
    const capture = c.capture()
    await c.registry.submit(capture, undefined, async () => ({ text: 'Prompt', attachments: [] }), c.admit)
    expect(c.session.getSnapshot().pending).toMatchObject({ status: 'uncertain', attempt: { requestId: capture.requestId } })
    expect(await h.ok('list', { sessionId: h.session.id })).toEqual([])
    await c.session.reconcile()
    await c.session.retry()
    c.session.clear()
    expect(c.admit).not.toHaveBeenCalled(); expect(c.retrySubmission).not.toHaveBeenCalled()
    expect(c.session.getSnapshot().draft.annotations).toHaveLength(1)
    expect(c.session.getSnapshot().pending?.attempt.requestId).toBe(capture.requestId)
    expect(() => c.capture()).toThrow()
  })

  it('preserves an unknown admission and immutable identity when a later prepare fails', async () => {
    const h = fixture(); const c = await clientFixture(h); c.add()
    const capture = c.capture()
    await c.registry.submit(capture, undefined, async () => ({ text: 'Prompt', attachments: [] }), async () => { throw new Error('Admission ACK lost.') })
    const original = c.registry.attemptFor(capture.requestId)!
    c.faults.prepareOffline = true
    expect(await c.registry.run(original, undefined, async () => 'accepted')).toMatchObject({ admission: 'uncertain' })
    expect(c.session.getSnapshot().pending).toMatchObject({ status: 'uncertain', attempt: original })
    c.session.clear()
    expect(c.session.getSnapshot().draft.annotations).toHaveLength(1)
    expect(() => c.capture()).toThrow()
  })

  it('keeps a known rejected record editable if file restaging fails before retry admission', async () => {
    const h = fixture(); const c = await clientFixture(h); c.add()
    const ref = { attachmentId: brandString<import('@deepseek-ai/dsh-attachment').AttachmentId>(`sha256:${'a'.repeat(64)}`), name: 'file.txt', bytes: 3 }
    h.fileUploads.resolve.mockReturnValue(ref)
    const capture = c.capture()
    await c.registry.submit(capture, undefined, async () => ({ text: 'Prompt', attachments: [{ type: 'file', receiptId: 'original' }] }), async () => 'rejected')
    expect(c.session.getSnapshot().pending?.status).toBe('rejected')
    h.fileUploads.uploadStream.mockRejectedValue(new Error('Stored attachment missing.'))
    await c.session.retry()
    expect(c.session.getSnapshot().pending?.status).toBe('rejected')
    expect(c.session.getSnapshot().frozenIds).toEqual([])
    expect(c.retrySubmission).not.toHaveBeenCalled()
    c.session.clear()
    expect(c.session.getSnapshot().draft.annotations).toEqual([])
  })
})
