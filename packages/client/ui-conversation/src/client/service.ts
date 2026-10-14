/**
 * Scope-addressed conversation send, cancel, and history orchestration.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with `scopeOf`. Mutable state must remain reachable
 * through one property read; assignment through the tracker proxy and `#`
 * private fields bypass that rebinding.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
// Type-only imports: a plugin-to-plugin value import is a bundle purity
// error, so scope resolution goes through the sessions service (scopeOf
// method) instead of the standalone helper.
import type {
  ISessions, PendingSubmissionRetirement, SessionFace,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ComposerAttachment, ComposerFileAttachment, ComposerImageAttachment, DraftFileUpload,
} from './contract/slots.ts'
import type { QueueAction, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ComposerBlocks } from './contract/composer-blocks.ts'
import type {
  DraftAttachmentId, DraftAttachmentSerializationResult, SessionInputResolver, SubmitAttachment, SubmitOutcome,
} from './contract/input.ts'
import type { InputSubmitMode } from './contract/composer-submission.ts'
import type {
  CapturedConversationSubmission, ConversationSubmissionAttempt, ConversationSubmissions, SubmissionContribution,
} from './contract/contributions.ts'
import { SubmissionContributionRegistry } from './submission-contributions.ts'

/**
 * The outward conversation face (`ctx.conversation`): the scope-addressed
 * verbs and the input registry other plugins may reach — and exactly what a
 * test fake must supply.
 */
export interface IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver
  /**
   * The per-session composer-block registry: how a plugin the composer
   * cannot import makes a session's input inert with its own reason.
   */
  readonly blocks: ComposerBlocks
  /** Immutable submission records and caller-owned history reconciliation. */
  readonly submissions: ConversationSubmissions
  /**
   * Register a draft contribution under the calling plugin's lifetime.
   * @param sessionId - target Session.
   * @param contribution - owner draft and callbacks.
   * @returns an owner-scoped disposer that closes callbacks, awaits quiescence, and reports outstanding operation failures.
   */
  registerContribution(sessionId: SessionId, contribution: SubmissionContribution): () => Promise<void>
  /**
   * Retry the identical request without minting a replacement id or reading current drafts.
   * Unfinished in-process preparation repeats; fresh restores prepare every captured owner idempotently before admission.
   * @param attempt - retained or restored immutable request; content conflicts throw.
   * @param signal - optional cancellation.
   * @param transportAttachments - optional ordered restaged file receipts; image values remain identical.
   * @returns the same-request Host admission outcome; accepted settlement errors never imply rejection.
   */
  retrySubmission(
    attempt: ConversationSubmissionAttempt,
    signal?: AbortSignal,
    transportAttachments?: readonly SubmitAttachment[],
  ): Promise<SubmitOutcome>
  /**
   * Queue only the supplied text into the caller scope's Session, without composer drafts or contributions.
   * @param text - prompt text, sent verbatim as one text block.
   * @returns completion; business failures reject (and land in promptError).
   */
  send(text: string): Promise<void>
  /**
   * Apply one edit, remove, or Steer operation to a pending queue occurrence.
   * @param itemId - agent-owned inbox occurrence identity.
   * @param action - requested queue operation.
   * @returns completion; converged QueueDock races resolve, while other failures reject.
   */
  updateQueue(itemId: MessageId, action: QueueAction): Promise<void>
  /**
   * Cancel the scoped session's in-flight turn while preserving its pending Queue.
   * @returns completion; failures reject as in send.
   */
  cancel(): Promise<void>
  /**
   * Pull one older history page for the scoped session.
   * @returns completion of the page pull.
   */
  loadOlder(): Promise<void>
}

/** Create one browser-only image draft descriptor; only its id enters input state. */
function browserDraftAttachment(file: File): ComposerImageAttachment {
  return {
    kind: 'image',
    id: randomUUID() as DraftAttachmentId,
    previewUrl: URL.createObjectURL(file),
    file,
  }
}

