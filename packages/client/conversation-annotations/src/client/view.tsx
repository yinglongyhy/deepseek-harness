/** Chat annotations UI: composer summary, selection actions, and verified message history. */
import { createRef, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import {
  Button, HoverCard, MenuSurface, Tooltip, useAnchoredPosition,
  IconCloseOutlineRegular, IconEditOutlineRegular,
  IconPlusOutlineRegular, IconTrashOutlineRegular, ReferenceIconRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ChatTextNavigationResult, ChatTextSelection } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AnnotationSessionSnapshot, EditorState, HistoryState, SelectionState } from './controller.ts'
import type { CapturedAnnotation } from '../shared.ts'
import type { Annotation, AnnotationId } from '../draft.ts'
import { NAMESPACE } from './locales.ts'
import { annotationDisplayText, pendingAnnotationDisplayText } from './presentation.ts'
import styles from './Annotations.module.css'

type T = TranslateNS<typeof NAMESPACE>
/** Store hooks and mutations consumed by the composer annotation summary. */
export interface SummaryInjected {
  readonly available: boolean
  readonly hooks: { readonly annotations: ObservableSnapshot<AnnotationSessionSnapshot> }
  readonly edit: (id: AnnotationId) => Promise<void>
  readonly remove: (id: AnnotationId) => void
  readonly releaseEditor: () => void
  readonly clear: () => void
  readonly navigate: (id: AnnotationId) => Promise<void>
  readonly retry: () => Promise<void>
  readonly reconcile: () => Promise<void>
}
/** Framework-derived inputs for the composer annotation summary. */
export type SummaryProps = PropsRuntime<'conversation.input.summary'> & PropsLocale<typeof NAMESPACE> & InjectFace<SummaryInjected>

/** Mutations available to the annotation editor. */
export interface EditorCommands {
  readonly update: (value: string) => void
  readonly save: () => void
  readonly cancel: () => void
  readonly removeEditor: () => void
}
/** Local selection/editor hooks and mutations for the selection action. */
export interface SelectionInjected extends EditorCommands {
  readonly hooks: { readonly selection: ObservableSnapshot<SelectionState>; readonly editor: ObservableSnapshot<EditorState | null> }
  readonly add: (source: ChatTextSelection) => void
}
/** Framework-derived inputs for the shell selection action. */
export type SelectionProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NAMESPACE> & InjectFace<SelectionInjected>

/** Keyed annotation history and source navigation shared by message renderers. */
export interface HistoryInjected {
  readonly keyedHooks: { readonly history: (key: string) => ObservableSnapshot<HistoryState> }
  readonly navigate: (annotation: CapturedAnnotation) => Promise<ChatTextNavigationResult>
}

function navigation(status: string | null, t: T): ReactNode {
  if (status === 'missing' || status === 'changed' || status === 'unavailable') {
    return <p className={styles['status']} role="status">{t(status)}</p>
  }
  return null
}
function badge(count: number, t: T, onClick: () => void, ref?: RefObject<HTMLButtonElement>, expanded = false, label: 'count' | 'historyCount' = 'count'): ReactNode {
  return <Button ref={ref} size="sm" variant="ghost" className={styles['badge']} aria-haspopup="dialog" aria-expanded={expanded} onClick={onClick}>
    <ReferenceIconRegular kind="session" size={14} />{t(label, { count })}
  </Button>
}
function removeAction(label: string, disabled: boolean, onClick: () => void): ReactNode {
  return <Tooltip label={label} side="top" portal>
    <Button size="sm" className={styles['iconAction']} disabled={disabled} aria-label={label} onClick={onClick}>
      <IconTrashOutlineRegular size={16} />
    </Button>
  </Tooltip>
}

/** One non-modal source editor, owned by the root overlay rather than the composer list. */
/** Renders the active annotation comment editor.
 * @param editor - Current editor draft.
 * @param t - Localized copy.
 * @param update - Draft mutation.
 * @param save - Commits the draft.
 * @param cancel - Discards the draft.
 * @param removeEditor - Closes the editor.
 * @returns The editor controls or null when inactive.
 */
