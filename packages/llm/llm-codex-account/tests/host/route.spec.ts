import { describe, expect, it } from 'vitest'
import { descriptor } from './seams.ts'
import { routeEnableOps, routeFactsOf } from '../../src/host/route.ts'

describe('automatic route enabling', () => {
  it('adds only the absent Codex provider leaf', () => {
    const row = descriptor({ value: { providers: { anthropic: {} } }, revision: 7 })
    expect(routeFactsOf(row)).toEqual({ configured: false, namespaceRevision: 7 })
    expect(routeEnableOps(row)).toEqual([{ op: 'set', path: ['providers', 'openai-codex'], value: {} }])
  })

  it.each(['user', 'base'] as const)('preserves apiKeyEnv and all existing configuration in %s', (layer) => {
    const value = { providers: { 'openai-codex': { apiKeyEnv: 'KEEP_KEY', models: [{ id: 'custom' }], baseURL: 'https://example.com' } } }
    const row = descriptor({ value, [layer]: value })
    const before = structuredClone(row)
    expect(routeEnableOps(row)).toEqual([])
    expect(row).toEqual(before)
    expect(routeFactsOf(row).configured).toBe(true)
  })

  it('does not rewrite an existing native-auth profile', () => {
    expect(routeEnableOps(descriptor({ value: { providers: { 'openai-codex': {} } } }))).toEqual([])
  })

  it('does not replace an existing malformed provider value or parent', () => {
    const leaf = descriptor({ value: { providers: { 'openai-codex': 'preserve' } } })
    const parent = descriptor({ value: { providers: 'preserve' } })
    expect(routeEnableOps(leaf)).toEqual([])
    expect(routeEnableOps(parent)).toEqual([])
    expect(routeFactsOf(leaf).configured).toBe(false)
    expect(routeFactsOf(parent).configured).toBe(false)
  })
})
