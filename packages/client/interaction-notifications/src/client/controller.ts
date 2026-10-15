/** Background-only reminder policy over existing interaction identities. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { NotificationKind, NotificationLocale, NotificationToken } from '../types.ts'
import type { NoticeCopy, NoticeHandle, NotificationPermissionState, NotificationPlatform } from './platform.ts'

/** Minimal request data retained by the notification plugin; never contains user content. */
export interface InteractionNotice {
  readonly key: string
  readonly sessionId: SessionId
  readonly kind: NotificationKind
}
/** Settings-owned feedback; native submission cannot confirm OS delivery. */
export interface NotificationState {
  readonly enabled: boolean
  readonly permission: NotificationPermissionState | 'loading'
  readonly failed: boolean
}
interface PendingNotice { readonly request: InteractionNotice; readonly token: NotificationToken; handle?: NoticeHandle }

/** Owns pending sends, runtime-local deduplication, and withdrawable notifications. */
export class InteractionNotifications {
  private readonly preference = createSnapshotStore(true, { persist: { name: 'dsh.interaction-notifications.enabled' } })
  /** Local preference and permission feedback for the settings row. */
  readonly state = createSnapshotStore<NotificationState>({ enabled: this.preference.getSnapshot(), permission: 'loading', failed: false })
  private readonly sent = new Set<string>()
  private readonly notices = new Map<string, PendingNotice>()
  private requests: readonly InteractionNotice[] = []
  private readonly completions = new Map<SessionId, InteractionNotice>()
  private background = false
  private foregroundSessionId: SessionId | undefined
  private disposal: Promise<void> | undefined
  private readonly tasks = new Set<Promise<void>>()
  private permissionRevision = 0

  /**
   * @param platform - lifetime-owned platform provider.
   * @param copy - current locale's privacy-preserving copy.
   * @param locale - shell copy selector.
   * @param open - existing session navigation; never an approval operation.
   */
  constructor(
    private readonly platform: NotificationPlatform,
    private readonly copy: (kind: NotificationKind) => NoticeCopy,
    private readonly locale: () => NotificationLocale,
    private readonly open: (sessionId: SessionId) => void,
  ) {}

  /**
   * Reconcile request publication and window focus without retaining Session objects.
   * @param requests - complete live request list, excluding read-only review cards.
   * @param background - whether the document is hidden or its window lacks focus.
   * @param foregroundSessionId - Session currently selected while the document is foreground.
   */
  update(requests: readonly InteractionNotice[], background: boolean, foregroundSessionId?: SessionId): void {
    if (this.disposal !== undefined) return
    this.requests = requests
    this.background = background
    this.foregroundSessionId = foregroundSessionId
    this.reconcile()
  }

  /**
   * Admit a newly observed normal task completion, not a replayed historical event.
   * Foreground, disabled, and unavailable-permission completions are consumed without later replay.
   * @param sessionId - conversation owning the finished task.
   * @param seq - durable completion event identity within that Session.
   */
  completed(sessionId: SessionId, seq: SessionSeq): void {
    if (this.disposal !== undefined) return
    const key = JSON.stringify([sessionId, 'task-completed', seq])
    if (this.sent.has(key) || this.completions.get(sessionId)?.key === key) return
    const previous = this.completions.get(sessionId)
    if (previous !== undefined) this.sent.add(previous.key)
    this.completions.set(sessionId, { key, sessionId, kind: 'task-completed' })
    this.reconcile()
  }

  /**
   * Refresh permissions on startup and foreground return; late responses are ignored.
   * @returns completion after updating feedback, unless superseded or disposed.
   */
  async refreshPermission(): Promise<void> { await this.readPermission(() => this.platform.permission()) }

  /**
   * Must be called directly by a user gesture so browsers can show their permission prompt.
   * @returns completion after recording the permission outcome.
   */
  async requestPermission(): Promise<void> { await this.readPermission(() => this.platform.requestPermission(), true) }

