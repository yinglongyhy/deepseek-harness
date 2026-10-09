/**
 * The two decisions the bridge makes about the official flow's questions.
 *
 * pi-ai's Codex login asks the human to pick a login method and then races a
 * typed authorization code against the loopback callback. This bridge renders
 * neither: the method question is answered for the human (the local desktop is
 * exactly the case the browser method exists for) and the code question is held
 * pending so the automatic callback is the one that finishes the login.
 *
 * Both decisions are structural. The method question is answered only when the
 * offered choices are exactly the browser/device-code pair, so a changed or
 * unknown option set is reported as incompatible instead of guessed at; the
 * code question is recognized by the callback address it names, so an
 * unrelated text question is refused rather than left hanging.
 */

import type { AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { CODEX_AUTHORIZATION_REDIRECT_URI } from '../shared/index.ts'

/** pi-ai's browser login method id. */
const BROWSER_LOGIN_METHOD = 'browser'

/** The method id pi-ai pairs the browser login with; its presence is part of the structural check. */
const DEVICE_CODE_LOGIN_METHOD = 'device_code'

/**
 * The answer to give the official login-method question.
 * @param prompt - what the flow asked.
 * @returns the browser method id, or undefined when this is not the official Codex choice.
 */
export function codexBrowserMethodOf(prompt: AuthorizationPrompt): string | undefined {
  if (prompt.kind !== 'select') return undefined
  const offered = new Set(prompt.options.map(option => option.id))
  if (offered.size !== 2) return undefined
  if (!offered.has(BROWSER_LOGIN_METHOD) || !offered.has(DEVICE_CODE_LOGIN_METHOD)) return undefined
  return BROWSER_LOGIN_METHOD
}

/**
 * Whether a question is the official manual-code prompt this bridge hides.
 * @param prompt - what the flow asked.
 * @returns true for the text question naming the loopback callback address.
 */
export function isHiddenManualCodePrompt(prompt: AuthorizationPrompt): boolean {
  return prompt.kind === 'text' && prompt.placeholder === CODEX_AUTHORIZATION_REDIRECT_URI
}

/**
 * The promise a hidden question returns: it is never answered, and it rejects
 * as soon as either the attempt or the question itself is withdrawn.
 *
 * Rejecting is the whole point. pi-ai waits on this question after its callback
 * server stops waiting, so an unanswered question that never rejects would keep
 * the official flow — and its listening socket — alive after the login was
 * cancelled. The rejection is a plain `AbortError`: a withdrawal is not a
 * decline, and the authorization seam would otherwise read a cancelled attempt
 * as the human refusing.
 * @param attemptSignal - signal withdrawn when the attempt is cancelled, times out, or unloads.
 * @param promptSignal - signal the flow itself withdraws when it stops racing this question.
 * @returns a promise that never fulfills.
 */
export function withdrawablePrompt(
  attemptSignal: AbortSignal,
  promptSignal: AbortSignal | undefined,
): Promise<string> {
  const signals = promptSignal === undefined ? [attemptSignal] : [attemptSignal, promptSignal]
  return new Promise<string>((_resolve, reject) => {
    for (const signal of signals) {
      if (signal.aborted) {
        reject(abortErrorOf(signal))
        return
      }
    }
    for (const signal of signals) {
      signal.addEventListener('abort', () => { reject(abortErrorOf(signal)) }, { once: true })
    }
  })
}

/** A withdrawn signal's plain `AbortError`, preserving an abort error the signal already carries. */
function abortErrorOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  return new DOMException('the Codex sign-in prompt was withdrawn', 'AbortError')
}
