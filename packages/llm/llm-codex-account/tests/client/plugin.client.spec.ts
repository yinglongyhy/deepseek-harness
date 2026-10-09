// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CODEX_OAUTH_SETTINGS_NAMESPACE, CODEX_PROVIDER_ID } from '../../src/shared/index.ts'
import { apply, inject } from '../../src/client/index.ts'
import { CODEX_OAUTH_LOCALE_NAMESPACE, en, zh } from '../../src/client/locales.ts'
import type { ProviderInfoInjected } from '../../src/client/provider-info.tsx'
import { clientBench } from './seams.client.ts'

describe('codex oauth client plugin', () => {
  it('declares the three services its card reads', () => {
    expect(inject).toEqual(['connection', 'slots', 'locale', 'remote', 'remote.llm', 'remote.settings', 'settingsSchema'])
  })

  it('registers its dictionaries and one settings section entry under its own namespace', () => {
    const bench = clientBench()
    apply(bench.ctx)
    expect(bench.locale.registered.map(entry => entry.ns)).toEqual([CODEX_OAUTH_LOCALE_NAMESPACE, 'codex-model-catalog'])
    expect(bench.locale.registered[0]?.dicts).toEqual({ zh, en })
    expect(bench.slots.injected).toEqual(['settings.section'])
    expect(bench.slots.registrations.map(entry => entry.options)).toHaveLength(1)
    const options = bench.slots.registrations[0]!.options
    expect(options).toMatchObject({
      name: 'settings.section', id: 'codex-account', order: 11, locale: CODEX_OAUTH_LOCALE_NAMESPACE,
    })
    expect(typeof options.label).toBe('function')
    expect(typeof options.inject).toBe('function')
    expect(CODEX_OAUTH_SETTINGS_NAMESPACE).toBe('llm-pi-ai')
    expect(bench.slots.component).toBeTypeOf('function')
  })

  it('labels its nav entry from its own dictionary, following the locale without re-registering', () => {
    const bench = clientBench()
    apply(bench.ctx)
    const label = bench.slots.registrations[0]?.options.label
    expect(typeof label).toBe('function')
    expect((label as () => string)()).toBe('Codex 登录')
    bench.locale.active = 'en'
    expect((label as () => string)()).toBe('Codex sign-in')
    expect(bench.slots.registrations).toHaveLength(1)
  })

  it('registers nothing into the Models page seats', () => {
    const bench = clientBench()
    apply(bench.ctx)
    expect(bench.slots.injected).not.toContain('settings.models.provider-card')
    expect(bench.slots.injected).not.toContain('settings.models.sign-in')
    expect(bench.slots.registrations).toHaveLength(1)
  })

  it('withdraws the entry and the dictionaries when the plugin unloads', async () => {
    const bench = clientBench()
    const fiber = bench.ctx.plugin({ inject, apply })
    await fiber.await()
    expect(bench.slots.registrations).toHaveLength(1)
    expect(bench.locale.registered).toHaveLength(2)
    await fiber.dispose()
    expect(bench.slots.registrations).toEqual([])
    expect(bench.locale.registered).toEqual([])
  })

  it('is idempotent per load: one entry, whatever the section renders', async () => {
    const bench = clientBench()
    const fiber = bench.ctx.plugin({ inject, apply })
    await fiber.await()
    expect(bench.slots.registrations).toHaveLength(1)
    expect(bench.slots.registrations[0]?.component).toBe(bench.slots.component)
    await fiber.dispose()
  })

  it('registers an independent footer over the shared model directory when the service is available', async () => {
    const bench = clientBench()
    const directory = { getSnapshot: () => ({ current: null }), subscribe: () => () => {} }
    const directoryFor = () => ({ store: directory })
    bench.ctx.provide('modelDirectories', { directoryFor } as never)
    const fiber = bench.ctx.plugin({ inject, apply })
    await fiber.await()
    const entry = bench.slots.registrations.find(row => row.options.name === 'conversation.composer.dock')
    expect(entry?.options).toMatchObject({ id: 'provider-info', order: 2, locale: CODEX_OAUTH_LOCALE_NAMESPACE })
    const injected = entry?.options.inject?.('session' as never) as ProviderInfoInjected
    expect(injected.hooks.directory).toBe(directory)
    expect(bench.slots.registrations).toHaveLength(2)
    await fiber.dispose()
    expect(bench.slots.registrations).toEqual([])
  })

  it('names the provider it serves as the only one it recognizes', () => {
    expect(CODEX_PROVIDER_ID).toBe('openai-codex')
  })
})
