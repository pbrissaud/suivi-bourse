import type { ReactNode } from 'react'

import type { DialState } from '@/features/settings/lib/useDial'
import { useI18n } from '@/lib/i18n'

/**
 * **The one row of the Settings page** (#1279): the label and what it means on
 * the left, the control on the right, a `rule` between rows. Every control of
 * the page sits in one; none sits in a section's gutter or title row.
 *
 * The receipt slot sits under the control, and says what happened to *this*
 * value — saving, saved, or why not — so a save is never answered somewhere
 * else on the page.
 */
export function SettingRow({
  id,
  label,
  description,
  children,
  state,
}: {
  /** The control's id: the label points at it, and the description is `${id}-description`. */
  id?: string
  label: ReactNode
  description?: ReactNode
  children: ReactNode
  state?: DialState
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-t py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 basis-60 space-y-0.5">
        {id ? (
          <label htmlFor={id} className="block text-base font-medium">
            {label}
          </label>
        ) : (
          <p className="text-base font-medium">{label}</p>
        )}
        {description ? (
          <div
            id={id ? `${id}-description` : undefined}
            className="label max-w-prose text-muted-foreground"
          >
            {description}
          </div>
        ) : null}
      </div>
      <div className="flex min-h-11 flex-col items-end gap-1">
        {children}
        {/* Mounted before it has anything to say: a live region inserted already
            filled is not announced by every screen reader. */}
        {state ? (
          <div aria-live="polite">
            <Receipt state={state} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Receipt({ state }: { state: DialState }) {
  const { t } = useI18n()
  if (state.kind === 'failed') {
    return (
      <p role="alert" className="max-w-72 text-right text-xs text-destructive">
        {state.reason}
      </p>
    )
  }
  if (state.kind === 'idle') return null
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {state.kind === 'saving' ? t('settings.row.saving') : t('settings.row.saved')}
    </p>
  )
}
