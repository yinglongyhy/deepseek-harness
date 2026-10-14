// @vitest-environment jsdom
// ConversationController scope addressing over the runtime's real scope tag:
// TestSessions mints tagged scopes through the production createScope, so the
// service's scopeOf/binding path runs against production resolution (no local
// tag probe).
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it, vi } from 'vitest'
import { makeTranslate, RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  BeginSubmissionInput, PendingSubmissionRetirement,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConversationContributionId, ConversationSubmissionAttempt, SubmissionContributionState } from '../src/client/contract/contributions.ts'
import type { CommandClaim, DraftAttachmentId, InputTriggerController, PickOutcome } from '../src/client/contract/input.ts'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { $composerLayout } from '../src/client/input/editor/projection.ts'
import { ConversationController } from '../src/client/service.ts'
import { zh } from '../src/client/locales.ts'

async function bench(maxConcurrentFileUploads = 2) {
  const runtime = await SlotTestRuntime.create()
  runtime.fileUpload.upload = (sessionId: SessionId, ...args: unknown[]) => {
    const session = runtime.sessions.behavior(sessionId) as {
      uploadFile?: (...input: unknown[]) => Promise<unknown>
    }
    if (session.uploadFile === undefined) throw new Error('test file upload has no Session override')
    return session.uploadFile(...args)
  }
  const prompt = vi.fn((
    _content?: unknown, _mode?: unknown, _signal?: AbortSignal, _rpcId?: string,
  ) => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const updateQueue = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const cancel = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const loadOlder = vi.fn(() => Promise.resolve())
  await runtime.sessions.add({
    id: 's1',
    session: { prompt, updateQueue, cancel, loadOlder },
  })
  const reference = runtime.sessions.retain('s1' as SessionId)
  await reference.ready
  // config.input is required (the apply shares its hub with the inject
  // factories); the bench passes its own instance explicitly.
  const hub = new InputHub(runtime.ctx, makeTranslate(zh, {}))
  const fiber = runtime.ctx.plugin(ConversationController, {
    input: hub,
    blocks: new ComposerBlockRegistry(),
    maxConcurrentFileUploads,
  })
  await fiber.await()
  const root = runtime.ctx.get('conversation') as ConversationController
  const scoped = runtime.sessions.scope('s1')!.get('conversation') as ConversationController
  const shell = hub.shellFor(runtime.sessions.binding('s1')!)
  return { runtime, fiber, root, scoped, hub, shell, prompt, updateQueue, cancel, loadOlder, reference }
}

function codecs(b: Awaited<ReturnType<typeof bench>>, serializeReference: InputTriggerController['serializeReference'], adjudicate: InputTriggerController['adjudicate'] = async () => undefined) {
  const controller: InputTriggerController = {
    launcher: createSnapshotStore<string | null>(null),
    lexicon: createSnapshotStore<ReadonlyMap<'/' | '@', readonly string[]>>(new Map()),
    track: () => {}, arbitrate: () => 'pass', onSpace: () => false,
    serializeReference, adjudicate, resolveClaim: async () => undefined, openReference: () => false, toggleSource: () => {},
  }
  b.runtime.ctx.provide('inputTriggers', { sessionOf: () => controller })
}

function insertChip(b: Awaited<ReturnType<typeof bench>>) {
  b.shell.setDraft('@ref')
  expect(b.shell.insertReference({ source: 'reference', ref: '@ref', label: 'Reference', clipboardText: '@ref' }, {
    start: 0, end: 4, draftRev: b.shell.snapshot.draftRev,
  })).toBe(true)
}

function note(b: Awaited<ReturnType<typeof bench>>) {
  const state = createSnapshotStore<SubmissionContributionState>({ hasContent: true, revision: 1, text: 'note' })
  const prepare = vi.fn(async () => {})
  const settled = Promise.withResolvers<ConversationSubmissionAttempt>()
  const off = b.scoped.registerContribution('s1' as SessionId, {
    id: 'note' as ConversationContributionId, state, prepare,
    settle: (attempt) => { settled.resolve(attempt) },
  })
  return { state, prepare, settled, off }
}

describe('ConversationController', () => {
  it('retries restored identity with copied replacement file receipts without changing logical content', async () => {
    const b = await bench()
    try {
      const attempt = b.root.submissions.restore({
        sessionId: 's1' as SessionId, requestId: 'restored-retry' as SessionRequestId,
        source: 'enter', mode: 'steer', text: 'original text', contributions: [],
        attachments: [{ type: 'image', mediaType: 'image/png', data: 'AQ==', name: 'original.png' }, { type: 'file', receiptId: 'expired-receipt' }],
      })
      const fresh = { type: 'file' as const, receiptId: 'fresh-receipt' }
      const transport = [attempt.attachments[0]!, fresh]
      const sending = b.root.retrySubmission(attempt, undefined, transport)
      fresh.receiptId = 'mutated-after-retry'
      expect(await sending).toEqual({ kind: 'success', admission: 'accepted' })
      expect(b.prompt).toHaveBeenCalledWith([
        attempt.attachments[0], { type: 'file', receiptId: 'fresh-receipt' }, { type: 'text', text: 'original text' },
      ], 'steer', expect.any(AbortSignal), attempt.requestId)
      expect(attempt.attachments[1]).toEqual({ type: 'file', receiptId: 'expired-receipt' })
      await expect(b.root.retrySubmission(attempt, undefined, [fresh])).rejects.toThrow('retry may replace only file receipts in their original positions')
      await expect(b.root.retrySubmission(attempt, undefined, [fresh, attempt.attachments[0]!])).rejects.toThrow('retry may replace only file receipts in their original positions')
      await expect(b.root.retrySubmission(attempt, undefined, [{ type: 'image', mediaType: 'image/png', data: 'Ag==', name: 'original.png' }, fresh])).rejects.toThrow('retry may replace only file receipts in their original positions')
      expect(b.prompt).toHaveBeenCalledOnce()
    } finally { await b.runtime.dispose() }
  })
  it('reserves a real reference send before codecs so click, Enter, and programmatic sends cannot duplicate its revision', async () => {
    const b = await bench()
    const gate = Promise.withResolvers<string>()
    try {
      const n = note(b)
      const serializer = vi.fn(() => gate.promise)
      codecs(b, serializer)
      insertChip(b)
      b.shell.submit('queue', 'click')
      b.shell.setDraft('next draft')
      b.shell.submit('queue', 'enter')
      const duplicate = b.root.sendSession(b.runtime.sessions.binding('s1')!.session, 'programmatic', [], 'queue')
      await expect(duplicate).rejects.toThrow('admission pending')
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).toBe(true)
      expect(b.shell.snapshot.draft).toBe('next draft')
      expect(b.prompt).not.toHaveBeenCalled()
      gate.resolve('expanded reference')
      const attempt = await n.settled.promise
      await b.runtime.flush()
      expect(serializer).toHaveBeenCalledOnce()
      expect(b.prompt).toHaveBeenCalledOnce()
      expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'expanded reference\n\nnote' }], 'queue', expect.any(AbortSignal), attempt.requestId)
    } finally { gate.resolve('expanded reference'); await b.runtime.dispose() }
  })

  it('unlocks the captured revision after a real reference codec rejection', async () => {
    const b = await bench()
    const gate = Promise.withResolvers<string>()
    try {
      const n = note(b)
      codecs(b, () => gate.promise)
      insertChip(b)
      b.shell.submit('queue', 'enter')
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).toBe(true)
      gate.reject(new Error('codec failed'))
      await b.runtime.flush()
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).not.toBe(true)
      expect(b.prompt).not.toHaveBeenCalled()
      expect((await b.root.sendSession(b.runtime.sessions.binding('s1')!.session, 'retry', [], 'queue')).admission).toBe('accepted')
      expect(n.prepare).toHaveBeenCalledOnce()
    } finally { gate.resolve('unused'); await b.runtime.dispose() }
  })

  it.each(['owner', 'shell'] as const)('prevents late reference admission after %s teardown and drains codec work', async (target) => {
    const b = await bench()
    const gate = Promise.withResolvers<string>()
    try {
      const n = note(b)
      const entered = Promise.withResolvers<AbortSignal>()
      codecs(b, (_source, _ref, signal) => { entered.resolve(signal); return gate.promise })
      insertChip(b)
      b.shell.submit('queue', 'click')
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).toBe(true)
      const signal = await entered.promise
      let drained = false
      const disposal = target === 'owner' ? n.off().then(() => { drained = true }) : Promise.resolve(b.shell.dispose())
      if (target === 'owner') { await Promise.resolve(); expect(drained).toBe(false) }
      expect(signal.aborted).toBe(true)
      gate.resolve('late reference')
      if (target === 'owner') await expect(disposal).rejects.toThrow('submission cancelled before admission')
      else await disposal
      await b.runtime.flush()
      expect(b.prompt).not.toHaveBeenCalled()
      expect(n.prepare).not.toHaveBeenCalled()
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).not.toBe(true)
    } finally { gate.resolve('unused'); await b.runtime.dispose() }
  })

  it.each(['handled', 'claimed', 'failed'] as const)('releases a slash capture after %s adjudication', async (result) => {
    const b = await bench()
    const gate = Promise.withResolvers<PickOutcome>()
    try {
      note(b)
      codecs(b, async () => '', () => gate.promise)
      b.shell.setDraft('/command')
      b.shell.submit('queue', 'enter')
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).toBe(true)
      if (result === 'failed') gate.reject(new Error('adjudication failed'))
      else gate.resolve(result === 'handled' ? 'handled' : { claim: { name: 'command', token: '/command ', submit: async () => ({ kind: 'success' }) } })
      await b.runtime.flush()
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).not.toBe(true)
      expect(b.prompt).not.toHaveBeenCalled()
      expect((await b.root.sendSession(b.runtime.sessions.binding('s1')!.session, 'ordinary', [], 'queue')).admission).toBe('accepted')
    } finally { gate.resolve(undefined); await b.runtime.dispose() }
  })

  it.each(['success', 'failure'] as const)('keeps contributions intact across a claimed command %s, then freezes the next ordinary send', async (result) => {
    const b = await bench()
    const commandGate = Promise.withResolvers<{ kind: 'success' | 'error' }>()
    const codecGate = Promise.withResolvers<string>()
    try {
      const n = note(b)
      codecs(b, () => codecGate.promise)
      const claim: CommandClaim = { name: 'tool', token: '/tool ', submit: () => commandGate.promise }
      b.shell.setDraft('/tool')
      expect(b.shell.beginCommand(claim, { start: 0, end: 5, draftRev: b.shell.snapshot.draftRev })).toBe(true)
      b.shell.submit('queue', 'enter')
      await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('submitting') })
      expect(n.state.getSnapshot()).toMatchObject({ hasContent: true, revision: 1, text: 'note' })
      expect(n.prepare).not.toHaveBeenCalled()
      commandGate.resolve({ kind: result === 'success' ? 'success' : 'error' })
      await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe(result === 'success' ? 'plain' : 'claimed') })
      expect(n.state.getSnapshot()).toMatchObject({ hasContent: true, revision: 1, text: 'note' })
      expect(n.prepare).not.toHaveBeenCalled()

      b.shell.setDraft('ordinary @ref')
      expect(b.shell.insertReference({ source: 'reference', ref: '@ref', label: 'Reference', clipboardText: '@ref' }, {
        start: 9, end: 13, draftRev: b.shell.snapshot.draftRev,
      })).toBe(true)
      b.shell.submit('queue', 'enter')
      n.state.set({ hasContent: true, revision: 2, text: 'new note' })
      b.shell.setDraft('new draft')
      codecGate.resolve('expanded reference')
      const attempt = await n.settled.promise
      await b.runtime.flush()
      expect(attempt.text).toBe('ordinary expanded reference\n\nnote')
      expect(attempt.contributions).toMatchObject([{ revision: 1, text: 'note' }])
      expect(n.state.getSnapshot()).toMatchObject({ hasContent: true, revision: 2, text: 'new note' })
      expect(b.shell.snapshot.draft).toBe('new draft')
      expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: attempt.text }], 'queue', expect.any(AbortSignal), attempt.requestId)
    } finally {
      commandGate.resolve({ kind: 'error' })
      codecGate.resolve('unused')
      await b.runtime.dispose()
    }
  })

  it('allows a newer owner revision while an earlier reference codec is pending', async () => {
    const b = await bench()
    const gate = Promise.withResolvers<string>()
    try {
      const n = note(b)
      codecs(b, () => gate.promise)
      insertChip(b)
      b.shell.submit('queue', 'click')
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).toBe(true)
      n.state.set({ hasContent: true, revision: 2, text: 'new note' })
      b.shell.setDraft('new question')
      b.shell.submit('queue', 'enter')
      await n.settled.promise
      expect(b.prompt).toHaveBeenCalledOnce()
      gate.resolve('old question')
      await b.runtime.flush()
      expect(b.prompt.mock.calls.map(([content]) => content)).toEqual([
        [{ type: 'text', text: 'new question\n\nnew note' }], [{ type: 'text', text: 'old question\n\nnote' }],
      ])
    } finally { gate.resolve('unused'); await b.runtime.dispose() }
  })
  it('drains slash adjudication on owner disposal without admitting its late ordinary fallback', async () => {
    const b = await bench()
    const gate = Promise.withResolvers<PickOutcome>()
    try {
      const n = note(b)
      const entered = Promise.withResolvers<AbortSignal>()
      codecs(b, async () => '', (_line, signal) => { entered.resolve(signal); return gate.promise })
      b.shell.setDraft('/ordinary')
      b.shell.submit('queue', 'enter')
      const signal = await entered.promise
      let drained = false
      const disposal = n.off().then(() => { drained = true })
      expect(signal.aborted).toBe(true)
      await Promise.resolve()
      expect(drained).toBe(false)
      gate.resolve(undefined)
      await disposal
      await b.runtime.flush()
      expect(b.prompt).not.toHaveBeenCalled()
      expect(b.shell.snapshot.phase).toBe('plain')
    } finally { gate.resolve(undefined); await b.runtime.dispose() }
  })

  it('keeps a slash ordinary fallback reserved through preparation under its original capture', async () => {
    const b = await bench()
    const gate = Promise.withResolvers<PickOutcome>()
    try {
      const n = note(b)
      codecs(b, async () => '', () => gate.promise)
      b.shell.setDraft('/ordinary')
      b.shell.submit('queue', 'enter')
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).toBe(true)
      gate.resolve(undefined)
      const attempt = await n.settled.promise
      await b.runtime.flush()
      expect(b.prompt).toHaveBeenCalledOnce()
      expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: '/ordinary\n\nnote' }], 'queue', expect.any(AbortSignal), attempt.requestId)
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).not.toBe(true)
    } finally { gate.resolve(undefined); await b.runtime.dispose() }
  })

  it('waits for every reference codec after one rejects before releasing the owner reservation', async () => {
    const b = await bench()
    const gate = Promise.withResolvers<string>()
    try {
      const n = note(b)
      const entered = Promise.withResolvers<undefined>()
      codecs(b, async (_source, ref) => {
        if (ref === '@ref') throw new Error('first codec failed')
        entered.resolve(undefined)
        return gate.promise
      })
      insertChip(b)
      const end = b.shell.editor.getEditorState().read(() => $composerLayout().detectLength)
      expect(b.shell.insertReference({ source: 'reference', ref: '@second', label: 'Second', clipboardText: '@second' }, {
        start: end, end, draftRev: b.shell.snapshot.draftRev,
      })).toBe(true)
      b.shell.submit('queue', 'click')
      await entered.promise
      await b.runtime.flush()
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).toBe(true)
      let drained = false
      const disposal = n.off().then(() => { drained = true })
      await Promise.resolve()
      expect(drained).toBe(false)
      gate.resolve('second reference')
      await expect(disposal).rejects.toThrow('first codec failed')
      await b.runtime.flush()
      expect(b.prompt).not.toHaveBeenCalled()
      expect(n.prepare).not.toHaveBeenCalled()
    } finally { gate.resolve('unused'); await b.runtime.dispose() }
  })

  it('releases the capture if attachment preflight rejects before registry submission', async () => {
    const b = await bench()
    try {
      note(b)
      const session = b.runtime.sessions.binding('s1')!.session
      await expect(b.root.sendSession(session, 'first', ['missing' as DraftAttachmentId], 'queue')).rejects.toThrow('no longer available')
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).not.toBe(true)
      expect((await b.root.sendSession(session, 'second', [], 'queue')).admission).toBe('accepted')
      expect(b.prompt).toHaveBeenCalledOnce()
    } finally { await b.runtime.dispose() }
  })

  it('does not revive a withdrawn generation when an old input submits before scoped cleanup', async () => {
    const b = await bench()
    try {
      b.shell.setDraft('old draft')
      b.reference.release()
      const retain = vi.spyOn(b.runtime.sessions, 'retain')
      b.shell.submit()
      b.shell.steerQueue()
      expect(b.runtime.sessions.binding('s1')).toBeUndefined()
      expect(retain).not.toHaveBeenCalled()
      await b.runtime.flush()
      expect(b.prompt).not.toHaveBeenCalled()
      retain.mockRestore()
    } finally {
      await b.runtime.dispose()
    }
  })

  it('freezes programmatic contributions before async preparation and admits the prepared request identity', async () => {
    const b = await bench()
    try {
      const state = createSnapshotStore<SubmissionContributionState>({ hasContent: true, revision: 1, text: 'old note' })
      const entered = Promise.withResolvers<ConversationSubmissionAttempt>()
      const gate = Promise.withResolvers<undefined>()
      const prepare = vi.fn(async (attempt: ConversationSubmissionAttempt) => { entered.resolve(attempt); await gate.promise })
      const settle = vi.fn()
      b.scoped.registerContribution('s1' as SessionId, { id: 'note' as ConversationContributionId, state, prepare, settle })
      const pending = b.root.sendSession(b.runtime.sessions.binding('s1')!.session, 'question', [], 'queue')
      state.set({ hasContent: true, revision: 2, text: 'new note' })
      const attempt = await entered.promise
      expect(attempt.text).toBe('question\n\nold note')
      expect(attempt.source).toBe('programmatic')
      expect(b.prompt).not.toHaveBeenCalled()
      gate.resolve(undefined)
      expect((await pending).admission).toBe('accepted')
      expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: attempt.text }], 'queue', expect.any(AbortSignal), attempt.requestId)
      expect(settle).toHaveBeenCalledWith(attempt, attempt.contributions[0], 'accepted')
      expect(state.getSnapshot().text).toBe('new note')
    } finally { await b.runtime.dispose() }
  })

  it('prevents contribution-only double clicks and retries lost ACK with identical content and requestId', async () => {
    const b = await bench()
    try {
      const state = createSnapshotStore<SubmissionContributionState>({ hasContent: true, revision: 1, text: 'note' })
      const settled = Promise.withResolvers<ConversationSubmissionAttempt>()
      const prepare = vi.fn(async () => {})
      const settle = vi.fn((attempt: ConversationSubmissionAttempt) => { settled.resolve(attempt) })
      b.scoped.registerContribution('s1' as SessionId, { id: 'note' as ConversationContributionId, state, prepare, settle })
      b.prompt.mockRejectedValueOnce(new Error('lost ACK'))
      b.shell.submit('queue', 'click')
      b.shell.submit('queue', 'click')
      const attempt = await settled.promise
      await b.runtime.flush()
      expect(attempt.source).toBe('click')
      expect(b.prompt).toHaveBeenCalledOnce()
      expect(b.root.submissions.storeFor('s1' as SessionId).getSnapshot().pending).toBe(true)
      b.shell.submit('queue', 'enter')
      expect(b.prompt).toHaveBeenCalledOnce()
      expect((await b.scoped.retrySubmission(attempt)).admission).toBe('accepted')
      expect(b.prompt).toHaveBeenCalledTimes(2)
      expect(b.prompt.mock.calls.map(([content, mode, _signal, requestId]) => ({ content, mode, requestId }))).toEqual([
        { content: [{ type: 'text', text: 'note' }], mode: 'queue', requestId: attempt.requestId },
        { content: [{ type: 'text', text: 'note' }], mode: 'queue', requestId: attempt.requestId },
      ])
      expect(prepare).toHaveBeenCalledOnce()
    } finally { await b.runtime.dispose() }
  })

  it('does not bypass a failed durable prepare through public retrySubmission', async () => {
    const b = await bench()
    try {
      const state = createSnapshotStore<SubmissionContributionState>({ hasContent: true, revision: 1, text: 'note' })
      const entered = Promise.withResolvers<ConversationSubmissionAttempt>()
      const prepare = vi.fn(async (attempt: ConversationSubmissionAttempt) => { entered.resolve(attempt); throw new Error('storage unavailable') })
      b.scoped.registerContribution('s1' as SessionId, { id: 'note' as ConversationContributionId, state, prepare, settle: () => {} })
      const first = await b.root.sendSession(b.runtime.sessions.binding('s1')!.session, '', [], 'queue')
      expect(first.admission).toBe('rejected')
      const attempt = await entered.promise
      expect((await b.scoped.retrySubmission(attempt)).admission).toBe('rejected')
      expect(prepare).toHaveBeenCalledTimes(2)
      expect(b.prompt).not.toHaveBeenCalled()
    } finally { await b.runtime.dispose() }
  })

  it.each([
    ['gateway/bad-request', 'rejected'], ['gateway/internal', 'uncertain'], ['session/agent-busy', 'rejected'],
  ] as const)('classifies contributed Host admission %s as %s', async (code, expected) => {
    const b = await bench()
    try {
      const state = createSnapshotStore<SubmissionContributionState>({ hasContent: true, revision: 1, text: 'note' })
      b.scoped.registerContribution('s1' as SessionId, { id: 'note' as ConversationContributionId, state, prepare: async () => {}, settle: () => {} })
      b.prompt.mockResolvedValueOnce({ ok: false, error: new RemoteError(code, 'failed', {}) } as never)
      expect((await b.root.sendSession(b.runtime.sessions.binding('s1')!.session, '', [], 'queue')).admission).toBe(expected)
    } finally { await b.runtime.dispose() }
  })

  it('routes operations through the public Session binding', async () => {
    const b = await bench()
    await b.scoped.send('hello')
    await b.scoped.updateQueue('item-1' as never, { kind: 'remove' })
    await b.scoped.cancel()
    await b.scoped.loadOlder()
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'queue')
    expect(b.updateQueue).toHaveBeenCalledWith('item-1', { kind: 'remove' })
    expect(b.cancel).toHaveBeenCalledOnce()
    expect(b.loadOlder).toHaveBeenCalledOnce()
    await b.runtime.dispose()
  })

  it('folds Session business failures into callback rejections', async () => {
    const b = await bench()
    b.prompt.mockResolvedValueOnce({ ok: false, error: new RemoteError('session/agent-busy', 'busy', { reason: 'busy' }) } as never)
    await expect(b.scoped.send('x')).rejects.toThrow('conversation.send failed: session/agent-busy: busy')
    b.cancel.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'nope', {}) } as never)
    await expect(b.scoped.cancel()).rejects.toThrow('conversation.cancel failed: gateway/internal: nope')
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('gateway/internal', 'broken', {}),
    } as never)
    await expect(b.scoped.updateQueue('item-1' as never, { kind: 'steer' }))
      .rejects.toThrow('conversation.updateQueue failed: gateway/internal: broken')
    await b.runtime.dispose()
  })

  it('treats QueueDock Steer pre-admission races as converged Queue delivery', async () => {
    const b = await bench()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/steer-unavailable', 'closed', { itemId: 'item-1' as MessageId }),
    } as never)
    await expect(b.scoped.updateQueue('item-1' as never, { kind: 'steer' })).resolves.toBeUndefined()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/queue-item-not-found', 'claimed', { itemId: 'item-1' as MessageId }),
    } as never)
    await expect(b.scoped.updateQueue('item-2' as never, { kind: 'steer' })).resolves.toBeUndefined()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/queue-item-not-found', 'claimed', { itemId: 'item-1' as MessageId }),
    } as never)
    await expect(b.scoped.updateQueue('item-3' as never, { kind: 'remove' }))
      .rejects.toThrow('conversation.updateQueue failed: session/queue-item-not-found: claimed')
    await b.runtime.dispose()
  })

  it('releases draft previews when their session scope is disposed', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:draft-1')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([new Uint8Array(4)], 'a.png', { type: 'image/png' }),
      ])
      if (attachment === undefined) throw new Error('draft attachment missing')
      b.root.input.for(b.runtime.sessions.scope('s1')!).addAttachments([attachment.id])
      b.reference.release()
      await b.runtime.flush()
      expect(b.root.resolveDraftAttachments([attachment.id])).toEqual([])
      expect(revoked).toHaveBeenCalledWith('blob:draft-1')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('releases an unsettled send preview during structural Session teardown', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:detached')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(1)], 'detached.png', { type: 'image/png' }),
      ])
      if (attachment === undefined) throw new Error('draft attachment missing')
      b.shell.addAttachments([attachment.id])
      b.shell.submit()
      expect(b.shell.snapshot.attachmentIds).toEqual([])
      await b.runtime.sessions.disposeScopes()
      expect(b.root.resolveDraftAttachments([attachment.id])).toEqual([])
      expect(revoked).toHaveBeenCalledWith('blob:detached')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('classifies image MIME drafts as images and every other file as an uploading file draft', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    const session = b.runtime.sessions.binding('s1')!.session
    const uploadFile = vi.fn((_data: Blob | Uint8Array) => Promise.resolve({
      ok: true as const,
      value: {
        receiptId: 'receipt-1' as never,
        file: { attachmentId: 'sha256:1' as never, name: 'notes.pdf', bytes: 2 },
      },
    }))
    ;(session as { uploadFile?: unknown }).uploadFile = uploadFile
    const drafts = b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(1)], 'valid.png', { type: 'image/png' }),
      new File([Uint8Array.of(2)], 'notes.pdf', { type: 'application/pdf' }),
    ])
    expect(drafts.map(draft => draft.kind)).toEqual(['image', 'file'])
    expect(created).toHaveBeenCalledTimes(1)
    const fileDraft = drafts[1]!
    expect(b.root.fileUploads.getSnapshot()[fileDraft.id]?.status).toBe('uploading')
    await vi.waitFor(() => {
      expect(b.root.fileUploads.getSnapshot()[fileDraft.id]?.status).toBe('ready')
    })
    expect(uploadFile).toHaveBeenCalledOnce()
    expect(uploadFile.mock.calls[0]?.[0]).toBe((fileDraft as { file: File }).file)
    created.mockRestore()
    await b.runtime.dispose()
  })

  it('serializes command files as staged receipts without reading their bytes again', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    ;(session as { uploadFile?: unknown }).uploadFile = vi.fn((_file: Blob | Uint8Array, name?: string) =>
      Promise.resolve({
        ok: true as const,
        value: {
          receiptId: `receipt-${name}` as never,
          file: { attachmentId: `file-${name}` as never, name: name ?? 'file', bytes: 1 },
        },
      }))
    const drafts = b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(1)], 'one.txt', { type: 'text/plain' }),
      new File([Uint8Array.of(2)], 'two.txt', { type: 'text/plain' }),
    ])
    await vi.waitFor(() => {
      expect(drafts.every(draft => b.root.fileUploads.getSnapshot()[draft.id]?.status === 'ready')).toBe(true)
    })
    function RejectingFileReader(): never {
      throw new Error('generic file bytes were reread')
    }
    vi.stubGlobal('FileReader', RejectingFileReader)
    try {
      await expect(b.root.serializeDraftAttachments(drafts.map(draft => draft.id))).resolves.toEqual({
        attachments: [
          { type: 'file', receiptId: 'receipt-one.txt' },
          { type: 'file', receiptId: 'receipt-two.txt' },
        ],
      })
    } finally {
      vi.unstubAllGlobals()
    }
    await b.runtime.dispose()
  })

  it('bounds upload Workers, advances on settlement, and skips a queued file removed by the user', async () => {
    const b = await bench(2)
    const session = b.runtime.sessions.binding('s1')!.session
    type UploadResult = {
      ok: true
      value: { receiptId: never; file: { attachmentId: never; name: string; bytes: number } }
    }
    const gates = new Map<string, { resolve: (value: UploadResult) => void }>()
    let active = 0
    let maxActive = 0
    const uploadFile = vi.fn((_file: Blob | Uint8Array, name?: string) => {
      const fileName = name ?? 'unnamed'
      const gate = Promise.withResolvers<UploadResult>()
      gates.set(fileName, gate)
      active += 1
      maxActive = Math.max(maxActive, active)
      return gate.promise.finally(() => { active -= 1 })
    })
    ;(session as { uploadFile?: unknown }).uploadFile = uploadFile
    const drafts = b.root.createDrafts(session.sessionId, ['one', 'two', 'three', 'four', 'removed'].map(name =>
      new File([Uint8Array.of(1)], `${name}.txt`, { type: 'text/plain' })))

    await vi.waitFor(() => { expect(uploadFile.mock.calls.map(call => call[1])).toEqual(['one.txt', 'two.txt']) })
    await expect(b.root.serializeDraftAttachments([drafts[2]!.id]))
      .rejects.toThrow('one or more files have not finished uploading')
    b.root.releaseDraftAttachment(drafts[4]!.id)

    const complete = (name: string) => gates.get(name)?.resolve({
      ok: true,
      value: {
        receiptId: `receipt-${name}` as never,
        file: { attachmentId: `file-${name}` as never, name, bytes: 1 },
      },
    })
    complete('one.txt')
    await vi.waitFor(() => { expect(uploadFile).toHaveBeenCalledTimes(3) })
    complete('two.txt')
    await vi.waitFor(() => { expect(uploadFile).toHaveBeenCalledTimes(4) })
    complete('three.txt')
    complete('four.txt')
    await vi.waitFor(() => {
      expect(drafts.slice(0, 4).every(draft =>
        b.root.fileUploads.getSnapshot()[draft.id]?.status === 'ready')).toBe(true)
    })
    expect(maxActive).toBe(2)
    expect(uploadFile.mock.calls.map(call => call[1])).not.toContain('removed.txt')
    expect(b.root.fileUploads.getSnapshot()[drafts[4]!.id]).toBeUndefined()
    await b.runtime.dispose()
  })

  it('keeps one upload alive and observable while another Session is open', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    const settled = Promise.withResolvers<{
      ok: true
      value: { receiptId: never; file: { attachmentId: never; name: string; bytes: number } }
    }>()
    let reportProgress: ((progress: { loaded: number; total?: number }) => void) | undefined
    const uploadFile = vi.fn((
      _file: Blob | Uint8Array,
      _name?: string,
      _signal?: AbortSignal,
      onProgress?: (progress: { loaded: number; total?: number }) => void,
    ) => {
      reportProgress = onProgress
      return settled.promise
    })
    ;(session as { uploadFile?: unknown }).uploadFile = uploadFile
    const [attachment] = b.root.createDrafts(session.sessionId, [
      new File([new Uint8Array(8)], 'background.bin', { type: 'application/octet-stream' }),
    ])
    if (attachment === undefined) throw new Error('file draft missing')
    b.shell.addAttachments([attachment.id])
    await vi.waitFor(() => { expect(uploadFile).toHaveBeenCalledOnce() })

    await b.runtime.sessions.add({
      id: 's2',
      session: {
        prompt: b.prompt, updateQueue: b.updateQueue, cancel: b.cancel, loadOlder: b.loadOlder,
      },
    })
    using other = b.runtime.sessions.retain('s2' as SessionId)
    await other.ready
    reportProgress?.({ loaded: 3, total: 8 })
    expect(b.root.fileUploads.getSnapshot()[attachment.id]).toEqual({
      status: 'uploading', loaded: 3, total: 8,
    })
    expect(b.shell.snapshot.attachmentIds).toEqual([attachment.id])

    settled.resolve({
      ok: true,
      value: {
        receiptId: 'background-receipt' as never,
        file: { attachmentId: 'background-file' as never, name: 'background.bin', bytes: 8 },
      },
    })
    await vi.waitFor(() => {
      expect(b.root.fileUploads.getSnapshot()[attachment.id]?.status).toBe('ready')
    })
    expect(b.shell.snapshot.attachmentIds).toEqual([attachment.id])
    await b.runtime.dispose()
  })

  it('cancels a superseded upload and stages the carried draft on the target Session', async () => {
    const b = await bench()
    const source = b.runtime.sessions.binding('s1')!.session
    let sourceSignal: AbortSignal | undefined
    const sourceUpload = vi.fn((_data: Blob | Uint8Array, _name?: string, signal?: AbortSignal) => {
      sourceSignal = signal
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve({ ok: false, error: { message: 'aborted' } })
        }, { once: true })
      })
    })
    ;(source as { uploadFile?: unknown }).uploadFile = sourceUpload
    const [attachment] = b.root.createDrafts(source.sessionId, [
      new File([Uint8Array.of(4)], 'carry.pdf', { type: 'application/pdf' }),
    ])
    if (attachment === undefined) throw new Error('file draft missing')
    await vi.waitFor(() => { expect(sourceUpload).toHaveBeenCalledOnce() })

    const target = {
      uploadFile: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: {
          receiptId: 'target-receipt' as never,
          file: { attachmentId: 'target-file' as never, name: 'carry.pdf', bytes: 1 },
        },
      })),
    }
    await b.runtime.sessions.add({ id: 's2', session: target })
    using _target = b.runtime.sessions.retain('s2' as SessionId)
    await _target.ready
    b.root.rebindDraftFiles(b.runtime.sessions.binding('s2')!.session.sessionId, [attachment.id])

    expect(sourceSignal?.aborted).toBe(true)
    await vi.waitFor(() => {
      expect(b.root.fileUploads.getSnapshot()[attachment.id]).toEqual({
        status: 'ready', receiptId: 'target-receipt',
        file: { attachmentId: 'target-file', name: 'carry.pdf', bytes: 1 },
      })
    })
    await b.runtime.dispose()
  })

  it('cancels a file upload when its draft is removed', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    let uploadSignal: AbortSignal | undefined
    const uploadFile = vi.fn((_data: Blob | Uint8Array, _name?: string, signal?: AbortSignal) => {
      uploadSignal = signal
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve({ ok: false, error: { message: 'aborted' } })
        }, { once: true })
      })
    })
    ;(session as { uploadFile?: unknown }).uploadFile = uploadFile
    const [attachment] = b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(5)], 'removed.pdf', { type: 'application/pdf' }),
    ])
    if (attachment === undefined) throw new Error('file draft missing')
    await vi.waitFor(() => { expect(uploadFile).toHaveBeenCalledOnce() })

    b.root.releaseDraftAttachment(attachment.id)

    expect(uploadSignal?.aborted).toBe(true)
    expect(b.root.fileUploads.getSnapshot()[attachment.id]).toBeUndefined()
    await b.runtime.dispose()
  })

  it('keeps the accepted file draft until its rpcId appears in the Host queue', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    let retire: BeginSubmissionInput['onRetire']
    const begin = vi.spyOn(session, 'beginSubmission').mockImplementation((input) => {
      retire = input.onRetire
      if (input.requestId === undefined) throw new Error('captured request id missing')
      return { requestId: input.requestId, abandon: vi.fn() }
    })
    ;(session as { uploadFile?: unknown }).uploadFile = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: {
        receiptId: 'send-receipt' as never,
        file: { attachmentId: 'send-file' as never, name: 'sent.pdf', bytes: 1 },
      },
    }))
    const [attachment] = b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(6)], 'sent.pdf', { type: 'application/pdf' }),
    ])
    if (attachment === undefined) throw new Error('file draft missing')
    await vi.waitFor(() => {
      expect(b.root.fileUploads.getSnapshot()[attachment.id]?.status).toBe('ready')
    })

    const sending = b.root.sendSession(session, 'read', [attachment.id], 'queue')
    await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })

    expect(b.prompt).toHaveBeenCalledWith([
      { type: 'file', receiptId: 'send-receipt' },
      { type: 'text', text: 'read' },
    ], 'queue', expect.any(AbortSignal), expect.any(String))
    expect(b.root.resolveDraftAttachments([attachment.id])).toHaveLength(1)
    expect(b.prompt.mock.calls[0]?.[3]).toBe(begin.mock.calls[0]?.[0].requestId)
    retire?.({
      reason: 'observed',
      attachments: [{ attachmentId: AttachmentId('send-file'), name: 'sent.pdf', bytes: 1 }],
    })
    await expect(sending).resolves.toEqual({ kind: 'success', admission: 'accepted' })
    expect(b.root.resolveDraftAttachments([attachment.id])).toEqual([])
    await b.runtime.dispose()
  })

  it('awaits an aborted upload before disposing the service', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    let uploadSignal: AbortSignal | undefined
    let finishUpload: (() => void) | undefined
    ;(session as { uploadFile?: unknown }).uploadFile = vi.fn(
      (_data: Uint8Array, _name?: string, signal?: AbortSignal) => {
        uploadSignal = signal
        return new Promise((resolve) => {
          finishUpload = () => { resolve({ ok: false, error: { message: 'aborted' } }) }
        })
      },
    )
    b.root.createDrafts(session.sessionId, [
      new File([Uint8Array.of(7)], 'dispose.pdf', { type: 'application/pdf' }),
    ])
    await vi.waitFor(() => { expect(uploadSignal).toBeDefined() })

    let disposed = false
    const disposal = b.fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(uploadSignal?.aborted).toBe(true) })
    await Promise.resolve()
    expect(disposed).toBe(false)
    finishUpload?.()
    await disposal
    expect(disposed).toBe(true)
    await b.runtime.dispose()
  })

  it('fails loudly from the root scope, on an unbound session, or without Client Sessions', async () => {
    const b = await bench()
    await expect(b.root.send('x')).rejects.toThrow(/requires a session scope/)
    b.reference.release()
    await b.runtime.flush()
    await expect(b.scoped.send('x')).rejects.toThrow(/resolved no binding/)
    await b.runtime.dispose()
    // No Client Sessions service at all: a bare context lacks the assembled controller.
    const bare = new Context()
    await bare.plugin(ConversationController, {
      input: new InputHub(bare, makeTranslate(zh, {})),
      blocks: new ComposerBlockRegistry(),
      maxConcurrentFileUploads: 2,
    }).await()
    const orphan = bare.get('conversation') as ConversationController
    await expect(orphan.send('x')).rejects.toThrow(/sessions service unavailable/)
  })
})

