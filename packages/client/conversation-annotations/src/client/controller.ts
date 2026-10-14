import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {
  ChatTextDecorationActivationEvent, ChatTextDecorationHandle, ChatTextDecorationId, ChatTextNavigationResult,
  ChatTextRectangle, ChatTextSelection,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationSubmissionAttempt, ConversationSubmissionStatus,
  FrozenSubmissionContribution, SubmissionContributionState,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  addAnnotation, beginCommentEdit, cancelCommentEdit, clearAnnotations, createDraft,
  removeAnnotation, saveCommentEdit, updateCommentEdit,
} from '../draft.ts'
import type { AnnotationId, DraftState } from '../draft.ts'
import { canonicalJSON, formatAnnotations, OWNER_ID, PREPARE_ABSENT_CODE } from '../shared.ts'
import type { AnnotationAttachment, AnnotationAttempt, AnnotationSnapshot, CapturedAnnotation, PreparedRecord } from '../shared.ts'
import { AnnotationChannel, AnnotationRpcError } from './channel.ts'

/** Observable editor and submission state for one ordinary Session. */
export interface AnnotationSessionSnapshot {
  readonly draft: DraftState
  readonly pending: PreparedRecord | null
  readonly busy: boolean
  readonly error: string | null
  readonly navigation: string | null
  readonly frozenIds: readonly AnnotationId[]
}
/** Read status and prepared annotation record for one message. */
export interface HistoryState {
  readonly record: PreparedRecord | null
  readonly busy: boolean
  readonly error: string | null
}
/** Current comment editor contents and source geometry for one Session. */
export interface EditorState {
  readonly sessionId: SessionId
  readonly annotation: CapturedAnnotation
  readonly number: number
  readonly value: string
  readonly rectangles: readonly ChatTextRectangle[] | null
  readonly error: string | null
  readonly frozen: boolean
}
/** Current eligible ChatText selection and its viewport geometry. */
export interface SelectionState {
  readonly source: ChatTextSelection | null
  readonly rectangles: readonly ChatTextRectangle[] | null
}

/** Stable observable identities, with no React or service values in their snapshots. */
class Source<T> implements ObservableSnapshot<T> {
  private readonly listeners = new Set<() => void>()
  constructor(private value: T) {}
  readonly getSnapshot = (): T => this.value
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(value: T): void {
    if (value === this.value) return
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }
  close(): void { this.listeners.clear() }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function requireMapValue<K, V>(map: ReadonlyMap<K, V>, key: K, name: string): V {
  const value = map.get(key)
  if (value === undefined) throw new Error(`Missing annotation ${name}.`)
  return value
}
function sourceOf(annotation: CapturedAnnotation): ChatTextSelection {
  const { anchor } = annotation
  return {
    sessionId: anchor.sessionId,
    messageId: anchor.messageId,
    seq: annotation.seq,
    surfaceId: anchor.blockId,
    revision: anchor.revision,
    completed: true, start: anchor.start, end: anchor.end, selectedText: anchor.selectedText,
  }
}
function publicAttempt(record: PreparedRecord): ConversationSubmissionAttempt {
  return {
    ...record.attempt,
    attachments: record.attempt.attachments.map(attachment => attachment.type === 'file'
      ? { ...attachment, receiptId: String(attachment.receiptId) }
      : attachment),
  }
}
function annotationAttempt(attempt: ConversationSubmissionAttempt): AnnotationAttempt {
  return {
    ...attempt,
    attachments: attempt.attachments.map(attachment => attachment.type === 'file'
      ? { ...attachment, receiptId: brandString<FileUploadReceiptId>(attachment.receiptId) }
      : attachment),
  }
}

/** Owns annotation commands and presentation sources for ordinary Sessions. */
export class AnnotationClient {
  /** Live eligible ChatText selection and its viewport geometry. */
  readonly selection = new Source<SelectionState>({ source: null, rectangles: null })
  /** The currently open annotation editor, if any. */
  readonly editor = new Source<EditorState | null>(null)
  /** Transport adapter for persisted annotation records. */
  readonly channel: AnnotationChannel
  private readonly sessions = new Map<SessionId, AnnotationSession>()
  private readonly histories = new Map<string, Source<HistoryState>>()
  private readonly historyReads = new Map<string, number>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly controller = new AbortController()
  private readonly offSelection: () => Promise<void>
  private readonly offReset: () => void
  private disposal?: Promise<void>
  private active = true

  constructor(
    readonly ctx: Context,
    readonly reasonLabel: (reason: 'editing' | 'loading' | 'pending' | 'busy') => string = reason => reason,
    readonly decorationLabel: (number: number) => string = number => `Edit annotation ${number}`,
  ) {
    const connection = ctx.get('connection') as ConnectionHandle
    this.channel = new AnnotationChannel(connection.rpc)
    this.offSelection = ctx.chatText.subscribe(ctx, (source) => { this.publishSelection(source) })
    this.publishSelection(ctx.chatText.selection())
    // Gateway emits reset only after a replacement generation has become ready.
    this.offReset = ctx.on('connection/reset', () => {
      if (!this.active) return
      for (const [key, history] of this.histories) this.readHistory(key, history)
      for (const session of this.sessions.values()) session.refreshGeneration()
    })
  }

