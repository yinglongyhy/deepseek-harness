/** Coding-only composition derived from the shipped PTC preset. */
import { Context, Service } from '@deepseek-ai/cordis'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { isJsExpr, type JsExpr } from '@deepseek-ai/cordis-plugin-loader'
import { entryListProblem, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'

/** The bundle supplies the current PTC declaration without a reverse package dependency. */
export interface Config {
  /** Absolute path to the shipped PTC patch, not the user's edited preset. */
  ptcPresetPath: string
}

const patchList = z.array(z.any<PatchOptions>()) as z<unknown, PatchOptions[]>
const ptcConfig = z.object({
  id: z.const('ptc').required(),
  plugins: z.array(z.any<PresetDefinition['plugins'][number]>()).required(),
}) as z<unknown, { plugins: PresetDefinition['plugins'] }>
const personaConfig = z.dict(z.any<unknown>()).required() as z<unknown, Record<string, unknown>>

function appendPolicy(suffix: unknown, policy: string): string | JsExpr {
  if (isJsExpr(suffix)) {
    const separator = JSON.stringify(`\n\n${policy}`)
    return { __jsExpr: `((suffix) => {
      if (typeof suffix !== 'string') throw new TypeError('PTC persona suffix must be text');
      return suffix ? suffix + ${separator} : ${JSON.stringify(policy)};
    })(${suffix.__jsExpr})` }
  }
  if (suffix !== undefined && typeof suffix !== 'string') throw new TypeError('PTC persona suffix must be text')
  return suffix ? `${suffix}\n\n${policy}` : policy
}

/** Register Coding without changing Standard, PTC, Host settings, or the registry's inheritance rules. */
export default class CodingPreset {
  static inject = ['agentPresets']
  static Config: z<Config> = z.object({ ptcPresetPath: z.string().required() })

  constructor(private readonly ctx: Context, private readonly config: Config) {}

  async* [Service.init]() {
    const patches = patchList(load(await readFile(this.config.ptcPresetPath, 'utf8'), {
      schema: entryListSchema,
    }))
    const rows = applyEntryPatches([], patches, (message) => { throw new Error(`PTC preset patch: ${message}`) })
    const declarations = rows.filter((row) => {
      const config: unknown = row.config
      return row.name === '@deepseek-ai/dsh-agent-preset' && typeof config === 'object' && config !== null
        && 'id' in config && config.id === 'ptc'
    })
    const [ptc] = declarations
    if (declarations.length !== 1 || ptc === undefined) throw new Error('Expected exactly one shipped PTC preset declaration')
    const { plugins } = ptcConfig(ptc.config)
    const problem = entryListProblem(plugins)
    if (problem !== undefined) throw new Error(`PTC preset: ${problem}`)
    const personas = plugins.filter(row => row.name === '@deepseek-ai/dsh-persona')
    const [persona] = personas
    if (personas.length !== 1 || persona === undefined) throw new Error('Expected exactly one top-level PTC persona')
    const config = personaConfig(persona.config)
    if (config.complete !== undefined && config.complete !== false) {
      throw new Error('PTC persona must leave complete disabled to accept the Coding policy suffix')
    }
    const policy = await readFile(new URL('../policy.md', import.meta.url), 'utf8')
    const suffix = appendPolicy(config.suffix, policy)
    const ctx = this.ctx.extend({ baseUrl: pathToFileURL(this.config.ptcPresetPath).href })
    yield await ctx.agentPresets.register({
      id: 'coding',
      order: 1.5,
      plugins: plugins.map(row => row === persona ? { ...row, config: { ...config, suffix } } : row),
    })
  }
}