/**
 * Fill the draft's intrinsic dimensions once the browser parses the image
 * header (a metadata read off the preview URL, not a full decode). Failures
 * and non-browser runtimes leave them absent — consumers size those images
 * from CSS constraints instead. The descriptors stay registry-owned; submit
 * reads the dimensions into an immutable echo snapshot, so this late write
 * does not require a store notification.
 */
function probeDimensions(attachment: ComposerImageAttachment): void {
  if (typeof Image !== 'function') return
  const probe = new Image()
  probe.onload = () => {
    attachment.width = probe.naturalWidth
    attachment.height = probe.naturalHeight
  }
  probe.src = attachment.previewUrl
}

/** Give the echo one paint opportunity without letting a throttled frame clock block admission. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        setTimeout(resolve, 0)
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        setTimeout(resolve, 0)
      }
      const fallback = setTimeout(finish, 100)
      requestAnimationFrame(finish)
    } else {
      setTimeout(resolve, 0)
    }
  })
}

/** Native canonical base64 of one browser image (FileReader data-URL encode; no main-thread byte loop). */
function base64ImageOf(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = reader.result as string
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => {
      reject(reader.error ?? new Error('conversation: image read failed'))
    }
    reader.readAsDataURL(file)
  })
}

/** Unsupported browser-declared image type, localized by the UI boundary. */
export class UnsupportedImageMediaTypeError extends Error {
  /** Browser-declared MIME value, possibly empty. */
  readonly mediaType: string

  /** @param mediaType - Browser-declared MIME value, possibly empty. */
  constructor(mediaType: string) {
    super(`unsupported image media type: ${mediaType || '(empty)'}`)
    this.name = 'UnsupportedImageMediaTypeError'
    this.mediaType = mediaType
  }
}

