/** Replayable completion candidates; runtime eligibility gates only live change-feed delivery. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {} from '../types.ts'

const seqSchema = z.number().int().nonnegative().transform(value => value as SessionSeq).nullable()

/** Normal primary-Session turn candidates, independent of runtime pending work. */
export const taskCompletionProjection = {
  key: 'interactionTaskCompletion',
  stateVersion: 1,
  stateSchema: z.object({ primary: z.boolean(), completedSeq: seqSchema }),
  init: header => ({ primary: header.origin !== 'subagent', completedSeq: null }),
  apply: (state, event) => state.primary && event.type === 'turn/end' && event.data.reason.kind === 'completed'
    ? { ...state, completedSeq: event.seq }
    : state,
  wire: { viewSchema: seqSchema, view: state => state.completedSeq },
} satisfies ProjectionDefinition<'interactionTaskCompletion'>
