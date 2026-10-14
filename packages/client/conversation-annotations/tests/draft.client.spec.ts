/** Pure annotation draft operations. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ChatTextRevision, ChatTextSurfaceId } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AnnotationId } from '../src/draft.ts'
import {
  addAnnotation, beginCommentEdit, cancelCommentEdit, clearAnnotations, createDraft,
  numberAnnotations, removeAnnotation, saveCommentEdit, updateCommentEdit,
} from '../src/draft.ts'

const sessionId = brandString<SessionId>('session')
const annotationId = (value: string): AnnotationId => brandString<AnnotationId>(value)
const anchor = {
  kind: 'conversation', sessionId, messageId: brandString<MessageId>('message'), blockId: brandString<ChatTextSurfaceId>('markdown:0'),
  revision: brandString<ChatTextRevision>('render-1'), start: 2, end: 5, selectedText: '🙂中',
} as const

describe('annotation draft', () => {
  it('adds ordered unique anchors with sequential display numbers', () => {
    const empty = createDraft(sessionId)
    const first = addAnnotation(empty, annotationId('one'), anchor)
    const duplicate = addAnnotation(first, annotationId('two'), anchor)
    const second = addAnnotation(first, annotationId('two'), { ...anchor, start: 5, end: 6, selectedText: 'x' })

    expect(first.revision).toBe(1)
    expect(duplicate).toBe(first)
    expect(second.annotations.map(item => item.id)).toEqual(['one', 'two'])
    expect(numberAnnotations(second).map(item => item.number)).toEqual([1, 2])
    expect(first.annotations[0]?.anchor).not.toBe(anchor)
  })

  it('rejects mismatched or cross-session UTF-16 source ranges', () => {
    expect(() => createDraft(brandString<SessionId>('  '))).toThrow()
    expect(() => addAnnotation(createDraft(sessionId), annotationId('one'), { ...anchor, sessionId: brandString<SessionId>('other') })).toThrow()
    expect(() => addAnnotation(createDraft(sessionId), annotationId('one'), { ...anchor, end: 6 })).toThrow()
    expect(() => addAnnotation(createDraft(sessionId), annotationId('one'), { ...anchor, selectedText: ' ' })).toThrow()
    expect(() => addAnnotation(createDraft(sessionId), annotationId('one'), { ...anchor, start: -1 })).toThrow()
  })

  it('edits, saves, and cancels comment buffers without mutating prior states', () => {
    const saved = addAnnotation(createDraft(sessionId), annotationId('one'), anchor)
    const editing = beginCommentEdit(saved, annotationId('one'))
    const changed = updateCommentEdit(editing, 'first line\n第二行')
    const committed = saveCommentEdit(changed)
    const canceling = beginCommentEdit(committed, annotationId('one'))
    const discarded = updateCommentEdit(canceling, 'not saved')

    expect(saved.annotations[0]?.comment).toBe('')
    expect(committed.annotations[0]?.comment).toBe('first line\n第二行')
    expect(cancelCommentEdit(discarded).annotations[0]?.comment).toBe('first line\n第二行')
    expect(cancelCommentEdit(saved)).toBe(saved)
    expect(() => beginCommentEdit(beginCommentEdit(saved, annotationId('one')), annotationId('missing'))).toThrow()
  })

  it('removes and clears drafts while retaining sequential ordering', () => {
    const first = addAnnotation(createDraft(sessionId), annotationId('one'), anchor)
    const two = addAnnotation(first, annotationId('two'), { ...anchor, start: 5, end: 6, selectedText: 'x' })
    const editing = beginCommentEdit(two, annotationId('one'))
    const removed = removeAnnotation(editing, annotationId('one'))

    expect(removeAnnotation(removed, annotationId('unknown'))).toBe(removed)
    expect(removed.edit).toBeNull()
    expect(numberAnnotations(removed).map(item => item.number)).toEqual([1])
    expect(clearAnnotations(removed).annotations).toEqual([])
    expect(clearAnnotations(createDraft(sessionId)).revision).toBe(0)
  })
})
