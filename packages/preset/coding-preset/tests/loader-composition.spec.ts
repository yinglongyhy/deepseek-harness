import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { interpolate, type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import yaml from 'js-yaml'
import CodingPreset from '../src/index.ts'

const POLICY_PATH = new URL('../policy.md', import.meta.url)

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})

const sourcePatch = (personaConfig: string, extraRows = ''): string => [
  '- insert:',
  '    - id: preset-ptc',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: ptc',
  '        order: 2',
  '        plugins:',
  ...personaConfig.split('\n').map(line => `          ${line}`),
  '          - id: tool-existing',
  "            name: '@deepseek-ai/dsh-tool-fs'",
  '            config:',
  '              sampleOverCapGlobResults: false',
  '          - id: platform-tool',
  "            name: '@deepseek-ai/dsh-tool-bash'",
  "            disabled: !!js process.platform === 'win32'",
  '          - id: tool-presentation',
  "            name: '@deepseek-ai/dsh-agent-tool-presentation'",
  '            config:',
  '              mode: ptc',
  ...extraRows.split('\n').filter(Boolean).map(line => `          ${line}`),
  '',
].join('\n')

const compatiblePersona = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    prefix: Preserve this prefix.',
  '    suffix: Preserve this existing suffix.',
  '    style: concise',
].join('\n')

interface Harness {
  ctx: Context
  configPath: string
  sourcePath: string
  sourceBefore: string
}

async function writeConfig(root: string, sourcePath: string): Promise<string> {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: session-projections',
    "  name: '@deepseek-ai/dsh-session-projection'",
    '- id: agent-presets',
    "  name: '@deepseek-ai/dsh-agent-preset-registry'",
    '  config:',
    '    default: standard',
    '- id: coding-preset',
    "  name: '@deepseek-ai/dsh-coding-preset'",
    '  config:',
    `    ptcPresetPath: ${JSON.stringify(sourcePath)}`,
    '',
  ].join('\n'))
  return configPath
}

async function startLoader(root: string, configPath: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session-projection', SessionProjections],
    ['@deepseek-ai/dsh-agent-preset-registry', AgentPresets],
    ['@deepseek-ai/dsh-coding-preset', CodingPreset],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  return ctx
}

async function loadComposition(source: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coding-preset-loader-'))
  roots.push(root)
  const sourcePath = join(root, 'ptc.patch.yml')
  await writeFile(sourcePath, source)
  const configPath = await writeConfig(root, sourcePath)
  const ctx = await startLoader(root, configPath)
  await ctx.loader.await()
  return { ctx, configPath, sourcePath, sourceBefore: await readFile(sourcePath, 'utf8') }
}

function parsedRows(document: string): Record<string, unknown>[] {
  const value: unknown = yaml.load(document, { schema: entryListSchema })
  if (!Array.isArray(value)) throw new Error('Preset document is not an entry list')
  return value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row))
}

async function codingDocument(ctx: Context): Promise<string> {
  return (await ctx.agentPresets.readDocument('coding')).content
}

function pluginFiber(ctx: Context) {
  const fiber = [...(ctx.registry.get(CodingPreset)?.fibers ?? [])][0]
  if (fiber === undefined) throw new Error('Loader did not create the coding preset fiber')
  return fiber
}

