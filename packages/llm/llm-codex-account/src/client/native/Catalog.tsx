import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { CODEX_PROVIDER_ID } from '../../shared/index.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import { modelDrafts, validateDeepSeekModels } from './model-draft.ts'
import { pathOps } from './path-ops.ts'
import { CatalogReadFailure, type CatalogOperations } from './operations.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

export interface CatalogProps {
  operations: CatalogOperations
  schema: SettingsSchemaOperations
  t: (key: ModelsKey) => string
  reloadToken: number | null
  disabled: boolean
  onSaved: () => void
}

export function Catalog(props: CatalogProps): ReactNode {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<CatalogOperations['read']>>>()
  const [loadFailure, setLoadFailure] = useState<{ diagnostic?: string }>()
  const [retry, setRetry] = useState(0)
  const dirty = useRef(false)
  useEffect(() => {
    if (dirty.current) return
    let current = true
    void props.operations.read().then((value) => {
      if (!current || dirty.current) return
      setLoaded(value)
      setLoadFailure(undefined)
    }, (error: unknown) => {
      if (current && !dirty.current) setLoadFailure(error instanceof CatalogReadFailure ? { diagnostic: error.diagnostic } : {})
    })
    return () => { current = false }
  }, [props.operations, props.reloadToken, retry])
  return <>
    {loadFailure !== undefined ? <>
      <p className={styles['error']} role="alert">
        {props.t('loadFailed')}
        {loadFailure.diagnostic ? <><br />{loadFailure.diagnostic}</> : null}
      </p>
      <Button variant="outline" onClick={() => { setRetry(value => value + 1) }}>{props.t('retry')}</Button>
    </> : loaded === undefined ? null : <LoadedCatalog key={`${loaded.namespace.ns}:${String(loaded.namespace.revision)}`} {...props}
      namespace={loaded.namespace} path={loaded.path} writable={loaded.writable}
      onDirty={(value) => { dirty.current = value }}
      onDiscard={() => { setRetry(value => value + 1) }} />}
  </>
}

function LoadedCatalog(props: CatalogProps & {
  namespace: SettingsNamespaceView
  path: readonly string[]
  writable: boolean
  onDirty: (dirty: boolean) => void
  onDiscard: () => void
}): ReactNode {
  const { namespace, schema, path, operations, t } = props
  const [draft, setDraft] = useState<Record<string, unknown>>(() => {
    const models = schema.getPath(namespace.user, [...path, 'models'])
    return models === undefined ? {} : { models: structuredClone(models) }
  })
  const [original, setOriginal] = useState<Record<string, unknown>>(draft)
  const [revision, setRevision] = useState(namespace.revision)
  const [editingResetToken, setEditingResetToken] = useState(0)
  const [busy, setBusy] = useState(false)
  const [listBusy, setListBusy] = useState(false)
  const [failure, setFailure] = useState<{ key: 'conflict' | 'saveFailed'; diagnostic?: string }>()
  const current = useRef(true)
  useEffect(() => { current.current = true; return () => { current.current = false } }, [])
  const overridden = schema.hasPath(draft, ['models'])
  const inherited = schema.getPath(namespace.base, [...path, 'models'])
  const models = overridden ? modelDrafts(draft['models'])
    : inherited === undefined ? undefined : modelDrafts(inherited)
  const fallback = schema.getPath(namespace.value, path)
  const defaultInput = schema.getPath(fallback, ['defaultInput'])
  const modelFailure = validateDeepSeekModels(draft['models'])
  const disabled = props.disabled || !props.writable || busy
  const replace = (next: Record<string, unknown>): void => {
    props.onDirty(JSON.stringify(next) !== JSON.stringify(original))
    setDraft(next)
    setFailure(undefined)
  }
  const resetDraft = (next: Record<string, unknown>): void => {
    replace(next)
    setEditingResetToken(value => value + 1)
  }
  const save = async (): Promise<void> => {
    if (disabled || listBusy || modelFailure !== undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      const ops = pathOps(path, original, draft)
      if (ops.length > 0) {
        const written = await operations.writeSettings(namespace.ns, ops, revision)
        if (!current.current) return
        if (written.kind !== 'written') {
          setFailure({ key: written.kind === 'conflict' ? 'conflict' : 'saveFailed', diagnostic: written.message })
          return
        }
        setRevision(written.view.revision)
      }
      setOriginal(draft)
      props.onDirty(false)
      props.onSaved()
    } catch {
      if (current.current) setFailure({ key: 'saveFailed' })
    } finally {
      if (current.current) setBusy(false)
    }
  }
  return <div className={styles['editor']}>
    {!props.writable ? <p className={styles['advancedHint']}>{t('readOnly')}</p> : null}
    <ModelListEditor models={models} overridden={overridden} catalogProvider={CODEX_PROVIDER_ID} resetToken={editingResetToken}
      defaultInput={Array.isArray(defaultInput) ? defaultInput : undefined}
      onChange={(next) => { replace({ models: next }) }} onReset={() => { resetDraft({}) }}
      probe={{ settingsNs: namespace.ns }} operations={operations} t={t}
      disabled={disabled} onBusyChange={setListBusy} />
    {failure !== undefined ? <p className={styles['error']} role="alert">
      {t(failure.key)}
      {failure.diagnostic ? <><br />{failure.diagnostic}</> : null}
    </p> : null}
    {modelFailure === undefined ? null : <p className={styles['error']} role="alert">
      {`${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`}
    </p>}
    <EditorFooter t={t} busy={busy}
      cancelDisabled={props.disabled || listBusy || JSON.stringify(draft) === JSON.stringify(original)}
      submitDisabled={disabled || listBusy || modelFailure !== undefined}
      submitLabelKey="apply" submitBusyLabelKey="applying"
      onCancel={() => { resetDraft(structuredClone(original)); props.onDiscard() }} onSubmit={() => { void save() }} />
  </div>
}
