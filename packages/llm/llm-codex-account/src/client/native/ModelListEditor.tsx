import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatCapacity, parseCapacity } from './model-draft.ts'
import type { ModelsOperations } from './operations.ts'
import type { DeepSeekModelDraft } from './model-draft.ts'
import type { en } from './locales.ts'
import { ModelRow } from './ModelRow.tsx'
import styles from './ModelsSection.module.css'

/**
 * One configured model row. Fields this card does not edit must survive an
 * edit rather than being dropped by a rebuild.
 */
export type ModelDraft = DeepSeekModelDraft

/** A row's text field, or the empty string when unset or not a string. */
function textOf(model: ModelDraft, key: string): string {
  const value = model[key]
  return typeof value === 'string' ? value : ''
}

/** A row's numeric field, or `undefined` when unset or not a number. */
function numberOf(model: ModelDraft, key: string): number | undefined {
  const value = model[key]
  return typeof value === 'number' ? value : undefined
}

export interface ProbeTarget {
  settingsNs: string
}

/** Props of {@link ModelListEditor}. */
export interface ModelListEditorProps {
  models: readonly ModelDraft[] | undefined
  /** Advance only when the parent discards or resets the draft, not on keystrokes. */
  resetToken: number
  /** Installed provider whose catalog supplies defaults without endpoint I/O. */
  catalogProvider?: string | undefined
  /** Route input types for models absent from the installed catalog. */
  defaultInput?: readonly string[] | undefined
  /** Whether the user layer currently owns the whole array; absent on a create. */
  overridden?: boolean
  /** Replace the drafted rows. */
  onChange: (models: ModelDraft[]) => void
  /** Remove the user-owned array and return to inheritance; absent on a create. */
  onReset?: () => void
  probe: ProbeTarget
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every control (read-only deployment or a pending write). */
  disabled: boolean
  onBusyChange: (busy: boolean) => void
}

/** The two token counts edited as K/M-suffixed text behind a row's disclosure. */
type CapacityField = 'contextWindow' | 'maxTokens'

/**
 * What an empty capacity field is worth, shown as its placeholder so a row left
 * blank does not read as a model with no capacity at all.
 *
 * The magnitudes are the adapter's own route-level fallbacks (`llm-pi-ai`'s
 * `defaultContextWindow` and `defaultMaxTokens`), spelled the way a person
 * would say them. They are a hint, not a mirror: this page counts `K` as 1000,
 * so typing `256K` stores 256000 while leaving the field blank keeps the
 * adapter's 262144. A deployment that overrides those defaults is not
 * reflected here — nothing on this page can read them.
 */
const CAPACITY_HINT: Readonly<Record<CapacityField, 'contextWindowPlaceholder' | 'maxTokensPlaceholder'>> = {
  contextWindow: 'contextWindowPlaceholder',
  maxTokens: 'maxTokensPlaceholder',
}

/**
 * Spell a stored count for a field that may be unset. The spelling itself is
 * {@link formatCapacity}, shared with the DeepSeek catalog editor so both
 * surfaces read and write one K/M vocabulary.
 * @param value - stored capacity, or `undefined` for an unset field.
 * @returns the field text, empty when unset.
 */
function capacitySpelling(value: number | undefined): string {
  return value === undefined ? '' : formatCapacity(value)
}

/** Adopt a candidate, preserving disclosed capacities and input types. */
function adopt(candidate: LlmDiscoveredModel): ModelDraft {
  return {
    id: candidate.id,
    ...candidate.name === undefined ? {} : { name: candidate.name },
    ...candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow },
    ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
    ...candidate.inputModalities === undefined ? {} : { input: [...candidate.inputModalities] },
  }
}

