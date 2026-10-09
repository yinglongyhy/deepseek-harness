/** Native settings and model-discovery operations for the Codex catalog editor. */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmConfigurableProvider, LlmDiscoveredModel, LlmModelDiscoveryRequest, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { CODEX_PROVIDER_ID, CODEX_OAUTH_SETTINGS_NAMESPACE } from '../../shared/index.ts'

/** Model discovery operations used by the editor. */
export interface ModelsOperations {
  /**
   * @param settingsNs - the provider's discovery settings namespace.
   * @param request - the provider discovery request.
   * @returns The discovered models or the refusal diagnostic.
   */
  discoverModels(this: void, settingsNs: string, request: LlmModelDiscoveryRequest): Promise<
    | { kind: 'found'; models: readonly LlmDiscoveredModel[] }
    | { kind: 'refused'; message: string }
  >
}

type CatalogContext = {
  remote: {
    llm: Pick<Context['remote']['llm'], 'listConfigurableProviders' | 'discoverModels'>
    settings: Pick<Context['remote']['settings'], 'describe' | 'mutate'>
  }
}

/** Settings and discovery operations consumed by the catalog editor. */
export interface CatalogOperations {
  /** @returns The namespace, provider settings path, and write permission. */
  read(this: void): Promise<{ namespace: SettingsNamespaceView; path: readonly string[]; writable: boolean }>
  /**
   * @param settingsNs - the provider's discovery settings namespace.
   * @param request - the provider discovery request.
   * @returns The discovered models or the refusal diagnostic.
   */
  discoverModels(this: void, settingsNs: string, request: LlmModelDiscoveryRequest): ReturnType<ModelsOperations['discoverModels']>
  /**
   * @param ns - the namespace to mutate.
   * @param ops - the settings update operations.
   * @param revision - the revision the editor read.
   * @returns The updated view or a conflict/refusal diagnostic.
   */
  writeSettings: (ns: string, ops: Parameters<Context['remote']['settings']['mutate']>[1], revision: number) => Promise<
    | { kind: 'written'; view: SettingsNamespaceView }
    | { kind: 'conflict' | 'refused'; message: string }
  >
}

/** A refusal while reading the provider or settings catalog. */
export class CatalogReadFailure extends Error {
  /** @param diagnostic - the source error for logging or diagnostics. */
  constructor(readonly diagnostic: string) { super('catalog-read-refused') }
}

/**
 * Create settings and discovery operations for the Codex model catalog.
 * @param ctx - the injected provider and settings remotes.
 * @returns The catalog operations consumed by the editor.
 */
export function createCatalogOperations(ctx: CatalogContext): CatalogOperations {
  return {
    read: async () => {
      const providers = await ctx.remote.llm.listConfigurableProviders()
      if (!providers.ok) throw new CatalogReadFailure(providers.error.message)
      const provider = providers.value.find((row: LlmConfigurableProvider) => row.provider === CODEX_PROVIDER_ID)
      const ns = provider?.settingsNs ?? CODEX_OAUTH_SETTINGS_NAMESPACE
      const response = await ctx.remote.settings.describe()
      if (!response.ok) throw new CatalogReadFailure(response.error.message)
      const namespace = response.value.namespaces.find((row: SettingsNamespaceView) => row.ns === ns)
      if (namespace === undefined) throw new Error('The Codex settings namespace is unavailable.')
      return { namespace, path: provider?.settingsPath ?? ['providers', CODEX_PROVIDER_ID], writable: response.value.writable }
    },
    writeSettings: async (ns, ops, expectedRevision) => {
      const response = await ctx.remote.settings.mutate(ns, ops, expectedRevision)
      if (response.ok) return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
    },
    discoverModels: async (settingsNs, request) => {
      const response = await ctx.remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
  }
}
