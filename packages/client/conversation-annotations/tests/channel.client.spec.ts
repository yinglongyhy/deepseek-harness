import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AnnotationChannel, AnnotationRpcError } from '../src/client/channel.ts'
import { PREPARE_ABSENT_CODE, type AnnotationAttempt } from '../src/shared.ts'

const sessionId = brandString<SessionId>('session-1')
const requestId = brandString<SessionRequestId>('request-1')
const expiredReceipt = brandString<FileUploadReceiptId>('expired-receipt')
const anotherExpiredReceipt = brandString<FileUploadReceiptId>('another-expired-receipt')
const freshReceipt1 = brandString<FileUploadReceiptId>('fresh-1')
const freshReceipt2 = brandString<FileUploadReceiptId>('fresh-2')
const attempt: AnnotationAttempt = {
  sessionId, requestId, source: 'click', mode: 'queue', text: 'prompt',
  attachments: [
    { type: 'file', receiptId: expiredReceipt },
    { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'image.png' },
    { type: 'file', receiptId: anotherExpiredReceipt },
  ],
  contributions: [],
}

describe('AnnotationChannel prepare failures', () => {
  it('preserves Host codes and structured details without classifying error text', async () => {
    const failure = { code: PREPARE_ABSENT_CODE, message: 'Upload again.', details: { reason: 'receipt' } }
    const call = vi.fn(async () => ({ ok: false as const, error: failure }))
    const channel = new AnnotationChannel({ call })
    const input = { attempt, snapshot: { revision: 0, annotations: [] } }
    await expect(channel.prepare(input)).rejects.toBeInstanceOf(AnnotationRpcError)
    await expect(channel.prepare(input)).rejects.toMatchObject({ failure })
    call.mockResolvedValue({ ok: false, error: { ...failure, code: 'annotation-error' } })
    await expect(channel.prepare(input)).rejects.toMatchObject({ failure: { code: 'annotation-error' } })
  })

  it('does not convert a transport exception into Host absence evidence', async () => {
    const error = new Error(PREPARE_ABSENT_CODE)
    const channel = new AnnotationChannel({ call: vi.fn(async () => { throw error }) })
    await expect(channel.prepare({ attempt, snapshot: { revision: 0, annotations: [] } })).rejects.toBe(error)
  })
})

describe('AnnotationChannel restage', () => {
  it('refreshes file receipts without changing attachment order or image data', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: [
      { type: 'file', receiptId: freshReceipt1 },
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'image.png' },
      { type: 'file', receiptId: freshReceipt2 },
    ] }))
    const channel = new AnnotationChannel({ call })

    await expect(channel.restage(attempt)).resolves.toEqual([
      { type: 'file', receiptId: freshReceipt1 },
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'image.png' },
      { type: 'file', receiptId: freshReceipt2 },
    ])
    expect(call).toHaveBeenCalledWith('/conversation-annotations', 'restage', { sessionId, requestId }, undefined)
  })

  it('rejects a Host response that changes ordered attachment kinds', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: [
      { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'image.png' },
      { type: 'file', receiptId: freshReceipt1 },
      { type: 'file', receiptId: freshReceipt2 },
    ] }))
    const channel = new AnnotationChannel({ call })

    await expect(channel.restage(attempt)).rejects.toThrow('Restaged attachment content mismatch.')
  })
})