export function ModelListEditor(props: ModelListEditorProps): ReactNode {
  const { onChange, probe, operations, t, onBusyChange } = props
  const { catalogProvider } = props
  const [failure, setFailure] = useState<{ diagnostic?: string }>()
  const [inheritedCatalog, setInheritedCatalog] = useState<{
    provider: string
    models: readonly LlmDiscoveredModel[]
  } | undefined>(undefined)
  useEffect(() => {
    if (catalogProvider === undefined) return
    let active = true
    void operations.discoverModels(probe.settingsNs, { provider: catalogProvider }).then((answer) => {
      if (!active) return
      setInheritedCatalog({ provider: catalogProvider, models: answer.kind === 'found' ? answer.models : [] })
      setFailure(answer.kind === 'refused' ? { diagnostic: answer.message } : undefined)
    }, () => {
      if (!active) return
      setInheritedCatalog({ provider: catalogProvider, models: [] })
      setFailure({})
    })
    return () => { active = false }
  }, [catalogProvider, operations, probe.settingsNs])
  const catalog = inheritedCatalog?.provider === catalogProvider ? inheritedCatalog?.models : undefined
  const inputDefaults = useMemo(() => new Map(catalog?.map(model => [model.id, model.inputModalities])), [catalog])
  const loading = catalogProvider !== undefined && catalog === undefined
  const models = props.models ?? catalog?.map(adopt) ?? []
  const disabled = props.disabled || (props.models === undefined && loading)
  useEffect(() => { onBusyChange(loading) }, [loading, onBusyChange])
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  // Capacities are edited as text, so a field's keystrokes are held here rather
  // than re-derived from the parsed count on every change — that would rewrite
  // `1000` to `1K` mid-word. Unreadable text is kept past blur so the refusal
  // names a row the user can still see, which is why this is one entry PER
  // FIELD: a single buffer would be displaced by editing any other field, and
  // the abandoned one would render its stored NaN as the literal `NaN`.
  const [editing, setEditing] = useState<{ resetToken: number; buffers: ReadonlyMap<string, string> }>(
    () => ({ resetToken: props.resetToken, buffers: new Map() }),
  )
  // A reset invalidates old text immediately without remounting rows, moving
  // focus, or re-running discovery. Ordinary edits keep their exact spelling.
  const updateEditing = (update: (current: ReadonlyMap<string, string>) => ReadonlyMap<string, string>): void => {
    setEditing(current => ({
      resetToken: props.resetToken,
      buffers: update(current.resetToken === props.resetToken ? current.buffers : new Map()),
    }))
  }

  /** Buffer key for one capacity field; the row half moves when rows do. */
  const bufferKey = (index: number, field: CapacityField): string => `${String(index)}:${field}`

  const editCapacity = (index: number, field: CapacityField, text: string): void => {
    updateEditing(current => new Map(current).set(bufferKey(index, field), text))
    patch(index, { [field]: parseCapacity(text) })
  }

  /** What a capacity field shows: the buffer while typing, else the stored count. */
  const capacityText = (model: ModelDraft, index: number, field: CapacityField): string =>
    (editing.resetToken === props.resetToken ? editing.buffers.get(bufferKey(index, field)) : undefined)
    ?? capacitySpelling(numberOf(model, field))

  /** Drop one row's entries and shift the rows after it down, in one pass. */
  const reindexOnRemove = (
    current: ReadonlyMap<string, string>,
    index: number,
  ): Map<string, string> => {
    const next = new Map<string, string>()
    for (const [key, value] of current) {
      const at = Number(key.slice(0, key.indexOf(':')))
      if (at === index) continue
      // Only the row number moves; the field half of the key is untouched.
      next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, value)
    }
    return next
  }

  const toggleExpanded = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  const patch = (index: number, next: Record<string, string | number | undefined>): void => {
    onChange(models.map((model, at) => {
      if (at !== index) return model
      // Spread first so a field this card does not edit survives; an emptied
      // optional field is then dropped rather than stored as a value its
      // schema would reject.
      const cleared = new Set(
        Object.entries(next).filter(([, value]) => value === undefined || value === '').map(([key]) => key),
      )
      return Object.fromEntries(
        Object.entries({ ...model, ...next }).filter(([key]) => !cleared.has(key)),
      )
    }))
  }

  return (
    <section className={styles['modelCatalog']} aria-label={t('models')}>
      <div className={styles['modelListHead']}>
        <div className={styles['modelCatalogHeading']}>
          <span className={styles['modelCatalogTitle']}>{t('models')}</span>
          {props.overridden === undefined
            ? null
            : (
              <span className={styles['modelCatalogMeta']}>
                {props.overridden ? t('modelsCustomized') : t('modelsInherited')}
              </span>
            )}
        </div>
        {props.overridden === true && props.onReset !== undefined
          ? (
            <Button
              type="button"
              variant="ghost" size="sm"
              disabled={disabled}
              onClick={props.onReset}
            >
              {t('resetModels')}
            </Button>
          )
          : null}
      </div>
      {props.models === undefined && loading
        ? <p className={styles['modelEmpty']} role="status">{t('fetching')}</p>
        : models.length === 0 ? <p className={styles['modelEmpty']}>{t('modelsEmpty')}</p> : null}
      <div className={styles['modelList']}>
        {models.map((model, index) => (
          <ModelRow
            key={index}
            model={model}
            position={index + 1}
            inputField="input"
            inputFallback={inputDefaults.get(textOf(model, 'id')) ?? props.defaultInput}
            inputLoading={catalogProvider !== undefined && catalog === undefined}
            expanded={expanded.has(index)}
            disabled={disabled}
            t={t}
            contextWindow={{
              value: capacityText(model, index, 'contextWindow'),
              placeholder: t(CAPACITY_HINT.contextWindow),
              onChange: (text) => { editCapacity(index, 'contextWindow', text) },
            }}
            maxTokens={{
              value: capacityText(model, index, 'maxTokens'),
              placeholder: t(CAPACITY_HINT.maxTokens),
              onChange: (text) => { editCapacity(index, 'maxTokens', text) },
            }}
            onFieldChange={(field, value) => { patch(index, { [field]: value }) }}
            onChange={(next) => { onChange(models.map((row, at) => at === index ? next : row)) }}
            onToggle={() => { toggleExpanded(index) }}
            onRemove={() => {
              onChange(models.filter((_model, at) => at !== index))
              setExpanded((current) => {
                const next = new Set<number>()
                for (const at of current) {
                  if (at < index) next.add(at)
                  else if (at > index) next.add(at - 1)
                }
                return next
              })
              updateEditing(current => reindexOnRemove(current, index))
            }}
          />
        ))}
      </div>
      <Button
        type="button"
        variant="outline" size="sm" className={styles['addModelButton']}
        disabled={disabled}
        onClick={() => { onChange([...models, { id: '' }]) }}
      >
        <IconPlusOutlineRegular size={14} />
        {t('addModel')}
      </Button>
      {failure !== undefined ? <p className={styles['error']} role="alert">
        {t('fetchFailed')}
        {failure.diagnostic ? <><br />{failure.diagnostic}</> : null}
      </p> : null}
    </section>
  )
}
