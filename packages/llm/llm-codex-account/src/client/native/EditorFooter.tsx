import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link EditorFooter}. */
export interface EditorFooterProps {
  /** Localizer for the row's own labels. */
  t: (key: keyof typeof en) => string
  /** Whether a commit is in flight; holds Cancel and swaps the commit label. */
  busy: boolean
  cancelDisabled?: boolean
  /** Whether the commit is refused, as judged by the owning card. */
  submitDisabled: boolean
  /** Commit label while idle. */
  submitLabelKey: keyof typeof en
  /** Commit label while a commit is in flight. */
  submitBusyLabelKey: keyof typeof en
  cancelLabelKey?: keyof typeof en
  onCancel: () => void
  /** Run the card's commit. */
  onSubmit: () => void
}

/**
 * Render one provider card's action row.
 * @param props - the labels, commit gating, and handlers the owning card supplies.
 * @returns the cancel/commit row.
 */
export function EditorFooter(props: EditorFooterProps): ReactNode {
  const { t } = props
  return (
    <div className={styles['editorActions']}>
      <Button
        type="button"
        variant="outline"
        disabled={props.busy || props.cancelDisabled === true}
        onClick={props.onCancel}
      >
        {t(props.cancelLabelKey ?? 'cancel')}
      </Button>
      <Button
        type="button"
        variant="primary"
        disabled={props.submitDisabled}
        onClick={props.onSubmit}
      >
        {props.busy ? t(props.submitBusyLabelKey) : t(props.submitLabelKey)}
      </Button>
    </div>
  )
}