  /**
   * Persist the local toggle and withdraw owned notices when disabled.
   * @param enabled - requested browser/device-local preference.
   */
  setEnabled(enabled: boolean): void {
    if (this.disposal !== undefined) return
    this.preference.set(enabled)
    this.state.set({ ...this.state.getSnapshot(), enabled })
    this.reconcile()
  }

  /**
   * Stop admission, withdraw notices, and drain native submissions and withdrawals before releasing the provider.
   * @returns completion after all admitted presentation work has settled.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.permissionRevision++
    this.disposal = Promise.resolve().then(async () => {
      await Promise.all(this.tasks)
      await this.platform.dispose()
    })
    for (const key of this.notices.keys()) this.close(key)
    return this.disposal
  }

  private async readPermission(read: () => Promise<NotificationPermissionState>, clearFailure = false): Promise<void> {
    if (this.disposal !== undefined) return
    const revision = ++this.permissionRevision
    try {
      const permission = await read()
      if (revision !== this.permissionRevision) return
      const current = this.state.getSnapshot()
      this.state.set({ ...current, permission, failed: clearFailure ? false : current.failed })
      this.reconcile()
    } catch (error) {
      if (revision === this.permissionRevision) this.fail(error)
    }
  }

  private reconcile(): void {
    const state = this.state.getSnapshot()
    for (const [sessionId, completion] of this.completions) {
      if (!state.enabled || (state.permission !== 'loading' && state.permission !== 'granted')
        || (!this.background && !this.notices.has(completion.key))) {
        this.sent.add(completion.key)
        this.completions.delete(sessionId)
      }
    }
    const requests = [...this.requests, ...this.completions.values()]
    const live = new Set(requests.map(request => request.key))
    for (const [key, owner] of this.notices) {
      if (!state.enabled || state.permission !== 'granted' || !live.has(key)
        || (!this.background && owner.request.sessionId === this.foregroundSessionId)) this.close(key)
    }
    if (!state.enabled || state.permission !== 'granted' || !this.background) return
    for (const request of requests) {
      if (this.sent.has(request.key) || this.notices.has(request.key)) continue
      const owner: PendingNotice = { request, token: randomUUID() as NotificationToken }
      this.notices.set(request.key, owner)
      this.track(this.send(owner))
    }
  }

  private async send(owner: PendingNotice): Promise<void> {
    const { request } = owner
    try {
      const handle = await this.platform.show(
        { id: owner.token, kind: request.kind, locale: this.locale() }, this.copy(request.kind),
        () => {
          if (this.notices.get(request.key) !== owner || this.disposal !== undefined) return
          this.close(request.key)
          try { this.open(request.sessionId) } catch (error) { this.fail(error) }
        },
        () => { if (this.disposal === undefined && this.notices.get(request.key) === owner) this.fail(new Error('System notification presentation failed')) },
      )
      if (handle === undefined) {
        if (this.notices.get(request.key) === owner) this.notices.delete(request.key)
        if (request.kind === 'task-completed') this.sent.add(request.key)
        return
      }
      this.sent.add(request.key)
      if (this.disposal !== undefined || this.notices.get(request.key) !== owner) await this.withdraw(handle)
      else owner.handle = handle
    } catch (error) {
      if (this.disposal !== undefined || this.notices.get(request.key) !== owner) return
      this.sent.add(request.key)
      this.close(request.key)
      this.fail(error)
    }
  }

  private close(key: string): void {
    const owner = this.notices.get(key)
    this.notices.delete(key)
    if (owner?.handle !== undefined) this.track(this.withdraw(owner.handle))
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task)
    void task.then(() => { this.tasks.delete(task) })
  }

  private async withdraw(handle: NoticeHandle): Promise<void> {
    try { await handle.close() }
    catch (error) {
      if (this.disposal === undefined) this.fail(error)
      else console.warn('Interaction notification cleanup failed', error)
    }
  }

  private fail(error: unknown): void {
    this.state.set({ ...this.state.getSnapshot(), failed: true })
    console.warn('Interaction notification unavailable; use the application to handle pending requests', error)
  }
}
