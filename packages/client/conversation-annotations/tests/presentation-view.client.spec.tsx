// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ChatTextRevision, ChatTextSurfaceId } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AnnotationId } from '../src/draft.ts'
import { en, zh } from '../src/client/locales.ts'
import { UserPresentation, PendingUserPresentation, type PendingUserPresentationProps, type UserPresentationProps } from '../src/client/view.tsx'
import type { AnnotationAttempt, AnnotationSnapshot, CapturedAnnotation, PreparedRecord } from '../src/shared.ts'
import { formatAnnotations, OWNER_ID } from '../src/shared.ts'
import type { HistoryState } from '../src/client/controller.ts'

afterEach(cleanup)

const sessionId = SessionId('session-1')
const annotation: CapturedAnnotation = {
  id: brandString<AnnotationId>('annotation-1'),
  anchor: { kind: 'conversation', sessionId, messageId: brandString<MessageId>('message-1'), blockId: brandString<ChatTextSurfaceId>('block-1'), revision: brandString<ChatTextRevision>('revision-1'), start: 0, end: 5, selectedText: 'hello' },
  comment: 'remember this', revision: 1, seq: SessionSeq(1),
}
const snapshot: AnnotationSnapshot = { revision: 1, annotations: [annotation] }
const ownerText = formatAnnotations(snapshot)
const text = `Question\n\n${ownerText}`
const attempt: AnnotationAttempt = {
  sessionId, requestId: brandString<SessionRequestId>('request-1'), source: 'click', mode: 'queue', text, attachments: [],
  contributions: [{ id: OWNER_ID, revision: 1, text: ownerText }],
}
const record: PreparedRecord = { schemaVersion: 1, attempt, snapshot, status: 'accepted', messageId: brandString<MessageId>('message-1') }
const { messageId: omittedMessageId, ...withoutMessageId } = record
void omittedMessageId
const pendingRecord: PreparedRecord = { ...withoutMessageId, status: 'uncertain' }
const ready: HistoryState = { record, busy: false, error: null }
const t = makeTranslate(zh, en)

describe('message annotation summaries', () => {
  it('shows history beside native user-message rendering', () => {
    const renderFactorySlot = vi.fn(() => <p>native user message</p>)
    const props = {
      node: { data: { requestId: 'request-1', messageId: brandString<MessageId>('message-1'), content: [{ type: 'text', text }] } },
      sessionId: 'session-1',
      useHistory: (_key: string, select: (value: HistoryState) => HistoryState) => select(ready),
      navigate: vi.fn(async () => ({ status: 'found' })),
      renderFactorySlot,
      loadImage: vi.fn(async () => 'blob:image'), t,
    } as UserPresentationProps

    const view = render(<UserPresentation {...props} />)

    expect(view.getByRole('region', { name: zh.title })).toBeTruthy()
    expect(view.getByRole('button', { name: '1 条评论' })).toBeTruthy()
    expect(view.getByText('native user message')).toBeTruthy()
    expect(renderFactorySlot).toHaveBeenCalledWith('conversation.chat.user-message', expect.objectContaining({ text: 'Question' }))
    expect(renderFactorySlot).toHaveBeenCalledTimes(1)
  })

  it('shows history beside native pending-user rendering', () => {
    const renderFactorySlot = vi.fn(() => <p>native pending message</p>)
    const props = {
      input: { requestId: 'request-1', text },
      sessionId: 'session-1',
      useHistory: (_key: string, select: (value: HistoryState) => HistoryState) => select({ ...ready, record: pendingRecord }),
      navigate: vi.fn(async () => ({ status: 'found' })),
      renderFactorySlot,
      loadImage: vi.fn(async () => 'blob:image'), t,
    } as PendingUserPresentationProps

    const view = render(<PendingUserPresentation {...props} />)

    expect(view.getByRole('region', { name: zh.title })).toBeTruthy()
    expect(view.getByRole('button', { name: '1 条评论' })).toBeTruthy()
    expect(view.getByText('native pending message')).toBeTruthy()
    expect(renderFactorySlot).toHaveBeenCalledWith('conversation.chat.pending-user-message', expect.objectContaining({ text: 'Question' }))
    expect(renderFactorySlot).toHaveBeenCalledTimes(1)
  })
})
