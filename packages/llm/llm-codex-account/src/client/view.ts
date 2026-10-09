/** React presentation for the standalone Codex account settings section. */

import { Fragment, createElement, useEffect, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the Settings shell's SlotMap declaration of the section seat.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { type CodexOAuthCapabilityGap } from '../shared/index.ts'
import type { CodexOAuthCardSnapshot } from './card.ts'
import { CODEX_OAUTH_LOCALE_NAMESPACE } from './locales.ts'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './Card.module.css'
import { Catalog, type CatalogProps } from './native/Catalog.tsx'

const h = createElement

/** The section's own copy namespace, bound as the framework-injected translate seat. */
type CodexOAuthTranslate = TranslateNS<typeof CODEX_OAUTH_LOCALE_NAMESPACE>

/** Props from the settings section slot and the localized Codex injection. */
export type CodexOAuthSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<typeof CODEX_OAUTH_LOCALE_NAMESPACE> & InjectFace<CodexOAuthSectionInjected>

/** Injected state and actions consumed by one settings-section occurrence. */
export interface CodexOAuthSectionInjected {
  readonly hooks: { readonly card: ObservableSnapshot<CodexOAuthCardSnapshot> }
  readonly actions: CodexOAuthCardActions
  readonly attach: () => void
  readonly detach: () => void
  readonly catalog: Pick<CatalogProps, 'operations' | 'schema' | 't'>
}

/** What the view asks the controller to do. `CodexOAuthCard` satisfies it as it stands. */
export interface CodexOAuthCardActions {
  loadStatus(this: void): void
  startLogin(this: void): void
  cancelLogin(this: void): void
  reopenAuthorization(this: void): void
  retryRouteWrite(this: void): void
  requestLogout(this: void): void
  dismissLogout(this: void): void
  confirmLogout(this: void): void
}

/** Input of one card render. */
export interface CodexOAuthCardViewInput {
  readonly snapshot: CodexOAuthCardSnapshot
  readonly t: CodexOAuthTranslate
  readonly actions: CodexOAuthCardActions
}

/**
 * Render the Codex account section and attach its page controller while mounted.
 * @param props - slot props and the injected card actions.
 * @returns The account card and catalog editor.
 */
export function CodexOAuthSection(props: CodexOAuthSectionProps): ReactNode {
  const { useCard, attach, detach, actions, catalog, t } = props
  const snapshot = useCard(value => value)
  useEffect(() => {
    attach()
    return detach
  }, [attach, detach])
  return h('div', null,
    codexOAuthCardView({ snapshot, t, actions }),
    h(Catalog, { ...catalog,
      reloadToken: snapshot.catalogVersion,
      disabled: snapshot.route.kind === 'writing' || snapshot.catalogSaving, onSaved: actions.loadStatus,
    }))
}

/**
 * Render one card occurrence from a snapshot.
 * @param input - the snapshot, the translate seat, and the controller actions.
 * @returns the card element.
 */
export function codexOAuthCardView(input: CodexOAuthCardViewInput): ReactNode {
  const { snapshot, t, actions } = input
  // Announced only while the card is working, so assistive technology is never told "busy" forever.
  const busyAttribute: { 'aria-busy'?: true } = isBusy(snapshot) ? { 'aria-busy': true } : {}
  return h('div', {
    className: styles['card'],
    role: 'group',
    'aria-label': t('card.title'),
    ...busyAttribute,
  },
  h('p', { className: styles['title'] }, t('card.title')),
  statusSection(snapshot, t, actions))
}

/** Whether an official call the card started is still in flight. */
function isBusy(snapshot: CodexOAuthCardSnapshot): boolean {
  return snapshot.login.kind === 'starting'
    || snapshot.login.kind === 'pending'
    || snapshot.route.kind === 'writing'
    || snapshot.logout.kind === 'running'
    || snapshot.catalogSaving

}

/** The `status` facts, the attempt, the route, and the sign-out. */
function statusSection(
  snapshot: CodexOAuthCardSnapshot,
  t: CodexOAuthTranslate,
  actions: CodexOAuthCardActions,
): ReactNode {
  const status = snapshot.status
  if (status.kind === 'loading') return h('p', { className: styles['status'], role: 'status' }, t('card.loading'))
  if (status.kind === 'failed') {
    return h('p', { className: styles['error'], role: 'alert' },
      t(`failure.${status.code}`),
      h(Button, { variant: 'outline', type: 'button', onClick: actions.loadStatus }, t('card.retry')))
  }
  const record = h('p', { className: styles['status'], role: 'status' },
    t(status.recordStored ? 'card.recordStored' : 'card.recordAbsent'))
  return h(Fragment, null,
    record,
    status.available ? null : h('p', { className: styles['error'], role: 'alert' }, gapCopy(status.gap, t)),
    loginSection(snapshot, t, actions),
    accountButton(snapshot, t, actions, status.available, status.recordStored),
    snapshot.route.kind === 'failed' ? h('div', { role: 'alert', className: styles['error'] },
      t(`failure.${snapshot.route.code}`),
      h(Button, { type: 'button', variant: 'outline', disabled: isBusy(snapshot), onClick: actions.retryRouteWrite }, t('card.retry'))) : null,
    snapshot.logout.kind !== 'idle' ? logoutSection(snapshot, t, actions) : null)
}

/** The copy for the first missing official dependency. */
function gapCopy(gap: CodexOAuthCapabilityGap | null, t: CodexOAuthTranslate): string {
  return gap === null ? t('card.loginUnavailable') : t(`gap.${gap}`)
}

/** The attempt's own states: one open path, one cancel, and no manual-code entry anywhere. */
function loginSection(
  snapshot: CodexOAuthCardSnapshot,
  t: CodexOAuthTranslate,
  actions: CodexOAuthCardActions,
): ReactNode {
  const login = snapshot.login
  switch (login.kind) {
    case 'idle':
      return null
    case 'starting':
      return h('div', { className: styles['actions'] },
        h('p', { className: styles['status'], role: 'status' }, t('login.starting')),
        cancelButton(t, actions))
    case 'pending':
      if (login.authUrl === null) {
        return h('div', { className: styles['actions'] },
          h('p', { className: styles['status'], role: 'status' }, t('login.starting')),
          cancelButton(t, actions))
      }
      return h('div', { className: styles['actions'] },
        h('p', { className: styles['status'], role: 'status' }, t('login.waiting')),
        h(Button, {
          variant: 'outline',
          type: 'button',
          onClick: actions.reopenAuthorization,
        }, t('login.reopen')),
        cancelButton(t, actions))
    case 'authorized':
      return h('p', { className: styles['status'], role: 'status' }, t('login.authorized'))
    case 'cancelled':
      return h('p', { className: styles['status'], role: 'status' }, t(`cancelled.${login.reason}`))
    default:
      return h('p', { className: styles['error'], role: 'alert' }, t(`failure.${login.code}`))
  }
}

function accountButton(
  snapshot: CodexOAuthCardSnapshot,
  t: CodexOAuthTranslate,
  actions: CodexOAuthCardActions,
  available: boolean,
  recordStored: boolean,
): ReactNode {
  if (snapshot.login.kind === 'starting' || snapshot.login.kind === 'pending') return null
  if (!recordStored && !available) return null
  return h(Button, {
    variant: 'primary',
    className: styles['accountButton'],
    type: 'button',
    disabled: isBusy(snapshot) || snapshot.logout.kind === 'confirming',
    onClick: recordStored ? actions.requestLogout : actions.startLogin,
  }, t(recordStored ? 'logout.request' : 'login.start'))
}

/** The local sign-out, which never touches the model configuration. */
function logoutSection(
  snapshot: CodexOAuthCardSnapshot,
  t: CodexOAuthTranslate,
  actions: CodexOAuthCardActions,
): ReactNode {
  const logout = snapshot.logout
  return h('div', { className: styles['group'] },
    ...logoutAction(logout, t, actions))
}

/** One sign-out step at a time, always behind a confirmation that states its scope. */
function logoutAction(
  logout: CodexOAuthCardSnapshot['logout'],
  t: CodexOAuthTranslate,
  actions: CodexOAuthCardActions,
): ReactNode[] {
  switch (logout.kind) {
    case 'idle':
      return []
    case 'confirming':
      return [h(Modal, {
        open: true, onClose: actions.dismissLogout,
        title: t('logout.confirm'), closeLabel: t('logout.confirmNo'),
        description: t('logout.confirmNote'),
        footer: h('div', { className: styles['actions'] },
          h(Button, { variant: 'outline', onClick: actions.dismissLogout }, t('logout.confirmNo')),
          h(Button, { variant: 'primary', onClick: actions.confirmLogout }, t('logout.confirmYes'))),
      })]
    case 'running':
      return [h('p', { className: styles['status'], role: 'status' }, t('logout.running'))]
    case 'removed':
      return [h('p', { className: styles['status'], role: 'status' }, t('logout.removed'))]
    default:
      return [
        h('p', { className: styles['error'], role: 'alert' }, t(`failure.${logout.code}`)),
      ]
  }
}

function cancelButton(t: CodexOAuthTranslate, actions: CodexOAuthCardActions): ReactNode {
  return h(Button, {
    variant: 'outline',
    type: 'button',
    onClick: actions.cancelLogin,
  }, t('login.cancel'))
}
