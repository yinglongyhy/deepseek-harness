/** Local notification preference and browser-permission controls. */
import { useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NotificationState } from './controller.ts'
import css from './NotificationRow.module.css'

/** Renderer-bound preference and narrow imperative actions. */
export interface NotificationRowInjected {
  hooks: { notifications: ObservableSnapshot<NotificationState> }
  setEnabled(enabled: boolean): void
  requestPermission(): Promise<void>
}

/**
 * Render the local toggle and permission guidance without requesting permission on mount.
 * @param props - framework-bound state, actions, and locale.
 * @returns one General Settings row.
 */
export function NotificationRow({ useNotifications, setEnabled, requestPermission, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'interactionNotifications'> & InjectFace<NotificationRowInjected>) {
  const state = useNotifications(value => value)
  const [busy, setBusy] = useState(false)
  return <div className={css.row}>
    <div className={css.content}>
      <div className={css.title}>{t('title')}</div>
      <div className={css.description}>{t('description')}</div>
      {state.enabled && <>
        <div className={css.description} role="status">{t(state.permission)}</div>
        {state.failed && <div className={css.description} role="alert">{t('failure')}</div>}
        {(state.permission === 'default' || state.failed) && <Button size="sm" variant="outline" disabled={busy}
          onClick={() => {
            setBusy(true)
            void requestPermission().finally(() => { setBusy(false) })
          }}>{t(state.permission === 'default' ? 'permission' : 'retry')}</Button>}
      </>}
    </div>
    <Switch checked={state.enabled} label={t('title')} onChange={setEnabled} />
  </div>
}
