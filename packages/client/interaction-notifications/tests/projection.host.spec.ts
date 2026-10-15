import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as Notifications from '../src/index.ts'

async function harness() {
  const ctx = new Context()
  const store = ctx.plugin(SessionStore)
  onTestFinished(async () => { await store.dispose() })
  await store
  const registry = ctx.plugin(SessionProjectionRegistry)
  onTestFinished(async () => { await registry.dispose() })
  await registry
  const plugin = ctx.plugin(Notifications)
  onTestFinished(async () => { await plugin.dispose() })
  await plugin
  return { ctx, plugin }
}

it('publishes only a normal primary completion at the causing event sequence', async () => {
  const { ctx } = await harness()
  const session = ctx.sessions.create(SessionId('primary'))
  expect(ctx.sessionProjections.snapshot(session).values.interactionTaskCompletion).toBeNull()
  const changes: { value: unknown; seq: number }[] = []
  ctx.sessionProjections.onChanged((_session, key, value, seq) => {
    if (key === 'interactionTaskCompletion') changes.push({ value, seq })
  })
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  session.append('turn/start', { turn: 2 })
  session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'failure', code: 'UNKNOWN' } } })
  session.append('turn/start', { turn: 3 })
  session.append('turn/end', { turn: 3, reason: { kind: 'blocked' } })
  expect(changes).toEqual([])
  session.append('turn/start', { turn: 4 })
  const end = session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
  expect(changes).toEqual([{ value: end.seq, seq: end.seq }])
  expect(ctx.sessionProjections.snapshot(session).values.interactionTaskCompletion).toBe(end.seq)
})

it('suppresses subagent completion while retaining completion for a primary fork', async () => {
  const { ctx } = await harness()
  const parent = ctx.sessions.create(SessionId('parent'))
  const child = ctx.sessions.create(SessionId('child'), { meta: { origin: 'subagent' } })
  child.append('turn/start', { turn: 1 })
  child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(ctx.sessionProjections.snapshot(child).values.interactionTaskCompletion).toBeNull()
  const fork = ctx.sessions.create(SessionId('fork'), { meta: { parentSession: parent.id } })
  fork.append('turn/start', { turn: 1 })
  const end = fork.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(ctx.sessionProjections.snapshot(fork).values.interactionTaskCompletion).toBe(end.seq)
})

it('unregisters the projection with its fiber and reconstructs history without publishing it as live', async () => {
  const { ctx, plugin } = await harness()
  const session = ctx.sessions.create(SessionId('reload'))
  session.append('turn/start', { turn: 1 })
  const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await plugin.dispose()
  expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('interactionTaskCompletion')
  const changes: unknown[] = []
  ctx.sessionProjections.onChanged((_session, key, value) => {
    if (key === 'interactionTaskCompletion') changes.push(value)
  })
  await ctx.plugin(Notifications)
  expect(ctx.sessionProjections.snapshot(session).values.interactionTaskCompletion).toBe(end.seq)
  expect(changes).toEqual([])
})