  /** Whether the Client remains available for new annotation operations. */
  get alive(): boolean { return this.active }
  /** Signal aborted when this Client begins disposal. */
  get signal(): AbortSignal { return this.controller.signal }

  /** Returns whether the Session is not a Subagent Session.
   * @param sessionId - Session to check.
   * @returns Whether annotation UI and operations are allowed.
   */
  isOrdinarySession(sessionId: SessionId): boolean {
    return this.ctx.sessions.binding(sessionId)?.session.getSnapshot().subagent === null
  }

  /** Returns the shared annotation controller for an ordinary Session.
   * @param sessionId - Session to retrieve.
   * @returns The Session controller, creating and recovering it on first use.
   * @throws If this Client is disposed or the Session is a Subagent.
   */
  forSession(sessionId: SessionId): AnnotationSession {
    if (!this.active) throw new Error('annotation client disposed')
    if (!this.isOrdinarySession(sessionId)) throw new Error('Annotations are unavailable in Subagent Sessions.')
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = new AnnotationSession(this, sessionId)
      this.sessions.set(sessionId, session)
      session.startRecovery()
    }
    return session
  }

  /** Adds the current eligible selection to its Session draft. */
  readonly addSelection = (): void => {
    const source = this.selection.getSnapshot().source
    if (source && this.active && this.isOrdinarySession(source.sessionId)) this.forSession(source.sessionId).add(source)
  }

  /** Refreshes selection and editor geometry after viewport movement. */
  readonly refreshGeometry = (): void => {
    if (!this.active) return
    this.publishSelection(this.ctx.chatText.selection())
    const current = this.editor.getSnapshot()
    if (current) this.refreshEditor(this.forSession(current.sessionId))
  }

  /** Opens the editor for the Session's active draft edit.
   * @param session - Session whose edit should be displayed.
   */
  showEditor(session: AnnotationSession): void {
    if (!this.active) return
    const { draft, error, frozenIds } = session.getSnapshot()
    const index = draft.annotations.findIndex(item => item.id === draft.edit?.annotationId)
    const annotation = draft.edit ? session.captured(draft.edit.annotationId) : undefined
    if (!annotation || !draft.edit) {
      if (this.editor.getSnapshot()?.sessionId === session.sessionId) this.editor.set(null)
      return
    }
    this.editor.set({ sessionId: session.sessionId, annotation, number: index + 1,
      value: draft.edit.value, rectangles: this.ctx.chatText.geometry(sourceOf(annotation)),
      error, frozen: frozenIds.includes(annotation.id) })
  }

  /** Closes the editor only when it belongs to the specified Session.
   * @param sessionId - Session whose editor should close.
   */
  hideEditor(sessionId: SessionId): void {
    if (this.editor.getSnapshot()?.sessionId === sessionId) this.editor.set(null)
  }

  /** Refreshes the editor when it displays the specified Session.
   * @param session - Session whose editor may need updated state.
   */
  refreshEditor(session: AnnotationSession): void {
    if (this.editor.getSnapshot()?.sessionId === session.sessionId) this.showEditor(session)
  }

  /** Updates the active editor's unsaved comment.
   * @param value - New comment text.
   */
  readonly updateEditor = (value: string): void => {
    const current = this.editor.getSnapshot()
    if (current && this.active) this.forSession(current.sessionId).update(value)
  }
  /** Saves the active comment edit. */
  readonly saveEditor = (): void => {
    const current = this.editor.getSnapshot()
    if (current && this.active) this.forSession(current.sessionId).save()
  }
  /** Cancels the active comment edit. */
  readonly cancelEditor = (): void => {
    const current = this.editor.getSnapshot()
    if (current && this.active) this.forSession(current.sessionId).cancel()
  }
  /** Removes the annotation being edited and closes its editor. */
  readonly removeEditor = (): void => {
    const current = this.editor.getSnapshot()
    if (current && this.active) this.forSession(current.sessionId).remove(current.annotation.id)
  }

  /** Refreshes localized annotation labels and submission block reasons. */
  readonly invalidateLabels = (): void => {
    if (this.active) for (const session of this.sessions.values()) session.invalidateLabels()
  }

  private publishSelection(source: ChatTextSelection | null): void {
    if (!this.active) return
    const eligible = source && this.isOrdinarySession(source.sessionId) ? source : null
    this.selection.set({ source: eligible, rectangles: eligible ? this.ctx.chatText.geometry(eligible) : null })
  }

