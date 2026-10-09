/** Default Codex settings through the shipped Host and built browser composition. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings } from './support.ts'

const mode = webSnapshotMode()

describe('web e2e: default Codex account', () => {
  let scaffold: WebScaffold
  let browser: Browser

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      developerTools: false,
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    })
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  for (const locale of ['en', 'zh'] as const) {
    it(`opens the dedicated ${locale} page without initiating sign-in or changing routes`, async () => {
      const context = await browser.newContext({ locale: locale === 'zh' ? 'zh-CN' : 'en-US' })
      try {
        const page = await context.newPage()
        const tripwire = watchConsole(page)
        const before = scaffold.ctx.settings.describe().find(form => form.ns === 'llm-pi-ai')
        if (before === undefined) throw new Error('The default pi-ai settings namespace is unavailable')
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
        await openSettings(page, locale)
        const dialog = page.getByRole('dialog', { name: locale === 'zh' ? '设置' : 'Settings', exact: true })
        await dialog.getByRole('button', { name: locale === 'zh' ? 'Codex 登录' : 'Codex sign-in', exact: true }).click()
        const title = locale === 'zh' ? '使用 ChatGPT 登录' : 'Sign in with ChatGPT'
        const card = dialog.getByRole('group', { name: title, exact: true })
        await card.getByText(locale === 'zh' ? '尚未登录。' : 'Not signed in.', { exact: true }).waitFor()
        expect(await card.getByRole('button', { name: locale === 'zh' ? '登录' : 'Sign in', exact: true }).isEnabled()).toBe(true)
        await dialog.getByRole('region', { name: locale === 'zh' ? '模型目录' : 'Models', exact: true }).waitFor()
        expect(await dialog.getByRole('button', { name: locale === 'zh' ? '添加模型' : 'Add model', exact: true }).count()).toBe(1)
        const actual = await captureStableAria(page, `[role="group"][aria-label="${title}"]`, scaffold.workspaceCwd)
        await compareOrRefreshGolden(fileURLToPath(new URL(`./expected/codex-account/${locale}.expected.md`, import.meta.url)), actual, mode)
        expect(context.pages()).toHaveLength(1)
        expect(scaffold.ctx.settings.describe().find(form => form.ns === 'llm-pi-ai')).toMatchObject({
          user: before.user, value: before.value, base: before.base, revision: before.revision,
        })
        await page.keyboard.press('Escape')
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      } finally {
        await context.close()
      }
    })
  }

  it('persists catalog edits without replacing the configured credential reference or hidden model fields', async () => {
    const before = scaffold.ctx.settings.describe().find(form => form.ns === 'llm-pi-ai')
    if (before === undefined || typeof before.user !== 'object' || before.user === null) {
      throw new Error('The default pi-ai settings namespace is unavailable')
    }
    const originalUser = before.user
    const context = await browser.newContext({ locale: 'en-US' })
    try {
      await scaffold.ctx.settings.mutate('llm-pi-ai', [{
        op: 'set', path: ['providers', 'openai-codex'], value: {
          apiKeyEnv: 'DSH_CODEX_BROWSER_TEST_KEY',
          models: [{ id: 'dsh-codex-before', name: 'Before', reasoningEfforts: false }],
        },
      }], before.revision)
      const page = await context.newPage()
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await openSettings(page, 'en')
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      await dialog.getByRole('button', { name: 'Codex sign-in', exact: true }).click()
      await dialog.getByRole('textbox', { name: 'Display name 1', exact: true }).fill('Edited model')
      await dialog.getByRole('button', { name: 'Add model', exact: true }).click()
      await dialog.getByRole('textbox', { name: 'Model ID 2', exact: true }).fill('dsh-codex-browser-added')
      await dialog.getByRole('textbox', { name: 'Display name 2', exact: true }).fill('Browser-added model')
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
      await expect.poll(() => scaffold.ctx.settings.describe().find(form => form.ns === 'llm-pi-ai')?.user).toMatchObject({
        providers: { 'openai-codex': {
          apiKeyEnv: 'DSH_CODEX_BROWSER_TEST_KEY',
          models: [
            { id: 'dsh-codex-before', name: 'Edited model', reasoningEfforts: false },
            { id: 'dsh-codex-browser-added', name: 'Browser-added model' },
          ],
        } },
      })
      const document = await readFile(await scaffold.ctx.settings.prepareDocument(), 'utf8')
      expect(document).toContain('dsh-codex-browser-added')
      expect(document).toContain('reasoningEfforts: false')
      await page.reload({ waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await openSettings(page, 'en')
      await dialog.getByRole('button', { name: 'Codex sign-in', exact: true }).click()
      expect(await dialog.getByRole('textbox', { name: 'Display name 1', exact: true }).inputValue()).toBe('Edited model')
      expect(await dialog.getByRole('textbox', { name: 'Model ID 2', exact: true }).inputValue()).toBe('dsh-codex-browser-added')
      const actual = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/codex-account/catalog.expected.md', import.meta.url)), actual, mode)
      expect(context.pages()).toHaveLength(1)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      try {
        await context.close()
      } finally {
        await scaffold.ctx.settings.replace('llm-pi-ai', originalUser)
      }
    }
  })
})
