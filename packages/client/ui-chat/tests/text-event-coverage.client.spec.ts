import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { textEventCoverage } from '../src/client/text-event-coverage.ts'

const messageId = MessageId('message-1')
const seq = 5 as SessionSeq

function assistant(seqValue: number, id: MessageId): SessionEventLikeEntry {
  return {
    type: 'event',
    event: {
      type: 'assistant/message', seq: seqValue as SessionSeq, time: 0, surfaceOp: 'append',
      data: {
        turn: 1, step: 1, stream: [],
        message: {
          id, role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [],
        },
      },
    },
  }
}

function other(seqValue: number): SessionEventLikeEntry {
  return {
    type: 'event',
    event: { type: 'turn/start', seq: seqValue as SessionSeq, time: 0, data: { turn: 1 } },
  }
}

describe('ChatText event coverage', () => {
  it('requires an exact durable message event and identity', () => {
    expect(textEventCoverage({ entries: [assistant(seq, messageId)], hasMore: true }, seq, messageId)).toBe('covered')
    expect(textEventCoverage({ entries: [assistant(seq, MessageId('other'))], hasMore: false }, seq, messageId)).toBe('changed')
    expect(textEventCoverage({ entries: [other(seq)], hasMore: false }, seq, messageId)).toBe('changed')
  })

  it('does not call an unloaded historical sequence missing', () => {
    expect(textEventCoverage({ entries: [assistant(8, MessageId('newer'))], hasMore: true }, seq, messageId)).toBe('unavailable')
    expect(textEventCoverage({ entries: [], hasMore: true }, seq, messageId)).toBe('unavailable')
    expect(textEventCoverage({ entries: [assistant(8, MessageId('newer'))], hasMore: false }, seq, messageId)).toBe('missing')
  })
})