  /** Returns cached history for a submitted USER message, starting a read on first access.
   * @param sessionId - Owning Session id.
   * @param requestId - Original submission request id.
   * @param messageId - Submitted USER message id.
   * @returns Stable observable history state for this message.
   * @throws If the Client has been disposed.
   */
  historyFor(sessionId: SessionId, requestId: SessionRequestId, messageId: MessageId): ObservableSnapshot<HistoryState> {
    if (!this.active) throw new Error('annotation client disposed')
    const key = JSON.stringify([sessionId, requestId, messageId])
    let source = this.histories.get(key)
    if (!source) {
      source = new Source<HistoryState>({ record: null, busy: true, error: null })
      this.histories.set(key, source)
      this.readHistory(key, source)
    }
    return source
  }

  private readHistory(key: string, history: Source<HistoryState>): void {
    const [rawSessionId, rawRequestId, rawMessageId] = JSON.parse(key) as [string, string, string]
    const sessionId = brandString<SessionId>(rawSessionId)
    const requestId = brandString<SessionRequestId>(rawRequestId)
    const messageId = brandString<MessageId>(rawMessageId)
    const generation = (this.historyReads.get(key) ?? 0) + 1
    this.historyReads.set(key, generation)
    history.set({ ...history.getSnapshot(), busy: true, error: null })
    void this.track((async () => {
      try {
        const record = await this.channel.read(sessionId, requestId, messageId, this.signal)
        if (this.active && this.historyReads.get(key) === generation) history.set({ record: record?.status === 'accepted' ? record : null, busy: false, error: null })
      } catch (error) {
        if (this.active && this.historyReads.get(key) === generation) history.set({ record: null, busy: false, error: message(error) })
      }
    })())
  }

  /** Rereads cached messages affected by the accepted or uncertain record.
   * @param record - Updated prepared record.
   */
  refreshHistory(record: PreparedRecord): void {
    if (!this.active) return
    for (const [key, history] of this.histories) {
      const [sessionId, requestId] = JSON.parse(key) as [string, string, string]
      if (sessionId === record.attempt.sessionId && requestId === record.attempt.requestId) this.readHistory(key, history)
    }
  }

  /** Navigates to a captured source while rejecting Subagent Sessions.
   * @param annotation - Annotation whose source should be revealed.
   * @returns The ChatText navigation result.
   * @throws If the Client is disposed or the Session is a Subagent.
   */
  readonly navigateSource = async (annotation: CapturedAnnotation): Promise<ChatTextNavigationResult> => {
    if (!this.active) throw new Error('annotation client disposed')
    if (!this.isOrdinarySession(annotation.anchor.sessionId)) throw new Error('Annotations are unavailable in Subagent Sessions.')
    return this.track(this.ctx.chatText.navigate(sourceOf(annotation)))
  }

  /** Keeps an in-flight operation in the disposal wait set.
   * @param operation - Operation to track.
   * @returns The same Promise, with its original result or rejection.
   */
  track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    // Use a handled cleanup branch: finally() alone creates an unhandled rejected Promise.
    void operation.then(() => { this.operations.delete(operation) }, () => { this.operations.delete(operation) })
    return operation
  }

  /** Stops new work and resolves after tracked operations and sources are closed.
   * @returns Promise that settles after disposal completes.
   */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.active = false
    this.controller.abort()
    this.offReset()
    const cleanups = [this.offSelection(), ...[...this.sessions.values()].map(session => session.dispose())]
    this.disposal = (async () => {
      await Promise.allSettled(cleanups)
      await Promise.allSettled([...this.operations])
      this.selection.close()
      this.editor.set(null)
      this.editor.close()
      for (const history of this.histories.values()) history.close()
    })()
    return this.disposal
  }
}

/** Owns one Session's draft, recovery, submission contribution, and ChatText decorations. */
export class AnnotationSession implements ObservableSnapshot<AnnotationSessionSnapshot> {
  private readonly view: Source<AnnotationSessionSnapshot>
  private readonly contribution: Source<SubmissionContributionState>
  private readonly snapshots = new Map<number, AnnotationSnapshot>()
  private readonly sequences = new Map<AnnotationId, SessionSeq>()
  private readonly decorations = new Map<AnnotationId, ChatTextDecorationHandle>()
  private readonly records = new Map<string, PreparedRecord>()
  private readonly preparationFailures = new Map<string, 'unknown' | 'absent'>()
  private readonly pendingPresentations = new Map<string, Source<HistoryState>>()
  private reservation: AnnotationSnapshot | null = null
  private restoring = true
  private recoveryFailed = false
  private active = true
  private readonly offContribution: () => Promise<void>
  private readonly offHost: () => void
  private disposal?: Promise<void>
  private readonly operations = new Set<Promise<unknown>>()
  private busyCount = 0
  private queryEpoch = 0
  private editorEpoch = 0
  private readonly admissionOperations = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  readonly getSnapshot: () => AnnotationSessionSnapshot
  readonly subscribe: (listener: () => void) => () => void

