// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from 'vitest'
import type { ISessions, SessionProjectionUpdate } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { observeCompletions } from '../src/client/completions.ts'

const sessionId = 'unselected' as SessionId
function source() {
  const listeners = new Set<(update: SessionProjectionUpdate) => void>()
  const stopped = vi.fn()
  const sessions: Pick<ISessions, 'onProjectionUpdate'> = { onProjectionUpdate(listener) {
    listeners.add(listener)
    return () => { stopped(); listeners.delete(listener) }
  } }
  const emit = (seq: number, value: unknown = seq, key = 'interactionTaskCompletion'): void => {
    for (const listener of listeners) listener({ sessionId, key, value, seq: seq as SessionSeq })
  }
  return { sessions, emit, stopped }
}

it('observes normal completions without any Session binding or history capability', () => {
  const f = source()
  const completed = vi.fn()
  const stop = observeCompletions(f.sessions, completed)
  onTestFinished(stop)
  f.emit(1, null)
  f.emit(2, 1)
  f.emit(3, '3')
  f.emit(4, 4, 'sessionListMetadata')
  expect(completed).not.toHaveBeenCalled()
  f.emit(5)
  expect(completed).toHaveBeenCalledExactlyOnceWith(sessionId, 5)
})

it('stops observing global completions when the plugin is unloaded', () => {
  const f = source()
  const completed = vi.fn()
  const stop = observeCompletions(f.sessions, completed)
  stop()
  f.emit(1)
  expect(f.stopped).toHaveBeenCalledOnce()
  expect(completed).not.toHaveBeenCalled()
})
