// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import { Catalog, type CatalogProps } from '../../src/client/native/Catalog.tsx'
import { CatalogReadFailure, createCatalogOperations } from '../../src/client/native/operations.ts'
import { en } from '../../src/client/native/locales.ts'
import { formatCapacity, parseCapacity, validateDeepSeekModels } from '../../src/client/native/model-draft.ts'
import { nativeBench, namespaceFixture } from './native-seams.client.ts'
import { deferred } from './seams.client.ts'

const models: LlmDiscoveredModel[] = [
  { id: 'one', name: 'First', contextWindow: 256000, maxTokens: 64000, inputModalities: ['text', 'image'] },
  { id: 'two', name: 'Second' },
]

function mount(bench = nativeBench(), changes: Partial<CatalogProps> = {}) {
  const props: CatalogProps = { ...bench, reloadToken: 7, disabled: false, onSaved: vi.fn(), ...changes }
  return { ...bench, props, ...render(createElement(Catalog, props)) }
}

async function ready(): Promise<void> { await screen.findByRole('button', { name: '添加模型' }) }
function click(name: string): void { fireEvent.click(screen.getByRole('button', { name })) }
function edit(name: string, value: string): void { fireEvent.change(screen.getByLabelText(name), { target: { value } }) }

async function saved(app: ReturnType<typeof mount>): Promise<Parameters<typeof app.operations.writeSettings>[1]> {
  click('保存')
  await waitFor(() => { expect(app.operations.writeSettings).toHaveBeenCalledTimes(1) })
  return app.operations.writeSettings.mock.calls[0]![1]
}

afterEach(cleanup)

