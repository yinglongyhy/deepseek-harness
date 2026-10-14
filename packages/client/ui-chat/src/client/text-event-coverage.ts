import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEventLikeEntry, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Result of checking durable coverage for one captured assistant message. */
export type TextEventCoverage = 'covered' | 'missing' | 'changed' | 'unavailable'

/**
 * Check whether the loaded contiguous event window covers the exact assistant message.
 * @param window - Current loaded Session event window after history loading.
 * @param seq - Captured durable message sequence.
 * @param messageId - Captured message id.
 * @returns Whether the exact source is covered, absent, changed, or still outside loaded history.
 */
export function textEventCoverage(
  window: Pick<SessionEventWindow, 'entries' | 'hasMore'>,
  seq: SessionSeq,
  messageId: MessageId,
): TextEventCoverage {
  const exact = window.entries.find(entry => entry.type === 'event' && entry.event.seq === seq)
  if (exact !== undefined) {
    return exact.event.type === 'assistant/message' && exact.event.data.message.id === messageId
      ? 'covered'
      : 'changed'
  }
  const firstDurable = window.entries.find((entry): entry is Extract<SessionEventLikeEntry, { type: 'event' }> => entry.type === 'event')
  return window.hasMore && (firstDurable === undefined || seq < firstDurable.event.seq)
    ? 'unavailable'
    : 'missing'
}
