/** Global completion observation over the existing Session-list projection transport. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/**
 * Observe live primary-Session completions without creating or retaining Client Sessions.
 * The carrier excludes initial and reconnect baselines; historical projection reads never notify.
 * @param sessions - global live projection subscription, independent of selection.
 * @param completed - normal completion identity; presentation owns deduplication and window policy.
 * @returns the live projection subscription disposer.
 */
export function observeCompletions(
  sessions: Pick<ISessions, 'onProjectionUpdate'>,
  completed: (sessionId: SessionId, seq: SessionSeq) => void,
): () => void {
  return sessions.onProjectionUpdate((update) => {
    // Only a newly completed turn has a completion value equal to the live event watermark.
    if (update.key === 'interactionTaskCompletion' && update.value === update.seq) completed(update.sessionId, update.seq)
  })
}
