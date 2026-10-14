import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatTextRevision, ChatTextSurfaceId } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AnnotationId } from '../src/draft.ts'
import { formatAnnotations, OWNER_ID, type AnnotationAttempt, type AnnotationSnapshot, type CapturedAnnotation, type PreparedRecord } from '../src/shared.ts'
import { AnnotationClient } from '../src/client/controller.ts'

const ordinary = brandString<SessionId>('ordinary')
const subagent = brandString<SessionId>('subagent')
const unbound = brandString<SessionId>('unbound')
const messageId = brandString<MessageId>('message-1')
const requestId = brandString<SessionRequestId>('request-1')
const expiredReceipt = brandString<FileUploadReceiptId>('expired-receipt')
const freshReceipt = brandString<FileUploadReceiptId>('fresh-receipt')
const annotationId = brandString<AnnotationId>('annotation-1')
const blockId = brandString<ChatTextSurfaceId>('block-1')
const textRevision = brandString<ChatTextRevision>('revision-1')

describe('annotation Client session access', () => {
  it('allows only ordinary bound Sessions and rejects Subagent Sessions', async () => {
    const bindings = new Map<string, { readonly subagent: { readonly address: string } | null }>([
      [ordinary, { subagent: null }],
      [subagent, { subagent: { address: 'parent/child' } }],
    ])
    const offSelection = vi.fn(async () => {})
    const ctx = Object.assign(new Context(), {
      chatText: { selection: () => null, subscribe: () => offSelection },
      sessions: { binding: (id: string) => {
        const snapshot = bindings.get(id)
        return snapshot ? { session: { getSnapshot: () => snapshot } } : undefined
      } },
    })
    vi.spyOn(ctx, 'get').mockImplementation(() => ({ rpc: { call: vi.fn(async () => ({ ok: true, value: [] })) } }) as never)
    const client = new AnnotationClient(ctx)

    expect(client.isOrdinarySession(ordinary)).toBe(true)
    expect(client.isOrdinarySession(subagent)).toBe(false)
    expect(client.isOrdinarySession(unbound)).toBe(false)
    expect(() => client.forSession(subagent)).toThrow('Annotations are unavailable in Subagent Sessions.')

    await client.dispose()
    expect(offSelection).toHaveBeenCalledOnce()
  })

  it('retries the retained attempt with Host-restaged file attachments', async () => {
    const annotation: CapturedAnnotation = {
      id: annotationId,
      anchor: { kind: 'conversation', sessionId: ordinary, messageId, blockId, revision: textRevision, start: 0, end: 5, selectedText: 'hello' },
      comment: 'remember this', revision: 1, seq: SessionSeq(1),
    }
    const snapshot: AnnotationSnapshot = { revision: 1, annotations: [annotation] }
    const ownerText = formatAnnotations(snapshot)
    const attempt: AnnotationAttempt = {
      sessionId: ordinary, requestId, source: 'click', mode: 'queue', text: `Question\n\n${ownerText}`,
      attachments: [{ type: 'file', receiptId: expiredReceipt }],
      contributions: [{ id: OWNER_ID, revision: 1, text: ownerText }],
    }
    const record: PreparedRecord = { schemaVersion: 1, attempt, snapshot, status: 'rejected' }
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => ({ ok: true as const, value:
      endpoint === 'list' || endpoint === 'reconcile' ? (endpoint === 'list' ? [record] : record)
        : endpoint === 'restage' ? [{ type: 'file', receiptId: freshReceipt }] : null,
    }))
    const attemptState = { pending: false }
    const submissions = {
      storeFor: () => ({ getSnapshot: () => attemptState, subscribe: () => () => {} }),
      restore: vi.fn((value: AnnotationAttempt) => value),
      reconcile: vi.fn(async (_requestId: string, resolve: () => Promise<string>) => resolve()),
    }
    const retrySubmission = vi.fn(async () => ({ kind: 'success' as const }))
    const ctx = Object.assign(new Context(), {
      chatText: { selection: () => null, subscribe: () => async () => {} },
      sessions: { binding: () => ({ session: { getSnapshot: () => ({ subagent: null }) } }) },
      conversation: {
        submissions,
        registerContribution: vi.fn(() => async () => {}),
        retrySubmission,
      },
    })
    vi.spyOn(ctx, 'get').mockImplementation(() => ({ rpc: { call: rpcCall } }) as never)
    const client = new AnnotationClient(ctx)
    const session = client.forSession(ordinary)

    await vi.waitFor(() => { expect(session.getSnapshot().busy).toBe(false) })
    await session.retry()

    expect(rpcCall).toHaveBeenCalledWith('/conversation-annotations', 'restage', { sessionId: ordinary, requestId }, expect.any(AbortSignal))
    expect(retrySubmission).toHaveBeenCalledWith(attempt, expect.any(AbortSignal), [{ type: 'file', receiptId: freshReceipt }])
    expect(session.getSnapshot().pending?.attempt).toStrictEqual(attempt)
    await client.dispose()
  })
})