/** Scope-addressed conversation service (root singleton, provided as `conversation`). */
export class ConversationController extends Service implements IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver
  /** The per-session composer-block registry. */
  readonly blocks: ComposerBlocks
  /** Immutable request registry shared with the resident composer. */
  readonly submissions: SubmissionContributionRegistry
  /** Live upload state per file-kind draft; images never appear here. */
  readonly fileUploads: SnapshotStore<Record<string, DraftFileUpload>> = createSnapshotStore<Record<string, DraftFileUpload>>({})
  private readonly draftAttachments = new Map<DraftAttachmentId, ComposerAttachment>()
  /** Exact-attempt retry resources, released by observed echo retirement or service disposal. */
  private readonly submissionDrafts = new Map<SessionRequestId, {
    attachments: readonly ComposerAttachment[]
    pendingAttachments: Parameters<SessionFace['beginSubmission']>[0]['attachments']
  }>()
  private readonly fileUploadOperations = new Map<DraftAttachmentId, {
    readonly controller: AbortController
    readonly done: Promise<void>
  }>()
  private readonly pendingFileUploads = new Set<Promise<void>>()
  private readonly fileUploadQueue: Array<{
    readonly run: () => Promise<void>
    readonly settle: () => void
  }> = []
  private activeFileUploads = 0
  private readonly maxConcurrentFileUploads: number

  /**
   * @param ctx - owning root context (the plugin apply context; the service
   * registers itself and follows that fiber's lifetime).
   * @param config - carries the SessionInputResolver and composer-block registry
   * constructed by the plugin apply (the same instances the slot inject
   * factories close over).
   */
  constructor(ctx: Context, config: {
    input: SessionInputResolver
    blocks: ComposerBlocks
    submissions?: SubmissionContributionRegistry
    maxConcurrentFileUploads: number
  }) {
    super(ctx, 'conversation')
    this.input = config.input
    this.blocks = config.blocks
    this.submissions = config.submissions ?? new SubmissionContributionRegistry()
    ctx.effect(() => () => this.submissions.dispose(), 'conversation submission contributions')
    this.maxConcurrentFileUploads = config.maxConcurrentFileUploads
    ctx.effect(() => async () => {
      const operations = [...this.fileUploadOperations.values()]
      for (const operation of operations) operation.controller.abort()
      await Promise.allSettled([...this.pendingFileUploads])
      this.fileUploadOperations.clear()
      this.fileUploadQueue.length = 0
      for (const attachment of this.draftAttachments.values()) {
        if (attachment.kind === 'image') revokePreview(attachment.previewUrl)
      }
      this.draftAttachments.clear()
      this.submissionDrafts.clear()
      this.fileUploads.set({})
    }, 'conversation draft attachments')
  }

  /**
   * Send only the supplied text into the scoped Session, without composer drafts or contributions.
   * Business failures update Session promptError and reject this callback.
   * @param text - prompt text, sent verbatim as one text block.
   */
  async send(text: string): Promise<void> {
    const session = this.scopedSession('send')
    const result = await session.prompt([{ type: 'text', text }], 'queue')
    if (!result.ok) throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Submit ordered draft attachments and frozen contributions through one Host admission.
   * Contributions complete durable preparation before the pending echo and prompt;
   * their acceptance does not wait for echo retirement. Submissions without contributions
   * retain the existing synchronous echo and attachment-retirement behavior.
   * Observed retirement releases draft attachments and seeds admitted image previews;
   * failures retain attachment ownership for definitive restoration or same-id retry.
   * @param session - target session.
   * @param text - serialized prompt text.
   * @param attachmentIds - ordered draft-local attachment ids.
   * @param mode - queue or steer delivery selected by composer policy.
   * @param signal - optional cancellation for the complete Host admission.
   * @param capture - ordinary gesture's synchronous snapshot; absent means a programmatic snapshot at this call.
   * @returns the Host admission outcome; local attachment preparation failures reject.
   */
  async sendSession(
    session: SessionFace,
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal?: AbortSignal,
    capture?: CapturedConversationSubmission,
  ): Promise<SubmitOutcome> {
    capture ??= this.submissions.capture(session.sessionId, text, attachmentIds, mode, 'programmatic')
    try {
      const attachments = this.resolveDraftAttachments(attachmentIds)
      if (attachments.length !== attachmentIds.length) {
        throw new Error('conversation.sendSession: one or more draft attachments are no longer available')
      }
      const uploads = this.fileUploads.getSnapshot()
      const uploadFor = (attachment: ComposerFileAttachment): Extract<DraftFileUpload, { status: 'ready' }> => {
        const upload = uploads[attachment.id]
        if (upload === undefined || upload.status !== 'ready') {
          throw new Error('conversation.sendSession: one or more files have not finished uploading')
        }
        return upload
      }
      const pendingAttachments = attachments.map(attachment => attachment.kind === 'image'
        ? {
          type: 'image' as const,
          value: {
            previewUrl: attachment.previewUrl,
            ...(attachment.file.name === '' ? {} : { name: attachment.file.name }),
            ...(attachment.width === undefined ? {} : { width: attachment.width }),
            ...(attachment.height === undefined ? {} : { height: attachment.height }),
          },
        }
        : { type: 'file' as const, value: uploadFor(attachment).file })
      const serializeAttachments = (): Promise<Parameters<SessionFace['prompt']>[0]> => Promise.all(
        attachments.map(async attachment => attachment.kind === 'image'
          ? { type: 'image' as const, ...await this.encodeImage(attachment.file) }
          : { type: 'file' as const, receiptId: uploadFor(attachment).receiptId }),
      )
      const snapshot = session.getSnapshot()
      if (snapshot.subagent !== null) {
        const submission = session.beginSubmission({
          requestId: capture.requestId, mode, text, attachments: pendingAttachments,
          onRetire: this.submissionRetirement(session.sessionId, capture.requestId, attachments),
        })
        const uploaded = await serializeAttachments()
        const content = [...uploaded, ...(text === '' ? [] : [{ type: 'text' as const, text }])]
        const result = await session.prompt(content, mode, signal, submission.requestId)
        if (!result.ok) submission.abandon()
        this.submissions.releaseCapture(capture)
        return result.ok ? { kind: 'success' } : { kind: 'error' }
      }
      // With no owners, echo registration does not precede any required preparation.
      const submission = capture.contributions.length === 0 ? session.beginSubmission({
        requestId: capture.requestId, mode, text, attachments: pendingAttachments,
        onRetire: this.submissionRetirement(session.sessionId, capture.requestId, attachments),
      }) : undefined
      const outcome = await this.submissions.submit(capture, signal, async () => {
        if (submission !== undefined) await nextPaint()
        const uploaded = await serializeAttachments()
        const wireAttachments = uploaded.filter((part): part is Extract<typeof part, { type: 'image' | 'file' }> => part.type === 'image' || part.type === 'file')
        return { text, attachments: wireAttachments }
      }, (attempt, admissionSignal) => this.admitSubmission(session, attempt, admissionSignal, attachments, pendingAttachments))
      if (outcome.admission === 'rejected') submission?.abandon()
      return outcome
    } catch (error) {
      this.submissions.releaseCapture(capture)
      throw error
    }
  }

  /** @param sessionId - target Session. @param contribution - owner draft and callbacks. @returns scope-bound owner disposer. */
  registerContribution(sessionId: SessionId, contribution: SubmissionContribution): () => Promise<void> {
    let dispose: (() => Promise<void>) | undefined
    this.ctx.effect(() => {
      dispose = this.submissions.register(sessionId, contribution)
      return dispose
    }, `conversation contribution ${contribution.id}`)
    return async () => { await dispose?.() }
  }

  /**
   * @param attempt - retained or restored immutable content.
   * @param signal - optional cancellation.
   * @param transportAttachments - ordered restaged file receipts; image values must remain identical.
   * @returns same-request admission outcome after captured-owner preparation.
   */
  retrySubmission(
    attempt: ConversationSubmissionAttempt,
    signal?: AbortSignal,
    transportAttachments?: readonly SubmitAttachment[],
  ): Promise<SubmitOutcome> {
    const frozen = this.submissions.restore(attempt)
    const sessions = this.ctx.get('sessions')
    const session = sessions?.binding(frozen.sessionId)?.session
    if (session === undefined) return Promise.reject(new Error('submission Session unavailable'))
    const wireAttachments = Object.freeze((transportAttachments ?? frozen.attachments).map(attachment => Object.freeze({ ...attachment })))
    if (wireAttachments.length !== frozen.attachments.length || frozen.attachments.some((original, index) => {
      const replacement = wireAttachments[index]
      return replacement === undefined || original.type !== replacement.type
        || (original.type === 'image' && (replacement.type !== 'image' || original.data !== replacement.data
          || original.mediaType !== replacement.mediaType || original.name !== replacement.name))
    })) return Promise.reject(new Error('retry may replace only file receipts in their original positions'))
    return this.submissions.run(frozen, signal,
      admissionSignal => this.admitSubmission(session, frozen, admissionSignal, undefined, undefined, wireAttachments), false)
  }

  private async admitSubmission(
    session: SessionFace,
    attempt: ConversationSubmissionAttempt,
    signal: AbortSignal,
    attachments: readonly ComposerAttachment[] = this.submissionDrafts.get(attempt.requestId)?.attachments ?? [],
    pendingAttachments: Parameters<SessionFace['beginSubmission']>[0]['attachments'] = this.submissionDrafts.get(attempt.requestId)?.pendingAttachments ?? [],
    wireAttachments: readonly SubmitAttachment[] = attempt.attachments,
  ): Promise<import('./contract/contributions.ts').ConversationSubmissionStatus> {
    if (attachments.length > 0) this.submissionDrafts.set(attempt.requestId, { attachments, pendingAttachments })
    const snapshot = session.getSnapshot()
    if (snapshot.subagent === null && !snapshot.pendingSubmissions.some(pending => pending.requestId === attempt.requestId)) {
      try {
        session.beginSubmission({
          requestId: attempt.requestId, mode: attempt.mode, text: attempt.text, attachments: pendingAttachments,
          onRetire: this.submissionRetirement(session.sessionId, attempt.requestId, attachments),
        })
      } catch (_error) {
        // No Host call happened; duplicate pending echoes and local admission errors are definite rejection.
        return 'rejected'
      }
    }
    const content = [...wireAttachments.map(attachment => attachment.type === 'file'
      ? { ...attachment, receiptId: attachment.receiptId as Extract<Parameters<SessionFace['prompt']>[0][number], { type: 'file' }>['receiptId'] }
      : { ...attachment }), ...(attempt.text === '' ? [] : [{ type: 'text' as const, text: attempt.text }])]
    const result = await session.prompt(content, attempt.mode, signal, attempt.requestId)
    // Gateway failures do not establish whether the Host admitted the request.
    if (!result.ok && (result.error.code === 'session/prompt-uncertain'
      || (result.error.code.startsWith('gateway/') && result.error.code !== 'gateway/bad-request'))) return 'uncertain'
    return result.ok ? 'accepted' : 'rejected'
  }

  private submissionRetirement(
    sessionId: SessionId,
    requestId: SessionRequestId,
    attachments: readonly ComposerAttachment[],
  ): NonNullable<Parameters<SessionFace['beginSubmission']>[0]['onRetire']> {
    return (settlement) => {
      this.settleSubmittedAttachments(sessionId, attachments, settlement)
      if (settlement.reason === 'observed') this.submissionDrafts.delete(requestId)
    }
  }

  /**
   * Create runtime-only draft attachments. Files whose browser MIME is an
   * accepted image type become image drafts (object URL preview, bytes sent
   * with the prompt); every other file becomes a file draft whose background
   * upload starts immediately and remains owned by this service across Session
   * navigation until completion or explicit removal.
   * @param sessionId - target Agent-scope identity.
   * @param files - browser files to register.
   * @returns ordered draft descriptors.
   */
  createDrafts(sessionId: SessionId, files: readonly File[]): readonly ComposerAttachment[] {
    return files.map((file) => {
      if (isImageMediaType(file.type)) {
        const attachment = browserDraftAttachment(file)
        this.draftAttachments.set(attachment.id, attachment)
        probeDimensions(attachment)
        return attachment
      }
      const attachment: ComposerFileAttachment = {
        kind: 'file',
        id: randomUUID() as DraftAttachmentId,
        file,
      }
      this.draftAttachments.set(attachment.id, attachment)
      this.beginFileUpload(sessionId, attachment)
      return attachment
    })
  }

  /**
   * Restart one failed file upload.
   * @param sessionId - target Agent-scope identity.
   * @param id - draft attachment id whose upload previously failed.
   */
  retryFileUpload(sessionId: SessionId, id: DraftAttachmentId): void {
    const attachment = this.draftAttachments.get(id)
    if (attachment === undefined || attachment.kind !== 'file') return
    if (this.fileUploads.getSnapshot()[id]?.status !== 'error') return
    this.beginFileUpload(sessionId, attachment)
  }

  /**
   * Stage carried file drafts again for a new Session.
   * @param sessionId - target Agent-scope identity after a Workspace switch.
   * @param ids - carried draft attachment ids.
   */
  rebindDraftFiles(sessionId: SessionId, ids: readonly DraftAttachmentId[]): void {
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id)
      if (attachment?.kind === 'file') this.beginFileUpload(sessionId, attachment)
    }
  }

  private beginFileUpload(sessionId: SessionId, attachment: ComposerFileAttachment): void {
    this.fileUploadOperations.get(attachment.id)?.controller.abort()
    const controller = new AbortController()
    this.fileUploads.update((draft) => {
      draft[attachment.id] = { status: 'uploading', loaded: 0 }
    })
    let settle!: () => void
    const done = new Promise<void>((resolve) => { settle = resolve })
    this.fileUploadOperations.set(attachment.id, { controller, done })
    this.pendingFileUploads.add(done)
    void done.then(() => { this.pendingFileUploads.delete(done) })
    const run = async (): Promise<void> => {
      try {
        if (controller.signal.aborted
          || this.fileUploadOperations.get(attachment.id)?.controller !== controller) return
        const result = await this.ctx.fileUpload.upload(
          sessionId,
          attachment.file,
          attachment.file.name === '' ? undefined : attachment.file.name,
          controller.signal,
          (progress) => {
            if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return
            this.fileUploads.update((draft) => {
              if (!(attachment.id in draft)) return
              draft[attachment.id] = {
                status: 'uploading',
                loaded: progress.loaded,
                ...(progress.total === undefined ? {} : { total: progress.total }),
              }
            })
          },
        )
        if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return
        this.fileUploads.update((draft) => {
          if (!(attachment.id in draft)) return
          draft[attachment.id] = result.ok
            ? { status: 'ready', receiptId: result.value.receiptId, file: result.value.file }
            : { status: 'error', message: result.error.message }
        })
      } catch (error) {
        if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return
        this.fileUploads.update((draft) => {
          if (!(attachment.id in draft)) return
          draft[attachment.id] = {
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          }
        })
      } finally {
        if (this.fileUploadOperations.get(attachment.id)?.controller === controller) {
          this.fileUploadOperations.delete(attachment.id)
        }
      }
    }
    this.fileUploadQueue.push({ run, settle })
    this.pumpFileUploads()
  }

  /** Start queued upload Workers until the configured concurrency is occupied. */
  private pumpFileUploads(): void {
    while (this.activeFileUploads < this.maxConcurrentFileUploads) {
      const task = this.fileUploadQueue.shift()
      if (task === undefined) return
      this.activeFileUploads += 1
      void task.run().finally(() => {
        this.activeFileUploads -= 1
        task.settle()
        this.pumpFileUploads()
      })
    }
  }

  /**
   * Resolve ordered input-state ids to runtime-owned draft attachments.
   * @param ids - draft attachment ids.
   * @returns descriptors that remain live, in requested order.
   */
  resolveDraftAttachments(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[] {
    const attachments: ComposerAttachment[] = []
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id)
      if (attachment !== undefined) attachments.push(attachment)
    }
    return attachments
  }

  /**
   * Serialize ordered draft attachments to command-submit wire payloads without
   * sending or releasing them. Images are encoded; generic files cite receipts
   * from their completed background uploads and never reread browser bytes.
   * @param attachmentIds - ordered draft-local attachment ids.
   * @returns wire payloads in id order.
   */
  async serializeDraftAttachments(
    attachmentIds: readonly DraftAttachmentId[],
  ): Promise<DraftAttachmentSerializationResult> {
    const attachments = this.resolveDraftAttachments(attachmentIds)
    if (attachments.length !== attachmentIds.length) {
      throw new Error('conversation.serializeDraftAttachments: one or more draft attachments are no longer available')
    }
    const uploads = this.fileUploads.getSnapshot()
    return {
      attachments: await Promise.all(attachments.map(async (attachment) => {
        if (attachment.kind === 'image') return { type: 'image' as const, ...await this.encodeImage(attachment.file) }
        const upload = uploads[attachment.id]
        if (upload === undefined || upload.status !== 'ready') {
          throw new Error('conversation.serializeDraftAttachments: one or more files have not finished uploading')
        }
        return { type: 'file' as const, receiptId: upload.receiptId }
      })),
    }
  }

  /**
   * Release one browser-owned draft attachment, aborting its active upload.
   * @param id - draft attachment id.
   */
  releaseDraftAttachment(id: DraftAttachmentId): void {
    const attachment = this.draftAttachments.get(id)
    if (attachment === undefined) return
    const operation = this.fileUploadOperations.get(id)
    this.fileUploadOperations.delete(id)
    operation?.controller.abort()
    this.draftAttachments.delete(id)
    if (attachment.kind === 'image') {
      revokePreview(attachment.previewUrl)
      return
    }
    // The stored Host object stays durable; only the draft's upload state ends.
    this.fileUploads.set(Object.fromEntries(
      Object.entries(this.fileUploads.getSnapshot()).filter(([key]) => key !== id),
    ))
  }

  /**
   * Release a set of browser-owned draft attachments.
   * @param attachments - descriptors to release.
   */
  releaseDraftAttachments(attachments: readonly ComposerAttachment[]): void {
    for (const attachment of attachments) this.releaseDraftAttachment(attachment.id)
  }

  /** Apply one operation to a pending queue occurrence. */
  async updateQueue(itemId: MessageId, action: QueueAction): Promise<void> {
    const session = this.scopedSession('updateQueue')
    const result = await session.updateQueue(itemId, action)
    if (!result.ok) {
      if (
        action.kind === 'steer'
        && (result.error.code === 'session/steer-unavailable' || result.error.code === 'session/queue-item-not-found')
      ) return
      throw new Error(`conversation.updateQueue failed: ${result.error.code}: ${result.error.message}`)
    }
  }

  /** Cancel the scoped session's in-flight turn while preserving Queue (failures land in promptError and reject, as in send). */
  async cancel(): Promise<void> {
    const session = this.scopedSession('cancel')
    const result = await session.cancel()
    if (!result.ok) throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`)
  }

  /** Pull one older history page for the scoped Session. */
  async loadOlder(): Promise<void> {
    await this.scopedSession('loadOlder').loadOlder()
  }

  /** Resolve the caller scope's session face or throw on root contexts. */
  private scopedSession(op: string): SessionFace {
    const id = this.scopeId(op)
    const binding = this.requireSessions().binding(id)
    if (binding === undefined) throw new Error(`conversation.${op}: session "${id}" resolved no binding`)
    return binding.session
  }

  /** Read the caller's session scope tag via the sessions service; root contexts fail loud. */
  private scopeId(op: string): SessionId {
    const id = this.requireSessions().scopeOf(this.ctx)
    if (id === undefined) {
      throw new Error(`conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`)
    }
    return id
  }

  private requireSessions(): ISessions {
    // Strict ctx.get, not the injection proxy: the scope-addressed pattern
    // reads the service off whatever context the tracker rebound.
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('conversation: sessions service unavailable')
    return sessions
  }

  /**
   * Settle one submission's draft attachments when its echo retires. Observed:
   * each image leaves the registry, handing its preview URL to the durable
   * image cache (seeded under the admitted reference so the transcript node
   * renders immediately while the cache reads canonical bytes) or revoking it
   * when the cache already holds that reference. Failed: nothing changes;
   * the ids stay registered for the composer's rail restore.
   */
  private settleSubmittedAttachments(
    sessionId: SessionId,
    attachments: readonly ComposerAttachment[],
    retirement: PendingSubmissionRetirement,
  ): void {
    if (retirement.reason !== 'observed') return
    const uiConversation = this.ctx.get('uiConversation')
    let observedIndex = 0
    for (const attachment of attachments) {
      const live = this.draftAttachments.get(attachment.id)
      const ref = retirement.attachments[observedIndex++]
      if (live === undefined) continue
      if (attachment.kind === 'file') {
        this.releaseDraftAttachment(attachment.id)
        continue
      }
      this.draftAttachments.delete(attachment.id)
      if (ref !== undefined && 'mediaType' in ref
        && uiConversation?.seedImageUrl(sessionId, ref, attachment.previewUrl) === true) continue
      revokePreview(attachment.previewUrl)
    }
  }

  /** Canonical base64 wire form of one browser image file. */
  private async encodeImage(file: File): Promise<Omit<Extract<SubmitAttachment, { type: 'image' }>, 'type'>> {
    return {
      mediaType: imageMediaType(file.type),
      data: await base64ImageOf(file),
      ...(file.name === '' ? {} : { name: file.name }),
    }
  }
}

function imageMediaType(value: string): ImageMediaType {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif':
      return value
    default:
      throw new UnsupportedImageMediaTypeError(value)
  }
}

/**
 * Whether a browser-declared MIME selects the image draft path (all other files upload verbatim).
 * @param value - the browser's declared MIME type.
 * @returns whether the file is an accepted raster image.
 */
export function isImageMediaType(value: string): boolean {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function revokePreview(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}