  constructor(private readonly owner: AnnotationClient, readonly sessionId: SessionId) {
    this.view = new Source({
      draft: createDraft(sessionId), pending: null, busy: true, error: null, navigation: null, frozenIds: Object.freeze([]),
    })
    this.getSnapshot = this.view.getSnapshot
    this.subscribe = this.view.subscribe
    this.contribution = new Source<SubmissionContributionState>({ hasContent: false, revision: 0, text: '', blockReason: owner.reasonLabel('loading') })
    this.captureSnapshot()
    const host = owner.ctx.conversation.submissions.storeFor(this.id)
    this.offContribution = owner.ctx.conversation.registerContribution(this.id, {
      id: OWNER_ID,
      state: this.contribution,
      prepare: (attempt, frozen, signal) => this.prepare(attempt, frozen, signal),
      settle: (attempt, frozen, status) => this.settle(attempt, frozen, status),
    })
    this.offHost = host.subscribe(() => {
      if (!this.alive) return
      if (host.getSnapshot().pending && !this.reservation && !this.getSnapshot().pending) {
        this.reservation = this.snapshots.get(this.contribution.getSnapshot().revision) ?? null
        this.patch({})
        this.publishContribution()
      } else if (!host.getSnapshot().pending && this.reservation && !this.getSnapshot().pending) {
        this.reservation = null
        this.patch({})
        this.publishContribution()
      }
    })
  }

  private get id(): ConversationSubmissionAttempt['sessionId'] {
    return this.sessionId
  }
  private get alive(): boolean { return this.active && this.owner.alive }
  private current(epoch: number): boolean { return this.alive && epoch === this.queryEpoch }

  /** Returns frozen record evidence for local and Inbox echoes before durable identity exists.
   * @param requestId - Original submission request id.
   * @returns Stable observable state for the pending presentation.
   */
  pendingPresentationFor(requestId: SessionRequestId): ObservableSnapshot<HistoryState> {
    let source = this.pendingPresentations.get(requestId)
    if (!source) {
      source = new Source(this.pendingPresentationState(requestId))
      this.pendingPresentations.set(requestId, source)
    }
    return source
  }

  private pendingPresentationState(requestId: string): HistoryState {
    const record = this.records.get(requestId) ?? null
    const state = this.getSnapshot()
    return { record, busy: this.restoring || (!record && state.frozenIds.length > 0),
      error: !record && this.recoveryFailed ? state.error : null }
  }

  private patch(patch: Partial<AnnotationSessionSnapshot>): void {
    if (!this.alive) return
    const previous = this.getSnapshot()
    const next = { ...previous, ...patch }
    const snapshot = next.pending?.status === 'rejected' ? null : next.pending?.snapshot ?? this.reservation
    const ids = snapshot?.annotations.map(annotation => annotation.id) ?? []
    const frozenIds = previous.frozenIds.length === ids.length && ids.every((id, index) => previous.frozenIds[index] === id)
      ? previous.frozenIds : Object.freeze(ids)
    this.view.set({ ...next, frozenIds })
    for (const [requestId, source] of this.pendingPresentations) source.set(this.pendingPresentationState(requestId))
    this.owner.refreshEditor(this)
  }

  private captureSnapshot(draft = this.getSnapshot().draft): AnnotationSnapshot {
    const annotations = draft.annotations.map(annotation => Object.freeze({
      ...annotation, anchor: Object.freeze({ ...annotation.anchor }), seq: requireMapValue(this.sequences, annotation.id, 'sequence'),
    }))
    const snapshot = Object.freeze({ revision: draft.revision, annotations: Object.freeze(annotations) })
    this.snapshots.set(draft.revision, snapshot)
    // Old editing revisions are not retry envelopes. Keep only the current,
    // still-advertised and synchronously reserved versions; records own retries.
    const advertised = this.contribution.getSnapshot().revision
    for (const revision of this.snapshots.keys()) {
      if (revision !== draft.revision && revision !== advertised && revision !== this.reservation?.revision) this.snapshots.delete(revision)
    }
    return snapshot
  }

  private publishContribution(): void {
    if (!this.alive) return
    const { draft, pending } = this.getSnapshot()
    // Keep the advertised revision reserved until Host release, even when the UI draft grows.
    // Otherwise aggregate pending would turn false during pre-prepare attachment serialization.
    const snapshot = this.reservation ?? requireMapValue(this.snapshots, draft.revision, 'snapshot')
    const blockReason = this.restoring || this.recoveryFailed ? this.owner.reasonLabel('loading')
      : draft.edit ? this.owner.reasonLabel('editing')
        : pending || this.reservation ? this.owner.reasonLabel('pending') : undefined
    const next = { hasContent: snapshot.annotations.length > 0, revision: snapshot.revision, text: snapshot.annotations.length ? formatAnnotations(snapshot) : '', ...(blockReason ? { blockReason } : {}) }
    const previous = this.contribution.getSnapshot()
    if (previous.hasContent !== next.hasContent || previous.revision !== next.revision
      || previous.text !== next.text || previous.blockReason !== next.blockReason) this.contribution.set(next)
  }

  /** Refreshes localized submission status and decoration labels. */
  invalidateLabels(): void { this.publishContribution(); this.syncDecorations() }

