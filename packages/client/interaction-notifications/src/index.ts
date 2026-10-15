/** Host projection registration for background completion reminders. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subagent'
import { taskCompletionProjection } from './host/projection.ts'

/** The existing projection registry drives committed Session events. */
export const inject = ['sessionProjections']

/**
 * Publish only a completion sequence; notification delivery and preferences remain Client-owned.
 * @param ctx - Host plugin context owning the reversible projection registration.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register({
    ...taskCompletionProjection,
    wire: {
      ...taskCompletionProjection.wire,
      publish: (session) => {
        const jobs = ctx.get('jobs')
        if (jobs !== undefined && jobs.list(session.id).some(job => job.owner === session.id
          && (job.status === 'running' || job.status === 'stopping'))) return false
        const agent = ctx.get('agents')?.get(session.id)
        if (agent === undefined || agent.session !== session) return true
        return agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0
          && !(ctx.get('subagents')?.hasPendingChildren(agent) ?? false)
      },
    },
  })
}
