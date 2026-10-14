/** Display projection for accepted and pending annotations; model context remains unchanged. */
import { formatAnnotations, OWNER_ID, type PreparedRecord } from '../shared.ts'

/**
 * Projects the plugin-owned annotation contribution out of exact accepted message text.
 * @param record - durable accepted submission record.
 * @param identity - exact Session, request, and message identity to admit.
 * @param modelText - visible model text stored for the message.
 * @returns display text without this plugin's frozen contribution, or `null` when the record does not match.
 */
export function annotationDisplayText(
  record: PreparedRecord,
  identity: { readonly sessionId: string; readonly requestId: string; readonly messageId: string },
  modelText: string,
): string | null {
  const { attempt } = record
  if (record.status !== 'accepted' || record.messageId !== identity.messageId
    || attempt.sessionId !== identity.sessionId || attempt.requestId !== identity.requestId
    || attempt.text !== modelText) return null
  return frozenAnnotationDisplayText(record, modelText)
}

/**
 * Projects annotation text for its matching pending submission.
 * @param record - prepared record before durable acceptance or rejection.
 * @param identity - trusted Session and request identity from the pending submission.
 * @param modelText - exact submitted text.
 * @returns display text without this plugin's contribution, or `null` for rejected or mismatched records.
 */
export function pendingAnnotationDisplayText(
  record: PreparedRecord,
  identity: { readonly sessionId: string; readonly requestId: string },
  modelText: string,
): string | null {
  if (record.status === 'rejected' || record.attempt.sessionId !== identity.sessionId
    || record.attempt.requestId !== identity.requestId || record.attempt.text !== modelText) return null
  return frozenAnnotationDisplayText(record, modelText)
}

function frozenAnnotationDisplayText(record: PreparedRecord, modelText: string): string | null {
  const { attempt, snapshot } = record
  const owner = attempt.contributions.find(contribution => contribution.id === OWNER_ID)
  if (!owner || owner.revision !== snapshot.revision || owner.text !== formatAnnotations(snapshot)) return null
  // Reverse the host's exact frozen join; never match delimiters in arbitrary user text.
  const suffix = attempt.contributions.map(contribution => contribution.text).filter(text => text !== '').join('\n\n')
  let editorText: string
  if (modelText === suffix) editorText = ''
  else if (modelText.endsWith('\n\n' + suffix)) editorText = modelText.slice(0, -suffix.length - 2)
  else return null
  // Other owners retain their existing display; this plugin only hides its own context.
  return [editorText, ...attempt.contributions.filter(contribution => contribution.id !== OWNER_ID).map(contribution => contribution.text)]
    .filter(text => text !== '').join('\n\n')
}
