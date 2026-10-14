import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationContributionId, ConversationSubmissionAttempt, SubmissionContribution, SubmissionContributionState,
} from '../src/client/contract/contributions.ts'
import { SubmissionContributionRegistry } from '../src/client/submission-contributions.ts'

const SID = 'contribution-session' as SessionId
const ID = 'business-summary' as ConversationContributionId

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function bench() {
  const registry = new SubmissionContributionRegistry()
  const state = createSnapshotStore<SubmissionContributionState>({ hasContent: true, revision: 1, text: 'frozen note' })
  const prepare = vi.fn<SubmissionContribution['prepare']>(async () => {})
  const settle = vi.fn()
  const dispose = registry.register(SID, { id: ID, state, prepare, settle })
  const capture = () => registry.capture(SID, 'question', [], 'queue', 'click')
  return { registry, state, prepare, settle, dispose, capture }
}

function identityBench() {
  const b = bench()
  const secondId = 'second-summary' as ConversationContributionId
  const second = b.registry.register(SID, {
    id: secondId,
    state: createSnapshotStore<SubmissionContributionState>({ hasContent: true, revision: 2, text: 'second note' }),
    prepare: async () => {}, settle: () => {},
  })
  const attempt: ConversationSubmissionAttempt = {
    sessionId: SID, requestId: b.capture().requestId, source: 'click', mode: 'queue',
    text: 'question\n\nfrozen note\n\nsecond note',
    attachments: [
      { type: 'image', mediaType: 'image/png', data: 'image bytes', name: 'image.png' },
      { type: 'file', receiptId: 'receipt-one' },
    ],
    contributions: [{ id: ID, revision: 1, text: 'frozen note' }, { id: secondId, revision: 2, text: 'second note' }],
  }
  return {
    registry: b.registry, attempt,
    dispose: async () => { await second(); await b.dispose(); await b.registry.dispose() },
  }
}