describe('native model directory', () => {
  it('automatically shows available defaults without writing configuration', async () => {
    const app = mount(nativeBench(namespaceFixture(), models))
    await ready()
    expect(await screen.findByLabelText('模型 ID 1')).toHaveProperty('value', 'one')
    expect(screen.getByLabelText('模型 ID 2')).toHaveProperty('value', 'two')
    expect(screen.queryByRole('button', { name: '获取可用模型' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(app.operations.discoverModels).toHaveBeenCalledWith('llm-pi-ai', { provider: 'openai-codex' })
    await waitFor(() => { expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false) })
    click('保存')
    await waitFor(() => { expect(app.props.onSaved).toHaveBeenCalledTimes(1) })
    expect(app.operations.writeSettings).not.toHaveBeenCalled()
  })

  it('keeps customized rows instead of appending discovered defaults', async () => {
    const app = mount(nativeBench(namespaceFixture([{ id: 'one', name: 'Tuned', contextWindow: 12345, future: { retained: true } }]), models))
    await ready()
    expect(screen.queryByLabelText('模型 ID 2')).toBeNull()
    edit('显示名称 1', 'Edited')
    expect(await saved(app)).toEqual([{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: [{ id: 'one', name: 'Edited', contextWindow: 12345, future: { retained: true } }] }])
  })

  it('edits manual rows, K/M capacities and input types while retaining hidden fields', async () => {
    const hidden = { reasoning: true, cost: { input: 1, output: 2 }, headers: { example: 'retained' } }
    const app = mount(nativeBench(namespaceFixture([{ id: 'custom', ...hidden }]), models))
    await ready()
    click('模型选项 1')
    await waitFor(() => { expect(screen.getByRole('checkbox', { name: '图片' })).toHaveProperty('disabled', false) })
    edit('显示名称 1', 'Custom name')
    edit('上下文窗口 1', '2.3M')
    edit('最大输出 token 数 1', '64K')
    fireEvent.click(screen.getByRole('checkbox', { name: '图片' }))
    const ops = await saved(app)
    expect(ops).toEqual([{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: [{ id: 'custom', ...hidden, name: 'Custom name', contextWindow: 2300000, maxTokens: 64000, input: ['text', 'image'] }] }])
    expect(app.operations.writeSettings.mock.calls[0]?.[2]).toBe(7)
  })

  it('materializes available default metadata only after an edit and Save', async () => {
    const app = mount(nativeBench(namespaceFixture(), [models[0]!]))
    expect(await screen.findByLabelText('模型 ID 1')).toHaveProperty('value', 'one')
    edit('显示名称 1', 'Edited')
    expect(app.operations.writeSettings).not.toHaveBeenCalled()
    expect(await saved(app)).toEqual([{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: [{ id: 'one', name: 'Edited', contextWindow: 256000, maxTokens: 64000, input: ['text', 'image'] }] }])
  })

  it('preserves an explicitly empty catalog and restores available defaults on reset', async () => {
    const app = mount(nativeBench(namespaceFixture([]), models))
    await ready()
    expect(screen.queryByLabelText('模型 ID 1')).toBeNull()
    click('恢复默认模型')
    expect(await screen.findByLabelText('模型 ID 1')).toHaveProperty('value', 'one')
    expect(await saved(app)).toEqual([{ op: 'unset', path: ['providers', 'openai-codex', 'models'] }])
  })

  it('restores inheritance by unsetting only models', async () => {
    const app = mount(nativeBench(namespaceFixture([{ id: 'custom' }], [{ id: 'inherited', reasoning: true }])))
    await ready()
    click('恢复默认模型')
    expect(screen.getByLabelText('模型 ID 1')).toHaveProperty('value', 'inherited')
    expect(await saved(app)).toEqual([{ op: 'unset', path: ['providers', 'openai-codex', 'models'] }])
  })

  it('materializes edited inherited rows without dropping their hidden configuration', async () => {
    const app = mount(nativeBench(namespaceFixture(undefined, [{ id: 'inherited', reasoning: true }])))
    await ready()
    expect(screen.queryByRole('button', { name: '恢复默认模型' })).toBeNull()
    edit('显示名称 1', 'New label')
    expect(await saved(app)).toEqual([{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: [{ id: 'inherited', reasoning: true, name: 'New label' }] }])
  })

  it('keeps empty catalogs valid and permits arbitrary manually entered IDs', async () => {
    const app = mount(nativeBench(namespaceFixture([{ id: 'custom' }])))
    await ready()
    click('删除模型 1')
    expect(await saved(app)).toEqual([{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: [] }])
    await waitFor(() => { expect(screen.getByRole('button', { name: '添加模型' })).toHaveProperty('disabled', false) })
    click('添加模型')
    edit('模型 ID 1', 'not-in-discovery')
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false)
  })

  it('blocks invalid and duplicate rows, keeping every invalid capacity buffer visible', async () => {
    const app = mount()
    await ready()
    click('添加模型')
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
    edit('模型 ID 1', 'one')
    click('添加模型')
    edit('模型 ID 2', ' one ')
    expect(screen.getByRole('alert').textContent).toContain('不能重复')
    edit('模型 ID 2', 'two')
    click('模型选项 1')
    click('模型选项 2')
    edit('上下文窗口 1', 'bad')
    edit('最大输出 token 数 2', 'also bad')
    expect(screen.getByLabelText('上下文窗口 1')).toHaveProperty('value', 'bad')
    expect(screen.getByLabelText('最大输出 token 数 2')).toHaveProperty('value', 'also bad')
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
    expect(app.operations.writeSettings).not.toHaveBeenCalled()
  })

  it.each(['conflict', 'refused'] as const)('retains the draft on a %s response', async (kind) => {
    const app = mount()
    app.operations.writeSettings.mockResolvedValue({ kind, message: 'Write refused' })
    await ready()
    click('添加模型')
    edit('模型 ID 1', 'custom')
    await saved(app)
    await screen.findByRole('alert')
    expect(screen.getByLabelText('模型 ID 1')).toHaveProperty('value', 'custom')
    expect(app.props.onSaved).not.toHaveBeenCalled()
  })

  it('never writes when read-only, during automatic activation or during discovery', async () => {
    const bench = nativeBench()
    bench.operations.read.mockResolvedValue({ namespace: namespaceFixture(), path: ['providers', 'openai-codex'], writable: false })
    const app = mount(bench)
    await ready()
    expect(screen.getByRole('button', { name: '添加模型' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
    app.unmount()
    const writable = mount(nativeBench(), { disabled: true })
    await ready()
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
    writable.unmount()
    const pending = deferred<Awaited<ReturnType<typeof bench.operations.discoverModels>>>()
    const loadingBench = nativeBench()
    loadingBench.operations.discoverModels.mockReturnValue(pending.promise)
    const loading = mount(loadingBench)
    await ready()
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
    pending.resolve({ kind: 'found', models: [] })
    await waitFor(() => { expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false) })
    expect(loading.operations.writeSettings).not.toHaveBeenCalled()
  })

  it('retries a failed read and reports a failed discovery without blocking manual edits', async () => {
    const bench = nativeBench()
    bench.operations.read.mockRejectedValueOnce(new Error('internal details'))
    bench.operations.discoverModels.mockRejectedValue(new Error('internal details'))
    mount(bench)
    expect((await screen.findByRole('alert')).textContent).toBe('无法加载模型目录。')
    click('重试')
    await ready()
    await screen.findByText('无法获取可用模型。')
    await waitFor(() => { expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false) })
    click('添加模型')
    edit('模型 ID 1', 'manual')
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false)
  })

  it('reports a refused catalog without blocking manual edits', async () => {
    const bench = nativeBench()
    bench.operations.discoverModels.mockResolvedValue({ kind: 'refused', message: 'Catalog unavailable' })
    mount(bench)
    expect((await screen.findByRole('alert')).textContent).toBe('无法获取可用模型。Catalog unavailable')
    click('添加模型')
    edit('模型 ID 1', 'manual')
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false)
  })

  it.each(['load', 'catalog', 'save'] as const)('localizes an existing %s failure without repeating operations', async (failure) => {
    const bench = nativeBench()
    if (failure === 'load') bench.operations.read.mockRejectedValue(new CatalogReadFailure('Read refused'))
    if (failure === 'catalog') bench.operations.discoverModels.mockResolvedValue({ kind: 'refused', message: 'Catalog unavailable' })
    if (failure === 'save') bench.operations.writeSettings.mockResolvedValue({ kind: 'refused', message: 'Write refused' })
    const app = mount(bench)
    if (failure === 'save') {
      await ready(); click('添加模型'); edit('模型 ID 1', 'manual'); click('保存')
    }
    await screen.findByRole('alert')
    const callCounts = (): number[] => [
      bench.operations.read.mock.calls.length,
      bench.operations.discoverModels.mock.calls.length,
      bench.operations.writeSettings.mock.calls.length,
    ]
    const counts = callCounts()
    app.rerender(createElement(Catalog, { ...app.props, t: key => en[key] }))
    const text = screen.getByRole('alert').textContent
    expect(text).toContain(en[failure === 'load' ? 'loadFailed' : failure === 'catalog' ? 'fetchFailed' : 'saveFailed'])
    expect(text).toContain(failure === 'load' ? 'Read refused' : failure === 'catalog' ? 'Catalog unavailable' : 'Write refused')
    expect(callCounts()).toEqual(counts)
  })

  it('does not replace customized edits with a late default catalog response', async () => {
    const bench = nativeBench(namespaceFixture([{ id: 'custom' }]))
    const pending = deferred<Awaited<ReturnType<typeof bench.operations.discoverModels>>>()
    bench.operations.discoverModels.mockReturnValue(pending.promise)
    mount(bench)
    await ready()
    edit('模型 ID 1', 'draft')
    pending.resolve({ kind: 'found', models })
    await waitFor(() => { expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false) })
    expect(screen.getByLabelText('模型 ID 1')).toHaveProperty('value', 'draft')
    expect(screen.queryByLabelText('模型 ID 2')).toBeNull()
  })

  it('preserves dirty drafts across status revisions, then rereads when edits are discarded', async () => {
    const app = mount(nativeBench(namespaceFixture([{ id: 'original' }])))
    await ready()
    edit('模型 ID 1', 'draft')
    app.operations.read.mockResolvedValue({ namespace: { ...namespaceFixture([{ id: 'external' }]), revision: 8 }, path: ['providers', 'openai-codex'], writable: true })
    app.rerender(createElement(Catalog, { ...app.props, reloadToken: 8 }))
    expect(screen.getByLabelText('模型 ID 1')).toHaveProperty('value', 'draft')
    click('取消')
    await waitFor(() => { expect(screen.getByLabelText('模型 ID 1')).toHaveProperty('value', 'external') })
  })

  it.each(['1M', 'bad'])('discards capacity buffers (%s) even when rereading the same revision', async (text) => {
    const original = [{ id: 'custom', contextWindow: 256000, maxTokens: 64000 }]
    const app = mount(nativeBench(namespaceFixture(original)))
    await ready()
    click('模型选项 1')
    edit('上下文窗口 1', text)
    edit('最大输出 token 数 1', '128000')
    expect(screen.getByLabelText('上下文窗口 1')).toHaveProperty('value', text)
    expect(screen.getByLabelText('最大输出 token 数 1')).toHaveProperty('value', '128000')
    click('取消')
    await waitFor(() => { expect(app.operations.read).toHaveBeenCalledTimes(2) })
    expect(screen.getByLabelText('上下文窗口 1')).toHaveProperty('value', '256K')
    expect(screen.getByLabelText('最大输出 token 数 1')).toHaveProperty('value', '64K')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true)
    expect(app.operations.discoverModels).toHaveBeenCalledTimes(1)
    edit('显示名称 1', 'After discard')
    expect(await saved(app)).toEqual([{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: [{ ...original[0], name: 'After discard' }] }])
    await waitFor(() => { expect(app.props.onSaved).toHaveBeenCalledTimes(1) })
    edit('最大输出 token 数 1', '128000')
    expect(screen.getByLabelText('上下文窗口 1')).toHaveProperty('value', '256K')
    edit('显示名称 1', 'New capacity')
    expect(screen.getByLabelText('最大输出 token 数 1')).toHaveProperty('value', '128000')
    click('保存')
    await waitFor(() => { expect(app.operations.writeSettings).toHaveBeenCalledTimes(2) })
    expect(app.operations.writeSettings.mock.calls[1]?.[1]).toEqual([{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: [{ ...original[0], name: 'New capacity', maxTokens: 128000 }] }])
  })

  it.each(['inherited', 'discovered'] as const)('clears capacity buffers when restoring %s defaults', async (source) => {
    const defaults = [{ id: 'default', contextWindow: 256000, maxTokens: 64000 }]
    const namespace = namespaceFixture([{ id: 'custom', contextWindow: 512000, maxTokens: 128000 }], source === 'inherited' ? defaults : undefined)
    const app = mount(nativeBench(namespace, source === 'discovered' ? defaults : []))
    await ready()
    await waitFor(() => { expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false) })
    click('模型选项 1')
    edit('上下文窗口 1', 'bad')
    edit('最大输出 token 数 1', '2M')
    click('恢复默认模型')
    expect(screen.getByLabelText('模型 ID 1')).toHaveProperty('value', 'default')
    expect(screen.getByLabelText('上下文窗口 1')).toHaveProperty('value', '256K')
    expect(screen.getByLabelText('最大输出 token 数 1')).toHaveProperty('value', '64K')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(app.operations.discoverModels).toHaveBeenCalledTimes(1)
    edit('显示名称 1', 'Edited default')
    expect(await saved(app)).toEqual([{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: [{ ...defaults[0], name: 'Edited default' }] }])
  })

  it('does not replace a newly dirty draft with an older in-flight refresh', async () => {
    const app = mount(nativeBench(namespaceFixture([{ id: 'original' }])))
    await ready()
    const refreshing = deferred<Awaited<ReturnType<typeof app.operations.read>>>()
    app.operations.read.mockReturnValue(refreshing.promise)
    app.rerender(createElement(Catalog, { ...app.props, reloadToken: 8 }))
    edit('模型 ID 1', 'draft')
    refreshing.resolve({ namespace: { ...namespaceFixture([{ id: 'external' }]), revision: 8 }, path: ['providers', 'openai-codex'], writable: true })
    await waitFor(() => { expect(app.operations.read).toHaveBeenCalledTimes(2) })
    await Promise.resolve()
    expect(screen.getByLabelText('模型 ID 1')).toHaveProperty('value', 'draft')
  })

  it('ignores a read or write that settles after unmount', async () => {
    const bench = nativeBench()
    const reading = deferred<Awaited<ReturnType<typeof bench.operations.read>>>()
    bench.operations.read.mockReturnValue(reading.promise)
    const app = mount(bench)
    app.unmount()
    reading.resolve({ namespace: namespaceFixture(), path: ['providers', 'openai-codex'], writable: true })
    const writing = mount()
    await ready()
    click('添加模型')
    edit('模型 ID 1', 'custom')
    const pending = deferred<Awaited<ReturnType<typeof bench.operations.writeSettings>>>()
    writing.operations.writeSettings.mockReturnValue(pending.promise)
    click('保存')
    writing.unmount()
    pending.resolve({ kind: 'written', view: { ...namespaceFixture(), revision: 8 } })
    await Promise.resolve()
    expect(writing.props.onSaved).not.toHaveBeenCalled()
  })
})