describe('sendSession submission echo', () => {
  /** Bench with an observable beginSubmission on the session face. */
  async function echoBench() {
    const b = await bench()
    const retire: { onRetire?: ((retirement: PendingSubmissionRetirement) => void) | undefined } = {}
    const abandon = vi.fn()
    const begun = Promise.withResolvers<BeginSubmissionInput>()
    const session = b.runtime.sessions.binding('s1')!.session
    const readSnapshot = session.getSnapshot.bind(session)
    let pending: ReturnType<typeof session.getSnapshot>['pendingSubmissions'] = []
    const getSnapshot = vi.spyOn(session, 'getSnapshot').mockImplementation(() => ({ ...readSnapshot(), pendingSubmissions: pending }))
    const beginSubmission = vi.spyOn(session, 'beginSubmission').mockImplementation((input: BeginSubmissionInput) => {
      if (input.requestId === undefined) throw new Error('captured request id missing')
      pending = [...pending, { requestId: input.requestId, placement: 'transcript', time: 0, text: input.text, attachments: input.attachments }]
      retire.onRetire = (settlement) => {
        pending = pending.filter(submission => submission.requestId !== input.requestId)
        input.onRetire?.(settlement)
      }
      begun.resolve(input)
      return { requestId: input.requestId, abandon }
    })
    await b.runtime.sessions.updateSessionSnapshot('s1', () => {})
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:echo-1')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    const restore = () => {
      created.mockRestore()
      revoked.mockRestore()
      getSnapshot.mockRestore()
    }
    return { ...b, beginSubmission, begun: begun.promise, abandon, retire, revoked, restore }
  }

  it('registers the echo before serialization and prompts with its identity', async () => {
    const b = await echoBench()
    try {
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(1, 2, 3)], 'a.png', { type: 'image/png' }),
      ])
      const session = b.runtime.sessions.binding('s1')!.session
      const sending = b.root.sendSession(session, '带图', [attachment!.id], 'queue')
      const echo = await b.begun
      expect(echo?.mode).toBe('queue')
      expect(echo?.text).toBe('带图')
      expect(echo?.attachments).toHaveLength(1)
      expect(echo?.attachments[0]?.type).toBe('image')
      expect(echo?.attachments[0]?.value).toMatchObject({ previewUrl: 'blob:echo-1', name: 'a.png' })
      expect(b.prompt).not.toHaveBeenCalled()
      await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
      expect(b.prompt).toHaveBeenCalledWith(
        [
          { type: 'image', mediaType: 'image/png', data: expect.any(String) as string, name: 'a.png' },
          { type: 'text', text: '带图' },
        ],
        'queue',
        expect.any(AbortSignal),
        echo.requestId,
      )
      // The draft stays registered until the echo's observed retirement.
      expect(b.beginSubmission).toHaveBeenCalledOnce()
      expect(b.root['submissionDrafts'].has(echo.requestId!)).toBe(true)
      expect(b.root.resolveDraftAttachments([attachment!.id])).toHaveLength(1)
      b.retire.onRetire?.({ reason: 'observed', attachments: [] })
      await expect(sending).resolves.toEqual({ kind: 'success', admission: 'accepted' })
      expect(b.root.resolveDraftAttachments([attachment!.id])).toEqual([])
      expect(b.root['submissionDrafts'].has(echo.requestId!)).toBe(false)
      expect(b.revoked).toHaveBeenCalledWith('blob:echo-1')
    } finally {
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('preserves mixed image/file selection order through echo, prompt, and observed retirement', async () => {
    const b = await echoBench()
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      ;(session as { uploadFile?: unknown }).uploadFile = vi.fn(() => Promise.resolve({
        ok: true as const,
        value: {
          receiptId: 'mixed-file-receipt' as never,
          file: { attachmentId: 'mixed-file' as never, name: 'notes.txt', bytes: 1 },
        },
      }))
      const drafts = b.root.createDrafts(session.sessionId, [
        new File([Uint8Array.of(1)], 'first.png', { type: 'image/png' }),
        new File([Uint8Array.of(2)], 'notes.txt', { type: 'text/plain' }),
        new File([Uint8Array.of(3)], 'last.png', { type: 'image/png' }),
      ])
      await vi.waitFor(() => {
        expect(b.root.fileUploads.getSnapshot()[drafts[1]!.id]?.status).toBe('ready')
      })
      const sending = b.root.sendSession(session, 'ordered', drafts.map(draft => draft.id), 'steer')
      const echo = await b.begun
      expect(echo?.mode).toBe('steer')
      expect(echo?.attachments.map(attachment => attachment.type === 'image'
        ? { type: attachment.type, name: attachment.value.name }
        : { type: attachment.type, value: attachment.value })).toEqual([
        { type: 'image', name: 'first.png' },
        { type: 'file', value: { attachmentId: 'mixed-file', name: 'notes.txt', bytes: 1 } },
        { type: 'image', name: 'last.png' },
      ])
      await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
      expect(b.prompt.mock.calls[0]?.[0]).toEqual([
        { type: 'image', mediaType: 'image/png', data: expect.any(String) as string, name: 'first.png' },
        { type: 'file', receiptId: 'mixed-file-receipt' },
        { type: 'image', mediaType: 'image/png', data: expect.any(String) as string, name: 'last.png' },
        { type: 'text', text: 'ordered' },
      ])
      b.retire.onRetire?.({
        reason: 'observed',
        attachments: [
          {
            attachmentId: 'image-first' as never,
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
          { attachmentId: 'mixed-file' as never, name: 'notes.txt', bytes: 1 },
          {
            attachmentId: 'image-last' as never,
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
        ],
      })
      await expect(sending).resolves.toEqual({ kind: 'success', admission: 'accepted' })
      expect(b.root.resolveDraftAttachments(drafts.map(draft => draft.id))).toEqual([])
      expect(b.root['submissionDrafts'].has(echo.requestId!)).toBe(false)
      expect(b.beginSubmission).toHaveBeenCalledOnce()
    } finally {
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('passes each delivery mode before image serialization', async () => {
    const b = await echoBench()
    try {
      await b.runtime.sessions.updateSessionSnapshot('s1', (draft) => { draft.running = true })
      const session = b.runtime.sessions.binding('s1')!.session
      await expect(b.root.sendSession(session, '立即纠偏', [], 'steer'))
        .resolves.toEqual({ kind: 'success', admission: 'accepted' })
      expect(b.beginSubmission).toHaveBeenLastCalledWith(expect.objectContaining({
        mode: 'steer',
        text: '立即纠偏',
      }))
      await expect(b.root.sendSession(session, '稍后处理', [], 'queue'))
        .resolves.toEqual({ kind: 'success', admission: 'accepted' })
      expect(b.beginSubmission).toHaveBeenLastCalledWith(expect.objectContaining({
        mode: 'queue',
        text: '稍后处理',
      }))
    } finally {
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('hands the preview URL to the image cache on observed retirement instead of revoking it', async () => {
    const b = await echoBench()
    try {
      const seedImageUrl = vi.fn(() => true)
      b.runtime.ctx.provide('uiConversation')
      b.runtime.ctx.set('uiConversation', { seedImageUrl })
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(9)], 'seeded.png', { type: 'image/png' }),
      ])
      const session = b.runtime.sessions.binding('s1')!.session
      const sending = b.root.sendSession(session, '', [attachment!.id], 'queue')
      await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
      const ref = {
        attachmentId: 'att-1' as never,
        mediaType: 'image/png' as const,
        bytes: 1,
        width: 1,
        height: 1,
      }
      b.retire.onRetire?.({ reason: 'observed', attachments: [ref] })
      await expect(sending).resolves.toEqual({ kind: 'success', admission: 'accepted' })
      expect(seedImageUrl).toHaveBeenCalledWith('s1', ref, 'blob:echo-1')
      expect(b.root.resolveDraftAttachments([attachment!.id])).toEqual([])
      expect(b.revoked).not.toHaveBeenCalled()
      // Failed retirement keeps nothing to do; a second retire of released ids is a no-op.
      b.retire.onRetire?.({ reason: 'observed', attachments: [ref] })
    } finally {
      b.restore()
    }
    await b.runtime.dispose()
  })

  it.each(['rejected', 'uncertain'] as const)('retains mixed image/file references after %s admission for a same-id retry until observed', async (status) => {
    const b = await echoBench()
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      ;(session as { uploadFile?: unknown }).uploadFile = vi.fn(() => Promise.resolve({
        ok: true as const,
        value: {
          receiptId: 'kept-file-receipt' as never,
          file: { attachmentId: 'kept-file' as never, name: 'kept.txt', bytes: 1 },
        },
      }))
      b.prompt.mockResolvedValueOnce({
        ok: false, error: status === 'rejected'
          ? new RemoteError('session/attachment-invalid', 'nope', { reason: 'nope' })
          : new RemoteError('gateway/internal', 'nope', {}),
      } as never)
      const attachments = b.root.createDrafts(session.sessionId, [
        new File([Uint8Array.of(7)], 'kept.png', { type: 'image/png' }),
        new File([Uint8Array.of(8)], 'kept.txt', { type: 'text/plain' }),
      ])
      await vi.waitFor(() => {
        expect(b.root.fileUploads.getSnapshot()[attachments[1]!.id]?.status).toBe('ready')
      })
      await expect(b.root.sendSession(session, '失败', attachments.map(attachment => attachment.id), 'queue'))
        .resolves.toEqual({ kind: 'error', admission: status })
      const echo = await b.begun
      const attempt = b.root.submissions.attemptFor(echo.requestId!)!
      b.retire.onRetire?.({ reason: 'failed' })
      expect(b.root.resolveDraftAttachments(attachments.map(attachment => attachment.id))).toHaveLength(2)
      expect(b.root['submissionDrafts'].get(attempt.requestId)?.attachments).toEqual(attachments)
      expect(b.revoked).not.toHaveBeenCalled()
      await expect(b.root.retrySubmission(attempt)).resolves.toEqual({ kind: 'success', admission: 'accepted' })
      expect(b.beginSubmission).toHaveBeenCalledTimes(2)
      expect(b.beginSubmission.mock.calls[1]?.[0]).toMatchObject({ requestId: attempt.requestId, attachments: echo.attachments })
      expect(b.prompt.mock.calls[1]?.[0]).toEqual(b.prompt.mock.calls[0]?.[0])
      expect(b.prompt.mock.calls[1]?.[3]).toBe(attempt.requestId)
      b.retire.onRetire?.({ reason: 'observed', attachments: [] })
      expect(b.root.resolveDraftAttachments(attachments.map(attachment => attachment.id))).toEqual([])
      expect(b.root['submissionDrafts'].has(attempt.requestId)).toBe(false)
    } finally {
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('abandons the echo when encoding fails before the prompt', async () => {
    const b = await echoBench()
    class FailingReader {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      error = new Error('read failed')
      readAsDataURL(): void {
        queueMicrotask(() => this.onerror?.())
      }
    }
    vi.stubGlobal('FileReader', FailingReader)
    try {
      const [attachment] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(1)], 'broken.png', { type: 'image/png' }),
      ])
      const session = b.runtime.sessions.binding('s1')!.session
      await expect(b.root.sendSession(session, 'x', [attachment!.id], 'queue'))
        .resolves.toEqual({ kind: 'error', admission: 'rejected', text: 'read failed' })
      expect(b.abandon).toHaveBeenCalledOnce()
      expect(b.prompt).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('yields through the macrotask fallback where no frame clock exists', async () => {
    const b = await echoBench()
    vi.stubGlobal('requestAnimationFrame', undefined)
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      await expect(b.root.sendSession(session, '纯文本', [], 'queue')).resolves.toEqual({ kind: 'success', admission: 'accepted' })
      expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: '纯文本' }], 'queue', expect.any(AbortSignal), b.beginSubmission.mock.calls[0]?.[0].requestId)
    } finally {
      vi.unstubAllGlobals()
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('bounds the paint yield when the frame clock is throttled', async () => {
    const b = await echoBench()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    try {
      const session = b.runtime.sessions.binding('s1')!.session
      const sending = b.root.sendSession(session, '后台标签', [], 'queue')
      expect(b.prompt).not.toHaveBeenCalled()
      await expect(sending).resolves.toEqual({ kind: 'success', admission: 'accepted' })
      expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: '后台标签' }], 'queue', expect.any(AbortSignal), b.beginSubmission.mock.calls[0]?.[0].requestId)
    } finally {
      vi.unstubAllGlobals()
      b.restore()
    }
    await b.runtime.dispose()
  })

  it('echoes a subagent continuation and sends it under the echo request id', async () => {
    const b = await bench()
    const session = b.runtime.sessions.binding('s1')!.session
    const snapshot = session.getSnapshot()
    const beginSubmission = vi.spyOn(session, 'beginSubmission')
    vi.spyOn(session, 'getSnapshot').mockReturnValue({
      ...snapshot,
      subagent: {
        address: { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' } as never,
      },
    })
    const prompt = vi.spyOn(session, 'prompt').mockResolvedValue({ ok: true, value: { accepted: true } })
    await expect(b.root.sendSession(session, '继续', [], 'queue')).resolves.toEqual({ kind: 'success' })
    expect(beginSubmission).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: 'queue', text: '继续' }))
    const echo = beginSubmission.mock.results[0]
    const requestId = echo?.type === 'return' ? echo.value.requestId : undefined
    expect(requestId).toEqual(expect.any(String))
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: '继续' }], 'queue', undefined, requestId)
    await b.runtime.dispose()
  })
})