  private frozen(id: AnnotationId): boolean {
    const { pending } = this.getSnapshot()
    if (pending?.status === 'rejected') return false
    return (pending?.snapshot ?? this.reservation)?.annotations.some(annotation => annotation.id === id) ?? false
  }

  private mutate(change: (draft: DraftState) => DraftState, ids: readonly AnnotationId[] = []): void {
    if (!this.alive) return
    try {
      // A preceding Host subscriber may invoke this action before our own notification runs.
      // Read the public reservation synchronously rather than relying on listener ordering.
      if (!this.reservation && !this.getSnapshot().pending
        && this.owner.ctx.conversation.submissions.storeFor(this.id).getSnapshot().pending
        && this.contribution.getSnapshot().hasContent) {
        this.reservation = this.snapshots.get(this.contribution.getSnapshot().revision) ?? null
        this.patch({})
        this.publishContribution()
      }
      if (ids.some(id => this.frozen(id))) throw new Error('Annotation belongs to a frozen submission.')
      const draft = change(this.getSnapshot().draft)
      if (draft === this.getSnapshot().draft) return
      this.captureSnapshot(draft)
      this.patch({ draft, error: null })
      this.syncDecorations()
      this.publishContribution()
    } catch (error) { this.patch({ error: message(error) }) }
  }

  /** Adds a completed ChatText selection to the draft.
   * @param source - Selection captured from ChatText.
   */
  readonly add = (source: ChatTextSelection): void => {
    const id = brandString<AnnotationId>(globalThis.crypto.randomUUID())
    this.sequences.set(id, source.seq)
    this.mutate(draft => addAnnotation(draft, id, {
      kind: 'conversation', sessionId: source.sessionId, messageId: source.messageId,
      blockId: source.surfaceId, revision: source.revision,
      start: source.start, end: source.end, selectedText: source.selectedText,
    }))
    if (!this.getSnapshot().draft.annotations.some(annotation => annotation.id === id)) this.sequences.delete(id)
  }
  /** Returns the captured annotation from the current draft revision.
   * @param id - Annotation id to resolve.
   * @returns The captured value, or `undefined` when it is not in the current revision.
   */
  captured(id: AnnotationId): CapturedAnnotation | undefined {
    return this.snapshots.get(this.getSnapshot().draft.revision)?.annotations.find(item => item.id === id)
  }

  /** UI addition opens its single editor; never replace another unsaved buffer. */
  readonly addAndEdit = (source: ChatTextSelection): void => {
    if (!this.alive) return
    const draft = this.getSnapshot().draft
    const existing = draft.annotations.find((item) => {
      const captured = this.captured(item.id)
      return captured && canonicalJSON(sourceOf(captured)) === canonicalJSON(source)
    })
    if (draft.edit && draft.edit.annotationId !== existing?.id) {
      this.patch({ error: `Annotation "${draft.edit.annotationId}" is already being edited.` })
      return
    }
    const id = existing?.id ?? brandString<AnnotationId>(globalThis.crypto.randomUUID())
    if (!existing) this.sequences.set(id, source.seq)
    this.mutate(current => beginCommentEdit(addAnnotation(current, id, {
      kind: 'conversation', sessionId: source.sessionId, messageId: source.messageId,
      blockId: source.surfaceId, revision: source.revision,
      start: source.start, end: source.end, selectedText: source.selectedText,
    }), id), existing ? [id] : [])
    if (!this.getSnapshot().draft.annotations.some(annotation => annotation.id === id)) this.sequences.delete(id)
    if (this.getSnapshot().draft.edit?.annotationId === id) this.owner.showEditor(this)
  }

  /** Opens a comment editor for an annotation.
   * @param id - Annotation id to edit.
   */
  readonly edit = (id: AnnotationId): void => {
    this.editorEpoch++
    this.mutate(draft => beginCommentEdit(draft, id), [id])
    if (this.getSnapshot().draft.edit?.annotationId === id) this.owner.showEditor(this)
  }

  /** Navigates to an annotation and opens its editor after a successful reveal.
   * @param id - Annotation id to edit.
   * @returns Promise that settles after navigation.
   */
  readonly editAtSource = (id: AnnotationId): Promise<void> => this.reveal(id, true)
  /** Closes this Session's active comment editor. */
  readonly releaseEditor = (): void => { this.editorEpoch++; this.owner.hideEditor(this.sessionId) }
  /** Updates the current comment draft.
   * @param value - New comment text.
   */
  readonly update = (value: string): void => { this.mutate(draft => updateCommentEdit(draft, value), this.editIds()) }
  /** Saves the current comment draft. */
  readonly save = (): void => { this.mutate(saveCommentEdit, this.editIds()) }
  /** Cancels the current comment draft. */
  readonly cancel = (): void => { this.editorEpoch++; this.mutate(cancelCommentEdit, this.editIds()) }
  /** Removes an annotation from the draft.
   * @param id - Annotation id to remove.
   */
  readonly remove = (id: AnnotationId): void => { this.mutate(draft => removeAnnotation(draft, id), [id]) }
  /** Clears all annotations from the draft. */
  readonly clear = (): void => { this.mutate(clearAnnotations, this.getSnapshot().draft.annotations.map(annotation => annotation.id)) }
  private editIds(): AnnotationId[] {
    const edit = this.getSnapshot().draft.edit
    return edit ? [edit.annotationId] : []
  }