export function SourceEditor({
  editor, t, update, save, cancel, removeEditor,
}: EditorCommands & { editor: EditorState | null; t: T }): ReactNode {
  const rect = editor?.rectangles?.at(-1)
  const anchorRef = useMemo(() => createRef<HTMLSpanElement>(), [rect?.x, rect?.y, rect?.width, rect?.height])
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open: !!editor, anchorRef, panelRef, side: 'bottom', gap: 10, margin: 12 })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const positioned = !!position
  // A hidden, not-yet-positioned floating panel cannot receive browser focus.
  useEffect(() => {
    if (editor && !editor.frozen && positioned) textareaRef.current?.focus({ preventScroll: true })
  }, [editor?.sessionId, editor?.annotation.id, editor?.frozen, positioned])
  if (!editor) return null
  return <>
    <span ref={anchorRef} aria-hidden="true" className={styles['selectionAnchor']} style={{
      '--annotations-anchor-x': `${rect ? rect.x + rect.width : 12}px`,
      '--annotations-anchor-y': `${rect?.y ?? 80}px`,
      '--annotations-anchor-width': '0px', '--annotations-anchor-height': `${rect?.height ?? 0}px`,
    } as CSSProperties} />
    <MenuSurface ref={panelRef} role="dialog" aria-modal="false" aria-label={t('edit', { number: editor.number })}
      className={styles['sourceEditor']} style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); cancel()
        }
      }}>
      {!rect && navigation('unavailable', t)}
      {editor.error && <p className={styles['error']} role="alert">{t('error')}</p>}
      <textarea key={editor.annotation.id} ref={textareaRef} className={styles['editor']} rows={1}
        aria-label={t('comment')} disabled={editor.frozen} placeholder={t('placeholder')} value={editor.value}
        onChange={(event) =>{  update(event.currentTarget.value) }} />
      <div className={styles['editActions']}>
        {removeAction(t('remove', { number: editor.number }), editor.frozen, removeEditor)}
        <Button size="sm" disabled={editor.frozen} onClick={cancel}>{t('cancel')}</Button>
        <Button size="sm" disabled={editor.frozen} variant="primary" onClick={save}>{t('save')}</Button>
      </div>
    </MenuSurface>
  </>
}

/** Clickable record content is a native button; edit/delete are independent sibling actions. */
function recordRow(annotation: Annotation, index: number, t: T, reveal: () => void, actions?: ReactNode, disabled = false): ReactNode {
  return <li key={annotation.id} className={styles['item']}>
    <button type="button" className={styles['record']} disabled={disabled} onClick={reveal}>
      <span className={styles['recordNumber']}>{index + 1}.</span>
      <span className={styles['recordContent']}>
        <span className={styles['recordField']}>
          <span className={styles['label']}>{t('selectedText')}</span>
          <span className={styles['recordQuote']}>{annotation.anchor.selectedText}</span>
        </span>
        <span className={styles['recordField']}>
          <span className={styles['label']}>{t('recordComment')}</span>
          <span className={styles['recordComment']}>{annotation.comment || t('empty')}</span>
        </span>
      </span>
    </button>
    {actions && <div className={styles['rowActions']}>{actions}</div>}
  </li>
}

/** Share native preview behavior and panel sizing without widening the message bubble. */
function AnnotationPreview({ anchor, content, disabled }: { anchor: ReactNode; content: ReactNode; disabled: boolean }): ReactNode {
  const widthAnchorRef = useRef<HTMLSpanElement>(null)
  return <span className={styles['previewAnchor']}>
    <span ref={widthAnchorRef} className={styles['previewWidthAnchor']} aria-hidden="true" />
    <HoverCard variant="preview" widthAnchorRef={widthAnchorRef} disabled={disabled} anchor={anchor} content={content} />
  </span>
}

function Details({ open, anchorRef, children, close, t }: {
  open: boolean
  anchorRef: RefObject<HTMLButtonElement>
  children: ReactNode
  close: () => void
  t: T
}): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, side: 'top', gap: 8, margin: 12 })
  if (!open) return null
  const dismiss = (): void => { close(); anchorRef.current?.focus({ preventScroll: true }) }
  return <MenuSurface ref={panelRef} role="dialog" aria-modal="false" aria-label={t('title')}
    className={styles['detailsPanel']} style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); dismiss()
      }
    }}>
    <div className={styles['detail']}>{children}</div>
  </MenuSurface>
}

/** Renders the composer summary, pending status, and edit controls.
 * @param props - Session and annotation actions.
 * @returns The composer annotation UI.
 */
