/**
 * Browser face of the Codex OAuth bundle.
 *
 * The client half owns a Settings page and a conversation composer footer. It
 * registers through `slots.inject`, so the entry follows the shell's
 * declaration, and every registration is an effect that a plugin unload
 * unwinds.
 *
 * React and UI primitives use the Client module table; other DSH packages
 * are type-only imports.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { CodexOAuthCard } from './card.ts'
import { CodexOAuthChannel } from './channel.ts'
import { CODEX_OAUTH_LOCALE_NAMESPACE, en, zh } from './locales.ts'
import { openAuthorizationInBrowser } from './open.ts'
import { CodexOAuthSection, type CodexOAuthSectionInjected } from './view.ts'
import { createCatalogOperations } from './native/operations.ts'
import { createSettingsSchemaOperations } from './native/schema-operations.ts'
import { en as catalogEn, zh as catalogZh, type ModelsKey } from './native/locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ProviderInfoChannel, ProviderInfoRevision, createProviderInfoFooter, type ProviderInfoInjected } from './provider-info.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'codex-model-catalog': ModelsKey
  }
}

/** Services this half reads: the RPC transport, the slot registry, and the dictionaries. */
export const inject: string[] = ['connection', 'slots', 'locale', 'remote', 'remote.llm', 'remote.settings', 'settingsSchema']

/**
 * Client plugin body.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(
    () => ctx.locale.register(CODEX_OAUTH_LOCALE_NAMESPACE, { zh, en }),
    'dsh-llm-codex-account: dictionaries',
  )
  ctx.effect(() => ctx.locale.register('codex-model-catalog', { en: catalogEn, zh: catalogZh }), 'dsh-llm-codex-account: catalog dictionaries')
  const catalogOperations = createCatalogOperations(ctx)
  const schema = createSettingsSchemaOperations(ctx.settingsSchema)
  const catalogT = ctx.locale.bind('codex-model-catalog')
  const endpoint = new CodexOAuthChannel(connection.rpc)
  const infoRevision = new ProviderInfoRevision()
  const infoFooter = createProviderInfoFooter(new ProviderInfoChannel(connection.rpc))
  const locale = {
    getSnapshot: () => ctx.locale.getLocale(),
    subscribe: (listener: () => void) => ctx.locale.subscribe(listener),
  }
  ctx.inject(['modelDirectories'], (scope) => {
    scope.effect(() => scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
      name: 'conversation.composer.dock', id: 'provider-info', order: 2, locale: CODEX_OAUTH_LOCALE_NAMESPACE,
      inject: (sessionId): ProviderInfoInjected => ({ hooks: {
        directory: scope.modelDirectories.directoryFor(sessionId).store,
        revision: infoRevision,
        locale,
      } }),
    }, infoFooter)), 'dsh-llm-codex-account: provider footer')
  })
  ctx.effect(() => {
    const invalidate = infoRevision.invalidate
    const disposers = [ctx.on('connection/reset', invalidate),
      ...(['settings/document-updated', 'llm/adapters-updated', 'credentials/record-updated', 'credentials/reference-updated'] as const)
        .map(event => ctx.remote.$on(event, invalidate)),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-llm-codex-account: provider information invalidation')
  // Registration-time nav text (the label thunk) and the injected `t` seat
  // share one bound translate, so the entry shows its locale without ever
  // re-registering.
  const t = ctx.locale.bind(CODEX_OAUTH_LOCALE_NAMESPACE)
  /** The controller of the currently declared section, if the shell's slot is on the ledger. */
  let section: CodexOAuthCard | undefined
  ctx.effect(() => ctx.slots.inject('settings.section', () => {
    const created = new CodexOAuthCard({ endpoint, open: openAuthorizationInBrowser })
    section = created
    const injected: CodexOAuthSectionInjected = {
      hooks: { card: created },
      attach: () => { created.attach() },
      detach: () => { created.detach() },
      actions: {
        loadStatus: created.loadStatus,
        startLogin: created.startLogin,
        cancelLogin: created.cancelLogin,
        reopenAuthorization: created.reopenAuthorization,
        retryRouteWrite: created.retryRouteWrite,
        requestLogout: created.requestLogout,
        dismissLogout: created.dismissLogout,
        confirmLogout: created.confirmLogout,
      },
      catalog: {
        schema, t: catalogT,
        operations: { ...catalogOperations,
          writeSettings: (ns, ops, revision) => created.writeCatalog(() => catalogOperations.writeSettings(ns, ops, revision)),
        },
      },
    }
    const unregister = ctx.slots.register({
      name: 'settings.section',
      id: 'codex-account',
      order: 11,
      label: () => t('nav'),
      locale: CODEX_OAUTH_LOCALE_NAMESPACE,
      inject: (): CodexOAuthSectionInjected => injected,
    }, CodexOAuthSection)
    return () => {
      unregister()
      created.dispose()
      if (section === created) section = undefined
    }
  }), 'dsh-llm-codex-account: settings section')
  ctx.effect(() => {
    const refresh = (): void => { section?.loadStatus() }
    const disposers = [
      ctx.remote.$on('settings/document-updated', refresh),
      ctx.remote.$on('llm/adapters-updated', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-llm-codex-account: catalog invalidations')
  // A re-established connection may reach a restarted Host: the attempt identity
  // of the previous one is useless, so the section drops it and rereads the facts.
  ctx.effect(() => ctx.on('connection/reset', () => { section?.reconnect() }), 'dsh-llm-codex-account: connection resets')
}
