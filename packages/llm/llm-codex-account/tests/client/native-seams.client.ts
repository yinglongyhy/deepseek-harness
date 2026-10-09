import { vi, type Mocked } from 'vitest'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SettingsSchemaService } from '../../../../client/ui-settings/src/client/schema.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSettingsSchemaOperations } from '../../src/client/native/schema-operations.ts'
import type { CatalogOperations } from '../../src/client/native/operations.ts'
import { zh } from '../../src/client/native/locales.ts'

const CODEX_SCHEMA: JsonValue = JSON.parse(JSON.stringify(Schema.object({
  providers: Schema.dict(Schema.object({
    models: Schema.array(Schema.object({ id: Schema.string() })),
  })),
}))) as JsonValue

export function nativeSchema(ctx = new Context()): ReturnType<typeof createSettingsSchemaOperations> {
  const remote = { $host: { isLoopback: true }, $on: () => () => {}, settings: {
    describe: async () => ({ ok: true, value: { writable: true, hasDocument: false, namespaces: [] } }),
  } }
  if (ctx.get('remote') === undefined) ctx.provide('remote', remote as never)
  return createSettingsSchemaOperations(new SettingsSchemaService(ctx))
}

export function namespaceFixture(models?: JsonValue, baseModels?: JsonValue): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai', schema: CODEX_SCHEMA,
    value: { providers: { 'openai-codex': { apiKeyEnv: 'KEEP_KEY', modelOverrides: { existing: { reasoning: false } } } } },
    user: { providers: { 'openai-codex': models === undefined ? { apiKeyEnv: 'KEEP_KEY' } : { apiKeyEnv: 'KEEP_KEY', models } } },
    base: { providers: { 'openai-codex': baseModels === undefined ? {} : { models: baseModels } } },
    revision: 7, autoGenerate: true, applies: 'live', secrets: [],
  }
}

export function nativeBench(namespace = namespaceFixture(), catalog: readonly LlmDiscoveredModel[] = []): {
  operations: Mocked<CatalogOperations>
  schema: ReturnType<typeof nativeSchema>
  t: (key: keyof typeof zh) => string
} {
  return {
    schema: nativeSchema(), t: key => zh[key],
    operations: {
      read: vi.fn<CatalogOperations['read']>().mockResolvedValue({ namespace, path: ['providers', 'openai-codex'], writable: true }),
      discoverModels: vi.fn<CatalogOperations['discoverModels']>().mockResolvedValue({ kind: 'found', models: catalog }),
      writeSettings: vi.fn<CatalogOperations['writeSettings']>().mockResolvedValue({ kind: 'written', view: { ...namespace, revision: namespace.revision + 1 } }),
    },
  }
}
