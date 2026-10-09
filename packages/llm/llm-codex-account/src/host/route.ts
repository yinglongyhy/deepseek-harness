/** @module @deepseek-ai/dsh-llm-codex-account/host/route */

import type { SettingsDescriptor, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { CODEX_OAUTH_PROVIDER_PATH } from '../shared/index.ts'

/** Read whether the Codex route exists and the settings revision it belongs to.
 * @param descriptor - current settings namespace value.
 * @returns route presence and namespace revision.
 */
export function routeFactsOf(descriptor: SettingsDescriptor): {
  configured: boolean
  namespaceRevision: number
} {
  return { configured: profileAt(descriptor.value) !== undefined, namespaceRevision: descriptor.revision }
}

/** Add an empty provider profile only when every existing parent is an object and the path is absent.
 * @param descriptor - current settings namespace value.
 * @returns one set operation for an absent route, or no operations when the path exists or is malformed.
 */
export function routeEnableOps(descriptor: SettingsDescriptor): SettingsPathOp[] {
  let node: unknown = descriptor.value
  for (const key of CODEX_OAUTH_PROVIDER_PATH) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return []
    if (!Object.hasOwn(node, key)) {
      return [{ op: 'set', path: [...CODEX_OAUTH_PROVIDER_PATH], value: {} }]
    }
    node = (node as Record<string, unknown>)[key]
  }
  return []
}

function profileAt(layer: unknown): object | undefined {
  let node = layer
  for (const key of CODEX_OAUTH_PROVIDER_PATH) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return typeof node === 'object' && node !== null && !Array.isArray(node) ? node : undefined
}