describe('draft image dimension probe', () => {
  it('fills intrinsic dimensions from the header probe and skips runtimes without Image', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:probe')
    class InstantImage {
      onload: (() => void) | null = null
      naturalWidth = 0
      naturalHeight = 0
      set src(_value: string) {
        this.naturalWidth = 640
        this.naturalHeight = 480
        this.onload?.()
      }
    }
    vi.stubGlobal('Image', InstantImage)
    try {
      const [probed] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(1)], 'probed.png', { type: 'image/png' }),
      ])
      expect(probed).toMatchObject({ width: 640, height: 480 })
      vi.stubGlobal('Image', undefined)
      const [unprobed] = b.root.createDrafts(b.runtime.sessions.binding('s1')!.session.sessionId, [
        new File([Uint8Array.of(2)], 'unprobed.png', { type: 'image/png' }),
      ])
      expect(unprobed?.kind).toBe('image')
      if (unprobed?.kind !== 'image') throw new Error('image draft missing')
      expect(unprobed.width).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
      created.mockRestore()
    }
    await b.runtime.dispose()
  })
})

describe('InputHub queue steering (empty-draft accelerated Enter)', () => {
  const row = (id: string): UserMessage => ({
    id: id as never,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: id }],
  })

  it('steers every queued row in FIFO order and leaves steering rows alone', async () => {
    const b = await bench()
    await b.runtime.sessions.setProjection('s1', 'inbox', { 'next-turn': [row('q-1'), row('q-3')], 'next-step': [row('q-2')] })
    b.shell.steerQueue()
    await vi.waitFor(() => {
      expect(b.updateQueue).toHaveBeenCalledTimes(2)
    })
    expect(b.updateQueue).toHaveBeenNthCalledWith(1, 'q-1', { kind: 'steer' })
    expect(b.updateQueue).toHaveBeenNthCalledWith(2, 'q-3', { kind: 'steer' })
    expect(b.shell.notices.getSnapshot()).toBeNull()
    await b.runtime.dispose()
  })

  it('converges silently when the turn closes or a row is claimed mid-steer', async () => {
    const b = await bench()
    await b.runtime.sessions.setProjection('s1', 'inbox', { 'next-turn': [row('q-1'), row('q-2')], 'next-step': [] })
    // The turn closes before the second row: the flush stops, silently.
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/steer-unavailable', 'closed', { itemId: 'item-1' as MessageId }),
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => { expect(b.updateQueue).toHaveBeenCalledTimes(1) })
    expect(b.shell.notices.getSnapshot()).toBeNull()

    // A row the host already claimed (e.g. a repeated empty-draft chord):
    // the duplicate Steer is a silent no-op.
    await b.runtime.sessions.setProjection('s1', 'inbox', { 'next-turn': [row('q-3')], 'next-step': [] })
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/queue-item-not-found', 'claimed', { itemId: 'item-1' as MessageId }),
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => { expect(b.updateQueue).toHaveBeenCalledTimes(2) })
    expect(b.shell.notices.getSnapshot()).toBeNull()
    await b.runtime.dispose()
  })

  it('surfaces one notice on a genuine steer failure and stops', async () => {
    const b = await bench()
    await b.runtime.sessions.setProjection('s1', 'inbox', { 'next-turn': [row('q-1'), row('q-2')], 'next-step': [] })
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: new RemoteError('gateway/internal', 'broken', {}),
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => {
      expect(b.shell.notices.getSnapshot()).toEqual(
        expect.objectContaining({ level: 'error', text: '插话发送失败，请重试。' }),
      )
    })
    expect(b.updateQueue).toHaveBeenCalledTimes(1)
    await b.runtime.dispose()
  })

  it('no-ops without queued rows', async () => {
    const b = await bench()
    b.shell.steerQueue()
    expect(b.updateQueue).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })
})


