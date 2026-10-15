/** System presentation adapters; no request state or navigation policy lives here. */
import type { DesktopNotificationBridge, DesktopNotificationRequest, NotificationToken } from '../types.ts'

/** Permission and presentation availability exposed in General settings. */
export type NotificationPermissionState = 'granted' | 'default' | 'denied' | 'unsupported'
/** Withdrawable native presentation. */
export interface NoticeHandle { close(): void | Promise<void> }
/** Localized, non-sensitive system copy. */
export interface NoticeCopy { readonly title: string; readonly body: string }
/** The two supported platform providers implement only presentation and permission operations. */
export interface NotificationPlatform {
  permission(): Promise<NotificationPermissionState>
  requestPermission(): Promise<NotificationPermissionState>
  show(request: DesktopNotificationRequest, copy: NoticeCopy, click: () => void, failed: () => void): Promise<NoticeHandle | undefined>
  dispose(): void | Promise<void>
}

/**
 * Choose native Desktop presentation without falling back to browser notifications.
 * @param desktop - shell marker; absence selects the browser provider.
 * @returns one lifetime-owned provider.
 */
export function createNotificationPlatform(
  desktop: { protocolVersion: number; notifications?: DesktopNotificationBridge } | undefined,
): NotificationPlatform {
  if (desktop !== undefined) return new DesktopPlatform(desktop.protocolVersion === 1 ? desktop.notifications : undefined)
  return new BrowserPlatform()
}

class BrowserPlatform implements NotificationPlatform {
  permission(): Promise<NotificationPermissionState> {
    return Promise.resolve(typeof Notification === 'undefined' || !globalThis.isSecureContext ? 'unsupported' : Notification.permission)
  }

  requestPermission(): Promise<NotificationPermissionState> {
    if (typeof Notification === 'undefined' || !globalThis.isSecureContext) return Promise.resolve('unsupported')
    return Notification.requestPermission()
  }

  show(request: DesktopNotificationRequest, copy: NoticeCopy, click: () => void, failed: () => void): Promise<NoticeHandle> {
    const notice = new Notification(copy.title, { body: copy.body, tag: request.id, silent: true })
    notice.onclick = () => { window.focus(); click() }
    notice.onerror = failed
    return Promise.resolve({ close: () => { notice.onclick = null; notice.onerror = null; notice.close() } })
  }

  dispose(): void {}
}

class DesktopPlatform implements NotificationPlatform {
  private readonly callbacks = new Map<NotificationToken, { click: () => void; failed: () => void }>()
  private readonly unsubscribe: (() => void) | undefined

  constructor(private readonly bridge: DesktopNotificationBridge | undefined) {
    this.unsubscribe = bridge?.subscribe((event) => {
      const owner = this.callbacks.get(event.id)
      if (event.kind === 'click') owner?.click()
      else owner?.failed()
    })
  }

  async permission(): Promise<NotificationPermissionState> {
    return this.bridge !== undefined && await this.bridge.status() === 'available' ? 'granted' : 'unsupported'
  }

  requestPermission(): Promise<NotificationPermissionState> { return this.permission() }

  async show(
    request: DesktopNotificationRequest, _copy: NoticeCopy, click: () => void, failed: () => void,
  ): Promise<NoticeHandle | undefined> {
    if (this.bridge === undefined) return undefined
    this.callbacks.set(request.id, { click, failed })
    let result: Awaited<ReturnType<DesktopNotificationBridge['show']>>
    try { result = await this.bridge.show(request) }
    catch (error) { this.callbacks.delete(request.id); throw error }
    if (result !== 'shown') {
      this.callbacks.delete(request.id)
      if (result === 'failed') throw new Error('Native notification submission failed')
      return undefined
    }
    return { close: async () => {
      this.callbacks.delete(request.id)
      await this.bridge?.close(request.id)
    } }
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.()
    const tasks = [...this.callbacks.keys()].map(async (id) => {
      try { await this.bridge?.close(id) }
      catch (error) { console.warn('Interaction notification cleanup failed', error) }
    })
    this.callbacks.clear()
    await Promise.all(tasks)
  }
}
