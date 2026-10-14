// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { AnnotationId } from '../src/draft.ts'
import type { ChatTextRevision, ChatTextSurfaceId } from '@deepseek-ai/dsh-client-ui-chat/client'
import { en, zh } from '../src/client/locales.ts'
import { Summary, type SummaryProps } from '../src/client/view.tsx'
import type { AnnotationSessionSnapshot } from '../src/client/controller.ts'
import { createDraft } from '../src/draft.ts'
import type { CapturedAnnotation } from '../src/shared.ts'

afterEach(cleanup)

const sessionId = SessionId('session-1')
const annotation: CapturedAnnotation = {
  id: brandString<AnnotationId>('annotation-1'),
  anchor: { kind: 'conversation', sessionId, messageId: brandString<MessageId>('message-1'), blockId: brandString<ChatTextSurfaceId>('block-1'), revision: brandString<ChatTextRevision>('revision-1'), start: 0, end: 5, selectedText: 'hello' },
  comment: 'remember this', revision: 1, seq: SessionSeq(1),
}
const snapshot: AnnotationSessionSnapshot = {
  draft: { ...createDraft(sessionId), revision: 1, annotations: [annotation] },
  pending: null, busy: false, error: null, navigation: null, frozenIds: [],
}
const t = makeTranslate(zh, en)

function props(available: boolean): SummaryProps {
  return {
    available,
    useAccess: () => { throw new Error('summary does not read access state') },
    useRemoteAccess: () => { throw new Error('summary does not read remote access state') },
    useSessionAccess: () => { throw new Error('summary does not read Session access state') },
    useWorkspaceAccess: () => { throw new Error('summary does not read Workspace access state') },
    useSessions: () => { throw new Error('summary does not read Sessions state') },
    useSessionStatus: () => { throw new Error('summary does not read Session status') },
    useSessionRetainInfo: () => { throw new Error('summary does not read Session retention') },
    useWorkspaces: () => { throw new Error('summary does not read Workspaces state') },
    useResource: () => { throw new Error('summary does not read Resources') },
    usePanelInfo: () => { throw new Error('summary does not read Panel state') },
    useSession: () => { throw new Error('summary does not read Session state') },
    sessionId,
    useProjection: () => { throw new Error('summary does not read projection state') },
    useConversation: () => { throw new Error('summary does not read Conversation state') },
    useInput: () => { throw new Error('summary does not read input state') },
    inputActions: {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
      insertText: () => false,
      setDraft: () => {}, persistDraft: () => {}, addAttachments: () => false,
      removeAttachment: () => {}, pruneAttachments: () => {}, submit: () => {},
    },
    useChat: () => { throw new Error('summary does not read Chat state') },
    useTrajectory: () => { throw new Error('summary does not read trajectory state') },
    useAnnotations: select => select(snapshot),
    edit: vi.fn(async () => {}), remove: vi.fn(), releaseEditor: vi.fn(), clear: vi.fn(),
    navigate: vi.fn(async () => {}), retry: vi.fn(async () => {}), reconcile: vi.fn(async () => {}),
    t,
  }
}

describe('composer annotation summary', () => {
  it('shows ordinary Session annotations', () => {
    const view = render(<Summary {...props(true)} />)

    expect(view.getByRole('region', { name: zh.title })).toBeTruthy()
    expect(view.getByRole('button', { name: '1 条注释' })).toBeTruthy()
  })

  it('exposes no annotation entry point for a Subagent Session', () => {
    const view = render(<Summary {...props(false)} />)

    expect(view.container.childElementCount).toBe(0)
    expect(view.queryByRole('region')).toBeNull()
  })
})
