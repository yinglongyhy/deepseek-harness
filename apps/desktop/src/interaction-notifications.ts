/** Main-process owner for fixed-copy interaction notifications. */

import type { DesktopNotificationRequest, NotificationToken } from '@deepseek-ai/dsh-client-interaction-notifications/types'

/** Checks an untrusted IPC value as a renderer notification token.
 * @param value - untrusted token value.
 * @returns whether the value is a bounded non-empty string token.
 */
export function isNotificationToken(value: unknown): value is NotificationToken {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

/** Checks a value received over Electron IPC before it reaches notification logic.
 * @param value - untrusted IPC payload.
 * @returns whether the payload contains exactly the supported request fields.
 */
export function isDesktopNotificationRequest(value: unknown): value is DesktopNotificationRequest {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 3
    && 'id' in value && isNotificationToken(value.id)
    && 'kind' in value && typeof value.kind === 'string' && ['approval', 'question', 'plan-review', 'task-completed'].includes(value.kind)
    && 'locale' in value && typeof value.locale === 'string' && ['zh', 'en'].includes(value.locale)
}

/** Native notification APIs used by the owner. */
interface NativeNotification {
  on(event: 'click' | 'close' | 'failed', listener: () => void): this
  off(event: 'click' | 'close' | 'failed', listener: () => void): this
  show(): void
  close(): void
}

/** Electron notification constructor injected for each desktop owner. */
export interface InteractionNotificationConstructor {
  /** @param options - fixed localized copy and silent presentation setting.
   * @returns a native notification instance.
   */
  new(options: { title: string; body: string; silent: true }): NativeNotification
  /** @returns whether this operating system supports native notifications. */
  isSupported(): boolean
}

/** One native notification and the listeners installed by its owner. */
interface OwnedNotification {
  readonly notification: NativeNotification
  readonly listeners: {
    readonly click: () => void
    readonly close: () => void
    readonly failed: () => void
  }
}

/** Owns one renderer's notification instances and native event listeners. */
export class DesktopInteractionNotifications {
  readonly #notifications = new Map<NotificationToken, OwnedNotification>()

  /** @param NotificationClass - Electron's native notification implementation.
   * @param foreground - whether the owning window is visible and focused.
   * @param onClick - handles a native click with its opaque token.
   * @param onFailed - reports a native presentation failure with its opaque token.
   */
  constructor(
    private readonly NotificationClass: InteractionNotificationConstructor,
    private readonly foreground: () => boolean,
    private readonly onClick: (id: NotificationToken) => void,
    private readonly onFailed: (id: NotificationToken) => void,
  ) {}

  /** Returns whether the operating system can display native notifications.
   * @returns native notification capability.
   */
  status(): 'available' | 'unsupported' {
    return this.NotificationClass.isSupported() ? 'available' : 'unsupported'
  }

  /** Displays fixed, localized copy only while the application is in the background.
   * @param request - opaque renderer token and fixed copy selectors.
   * @returns native presentation outcome.
   */
  show(request: DesktopNotificationRequest): 'shown' | 'foreground' | 'unsupported' | 'failed' {
    if (this.status() === 'unsupported') return 'unsupported'
    if (this.foreground()) return 'foreground'
    this.close(request.id)
    const copy = notificationCopy(request.kind, request.locale)
    let notification: NativeNotification
    try {
      notification = new this.NotificationClass({ ...copy, silent: true })
    } catch (_error) {
      this.notifyFailed(request.id)
      return 'failed'
    }
    const owned: OwnedNotification = {
      notification,
      listeners: {
        click: () => { this.notifyClick(request.id) },
        close: () => { this.forget(request.id, owned) },
        failed: () => { this.notifyFailed(request.id); this.forget(request.id, owned) },
      },
    }
    this.#notifications.set(request.id, owned)
    notification.on('click', owned.listeners.click)
    notification.on('close', owned.listeners.close)
    notification.on('failed', owned.listeners.failed)
    try {
      notification.show()
      return 'shown'
    } catch (_error) {
      this.notifyFailed(request.id)
      this.forget(request.id, owned)
      return 'failed'
    }
  }

  /** Closes and forgets one notification owned by this renderer.
   * @param id - opaque renderer token.
   */
  close(id: NotificationToken): void {
    const owned = this.#notifications.get(id)
    if (owned === undefined) return
    this.forget(id, owned)
    try { owned.notification.close() } catch (error) {
      console.error('dsh desktop: native interaction notification close failed', error)
    }
  }

  /** Closes all owned notifications and removes every installed listener.
   * @returns nothing.
   */
  dispose(): void {
    for (const id of this.#notifications.keys()) this.close(id)
  }

  private notifyClick(id: NotificationToken): void {
    try { this.onClick(id) } catch (error) {
      console.error('dsh desktop: interaction notification click handler failed', error)
    }
  }

  private notifyFailed(id: NotificationToken): void {
    try { this.onFailed(id) } catch (error) {
      console.error('dsh desktop: interaction notification failure handler failed', error)
    }
  }

  private forget(id: NotificationToken, owned: OwnedNotification): void {
    if (this.#notifications.get(id) !== owned) return
    this.#notifications.delete(id)
    owned.notification.off('click', owned.listeners.click)
    owned.notification.off('close', owned.listeners.close)
    owned.notification.off('failed', owned.listeners.failed)
  }
}

function notificationCopy(kind: DesktopNotificationRequest['kind'], locale: DesktopNotificationRequest['locale']): { title: string; body: string } {
  const copy = {
    zh: {
      approval: ['DeepSeek Harness · 需要你处理', '有一项操作等待你确认。'],
      question: ['DeepSeek Harness · 需要你回复', '有一个问题等待你回答。'],
      'plan-review': ['DeepSeek Harness · 需要你审阅', '有一份计划等待你审阅。'],
      'task-completed': ['DeepSeek Harness · 任务已完成', '任务已完成，点击打开对应会话。'],
    },
    en: {
      approval: ['DeepSeek Harness · Action needed', 'An action is waiting for your approval.'],
      question: ['DeepSeek Harness · Response needed', 'A question is waiting for your response.'],
      'plan-review': ['DeepSeek Harness · Review needed', 'A plan is waiting for your review.'],
      'task-completed': ['DeepSeek Harness · Task completed', 'Your task has finished. Click to open the conversation.'],
    },
  } as const
  const [title, body] = copy[locale][kind]
  return { title, body }
}