export function Summary(props: SummaryProps): ReactNode {
  const state = props.useAnnotations(value => value)
  const badgeRef = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(false)
  const { draft, pending } = state
  const count = draft.annotations.length || pending?.snapshot.annotations.length || 0
  useEffect(() => props.releaseEditor, [props.releaseEditor])
  useEffect(() => { if (count === 0 || draft.edit) setExpanded(false) }, [count, draft.edit?.annotationId])
  if (!props.available) return null
  if (count === 0 && !state.error) return null
  const frozen = new Set(state.frozenIds)
  const rows = draft.annotations.length ? draft.annotations : pending?.snapshot.annotations ?? []
  const readOnly = draft.annotations.length === 0
  const records = rows.map((annotation, index) => recordRow(annotation, index, props.t,
    () => {
      setExpanded(false)
      badgeRef.current?.focus({ preventScroll: true })
      void props.navigate(annotation.id)
    }, !readOnly && <>
      <Tooltip label={props.t('edit', { number: index + 1 })} side="top" portal>
        <Button size="sm" className={styles['iconAction']} aria-label={props.t('edit', { number: index + 1 })}
          disabled={frozen.has(annotation.id)} onClick={() => { setExpanded(false); void props.edit(annotation.id) }}>
          <IconEditOutlineRegular size={16} />
        </Button>
      </Tooltip>
      {removeAction(props.t('remove', { number: index + 1 }), frozen.has(annotation.id), () =>{  props.remove(annotation.id) })}
    </>, readOnly))
  return <section className={`${styles['summary']} ${styles['composerSummary']}`} aria-label={props.t('title')} aria-busy={state.busy}>
    <div className={styles['badgeGroup']}>
      <AnnotationPreview disabled={expanded || draft.edit !== null}
        anchor={badge(count, props.t, () => {
          setExpanded(value => !value)
          if (draft.annotations.length === 1) {
            const annotation = draft.annotations[0]
            if (annotation) void props.navigate(annotation.id)
          }
        }, badgeRef, expanded)}
        content={<ol className={`${styles['list']} ${styles['preview']}`}>{records}</ol>} />
      {draft.annotations.length > 0 && <Tooltip label={props.t('clear')} side="top" portal>
        <Button size="sm" variant="outline" className={`${styles['iconAction']} ${styles['clearAction']}`} aria-label={props.t('clear')} disabled={frozen.size > 0} onClick={props.clear}>
          <IconCloseOutlineRegular size={16} />
        </Button>
      </Tooltip>}
    </div>
    {state.error && <p className={styles['error']} role="alert">{props.t('error')}</p>}
    {state.error && !pending && <Button size="sm" disabled={state.busy} onClick={() => { void props.reconcile() }}>{props.t('reconcile')}</Button>}
    {navigation(state.navigation, props.t)}
    {pending && <div className={styles['actions']}>
      <span role="status">{props.t(pending.status)}</span>
      <Button size="sm" disabled={state.busy || draft.edit !== null} onClick={() => { void props.retry() }}>{props.t('retry')}</Button>
      <Button size="sm" disabled={state.busy} onClick={() => { void props.reconcile() }}>{props.t('reconcile')}</Button>
    </div>}
    <Details open={expanded} anchorRef={badgeRef} close={() =>{  setExpanded(false) }} t={props.t}>
      {pending && frozen.size > 0 && <p className={styles['status']}>{props.t('frozen')}</p>}
      <ol className={styles['list']}>{records}</ol>
    </Details>
  </section>
}

/** Renders the annotation action for a current text selection.
 * @param props - Selection and editor actions.
 * @returns The anchored action when a source is available.
 */
export function SelectionAction(props: SelectionProps): ReactNode {
  const selection = props.useSelection(value => value)
  const source = selection.source
  const editor = props.useEditor(value => value)
  const rect = selection.rectangles?.[0]
  const anchorRef = useMemo(() => createRef<HTMLSpanElement>(), [rect?.x, rect?.y, rect?.width, rect?.height])
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open: !!source && !!rect && !editor, anchorRef, panelRef, side: 'top', gap: 8, margin: 8 })
  return <>
    <SourceEditor editor={editor} t={props.t} update={props.update} save={props.save}
      cancel={props.cancel} removeEditor={props.removeEditor} />
    {!editor && source && rect && <>
      <span ref={anchorRef} aria-hidden="true" className={styles['selectionAnchor']} style={{
        '--annotations-anchor-x': `${rect.x}px`, '--annotations-anchor-y': `${rect.y}px`,
        '--annotations-anchor-width': `${rect.width}px`, '--annotations-anchor-height': `${rect.height}px`,
      } as CSSProperties} />
      <MenuSurface compact ref={panelRef} className={styles['selection']} style={{
        '--annotations-left': `${position?.left ?? 0}px`, '--annotations-top': `${position?.top ?? 0}px`, visibility: position ? 'visible' : 'hidden',
      } as CSSProperties}>
        <Button size="sm" onPointerDown={(event) =>{  event.preventDefault() }} onClick={() =>{  props.add(source) }}>
          <IconPlusOutlineRegular size={14} />{props.t('add')}
        </Button>
      </MenuSurface>
    </>}
  </>
}

