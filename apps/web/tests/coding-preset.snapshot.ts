import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { assertFixtureInventory, fixtureUserPrompts, launchWebScaffold } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/coding-preset', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/coding-preset/session.v4.jsonl', import.meta.url))
const PROMPT_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/coding-preset/system-prompt.expected.md', import.meta.url))
const CODING_POLICY = fileURLToPath(new URL('../../../packages/preset/coding-preset/policy.md', import.meta.url))

/** The text sent as the system message in the persisted Session. */
function systemPromptText(session: Session): string | undefined {
  const message = session.deriveMessages().find(candidate => candidate.role === 'system')
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

async function codingPolicy(): Promise<string> {
  return (await readFile(CODING_POLICY, 'utf8')).trimEnd()
}

describe('coding agent preset snapshot', () => {

  it('replays the full coding policy while retaining standard as the default', async () => {
    const scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: true, paceMs: 10 })
    let agentHandle: AgentHandle | undefined
    try {
      expect(scaffold.ctx.agentPresets.defaultId).toBe('standard')
      const [prompt] = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
      if (prompt === undefined) throw new Error('coding preset fixture has no user task')
      agentHandle = await scaffold.ctx.agents.create({
        sessionId: SessionId('coding-preset-snapshot'),
        meta: { cwd: scaffold.workspaceCwd, agentPreset: 'coding' },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'coding').then(() => undefined),
      })
      agentHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      await agentHandle.agent.whenIdle()

      expect(agentHandle.agent.session.header.agentPreset).toBe('coding')
      expect(scaffold.ctx.agentPresets.composedPreset(agentHandle.agent.ctx)).toBe('coding')
      const requestHeader = agentHandle.agent.session.requestHeader()
      if (requestHeader === undefined) throw new Error('the coding agent issued no model request')
      const promptText = systemPromptText(agentHandle.agent.session)
      if (promptText === undefined) throw new Error('the coding agent issued no system prompt')
      expect(promptText.trimEnd().endsWith(await codingPolicy())).toBe(true)
      expect(requestHeader.tools?.map(tool => tool.name)).toEqual(['run_code'])
      expect(promptText).toContain('Program-only SDK bindings:')
      expect(promptText).toContain('subagent: {')
      expect(scaffold.ctx.tools.schemas(agentHandle.agent).map(tool => tool.name)).toContain('subagent')
    } finally {
      await agentHandle?.dispose()
      await scaffold.close()
    }
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v4.jsonl',
      'system-prompt.expected.md',
      'tool-schemas.expected.json',
    ])
    const promptSidecar = await readFile(PROMPT_EXPECTED, 'utf8').then(text => text.trimEnd())
    expect(promptSidecar.endsWith(await codingPolicy())).toBe(true)
  })
})