describe('coding preset Loader composition', () => {
  it('derives PTC entries and persona from the source without evaluating platform conditions', async () => {
    const { ctx, sourcePath, sourceBefore } = await loadComposition(sourcePatch(compatiblePersona))
    const document = await codingDocument(ctx)
    const rows = parsedRows(document)
    const persona = rows.find(row => row.id === 'persona')
    const personaConfig = persona?.config

    expect(await ctx.agentPresets.list()).toMatchObject([{ id: 'coding', order: 1.5 }])
    expect(ctx.agentPresets.defaultId).toBe('standard')
    expect(rows.map(row => row.id)).toEqual(['persona', 'tool-existing', 'platform-tool', 'tool-presentation'])
    expect(personaConfig).toMatchObject({
      prefix: 'Preserve this prefix.',
      style: 'concise',
    })
    const policy = await readFile(POLICY_PATH, 'utf8')
    expect((personaConfig as Record<string, unknown>).suffix).toBe(`Preserve this existing suffix.\n\n${policy}`)
    expect(rows.find(row => row.id === 'tool-presentation')?.config).toEqual({ mode: 'ptc' })
    expect(document).toContain('disabled: !!js process.platform === \'win32\'')
    expect(await readFile(sourcePath, 'utf8')).toBe(sourceBefore)
  })

  it('reads changed source on a fresh Loader start and clears its registration on unload', async () => {
    const initial = await loadComposition(sourcePatch(compatiblePersona))
    expect(parsedRows(await codingDocument(initial.ctx)).map(row => row.id)).toEqual([
      'persona', 'tool-existing', 'platform-tool', 'tool-presentation',
    ])
    await pluginFiber(initial.ctx).dispose()
    await expect(initial.ctx.agentPresets.readDocument('coding')).rejects.toThrow('Unknown agent preset: coding')

    const updatedPersona = compatiblePersona.replace('Preserve this prefix.', 'Updated prefix.')
      .replace('Preserve this existing suffix.', 'Updated suffix.')
    await writeFile(initial.sourcePath, sourcePatch(updatedPersona, [
      '- id: tool-added-later',
      "  name: '@deepseek-ai/dsh-tool-jobs'",
      '  config:',
      '    prompt: Read this updated source.',
    ].join('\n')))
    const next = await loadComposition(await readFile(initial.sourcePath, 'utf8'))
    const rows = parsedRows(await codingDocument(next.ctx))
    expect(rows.map(row => row.id)).toEqual(['persona', 'tool-existing', 'platform-tool', 'tool-presentation', 'tool-added-later'])
    expect(rows.at(-1)?.config).toEqual({ prompt: 'Read this updated source.' })
    expect(rows[0]?.config).toEqual({
      prefix: 'Updated prefix.',
      suffix: `Updated suffix.\n\n${await readFile(POLICY_PATH, 'utf8')}`,
      style: 'concise',
    })
    expect(await readFile(initial.sourcePath, 'utf8')).not.toBe(initial.sourceBefore)
  })

  it.each([undefined, ''])('uses only the policy for an empty PTC suffix (%s)', async (suffix) => {
    const persona = suffix === undefined
      ? compatiblePersona.replace('    suffix: Preserve this existing suffix.\n', '')
      : compatiblePersona.replace('suffix: Preserve this existing suffix.', "suffix: ''")
    const { ctx } = await loadComposition(sourcePatch(persona))
    expect(parsedRows(await codingDocument(ctx))[0]?.config).toEqual({
      prefix: 'Preserve this prefix.',
      suffix: await readFile(POLICY_PATH, 'utf8'),
      style: 'concise',
    })
  })

  it.each(["'Deferred PTC suffix.'", "''", '42'])('keeps !!js suffix evaluation deferred (%s)', async (expression) => {
    const { ctx } = await loadComposition(sourcePatch(compatiblePersona.replace(
      'suffix: Preserve this existing suffix.', `suffix: !!js ${JSON.stringify(expression)}`,
    )))
    const config = parsedRows(await codingDocument(ctx))[0]?.config as Record<string, unknown>
    expect(typeof config.suffix).toBe('object')
    if (expression === '42') {
      expect(() => { interpolate(ctx, config.suffix) }).toThrow('PTC persona suffix must be text')
    } else {
      const resolved: unknown = interpolate(ctx, config.suffix)
      const policy = await readFile(POLICY_PATH, 'utf8')
      expect(resolved).toBe(expression === "''" ? policy : `Deferred PTC suffix.\n\n${policy}`)
    }
  })

  it('fails without registering Coding when the distribution source file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-coding-preset-missing-'))
    roots.push(root)
    const configPath = await writeConfig(root, join(root, 'missing.patch.yml'))
    const ctx = await startLoader(root, configPath)
    await ctx.loader.await()
    await expect(pluginFiber(ctx).await()).rejects.toThrow('ENOENT')
    expect(await ctx.agentPresets.list()).toEqual([])
  })

  it.each([
    ['Standard source is not accepted as a fallback', sourcePatch(compatiblePersona).replace('id: ptc', 'id: standard'), 'Expected exactly one shipped PTC preset declaration'],
    ['missing PTC source row', '- insert:\n    - id: unrelated\n      name: unused\n', 'Expected exactly one shipped PTC preset declaration'],
    ['duplicate PTC source rows', sourcePatch(compatiblePersona)
      + sourcePatch(compatiblePersona).replace('- id: preset-ptc', '- id: another-ptc'),
    'Expected exactly one shipped PTC preset declaration'],
    ['patch with an unresolved target', '- id: missing-target\n  disabled: true\n', 'PTC preset patch:'],
    ['malformed child plugin row', sourcePatch(compatiblePersona, '- id: malformed-child'), 'names no plugin'],
    ['missing persona', sourcePatch('- id: another\n  name: unused'), 'Expected exactly one top-level PTC persona'],
    ['duplicate persona', sourcePatch(`${compatiblePersona}\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    suffix: duplicate`), 'Expected exactly one top-level PTC persona'],
    ['complete persona that cannot accept a suffix', sourcePatch([
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    prefix: Preserve this prefix.',
      '    suffix: Preserve this existing suffix.',
      '    complete: true',
    ].join('\n')), 'PTC persona must leave complete disabled to accept the Coding policy suffix'],
    ['conditional complete persona', sourcePatch([
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    prefix: Preserve this prefix.',
      '    suffix: Preserve this existing suffix.',
      "    complete: !!js process.platform === 'win32'",
    ].join('\n')), 'PTC persona must leave complete disabled to accept the Coding policy suffix'],
    ['non-literal persona suffix', sourcePatch([
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    prefix: Preserve this prefix.',
      '    suffix:',
      '      - not',
      '      - a string',
    ].join('\n')), 'PTC persona suffix must be text'],
  ])('fails clearly for %s', async (_label, source, error) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-coding-preset-invalid-'))
    roots.push(root)
    const sourcePath = join(root, 'ptc.patch.yml')
    await writeFile(sourcePath, source)
    const configPath = await writeConfig(root, sourcePath)
    const ctx = await startLoader(root, configPath)
    await ctx.loader.await()
    await expect(pluginFiber(ctx).await()).rejects.toThrow(error)
    expect(await ctx.agentPresets.list()).toEqual([])
  })
})