/** Props derived from the user-presentation shares and annotation history injection. */
export type UserPresentationProps = PropsRuntime<'conversation.chat.user-presentation'> & PropsRenderFactories & PropsLocale<typeof NAMESPACE> & InjectFace<HistoryInjected>

/** Renders verified annotation history beside the native user message.
 * @param props - Message and history inputs.
 * @returns The summary and native message presentation.
 */
export function UserPresentation({
  node, sessionId, useHistory, navigate, t, renderFactorySlot, loadImage,
}: UserPresentationProps): ReactNode {
  const { requestId, messageId, content } = node.data
  const history = useHistory(JSON.stringify([requestId ?? '', messageId]), value => value)
  const native = { node, loadImage }
  if (!requestId) return renderFactorySlot('conversation.chat.user-message', native)
  if (!history?.record) {
    if (!history || history.busy || history.error) return <p role="status">{t(history?.error ? 'historyError' : 'historyLoading')}</p>
    return renderFactorySlot('conversation.chat.user-message', native)
  }
  const modelText = content.filter(block => block.type === 'text').map(block => block.text).join('')
  const text = annotationDisplayText(history.record, { sessionId, requestId, messageId }, modelText)
  if (text === null) return <p role="status">{t('historyError')}</p>
  return <>
    <HistorySummary annotations={history.record.snapshot.annotations} navigate={navigate} t={t} />
    {renderFactorySlot('conversation.chat.user-message', { ...native, text })}
  </>
}

/** Props derived from the pending-user shares and annotation history injection. */
export type PendingUserPresentationProps = PropsRuntime<'conversation.chat.pending-user-presentation'> & PropsRenderFactories & PropsLocale<typeof NAMESPACE> & InjectFace<HistoryInjected>

/** Renders verified annotation history beside the native pending message.
 * @param props - Pending input and history values.
 * @returns The summary and native pending-message presentation.
 */
export function PendingUserPresentation({
  input, sessionId, useHistory, navigate, t, renderFactorySlot, loadImage,
}: PendingUserPresentationProps): ReactNode {
  const local = 'requestId' in input
  const requestId = local ? input.requestId : input.source.kind === 'user' && 'rpcId' in input.source ? input.source.rpcId : undefined
  const history = useHistory(requestId ?? '', value => value)
  const native = { input, loadImage }
  if (!requestId) return renderFactorySlot('conversation.chat.pending-user-message', native)
  if (!history?.record) {
    if (!history || history.busy || history.error) return <p role="status">{t(history?.error ? 'historyError' : 'historyLoading')}</p>
    return renderFactorySlot('conversation.chat.pending-user-message', native)
  }
  const modelText = local ? input.text : input.content.filter(block => block.type === 'text').map(block => block.text).join('')
  const text = pendingAnnotationDisplayText(history.record, { sessionId, requestId }, modelText)
  if (text === null) return <p role="status">{t('historyError')}</p>
  return <>
    <HistorySummary annotations={history.record.snapshot.annotations} navigate={navigate} t={t} />
    {renderFactorySlot('conversation.chat.pending-user-message', { ...native, text })}
  </>
}

function HistorySummary({ annotations, navigate, t }: {
  annotations: readonly CapturedAnnotation[]
  navigate: HistoryInjected['navigate']
  t: T
}): ReactNode {
  const badgeRef = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const reveal = (annotation: CapturedAnnotation): void => {
    void navigate(annotation).then((result) =>{  setStatus(result.status) }, () =>{  setStatus('unavailable') })
  }
  const rows = annotations.map((annotation, index) => recordRow(annotation, index, t, () => {
    setExpanded(false)
    badgeRef.current?.focus({ preventScroll: true })
    reveal(annotation)
  }))
  return <section className={`${styles['summary']} ${styles['historySummary']}`} aria-label={t('title')}>
    <div className={styles['badgeGroup']}>
      <AnnotationPreview disabled={expanded}
        anchor={badge(annotations.length, t, () => {
          setExpanded(value => !value)
          if (annotations.length === 1) {
            const annotation = annotations[0]
            if (annotation) reveal(annotation)
          }
        }, badgeRef, expanded, 'historyCount')} content={<ol className={`${styles['list']} ${styles['preview']}`}>{rows}</ol>} />
    </div>
    {navigation(status, t)}
    <Details open={expanded} anchorRef={badgeRef} close={() =>{  setExpanded(false) }} t={t}>
      <ol className={styles['list']}>{rows}</ol>
    </Details>
  </section>
}