  private readonly activateDecoration = (event: ChatTextDecorationActivationEvent): void => {
    if (!this.alive) return
    const id = brandString<AnnotationId>(event.id)
    const annotation = this.snapshots.get(this.getSnapshot().draft.revision)?.annotations.find(item => item.id === id)
    if (!annotation || canonicalJSON(event.source) !== canonicalJSON(sourceOf(annotation))) return
    // The existing command owns frozen-id checks and preserves any active edit buffer.
    this.edit(annotation.id)
  }

  private syncDecorations(): void {
    if (!this.alive) return
    const annotations = requireMapValue(this.snapshots, this.getSnapshot().draft.revision, 'snapshot').annotations
    for (const [id, handle] of this.decorations) {
      if (annotations.some(annotation => annotation.id === id)) continue
      this.decorations.delete(id)
      // Cordis effect cleanup may finish synchronously despite the ChatText promise type.
      const disposal = Promise.resolve(handle.dispose())
      this.operations.add(disposal)
      void this.owner.track(disposal)
      void disposal.then(() => { this.operations.delete(disposal) }, (error: unknown) => {
        this.operations.delete(disposal)
        this.patch({ error: message(error) })
      })
    }
    annotations.forEach((annotation, index) => {
      const decoration = { source: sourceOf(annotation), label: String(index + 1) }
      const activation = { label: this.owner.decorationLabel(index + 1), onActivate: this.activateDecoration }
      const handle = this.decorations.get(annotation.id)
      if (handle) handle.update(decoration, activation)
      else this.decorations.set(annotation.id, this.owner.ctx.chatText.register(this.owner.ctx, {
        id: brandString<ChatTextDecorationId>(annotation.id), ...decoration,
      }, activation))
    })
  }

  /** Navigates to the captured source without opening the editor.
   * @param id - Annotation id whose source should be revealed.
   * @returns Promise that settles after navigation.
   */
  readonly navigate = (id: AnnotationId): Promise<void> => this.reveal(id, false)

  private async reveal(id: AnnotationId, openEditor: boolean): Promise<void> {
    const epoch = openEditor ? ++this.editorEpoch : this.editorEpoch
    await this.run(async () => {
      const annotation = this.captured(id)
      if (!annotation) throw new Error('Unknown annotation.')
      const result = await this.owner.navigateSource(annotation)
      if (!this.alive) return
      this.patch({ navigation: result.status })
      if (openEditor && result.status === 'revealed' && epoch === this.editorEpoch) this.edit(id)
    })
  }

  private async prepare(attempt: ConversationSubmissionAttempt, frozen: FrozenSubmissionContribution, signal: AbortSignal): Promise<void> {
    if (!this.alive || signal.aborted) throw new Error('Annotation preparation cancelled.')
    const frozenAttempt = annotationAttempt(attempt)
    const existing = this.records.get(attempt.requestId)
    const pending = this.getSnapshot().pending
    if (pending && pending.attempt.requestId !== attempt.requestId) throw new Error('Another annotation attempt is unresolved.')
    if (existing && canonicalJSON(existing.attempt) !== canonicalJSON(attempt)) throw new Error('Frozen annotation envelope conflict.')
    const snapshot = existing?.snapshot ?? this.snapshots.get(frozen.revision)
    if (!snapshot || frozen.id !== OWNER_ID || snapshot.revision !== frozen.revision
      || formatAnnotations(snapshot) !== frozen.text) throw new Error('Frozen annotation snapshot unavailable.')
    const record: PreparedRecord = { schemaVersion: 1, attempt: frozenAttempt, snapshot, status: 'uncertain' }
    if (existing?.status !== 'accepted') this.records.set(attempt.requestId, record)
    this.reservation = snapshot
    this.patch({ pending: record })
    this.publishContribution()
    await this.operation(async () => {
      try {
        this.preparationFailures.set(attempt.requestId, 'unknown')
        const prepared = await this.owner.channel.prepare({ attempt: frozenAttempt, snapshot }, signal)
        this.preparationFailures.delete(attempt.requestId)
        if (this.alive) {
          if (prepared.status === 'accepted') this.applyRecord(prepared)
          else {
            this.records.set(attempt.requestId, prepared)
            this.patch({ pending: { schemaVersion: 1, attempt: prepared.attempt, snapshot: prepared.snapshot, status: 'uncertain' }, error: null })
          }
        }
      } catch (error) {
        if (error instanceof AnnotationRpcError && error.failure.code === PREPARE_ABSENT_CODE) {
          this.preparationFailures.set(attempt.requestId, 'absent')
        }
        this.patch({ error: message(error) })
        throw error
      }
    }, true)
  }