describe('official native Remote operations', () => {
  it.each(['llm', 'settings'])('marks only explicit %s Remote refusals as displayable diagnostics', async (owner) => {
    const refusal = { ok: false, error: { code: 'unavailable', message: 'Remote refused' } }
    const llm = {
      listConfigurableProviders: vi.fn().mockResolvedValue(owner === 'llm' ? refusal : { ok: true, value: [] }),
      discoverModels: vi.fn().mockResolvedValue({ ok: true, value: models }),
    }
    const settings = {
      describe: vi.fn().mockResolvedValue(refusal),
      mutate: vi.fn().mockResolvedValue({ ok: true, value: namespaceFixture() }),
    }
    const operations = createCatalogOperations({ remote: { llm, settings } })
    const rejected = operations.read()
    await expect(rejected).rejects.toBeInstanceOf(CatalogReadFailure)
    await expect(rejected).rejects.toMatchObject({ message: 'catalog-read-refused', diagnostic: 'Remote refused' })
  })

  it('uses the provider directory namespace/path and preserves the native revision fence', async () => {
    const namespace = { ...namespaceFixture(), ns: 'custom-settings' }
    const llm = { listConfigurableProviders: vi.fn().mockResolvedValue({ ok: true, value: [{ provider: 'openai-codex', settingsNs: namespace.ns, settingsPath: ['routes', 'codex'] }] }), discoverModels: vi.fn().mockResolvedValue({ ok: true, value: models }) }
    const settings = { describe: vi.fn().mockResolvedValue({ ok: true, value: { writable: true, namespaces: [namespace] } }), mutate: vi.fn().mockResolvedValue({ ok: false, error: { code: 'settings/conflict', message: 'Conflict' } }) }
    const operations = createCatalogOperations({ remote: { llm, settings } })
    expect(await operations.read()).toEqual({ namespace, path: ['routes', 'codex'], writable: true })
    const ops = [{ op: 'unset' as const, path: ['routes', 'codex', 'models'] }]
    expect(await operations.writeSettings(namespace.ns, ops, 7)).toEqual({ kind: 'conflict', message: 'Conflict' })
    expect(settings.mutate).toHaveBeenCalledWith(namespace.ns, ops, 7)
    expect(await operations.discoverModels(namespace.ns, { provider: 'openai-codex' })).toEqual({ kind: 'found', models })
  })
})

describe('native capacity helpers', () => {
  it.each([['256K', 256000], ['2.3M', 2300000], ['1', 1]])('round-trips %s', (text, count) => {
    expect(parseCapacity(text)).toBe(count)
    expect(parseCapacity(formatCapacity(count))).toBe(count)
  })
  it('uses blanks for inheritance and rejects fractional or nonpositive counts', () => {
    expect(parseCapacity('')).toBeUndefined()
    expect(parseCapacity('bad')).toBeNaN()
    for (const value of [0, -1, 1.5, Infinity, NaN]) expect(validateDeepSeekModels([{ id: 'x', contextWindow: value }])?.key).toBe('modelContextInvalid')
  })
})
