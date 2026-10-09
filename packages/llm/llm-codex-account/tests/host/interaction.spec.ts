import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import { describe, expect, it } from 'vitest'
import { CODEX_MANUAL_PROMPT, CODEX_METHOD_PROMPT } from './seams.ts'
import { codexBrowserMethodOf, isHiddenManualCodePrompt, withdrawablePrompt } from '../../src/host/interaction.ts'

/** A signal that never fires on its own. */
function pending(): AbortController {
  return new AbortController()
}

/** The rejection of a promise, with the promise's own rejection handled. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(() => undefined, (error: unknown) => error)
}

describe('login-method question', () => {
  it('answers the installed browser/device-code pair with the browser method', () => {
    expect(codexBrowserMethodOf(CODEX_METHOD_PROMPT)).toBe('browser')
  })

  it('answers the pair wherever it is ordered', () => {
    const [browser, device] = CODEX_METHOD_PROMPT.kind === 'select' ? CODEX_METHOD_PROMPT.options : []
    expect(browser).toBeDefined()
    expect(device).toBeDefined()
    expect(codexBrowserMethodOf({
      kind: 'select',
      message: CODEX_METHOD_PROMPT.message,
      options: [device!, browser!],
    })).toBe('browser')
  })

  it('refuses a changed or unknown option set instead of guessing', () => {
    expect(codexBrowserMethodOf({
      kind: 'select',
      message: 'Select OpenAI Codex login method:',
      options: [{ id: 'browser', label: 'Browser login (default)' }],
    })).toBeUndefined()
    expect(codexBrowserMethodOf({
      kind: 'select',
      message: 'Select OpenAI Codex login method:',
      options: [{ id: 'device_code', label: 'Device code login (headless)' }],
    })).toBeUndefined()
    expect(codexBrowserMethodOf({
      kind: 'select',
      message: 'Select OpenAI Codex login method:',
      options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'device_code', label: 'Device code login (headless)' },
        { id: 'api_key', label: 'API key' },
      ],
    })).toBeUndefined()
    expect(codexBrowserMethodOf({ kind: 'select', message: 'Select a method:', options: [] })).toBeUndefined()
  })

  it('ignores a question that is not a choice', () => {
    expect(codexBrowserMethodOf(CODEX_MANUAL_PROMPT)).toBeUndefined()
    expect(codexBrowserMethodOf({ kind: 'secret', message: 'Paste the key:' })).toBeUndefined()
  })
})

describe('hidden manual-code question', () => {
  it('recognizes the installed prompt by the callback it names', () => {
    expect(isHiddenManualCodePrompt(CODEX_MANUAL_PROMPT)).toBe(true)
  })

  it('does not hide an unrelated text question', () => {
    expect(isHiddenManualCodePrompt({
      kind: 'text',
      message: 'Paste the authorization code:',
      placeholder: 'https://example.invalid/callback',
    })).toBe(false)
    expect(isHiddenManualCodePrompt({ kind: 'text', message: CODEX_MANUAL_PROMPT.message })).toBe(false)
    expect(isHiddenManualCodePrompt({ kind: 'secret', message: CODEX_MANUAL_PROMPT.message })).toBe(false)
  })
})

describe('withdrawable question', () => {
  it('stays pending while neither the attempt nor the question is withdrawn', async () => {
    const attempt = pending()
    const question = pending()
    const answer = withdrawablePrompt(attempt.signal, question.signal)
    expect(await Promise.race([answer.then(() => 'answered', () => 'rejected'), Promise.resolve('pending')]))
      .toBe('pending')
    attempt.abort()
    expect(await rejectionOf(answer)).toBeInstanceOf(Error)
  })

  it('rejects a plain AbortError when the attempt is withdrawn', async () => {
    const attempt = pending()
    const answer = withdrawablePrompt(attempt.signal, undefined)
    attempt.abort()
    const error = await rejectionOf(answer)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('AbortError')
    expect(error).not.toBeInstanceOf(AuthorizationDeclinedError)
  })

  it('rejects a plain AbortError when the flow withdraws the losing question', async () => {
    const attempt = pending()
    const question = pending()
    const answer = withdrawablePrompt(attempt.signal, question.signal)
    question.abort()
    const error = await rejectionOf(answer)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('AbortError')
    expect(error).not.toBeInstanceOf(AuthorizationDeclinedError)
  })

  it('rejects at once for a question already withdrawn', async () => {
    const attempt = pending()
    const question = pending()
    question.abort()
    const error = await rejectionOf(withdrawablePrompt(attempt.signal, question.signal))
    expect((error as Error).name).toBe('AbortError')
  })

  it('rejects at once for an attempt already withdrawn', async () => {
    const attempt = pending()
    attempt.abort()
    const error = await rejectionOf(withdrawablePrompt(attempt.signal, pending().signal))
    expect((error as Error).name).toBe('AbortError')
  })

  it('keeps the abort reason a signal already carries', async () => {
    const attempt = pending()
    const withdrawal = new DOMException('closed by the page', 'AbortError')
    const answer = withdrawablePrompt(attempt.signal, undefined)
    attempt.abort(withdrawal)
    expect(await rejectionOf(answer)).toBe(withdrawal)
  })
})