  private async settle(
    attempt: ConversationSubmissionAttempt,
    frozen: FrozenSubmissionContribution,
    status: ConversationSubmissionStatus,
  ): Promise<void> {
    if (!this.alive) return
    await this.operation(async () => {
      const record = this.records.get(attempt.requestId)
      if (!record || record.snapshot.revision !== frozen.revision) return
      const preparationFailure = this.preparationFailures.get(attempt.requestId)
      // Both absent preparation and rejected admission are required to release a request.
      if (preparationFailure === 'absent' && status === 'rejected' && record.status !== 'accepted') {
        this.preparationFailures.delete(attempt.requestId)
        this.records.delete(attempt.requestId)
        if (this.getSnapshot().pending?.attempt.requestId === attempt.requestId) {
          this.reservation = null
          this.patch({ pending: null })
        }
        this.publishContribution()
        return
      }
      // A failed prepare ACK does not establish sidecar durability. Keep its lock
      // until Host settlement succeeds; other admission knowledge remains authoritative.
      if (!preparationFailure || status !== 'rejected') this.applyRecord({ ...record, status })
      try {
        const settled = await this.owner.channel.settle(this.sessionId, attempt.requestId, status, this.lifetime.signal)
        this.preparationFailures.delete(attempt.requestId)
        this.applyRecord(settled)
      } catch (error) {
        this.recoveryFailed = true
        this.patch({ error: message(error) })
        this.publishContribution()
      }
    }, true)
  }

  private applyRecord(record: PreparedRecord): void {
    if (!this.alive) return
    if (this.records.get(record.attempt.requestId)?.status === 'accepted' && record.status !== 'accepted') return
    this.records.set(record.attempt.requestId, record)
    if (record.status === 'accepted') {
      let draft = this.getSnapshot().draft
      for (const captured of record.snapshot.annotations) {
        const current = draft.annotations.find(annotation => annotation.id === captured.id)
        if (current?.revision === captured.revision) draft = removeAnnotation(draft, captured.id)
      }
      const matching = this.getSnapshot().pending?.attempt.requestId === record.attempt.requestId
      if (matching) this.reservation = null
      this.captureSnapshot(draft)
      this.patch({ draft, ...(matching ? { pending: null } : {}) })
      this.syncDecorations()
      this.owner.refreshHistory(record)
    } else {
      this.patch({ pending: record })
      this.reservation = record.status === 'uncertain' ? record.snapshot : null
    }
    this.publishContribution()
  }

  /** Starts loading this Session's persisted annotation records. */
  startRecovery(): void { void this.run(() => this.recover()) }

  /** Reconciles pending annotation state after a connection generation changes. */
  refreshGeneration(): void {
    if (!this.alive) return
    const epoch = ++this.queryEpoch
    const admissions = [...this.admissionOperations]
    this.restoring = true
    this.patch({ busy: true })
    this.publishContribution()
    void this.run(async () => {
      try {
        // Never replace an in-flight prepare/settle envelope with a recovery-list record.
        await Promise.allSettled(admissions)
        await this.waitForCaptureTransfer()
        if (!this.alive || epoch !== this.queryEpoch) return
        const record = this.getSnapshot().pending
        if (record) {
          await this.reconcileRecord(record, epoch)
          if (epoch === this.queryEpoch) this.recoveryFailed = false
        } else await this.recover(epoch)
      } catch (error) {
        if (epoch !== this.queryEpoch) return
        this.recoveryFailed = true
        throw error
      } finally {
        if (epoch === this.queryEpoch) {
          this.restoring = false
          this.publishContribution()
        }
      }
    })
  }

