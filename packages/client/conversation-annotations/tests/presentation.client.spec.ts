import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ChatTextRevision, ChatTextSurfaceId } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AnnotationId } from '../src/draft.ts'
import type { ConversationContributionId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { formatAnnotations, OWNER_ID, type AnnotationAttempt, type AnnotationSnapshot, type CapturedAnnotation, type PreparedRecord } from '../src/shared.ts'
import { annotationDisplayText, pendingAnnotationDisplayText } from '../src/client/presentation.ts'

const sessionId = SessionId('session-1')
const requestId = brandString<SessionRequestId>('request-1')
const messageId = brandString<MessageId>('message-1')
const annotation: CapturedAnnotation = {
  id: brandString<AnnotationId>('annotation-1'),
  anchor: { kind: 'conversation', sessionId, messageId, blockId: brandString<ChatTextSurfaceId>('block-1'), revision: brandString<ChatTextRevision>('revision-1'), start: 0, end: 5, selectedText: 'hello' },
  comment: 'remember this',
  revision: 1,
  seq: SessionSeq(1),
}
const snapshot: AnnotationSnapshot = { revision: 1, annotations: [annotation] }
const ownerText = formatAnnotations(snapshot)
const modelText = `Question\n\n${ownerText}\n\nOther context`
const attempt: AnnotationAttempt = {
  sessionId, requestId, source: 'click', mode: 'queue', text: modelText, attachments: [],
  contributions: [
    { id: OWNER_ID, revision: snapshot.revision, text: ownerText },
    { id: brandString<ConversationContributionId>('other-plugin'), revision: 2, text: 'Other context' },
  ],
}
const record: PreparedRecord = { schemaVersion: 1, attempt, snapshot, status: 'accepted', messageId }

const messageIdentity = { sessionId, requestId, messageId }
function withoutMessageId(status: PreparedRecord['status']): PreparedRecord {
  const { messageId: omitted, ...pending } = record
  void omitted
  return { ...pending, status }
}

describe('annotation transcript projection', () => {
  it('hides only the annotation contribution after matching the accepted message', () => {
    expect(annotationDisplayText(record, messageIdentity, modelText)).toBe('Question\n\nOther context')
  })

  it('projects pending history without requiring a durable message id', () => {
    expect(pendingAnnotationDisplayText(withoutMessageId('uncertain'), { sessionId, requestId }, modelText))
      .toBe('Question\n\nOther context')
  })

  it('does not alter text when identity, admission, or frozen text differs', () => {
    expect(annotationDisplayText(record, { ...messageIdentity, requestId: brandString<SessionRequestId>('another-request') }, modelText)).toBeNull()
    expect(annotationDisplayText(withoutMessageId('rejected'), messageIdentity, modelText)).toBeNull()
    expect(annotationDisplayText(record, messageIdentity, `${modelText}!`)).toBeNull()
    expect(pendingAnnotationDisplayText(withoutMessageId('rejected'), { sessionId: 'session-1', requestId: 'request-1' }, modelText)).toBeNull()
  })
})