describe('ordinary submission contributions', () => {
  it('retries only failed accepted settlement callbacks without repeating successful owners or Host admission', async () => {
    const b = bench()
    const secondSettle = vi.fn<SubmissionContribution['settle']>(() => { throw new Error('second owner failed') })
    const second = b.registry.register(SID, {
      id: 'second-summary' as ConversationContributionId,
      state: createSnapshotStore<SubmissionContributionState>({ hasContent: true, revision: 1, text: 'second note' }),
      prepare: async () => {}, settle: secondSettle,
    })
    try {
      const attempt = b.registry.materialize(b.capture(), 'question', [])
      const admit = vi.fn(async () => 'accepted' as const)
      expect(await b.registry.run(attempt, undefined, admit)).toMatchObject({ kind: 'error', admission: 'accepted' })
      const lookup = vi.fn(async () => 'uncertain' as const)
      await expect(b.registry.reconcile(attempt.requestId, lookup)).rejects.toThrow('second owner failed')
      secondSettle.mockImplementation(() => {})
      expect(await b.registry.reconcile(attempt.requestId, lookup)).toBe('accepted')
      expect(lookup).not.toHaveBeenCalled()
      expect(b.settle).toHaveBeenCalledOnce()
      expect(secondSettle).toHaveBeenCalledTimes(3)
      expect(admit).toHaveBeenCalledOnce()
    } finally { await second(); await b.dispose(); await b.registry.dispose() }
  })
  it.each(['rejected', 'uncertain'] as const)('rebinds a replaced owner after %s admission and reprepares the same frozen attempt', async (status) => {
    const b = bench()
    const capture = b.capture()
    const admit = vi.fn(async () => status)
    await b.registry.submit(capture, undefined, async () => ({ text: 'serialized question', attachments: [] }), admit)
    const attempt = b.registry.attemptFor(capture.requestId)!
    await b.dispose()
    const missingAdmit = vi.fn(async () => 'accepted' as const)
    expect(b.registry.restore(attempt)).toBe(attempt)
    expect((await b.registry.run(attempt, undefined, missingAdmit, false)).admission).toBe(status)
    expect(missingAdmit).not.toHaveBeenCalled()
    b.state.set({ hasContent: true, revision: 2, text: 'new draft' })
    const prepare = vi.fn<SubmissionContribution['prepare']>(async () => {})
    const settle = vi.fn<SubmissionContribution['settle']>(() => {})
    const off = b.registry.register(SID, { id: ID, state: b.state, prepare, settle })
    try {
      expect(b.registry.restore(attempt)).toBe(attempt)
      expect(await b.registry.run(attempt, undefined, missingAdmit, false)).toEqual({ kind: 'success', admission: 'accepted' })
      expect(prepare).toHaveBeenCalledWith(attempt, { id: ID, revision: 1, text: 'frozen note' }, expect.any(AbortSignal))
      expect(settle).toHaveBeenCalledWith(attempt, attempt.contributions[0], 'accepted')
      expect(missingAdmit).toHaveBeenCalledOnce()
      expect(attempt.requestId).toBe(capture.requestId)
      expect(attempt.text).toBe('serialized question\n\nfrozen note')
      expect(b.prepare).toHaveBeenCalledOnce()
      expect(b.state.getSnapshot().text).toBe('new draft')
    } finally { await off(); await b.registry.dispose() }
  })

  it.each(['prepare', 'admit', 'settle'] as const)('never rebinds replacement callbacks while captured %s is running', async (phase) => {
    const b = bench()
    const gate = deferred()
    const entered = deferred()
    const block = async (): Promise<void> => { entered.resolve(); await gate.promise }
    if (phase === 'prepare') b.prepare.mockImplementation(block)
    if (phase === 'settle') b.settle.mockImplementation(async () => { await block(); throw new Error('old settlement failed') })
    const admit = vi.fn(async () => {
      if (phase === 'admit') await block()
      return phase === 'settle' ? 'accepted' as const : 'uncertain' as const
    })
    const capture = b.capture()
    const pending = b.registry.submit(capture, undefined, async () => ({ text: 'question', attachments: [] }), admit)
    await entered.promise
    const attempt = b.registry.attemptFor(capture.requestId)!
    const disposal = b.dispose()
    const prepare = vi.fn<SubmissionContribution['prepare']>(async () => {})
    const settle = vi.fn<SubmissionContribution['settle']>(() => {})
    const off = b.registry.register(SID, { id: ID, state: b.state, prepare, settle })
    const replacementAdmit = vi.fn(async () => 'accepted' as const)
    const lookup = vi.fn(async () => 'accepted' as const)
    try {
      expect(b.registry.restore(attempt)).toBe(attempt)
      const retry = b.registry.run(attempt, undefined, replacementAdmit, false)
      const reconciliation = b.registry.reconcile(attempt.requestId, lookup)
      expect(prepare).not.toHaveBeenCalled()
      expect(settle).not.toHaveBeenCalled()
      gate.resolve()
      const outcome = await pending
      expect(await retry).toEqual(outcome)
      expect(await reconciliation).toBe(outcome.admission)
      await disposal
      expect(prepare).not.toHaveBeenCalled()
      expect(settle).not.toHaveBeenCalled()
      expect(replacementAdmit).not.toHaveBeenCalled()
      expect(lookup).not.toHaveBeenCalled()
      expect(b.registry.restore(attempt)).toBe(attempt)
      expect(await b.registry.run(attempt, undefined, replacementAdmit, false)).toEqual({ kind: 'success', admission: 'accepted' })
      expect(prepare).toHaveBeenCalledTimes(phase === 'settle' ? 0 : 1)
      expect(replacementAdmit).toHaveBeenCalledTimes(phase === 'settle' ? 0 : 1)
      expect(settle).toHaveBeenCalledWith(attempt, attempt.contributions[0], 'accepted')
    } finally { gate.resolve(); await disposal; await off(); await b.registry.dispose() }
  })

  it('keeps captured owners during tracked serialization even before an attempt operation starts', async () => {
    const b = bench()
    const capture = b.capture()
    const attempt = b.registry.materialize(capture, 'question', [])
    const gate = deferred()
    const entered = deferred()
    const serialization = b.registry.trackCapture(capture, new AbortController().signal, async () => {
      entered.resolve()
      await gate.promise
    })
    await entered.promise
    const disposal = b.dispose()
    const prepare = vi.fn<SubmissionContribution['prepare']>(async () => {})
    const settle = vi.fn<SubmissionContribution['settle']>(() => {})
    const off = b.registry.register(SID, { id: ID, state: b.state, prepare, settle })
    const admit = vi.fn(async () => 'accepted' as const)
    try {
      b.registry.restore(attempt)
      expect((await b.registry.run(attempt, undefined, admit, false)).admission).toBe('rejected')
      expect(prepare).not.toHaveBeenCalled()
      expect(settle).not.toHaveBeenCalled()
      expect(admit).not.toHaveBeenCalled()
      gate.resolve()
      await serialization
      await disposal
      b.registry.restore(attempt)
      expect(await b.registry.run(attempt, undefined, admit, false)).toEqual({ kind: 'success', admission: 'accepted' })
      expect(prepare).toHaveBeenCalledOnce()
      expect(settle).toHaveBeenCalledOnce()
      expect(admit).toHaveBeenCalledOnce()
    } finally { gate.resolve(); await serialization; await disposal; await off(); await b.registry.dispose() }
  })

  it('preserves successful accepted settlements across replacement and recovers only unavailable owners', async () => {
    const b = bench()
    const secondId = 'second-summary' as ConversationContributionId
    const secondState = createSnapshotStore<SubmissionContributionState>({ hasContent: true, revision: 1, text: 'second note' })
    const second = b.registry.register(SID, {
      id: secondId, state: secondState, prepare: async () => {},
      settle: () => { throw new Error('second settlement failed') },
    })
    const capture = b.capture()
    const admit = vi.fn(async () => 'accepted' as const)
    expect((await b.registry.submit(capture, undefined, async () => ({ text: 'question', attachments: [] }), admit)).admission).toBe('accepted')
    const attempt = b.registry.attemptFor(capture.requestId)!
    await b.dispose()
    await second()
    const lookup = vi.fn(async () => 'rejected' as const)
    await expect(b.registry.reconcile(attempt.requestId, lookup)).rejects.toThrow('settlement incomplete')
    const firstSettle = vi.fn<SubmissionContribution['settle']>(() => {})
    const secondSettle = vi.fn<SubmissionContribution['settle']>(() => {})
    const prepare = vi.fn<SubmissionContribution['prepare']>(async () => {})
    const firstOff = b.registry.register(SID, { id: ID, state: b.state, prepare, settle: firstSettle })
    const secondOff = b.registry.register(SID, { id: secondId, state: secondState, prepare, settle: secondSettle })
    try {
      expect(await b.registry.reconcile(attempt.requestId, lookup)).toBe('accepted')
      expect(await b.registry.run(attempt, undefined, admit, false)).toEqual({ kind: 'success', admission: 'accepted' })
      expect(firstSettle).not.toHaveBeenCalled()
      expect(secondSettle).toHaveBeenCalledOnce()
      expect(secondSettle).toHaveBeenCalledWith(attempt, attempt.contributions[1], 'accepted')
      expect(b.settle).toHaveBeenCalledOnce()
      expect(prepare).not.toHaveBeenCalled()
      expect(lookup).not.toHaveBeenCalled()
      expect(admit).toHaveBeenCalledOnce()
    } finally { await firstOff(); await secondOff(); await b.registry.dispose() }
  })

  it('restores equal request values despite reordered DTO fields and retains the original immutable object', async () => {
    const b = identityBench()
    try {
      const retained = b.registry.restore(b.attempt)
      const reordered: ConversationSubmissionAttempt = {
        contributions: [
          { text: 'frozen note', revision: 1, id: ID },
          { revision: 2, id: 'second-summary' as ConversationContributionId, text: 'second note' },
        ],
        attachments: [
          { name: 'image.png', data: 'image bytes', mediaType: 'image/png', type: 'image' },
          { receiptId: 'receipt-one', type: 'file' },
        ],
        text: b.attempt.text, mode: b.attempt.mode, source: b.attempt.source,
        requestId: b.attempt.requestId, sessionId: b.attempt.sessionId,
      }
      expect(b.registry.restore(reordered)).toBe(retained)
      expect(b.registry.attemptFor(reordered.requestId)).toBe(retained)
      expect(Object.isFrozen(retained)).toBe(true)
      expect(Object.isFrozen(retained.attachments[0])).toBe(true)
      expect(Object.isFrozen(retained.contributions[0])).toBe(true)
    } finally { await b.dispose() }
  })
  it.each<[string, (attempt: ConversationSubmissionAttempt) => ConversationSubmissionAttempt]>([
    ['session', attempt => ({ ...attempt, sessionId: 'other-session' as SessionId })],
    ['source', attempt => ({ ...attempt, source: 'enter' })],
    ['mode', attempt => ({ ...attempt, mode: 'steer' })],
    ['exact text', attempt => ({ ...attempt, text: `${attempt.text} ` })],
    ['attachment count', attempt => ({ ...attempt, attachments: attempt.attachments.slice(0, 1) })],
    ['attachment order', attempt => ({ ...attempt, attachments: [...attempt.attachments].reverse() })],
    ['image type', attempt => ({
      ...attempt,
      attachments: attempt.attachments.map(attachment => attachment.type === 'image'
        ? { type: 'file', receiptId: 'receipt-one' } : attachment),
    })],
    ['image media type', attempt => ({
      ...attempt,
      attachments: attempt.attachments.map(attachment => attachment.type === 'image'
        ? { ...attachment, mediaType: 'image/jpeg' } : attachment),
    })],
    ['image data', attempt => ({
      ...attempt,
      attachments: attempt.attachments.map(attachment => attachment.type === 'image'
        ? { ...attachment, data: `${attachment.data} ` } : attachment),
    })],
    ['image name', attempt => ({
      ...attempt,
      attachments: attempt.attachments.map(attachment => attachment.type === 'image'
        ? { ...attachment, name: 'other.png' } : attachment),
    })],
    ['omitted image name', attempt => ({
      ...attempt,
      attachments: attempt.attachments.map(attachment => attachment.type === 'image'
        ? { type: 'image', mediaType: attachment.mediaType, data: attachment.data } : attachment),
    })],
    ['file type', attempt => ({
      ...attempt,
      attachments: attempt.attachments.map(attachment => attachment.type === 'file'
        ? { type: 'image', mediaType: 'image/png', data: 'image bytes' } : attachment),
    })],
    ['file receipt', attempt => ({
      ...attempt,
      attachments: attempt.attachments.map(attachment => attachment.type === 'file'
        ? { ...attachment, receiptId: 'other-receipt' } : attachment),
    })],
    ['contribution count', attempt => ({ ...attempt, contributions: attempt.contributions.slice(0, 1) })],
    ['contribution order', attempt => ({ ...attempt, contributions: [...attempt.contributions].reverse() })],
    ['contribution ids', attempt => ({
      ...attempt,
      contributions: attempt.contributions.map(contribution => ({
        ...contribution, id: contribution.id === ID ? 'second-summary' as ConversationContributionId : ID,
      })),
    })],
    ['contribution revision', attempt => ({
      ...attempt,
      contributions: attempt.contributions.map(contribution => ({ ...contribution, revision: contribution.revision + 1 })),
    })],
    ['exact contribution text', attempt => ({
      ...attempt,
      contributions: attempt.contributions.map(contribution => ({ ...contribution, text: `${contribution.text} ` })),
    })],
  ])('rejects same-request identity reuse with different %s without replacing retained content', async (_field, change) => {
    const b = identityBench()
    try {
      const retained = b.registry.restore(b.attempt)
      expect(() => b.registry.restore(change(b.attempt))).toThrow('different submission content')
      expect(b.registry.attemptFor(b.attempt.requestId)).toBe(retained)
      expect(b.registry.restore(b.attempt)).toBe(retained)
    } finally { await b.dispose() }
  })

  it('retains different request ids independently even when their submitted values match', async () => {
    const b = identityBench()
    try {
      const requestId = 'independent-retained-request' as ConversationSubmissionAttempt['requestId']
      const first = b.registry.restore(b.attempt)
      const second = b.registry.restore({ ...b.attempt, requestId })
      expect(second).not.toBe(first)
      expect(second.requestId).toBe(requestId)
      expect(b.registry.attemptFor(b.attempt.requestId)).toBe(first)
      expect(b.registry.attemptFor(requestId)).toBe(second)
    } finally { await b.dispose() }
  })

  it('publishes stable eligibility and withdraws subscriptions on removal', async () => {
    const b = bench()
    const source = b.registry.storeFor(SID)
    expect(b.registry.storeFor(SID)).toBe(source)
    expect(source.getSnapshot()).toBe(source.getSnapshot())
    expect(source.getSnapshot()).toEqual({ hasContent: true })
    b.state.set({ hasContent: true, revision: 2, text: 'edited', blockReason: 'Saving' })
    expect(source.getSnapshot()).toEqual({ hasContent: true, blockReason: 'Saving' })
    expect(() => b.capture()).toThrow('Saving')
    await b.dispose()
    expect(source.getSnapshot()).toEqual({ hasContent: false })
    b.state.set({ hasContent: true, revision: 3, text: 'late' })
    expect(source.getSnapshot()).toEqual({ hasContent: false })
    await b.registry.dispose()
  })

  it('freezes revisions before serialization and prepares the immutable complete request before admission', async () => {
    const b = bench()
    const capture = b.capture()
    b.state.set({ hasContent: true, revision: 2, text: 'new note' })
    const attempt = b.registry.materialize(capture, 'serialized question', [{ type: 'image', mediaType: 'image/png', data: 'bytes' }])
    const gate = deferred()
    b.prepare.mockImplementation(async () => { await gate.promise })
    const admit = vi.fn(async () => 'accepted' as const)
    const pending = b.registry.run(attempt, undefined, admit)
    await Promise.resolve()
    expect(b.prepare).toHaveBeenCalledWith(attempt, { id: ID, revision: 1, text: 'frozen note' }, expect.any(AbortSignal))
    expect(admit).not.toHaveBeenCalled()
    expect(attempt.requestId).toBe(capture.requestId)
    expect(attempt.text).toBe('serialized question\n\nfrozen note')
    expect(Object.isFrozen(attempt)).toBe(true)
    expect(Object.isFrozen(attempt.attachments[0])).toBe(true)
    expect(Object.isFrozen(attempt.contributions[0])).toBe(true)
    gate.resolve()
    expect(await pending).toEqual({ kind: 'success', admission: 'accepted' })
    expect(b.settle).toHaveBeenCalledWith(attempt, attempt.contributions[0], 'accepted')
    expect(b.state.getSnapshot().revision).toBe(2)
    await b.dispose()
    await b.registry.dispose()
  })

  it('waits for every preparation to finish after one fails and never contacts the Host', async () => {
    const b = bench()
    const gate = deferred()
    b.prepare.mockRejectedValue(new Error('storage unavailable'))
    const second = vi.fn(async () => { await gate.promise })
    const off = b.registry.register(SID, { id: 'second' as ConversationContributionId, state: b.state, prepare: second, settle: vi.fn() })
    const attempt = b.registry.materialize(b.capture(), 'question', [])
    const admit = vi.fn(async () => 'accepted' as const)
    const pending = b.registry.run(attempt, undefined, admit)
    let finished = false
    void pending.then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    gate.resolve()
    expect(await pending).toEqual({ kind: 'error', admission: 'rejected', text: 'storage unavailable' })
    expect(admit).not.toHaveBeenCalled()
    expect(b.settle).toHaveBeenCalledWith(attempt, attempt.contributions[0], 'rejected')
    await off()
    await b.dispose()
    await b.registry.dispose()
  })

  it('contains settlement exceptions and deduplicates concurrent and accepted retries', async () => {
    const b = bench()
    b.settle.mockImplementation(() => { throw new Error('consumer failed') })
    const attempt = b.registry.materialize(b.capture(), 'question', [])
    const gate = deferred()
    const admit = vi.fn(async () => { await gate.promise; return 'accepted' as const })
    const first = b.registry.run(attempt, undefined, admit)
    expect(b.registry.run(attempt, undefined, admit)).toBe(first)
    gate.resolve()
    const outcome = await first
    expect(outcome).toMatchObject({ kind: 'error', admission: 'accepted' })
    if (outcome.kind !== 'error') throw new Error('settlement failure was not reported')
    expect(outcome.text).toContain('consumer failed')
    b.settle.mockImplementation(() => {})
    expect(await b.registry.run(attempt, undefined, admit, false)).toEqual({ kind: 'success', admission: 'accepted' })
    expect(b.settle).toHaveBeenCalledTimes(2)
    expect(admit).toHaveBeenCalledOnce()
    await b.dispose()
    await b.registry.dispose()
  })

  it('retains an uncertain request for same-body retry and full-history reconciliation', async () => {
    const b = bench()
    const attempt = b.registry.materialize(b.capture(), 'question', [{ type: 'file', receiptId: 'receipt' }])
    expect(await b.registry.run(attempt, undefined, async () => { throw new Error('ACK lost') })).toEqual({ kind: 'error', admission: 'uncertain', text: 'ACK lost' })
    expect(b.registry.attemptFor(attempt.requestId)).toBe(attempt)
    expect(() => b.registry.restore({ ...attempt, text: 'different' })).toThrow('different submission content')
    expect(() => b.registry.restore({ ...attempt, sessionId: 'other' as SessionId })).toThrow('different submission content')
    const lookup = vi.fn(async (saved: ConversationSubmissionAttempt) => {
      expect(saved.attachments).toEqual([{ type: 'file', receiptId: 'receipt' }])
      return 'accepted' as const
    })
    expect(await b.registry.reconcile(attempt.requestId, lookup)).toBe('accepted')
    expect(lookup).toHaveBeenCalledWith(attempt)
    await b.dispose()
    await b.registry.dispose()
  })

  it('restores frozen content and prepares its captured revision without rereading the current draft on retry', async () => {
    const b = bench()
    const original = b.registry.materialize(b.capture(), 'question', [])
    await b.registry.run(original, undefined, async () => 'uncertain')
    b.state.set({ hasContent: true, revision: 2, text: 'new note' })
    const restarted = new SubmissionContributionRegistry()
    const prepare = vi.fn(async () => {})
    const off = restarted.register(SID, { id: ID, state: b.state, prepare, settle: () => {} })
    const attempt = restarted.restore(JSON.parse(JSON.stringify(original)) as ConversationSubmissionAttempt)
    const admit = vi.fn(async () => 'accepted' as const)
    expect(await restarted.run(attempt, undefined, admit, false)).toEqual({ kind: 'success', admission: 'accepted' })
    expect(attempt).toEqual(original)
    expect(b.prepare).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledWith(attempt, original.contributions[0], expect.any(AbortSignal))
    expect(b.state.getSnapshot().text).toBe('new note')
    await off()
    await restarted.dispose()
    await b.dispose()
    await b.registry.dispose()
  })

  it('reprepares every restored owner before retrying partially durable content with its exact envelope', async () => {
    const b = bench()
    const secondId = 'second' as ConversationContributionId
    const secondState = createSnapshotStore<SubmissionContributionState>({ hasContent: true, revision: 7, text: 'second note' })
    const directory = await mkdtemp(join(tmpdir(), 'dsh-submission-restore-'))
    const storedEnvelope = join(directory, 'owner-a.json')
    const secondPrepare = vi.fn(async () => { throw new Error('second storage unavailable') })
    const off = b.registry.register(SID, { id: secondId, state: secondState, prepare: secondPrepare, settle: () => {} })
    const persist = async (path: string, attempt: ConversationSubmissionAttempt): Promise<void> => {
      const file = await open(path, 'wx')
      try { await file.writeFile(JSON.stringify(attempt), 'utf8'); await file.sync() }
      finally { await file.close() }
    }
    b.prepare.mockImplementation(async (attempt) => { await persist(storedEnvelope, attempt) })
    const original = b.registry.materialize(b.capture(), 'serialized question', [
      { type: 'image', mediaType: 'image/png', data: 'bytes', name: 'snapshot.png' },
      { type: 'file', receiptId: 'receipt' },
    ])
    const admit = vi.fn(async () => 'accepted' as const)
    const restarted = new SubmissionContributionRegistry()
    const gate = deferred()
    try {
      expect((await b.registry.run(original, undefined, admit)).admission).toBe('rejected')
      expect(JSON.parse(await readFile(storedEnvelope, 'utf8'))).toEqual(original)
      expect(secondPrepare).toHaveBeenCalledOnce()
      await off()
      await b.dispose()
      await b.registry.dispose()
      b.state.set({ hasContent: true, revision: 2, text: 'new draft' })
      secondState.set({ hasContent: true, revision: 8, text: 'new second draft' })
      const firstRecovered = vi.fn<SubmissionContribution['prepare']>(async (attempt) => {
        expect(JSON.parse(await readFile(storedEnvelope, 'utf8'))).toEqual(attempt)
      })
      const secondRecovered = vi.fn<SubmissionContribution['prepare']>(async () => { throw new Error('second still incomplete') })
      restarted.register(SID, { id: ID, state: b.state, prepare: firstRecovered, settle: () => {} })
      restarted.register(SID, { id: secondId, state: secondState, prepare: secondRecovered, settle: () => {} })
      const restored = restarted.restore(JSON.parse(await readFile(storedEnvelope, 'utf8')) as ConversationSubmissionAttempt)
      expect((await restarted.run(restored, undefined, admit, false)).admission).toBe('uncertain')
      expect(admit).not.toHaveBeenCalled()
      expect(firstRecovered).toHaveBeenCalledWith(restored, original.contributions[0], expect.any(AbortSignal))
      expect(secondRecovered).toHaveBeenCalledWith(restored, original.contributions[1], expect.any(AbortSignal))
      const entered = deferred()
      const secondEnvelope = join(directory, 'owner-b.json')
      secondRecovered.mockImplementation(async (attempt) => {
        entered.resolve()
        await gate.promise
        await persist(secondEnvelope, attempt)
      })
      admit.mockImplementation(async () => {
        expect(JSON.parse(await readFile(secondEnvelope, 'utf8'))).toEqual(original)
        return 'accepted'
      })
      const retry = restarted.run(restored, undefined, admit, false)
      await entered.promise
      expect(admit).not.toHaveBeenCalled()
      gate.resolve()
      expect((await retry).admission).toBe('accepted')
      expect(firstRecovered).toHaveBeenCalledTimes(2)
      expect(secondRecovered).toHaveBeenCalledTimes(2)
      expect(restored).toEqual(original)
      expect(admit).toHaveBeenCalledOnce()
    } finally {
      gate.resolve()
      await restarted.dispose(); await off(); await b.dispose(); await b.registry.dispose()
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()))
      expect(directory).toContain('dsh-submission-restore-')
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('closes callbacks and waits for cancelled preparation on owner disposal', async () => {
    const b = bench()
    const gate = deferred()
    let signal: AbortSignal | undefined
    const entered = deferred()
    b.prepare.mockImplementation(async (_attempt, _contribution, currentSignal) => {
      signal = currentSignal
      entered.resolve()
      await gate.promise
    })
    const attempt = b.registry.materialize(b.capture(), 'question', [])
    const admit = vi.fn(async () => 'accepted' as const)
    const pending = b.registry.run(attempt, undefined, admit)
    await entered.promise
    const disposal = b.dispose()
    expect(b.dispose()).toBe(disposal)
    let disposed = false
    void disposal.then(() => { disposed = true })
    expect(signal?.aborted).toBe(true)
    await Promise.resolve()
    expect(disposed).toBe(false)
    gate.resolve()
    expect((await pending).admission).toBe('rejected')
    await disposal
    expect(admit).not.toHaveBeenCalled()
    expect(b.settle).not.toHaveBeenCalled()
    await b.registry.dispose()
  })

  it('waits for a settlement already executing during disposal', async () => {
    const b = bench()
    const gate = deferred()
    const entered = deferred()
    b.settle.mockImplementation(async () => { entered.resolve(); await gate.promise })
    const attempt = b.registry.materialize(b.capture(), 'question', [])
    const pending = b.registry.run(attempt, undefined, async () => 'accepted')
    await entered.promise
    expect(b.settle).toHaveBeenCalledOnce()
    const disposal = b.registry.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    gate.resolve()
    await pending
    await disposal
    expect(() => b.capture()).toThrow('disposed')
  })

  it('coalesces concurrent reconciliation and retry without downgrading accepted admission', async () => {
    const b = bench()
    const attempt = b.registry.materialize(b.capture(), 'question', [])
    await b.registry.run(attempt, undefined, async () => 'uncertain')
    const gate = deferred()
    const firstLookup = vi.fn(async () => { await gate.promise; return 'accepted' as const })
    const secondLookup = vi.fn(async () => 'uncertain' as const)
    const admit = vi.fn(async () => 'accepted' as const)
    const first = b.registry.reconcile(attempt.requestId, firstLookup)
    const second = b.registry.reconcile(attempt.requestId, secondLookup)
    const retry = b.registry.run(attempt, undefined, admit, false)
    gate.resolve()
    expect(await first).toBe('accepted')
    expect(await second).toBe('accepted')
    expect((await retry).admission).toBe('accepted')
    expect(secondLookup).not.toHaveBeenCalled()
    expect(admit).not.toHaveBeenCalled()
    expect(await b.registry.reconcile(attempt.requestId, secondLookup)).toBe('accepted')
    expect(secondLookup).not.toHaveBeenCalled()
    expect(b.registry.storeFor(SID).getSnapshot().pending).toBeUndefined()
    await b.dispose()
    await b.registry.dispose()
  })

  it('tracks an operation before a prepare callback synchronously disposes its owner', async () => {
    const b = bench()
    const gate = deferred()
    const entered = deferred()
    let disposal: Promise<void> | undefined
    let disposed = false
    b.prepare.mockImplementation(async () => {
      disposal = b.dispose()
      void disposal.then(() => { disposed = true })
      entered.resolve()
      await gate.promise
    })
    const attempt = b.registry.materialize(b.capture(), 'question', [])
    const admit = vi.fn(async () => 'accepted' as const)
    const pending = b.registry.run(attempt, undefined, admit)
    await entered.promise
    await Promise.resolve()
    expect(disposed).toBe(false)
    gate.resolve()
    expect((await pending).admission).toBe('rejected')
    await disposal
    expect(disposed).toBe(true)
    expect(admit).not.toHaveBeenCalled()
    expect(b.settle).not.toHaveBeenCalled()
    await b.registry.dispose()
  })

  it('reserves matching content through serialization and uncertain admission, but leaves newer revisions sendable', async () => {
    const b = bench()
    const capture = b.capture()
    const gate = deferred()
    const pending = b.registry.submit(capture, undefined, async () => { await gate.promise; return { text: 'question', attachments: [] } }, async () => 'uncertain')
    expect(b.registry.storeFor(SID).getSnapshot().pending).toBe(true)
    expect(() => b.capture()).toThrow('admission pending')
    gate.resolve()
    expect((await pending).admission).toBe('uncertain')
    expect(() => b.capture()).toThrow('admission pending')
    b.state.set({ hasContent: true, revision: 2, text: 'new draft' })
    expect(b.registry.storeFor(SID).getSnapshot().pending).toBeUndefined()
    expect(b.capture().contributions[0]?.revision).toBe(2)
    b.state.set({ hasContent: false, revision: 1, text: '' })
    expect(b.registry.storeFor(SID).getSnapshot().pending).toBeUndefined()
    await b.dispose()
    await b.registry.dispose()
  })

  it('awaits async attachment serialization during teardown without running preparation or admission', async () => {
    const b = bench()
    const capture = b.capture()
    const gate = deferred()
    const entered = deferred()
    const admit = vi.fn(async () => 'accepted' as const)
    const pending = b.registry.submit(capture, undefined, async () => {
      entered.resolve(); await gate.promise
      return { text: 'question', attachments: [] }
    }, admit)
    await entered.promise
    const disposal = b.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    gate.resolve()
    expect((await pending).admission).toBe('rejected')
    await disposal
    expect(b.prepare).not.toHaveBeenCalled()
    expect(admit).not.toHaveBeenCalled()
    await b.registry.dispose()
  })

  it('requires successful durable preparation when retry follows a rejected prepare', async () => {
    const b = bench()
    b.prepare.mockRejectedValue(new Error('storage unavailable'))
    const attempt = b.registry.materialize(b.capture(), 'question', [])
    const admit = vi.fn(async () => 'accepted' as const)
    expect((await b.registry.run(attempt, undefined, admit)).admission).toBe('rejected')
    const retained = b.registry.attemptFor(attempt.requestId)!
    b.registry.restore(retained)
    expect((await b.registry.run(retained, undefined, admit, false)).admission).toBe('rejected')
    expect(b.prepare).toHaveBeenCalledTimes(2)
    expect(admit).not.toHaveBeenCalled()
    b.prepare.mockResolvedValue(undefined)
    expect((await b.registry.run(retained, undefined, admit, false)).admission).toBe('accepted')
    expect(b.prepare).toHaveBeenCalledTimes(3)
    expect(admit).toHaveBeenCalledOnce()
    await b.dispose()
    await b.registry.dispose()
  })

  it('does not admit a restored request with missing owners or downgrade its uncertain admission', async () => {
    const b = bench()
    const persisted = b.registry.materialize(b.capture(), 'question', [])
    const recovered = new SubmissionContributionRegistry()
    recovered.restore(persisted)
    const admit = vi.fn(async () => 'accepted' as const)
    expect((await recovered.run(persisted, undefined, admit, false)).admission).toBe('uncertain')
    expect(admit).not.toHaveBeenCalled()
    await recovered.dispose()
    await b.dispose()
    await b.registry.dispose()
  })
})