  private waitForCaptureTransfer(): Promise<void> {
    if (!this.reservation || this.getSnapshot().pending) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let off = (): void => {}
      const finish = (): void => {
        off()
        this.lifetime.signal.removeEventListener('abort', abort)
      }
      const abort = (): void => { finish(); reject(new Error('Annotation recovery cancelled.')) }
      const check = (): void => {
        if (!this.reservation || this.getSnapshot().pending) { finish(); resolve() }
      }
      off = this.view.subscribe(check)
      this.lifetime.signal.addEventListener('abort', abort, { once: true })
      if (this.lifetime.signal.aborted) abort()
      else check()
    })
  }

  private async recover(epoch = this.queryEpoch): Promise<void> {
    this.restoring = true
    this.publishContribution()
    try {
      const records = await this.owner.channel.list(this.sessionId, this.lifetime.signal)
      if (!this.alive || epoch !== this.queryEpoch) return
      const unresolved = records.filter(record => record.status !== 'accepted' && this.records.get(record.attempt.requestId)?.status !== 'accepted')
      for (const record of records) {
        const known = this.records.get(record.attempt.requestId)
        if (known?.status === 'accepted' && record.status !== 'accepted') {
          // A lost settlement ACK must not leave an old sidecar reservation blocking new IDs.
          const healed = await this.owner.channel.settle(this.sessionId, record.attempt.requestId, 'accepted', this.lifetime.signal)
          if (!this.current(epoch)) return
          this.applyRecord(healed)
        } else this.records.set(record.attempt.requestId, record)
      }
      if (unresolved.length > 1) throw new Error('Multiple unresolved annotation attempts require reconciliation.')
      const record = unresolved[0]
      if (record) {
        this.patch({ pending: record })
        this.reservation = record.status === 'uncertain' ? record.snapshot : null
        this.owner.ctx.conversation.submissions.restore(publicAttempt(record))
        await this.reconcileRecord(record, epoch)
      }
      if (epoch === this.queryEpoch) this.recoveryFailed = false
    } catch (error) {
      if (epoch !== this.queryEpoch) return
      this.recoveryFailed = true
      throw error
    } finally {
      if (epoch === this.queryEpoch) {
        this.restoring = false
        this.publishContribution()
      }
    }
  }

  private async reconcileRecord(record: PreparedRecord, epoch = this.queryEpoch): Promise<void> {
    let authoritative: PreparedRecord | undefined
    const status = await this.owner.ctx.conversation.submissions.reconcile(publicAttempt(record).requestId, async () => {
      if (!this.alive || epoch !== this.queryEpoch) return 'uncertain'
      const resolved = await this.owner.channel.reconcile(this.sessionId, record.attempt.requestId, this.lifetime.signal)
      if (epoch !== this.queryEpoch) return 'uncertain'
      authoritative = resolved
      return authoritative.status
    })
    if (!this.alive || epoch !== this.queryEpoch) return
    if (authoritative) this.applyRecord(authoritative)
    else if (status === 'accepted') this.applyRecord({ ...record, status: 'accepted' })
  }

  /** Rechecks unresolved submission state with the Host.
   * @returns Promise that settles after the reconciliation attempt.
   */
  readonly reconcile = async (): Promise<void> => {
    await this.run(async () => {
      if (this.restoring) return
      const record = this.getSnapshot().pending
      if (this.recoveryFailed || !record) await this.recover()
      else await this.reconcileRecord(record)
    })
  }

  /** Retries the retained submission with its original text and restaged attachments.
   * @returns Promise that settles after retry; failures appear in the Session snapshot.
   */
  readonly retry = async (): Promise<void> => {
    await this.run(async () => {
      const record = this.getSnapshot().pending
      if (!record || this.restoring || this.recoveryFailed) throw new Error('No recoverable annotation attempt.')
      // Explicit retry locks the original IDs again, including previously rejected attempts.
      this.reservation = record.snapshot
      this.patch({ pending: { schemaVersion: 1, attempt: record.attempt, snapshot: record.snapshot, status: 'uncertain' } })
      this.publishContribution()
      // The Host refreshes durable file receipts; every other frozen field stays unchanged.
      const attempt = this.owner.ctx.conversation.submissions.restore(publicAttempt(record))
      let attachments: readonly AnnotationAttachment[]
      try { attachments = await this.owner.channel.restage(record.attempt, this.lifetime.signal) }
      catch (error) {
        // Restaging precedes admission; its failure cannot change the retained outcome.
        this.applyRecord(record)
        throw error
      }
      if (!this.alive) return
      const result = await this.owner.ctx.conversation.retrySubmission(attempt, this.lifetime.signal, attachments)
      if (result.kind !== 'success') throw new Error(result.text ?? 'Annotation submission remains unresolved.')
    })
  }

  private operation<T>(execute: () => Promise<T>, admission = false): Promise<T> {
    const operation = Promise.resolve().then(async () => {
      if (!this.alive) throw new Error('Annotation client disposed.')
      this.busyCount++
      this.patch({ busy: true })
      try { return await execute() } finally {
        this.busyCount--
        this.patch({ busy: this.busyCount > 0 })
      }
    })
    this.operations.add(operation)
    if (admission) this.admissionOperations.add(operation)
    const finish = (): void => { this.operations.delete(operation); this.admissionOperations.delete(operation) }
    void operation.then(finish, finish)
    return this.owner.track(operation)
  }

  private async run(execute: () => Promise<void>): Promise<void> {
    if (!this.alive) return
    try { this.patch({ error: null }); await this.operation(execute) }
    catch (error) { this.patch({ error: message(error) }) }
  }

  /** Stops Session operations and resolves after registrations, decorations, and sources close.
   * @returns Promise that settles after disposal completes.
   */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.active = false
    this.lifetime.abort()
    this.offHost()
    const registration = this.offContribution()
    const decorations = [...this.decorations.values()].map(handle => handle.dispose())
    this.decorations.clear()
    this.disposal = Promise.allSettled([registration, ...decorations, ...this.operations]).then(() => {
      this.view.close()
      this.contribution.close()
      for (const source of this.pendingPresentations.values()) source.close()
      this.pendingPresentations.clear()
    })
    return this.disposal
  }
}
