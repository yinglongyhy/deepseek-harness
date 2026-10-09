import { useEffect, useId, useState, type ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { CODEX_OAUTH_CHANNEL } from '../shared/protocol.ts'
import {
  PROVIDER_INFO_ENDPOINT, infoProvider, parseProviderInfoResult,
  type InfoProvider, type ProviderInfo, type ProviderInfoResult,
} from '../shared/provider-info.ts'
import { CODEX_OAUTH_LOCALE_NAMESPACE } from './locales.ts'
import styles from './ProviderInfo.module.css'

export class ProviderInfoChannel {
  constructor(private readonly rpc: ClientConnectionRpc) {}

  async read(provider: InfoProvider): Promise<ProviderInfoResult> {
    const result = await this.rpc.call(CODEX_OAUTH_CHANNEL, PROVIDER_INFO_ENDPOINT, { provider })
    const parsed = result.ok ? parseProviderInfoResult(result.value) : undefined
    if (parsed === undefined || (parsed.info !== null && parsed.info.provider !== provider)) throw new Error('provider-info-unavailable')
    return parsed
  }
}

export class ProviderInfoRevision implements ObservableSnapshot<number> {
  private revision = 0
  private readonly listeners = new Set<() => void>()
  readonly getSnapshot = (): number => this.revision
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  readonly invalidate = (): void => {
    this.revision++
    for (const listener of this.listeners) listener()
  }
}

type Translate = TranslateNS<typeof CODEX_OAUTH_LOCALE_NAMESPACE>

function formattingLocale(locale: string): string {
  try { return Intl.DateTimeFormat.supportedLocalesOf(locale)[0] ?? 'en' }
  catch { return 'en' }
}

export function providerInfoText(info: ProviderInfo, t: Translate, locale: string): string {
  const language = formattingLocale(locale)
  if (info.provider === 'deepseek-official') return new Intl.NumberFormat(language, {
    style: 'currency', currency: info.currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(info.balance))
  const parts: string[] = []
  const format = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 })
  if (info.fiveHour !== undefined) parts.push(t('info.fiveHourShort', { percent: format.format(info.fiveHour.remainingPercent / 100) }))
  if (info.week !== undefined) parts.push(t('info.weekShort', { percent: format.format(info.week.remainingPercent / 100) }))
  return parts.join(t('info.separator'))
}

function infoTitle(info: ProviderInfo, t: Translate, locale: string): string {
  const date = (timestamp: number): string => new Date(timestamp).toLocaleString(formattingLocale(locale))
  const lines = [t(info.provider === 'deepseek-official' ? 'info.balance' : 'info.remaining')]
  if (info.provider === 'openai-codex') {
    if (info.fiveHour?.resetsAt != null) lines.push(`${t('info.fiveHourReset')} ${date(info.fiveHour.resetsAt)}`)
    if (info.week?.resetsAt != null) lines.push(`${t('info.weekReset')} ${date(info.week.resetsAt)}`)
  }
  lines.push(`${t('info.updated')} ${date(info.queriedAt)}`)
  return lines.join('\n')
}

export interface ProviderInfoInjected {
  readonly hooks: {
    readonly directory: ObservableSnapshot<Pick<ModelDirectoryState, 'current'>>
    readonly revision: ObservableSnapshot<number>
    readonly locale: ObservableSnapshot<Pick<LocaleSnapshot, 'active'>>
  }
}

export type ProviderInfoProps = PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<typeof CODEX_OAUTH_LOCALE_NAMESPACE> & InjectFace<ProviderInfoInjected>

export function createProviderInfoFooter(
  channel: Pick<ProviderInfoChannel, 'read'>,
): (props: ProviderInfoProps) => ReactNode {
  return function ProviderInfoFooter({ useDirectory, useRevision, useLocale, useSession, t }: ProviderInfoProps): ReactNode {
    const provider = useDirectory(selection => infoProvider(selection.current?.provider))
    const revision = useRevision(value => value)
    const locale = useLocale(value => value.active)
    const running = useSession(session => session.running)
    const descriptionId = useId()
    const [snapshot, setSnapshot] = useState<{ provider: InfoProvider; revision: number; info: ProviderInfo } | null>(null)
    useEffect(() => {
      if (provider === undefined) return
      let active = true
      const isActive = (): boolean => active
      let pending = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const refresh = async (): Promise<void> => {
        if (!active || pending || document.visibilityState === 'hidden') return
        pending = true
        if (timer !== undefined) clearTimeout(timer)
        let interval = 60_000
        try {
          const result = await channel.read(provider)
          interval = result.refreshIntervalMs
          if (isActive()) setSnapshot(result.info === null ? null : { provider, revision, info: result.info })
        } catch {
          if (isActive()) setSnapshot(null)
        } finally {
          pending = false
          if (isActive()) timer = setTimeout(() => { void refresh() }, interval)
        }
      }
      const visible = (): void => { void refresh() }
      document.addEventListener('visibilitychange', visible)
      window.addEventListener('focus', visible)
      void refresh()
      return () => {
        active = false
        if (timer !== undefined) clearTimeout(timer)
        document.removeEventListener('visibilitychange', visible)
        window.removeEventListener('focus', visible)
      }
    }, [provider, revision, running])
    if (provider === undefined || snapshot?.provider !== provider || snapshot.revision !== revision) return null
    const text = providerInfoText(snapshot.info, t, locale)
    const details = infoTitle(snapshot.info, t, locale)
    return <>
      <span id={descriptionId} hidden>{text}{'\n'}{details}</span>
      <Tooltip label={details} side="top" portal>
        <span className={styles['pill']} role="group" tabIndex={0} aria-describedby={descriptionId} aria-label={t(snapshot.info.provider === 'deepseek-official' ? 'info.balance' : 'info.remaining')}>
          {text}
        </span>
      </Tooltip>
    </>
  }
}
