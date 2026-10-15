import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents, { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Notifications from '../src/index.ts'
import { taskCompletionProjection } from '../src/host/projection.ts'

function message(text = 'continue') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function harness(persistence = false) {
  const ctx = new Context()
  const root = persistence ? await mkdtemp(join(tmpdir(), 'dsh-notification-')) : undefined
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  if (root !== undefined) await ctx.plugin(JsonlPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 30 }, () => textResponse('answer'))))
  const { agent: parent } = await ctx.agents.create({
    sessionId: SessionId('notification-parent'), agentOptions: { provider: 'mock', model: 'mock' },
  })
  const notices: { id: string; seq: number }[] = []
  ctx.sessionProjections.onChanged((session, key, value, seq) => {
    if (key === 'interactionTaskCompletion' && value === seq) notices.push({ id: session.id, seq })
  })
  const plugin = await ctx.plugin(Notifications)
  return { ctx, parent, notices, plugin }
}

it('suppresses the actual continuable subagent tool path through HMR and queued result delivery', async () => {
  const { ctx, parent, notices, plugin } = await harness(true)
  await ctx.plugin(Subagents)
  ctx.subagents.registerProvider({
    name: 'local', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    prepareContinuable: () => Promise.resolve({}),
  })
  await ctx.plugin(SubagentTool, { provider: 'local', maxDepth: 'provider-managed' })
  const entered = Promise.withResolvers<Agent>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  ctx.on('agent/pre-step', async (event, next) => {
    if (event.agent.session.header.origin === 'subagent') {
      entered.resolve(event.agent)
      await release.promise
    }
    return next()
  })
  const ended = Promise.withResolvers<undefined>()
  ctx.on('subagent/end', () => { ended.resolve(undefined) })
  const result = await ctx.tools.execute({
    agent: parent, callId: ToolCallId('notification-delegation'), name: 'subagent',
    arguments: { description: 'child task', prompt: 'do the child task' }, signal: new AbortController().signal,
  })
  expect(result.isError, JSON.stringify(result)).toBe(false)
  const child = await entered.promise
  expect(ctx.subagents.hasPendingChildren(parent)).toBe(true)
  expect(ctx.subagents.hasPendingChildren(child)).toBe(false)
  parent.followup(message('waiting'))
  await parent.whenIdle()
  expect(notices).toEqual([])
  expect(parent.session.snapshotEvents().some(event => event.type === 'job/registered')).toBe(false)

  await plugin.dispose()
  const unguarded = ctx.sessionProjections.register(taskCompletionProjection)
  parent.followup(message('negative control without live eligibility'))
  await parent.whenIdle()
  expect(notices.map(notice => notice.id)).toEqual([parent.id])
  unguarded()
  notices.length = 0
  await ctx.plugin(Notifications)
  expect(ctx.sessionProjections.snapshot(parent.session).values.interactionTaskCompletion).not.toBeNull()
  expect(notices).toEqual([])
  parent.followup(message('still waiting after HMR'))
  await parent.whenIdle()
  expect(notices).toEqual([])
  const { agent: fork } = await ctx.agents.create({
    sessionId: SessionId('independent-fork'), meta: { parentSession: parent.id },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  fork.followup(message())
  await fork.whenIdle()
  expect(notices.map(notice => notice.id)).toEqual([fork.id])
  expect(ctx.subagents.hasPendingChildren(fork)).toBe(false)

  const enqueue = vi.spyOn(parent, 'followup').mockImplementation((input) => { parent.inbox.append('next-turn', input) })
  onTestFinished(() => { enqueue.mockRestore() })
  release.resolve(undefined)
  await ended.promise
  expect(ctx.agents.get(child.id)).toBeUndefined()
  expect(ctx.subagents.hasPendingChildren(parent)).toBe(false)
  expect(parent.inbox.nextTurn).toHaveLength(1)
  parent.session.append('turn/start', { turn: 3 })
  parent.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  expect(notices.map(notice => notice.id)).toEqual([fork.id])
  enqueue.mockRestore()
  parent.followup(message('consume result'))
  await parent.whenIdle()
  expect(parent.inbox.nextTurn).toHaveLength(0)
  expect(notices.map(notice => notice.id)).toEqual([fork.id, parent.id])
})

it('uses live job ownership, retains suppression while stopping, and never notifies on settlement alone', async () => {
  const { ctx, parent, notices } = await harness()
  await ctx.plugin(LocalJobs)
  ctx.jobs.attachController('notification-test')
  const done = Promise.withResolvers<JobOutcome>()
  onTestFinished(() => { done.resolve({ status: 'killed' }) })
  const id = ctx.jobs.start({
    owner: parent.id, kind: 'bash', label: 'pending job',
    run: () => ({ cancel: () => {}, done: done.promise }),
  })
  parent.followup(message('wait for job'))
  await parent.whenIdle()
  expect(notices).toEqual([])
  ctx.jobs.kill(id, parent.id)
  expect(ctx.jobs.get(id, parent.id).status).toBe('stopping')
  parent.followup(message('job still stopping'))
  await parent.whenIdle()
  expect(notices).toEqual([])
  const settled = ctx.jobs.wait(id, 10_000, parent.id)
  done.resolve({ status: 'killed' })
  await settled
  expect(notices).toEqual([])
  parent.followup(message('all work finished'))
  await parent.whenIdle()
  expect(notices.map(notice => notice.id)).toEqual([parent.id])
})

it('does not let unowned jobs, foreign jobs, or abandoned historical registrations hold completion', async () => {
  const { ctx, parent, notices } = await harness()
  await ctx.plugin(LocalJobs)
  ctx.jobs.attachController('notification-test')
  const done = Promise.withResolvers<JobOutcome>()
  onTestFinished(() => { done.resolve({ status: 'completed' }) })
  const { agent: other } = await ctx.agents.create({ sessionId: SessionId('other-owner') })
  for (const owner of [undefined, other.id]) {
    ctx.jobs.start({ ...owner === undefined ? {} : { owner }, kind: 'bash', label: 'unrelated',
      run: () => ({ cancel: () => { done.resolve({ status: 'killed' }) }, done: done.promise }),
    })
  }
  parent.session.append('job/registered', {
    jobId: JobId('abandoned-previous-runtime'), owner: parent.id, kind: 'bash', label: 'abandoned', startedAt: 0,
  })
  parent.followup(message())
  await parent.whenIdle()
  expect(notices.map(notice => notice.id)).toEqual([parent.id])
})

it('suppresses unclaimed next-step input and does not convert an aborted turn into completion when it clears', async () => {
  const { parent, notices } = await harness()
  parent.inbox.append('next-step', message('unclaimed steering'))
  parent.session.append('turn/start', { turn: 1 })
  parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(notices).toEqual([])
  parent.session.append('turn/start', { turn: 2 })
  parent.session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  parent.inbox.clear()
  expect(notices).toEqual([])
  parent.followup(message())
  await parent.whenIdle()
  expect(notices.map(notice => notice.id)).toEqual([parent.id])
})
