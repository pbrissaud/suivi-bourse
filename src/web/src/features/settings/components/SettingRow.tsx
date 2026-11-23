import type { ReactNode } from 'react'

import type { DialState } from '@/features/settings/lib/useDial'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * **The one row of the Settings page**: the name (and, where the row has one, a
 * one-clause description) on the left, the control on the right, a `border`
 * rule between rows. Every control of the page sits in one; none sits in a
 * section's gutter.
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
  wide,
}: {
  /** The control's id: the label points at it, and the description is `${id}-description`. */
  id?: string
  label: ReactNode
  description?: ReactNode
  children: ReactNode
  state?: DialState
  /** A control too wide to sit beside its name on a phone (an address): under 640 px it goes below. */
  wide?: boolean
}) {
  return (
    <div
      className={cn(
        'grid min-h-12 items-center gap-x-6 gap-y-2 border-b py-2 last:border-b-0',
        wide ? 'grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]',
      )}
    >
      <div className="min-w-0">
        {id ? (
          <label htmlFor={id} className="block text-md">
            {label}
          </label>
        ) : (
          <p className="text-md">{label}</p>
        )}
        {description ? (
          <div
            id={id ? `${id}-description` : undefined}
            className="mt-0.5 text-sm text-muted-foreground"
          >
            {description}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col items-end gap-1">
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