it('captures run mode and queue intent at submission before later projection changes', async () => {
  const b = await bench()
  const track = vi.fn()
  b.runtime.ctx.provide('productAnalytics', { enabled: true, track } as never)
  try {
    await b.runtime.sessions.setProjection('s1', 'plan', { active: true, pending: false })
    await b.runtime.sessions.setProjection('s1', 'goal', { goal: { phase: 'active' } })
    await b.runtime.sessions.setProjection('s1', 'modelSelection', { next: { provider: 'fixture', model: 'model', reasoningEffort: 'high' }, lastUsed: null })
    await b.runtime.sessions.updateSessionSnapshot('s1', (state) => { state.running = true; state.blank = false })
    b.shell.setDraft('private prompt')
    b.shell.submit('queue', 'click')
    expect(track).toHaveBeenCalledExactlyOnceWith('send_button_click', {
      session_id: 's1', model_name: 'fixture/model', thinking_effort: 'high', run_mode: 'plan', msg_type: 'queue',
    }, expect.any(Number))
    await b.runtime.sessions.setProjection('s1', 'plan', { active: false, pending: false })
    expect(track).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(track.mock.calls)).not.toContain('private prompt')
  } finally { await b.runtime.dispose() }
})

it.each([
  { running: false, mode: 'queue', expected: 'default' },
  { running: true, mode: 'steer', expected: 'steer' },
] as const)('reports msg_type=$expected without gesture fields', async ({ running, mode, expected }) => {
  const b = await bench()
  const track = vi.fn()
  b.runtime.ctx.provide('productAnalytics', { enabled: true, track } as never)
  try {
    await b.runtime.sessions.updateSessionSnapshot('s1', (state) => { state.running = running; state.blank = true })
    b.shell.setDraft('message')
    b.shell.submit(mode, 'enter')
    expect(track).toHaveBeenCalledExactlyOnceWith('send_button_click', { run_mode: 'default', msg_type: expected }, expect.any(Number))
  } finally { await b.runtime.dispose() }
})
