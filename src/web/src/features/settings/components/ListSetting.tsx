/**
 * **A list inside a setting** (tokens, funds, tax models, providers, channels —
 * DESIGN.md › Layout): ruled rows directly in the section's plane under their
 * name, ending on a « + Ajouter … » row. Never a nested plane, and at most one
 * text action per row.
 */
import { type ComponentProps, type ReactNode, useId } from 'react'
import { PlusIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

const TEXT_ACTION =
  'text-sm text-muted-foreground underline decoration-border underline-offset-3 outline-none hover:text-foreground focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50'

/** An action on a row that is not its main one: 13 px, muted, underlined in `border`. */
export function TextAction({ className, ...props }: ComponentProps<'button'>) {
  return <button type="button" className={cn(TEXT_ACTION, className)} {...props} />
}

/** The list's name, then its rows, then its add row. */
export function ListSetting({
  id,
  label,
  hint,
  children,
}: {
  id?: string
  label: ReactNode
  /** The grey words beside the name (« · API et MCP »). */
  hint?: ReactNode
  children: ReactNode
}) {
  const heading = useId()
  return (
    <div id={id} className="scroll-mt-20 border-b py-3.5 last:border-b-0">
      <p id={heading} className="mb-2 text-md">
        {label}
        {hint ? <span className="text-muted-foreground"> · {hint}</span> : null}
      </p>
      <ul aria-labelledby={heading}>{children}</ul>
    </div>
  )
}

/** One ruled row: a name with an optional sub-line, what it says, its one action. */
export function ListRow({
  name,
  sub,
  aside,
  actions,
}: {
  name: ReactNode
  sub?: ReactNode
  /** Plain words in `muted-foreground` before the actions (« Par défaut »). */
  aside?: ReactNode
  actions?: ReactNode
}) {
  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b',
        sub ? 'min-h-12' : 'min-h-10',
      )}
    >
      <div className="min-w-0">
        <div className="text-md">{name}</div>
        {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
      </div>
      <div className="flex items-center gap-4 text-sm">
        {aside ? <span className="text-muted-foreground">{aside}</span> : null}
        {actions}
      </div>
    </li>
  )
}

/** « + Ajouter … »: the last row of a list. */
export function AddRow({
  children,
  hint,
  ...props
}: ComponentProps<'button'> & { hint?: ReactNode }) {
  return (
    <li className="flex min-h-10 items-center">
      <button
        type="button"
        className="inline-flex items-center gap-2 text-md outline-none focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
        {...props}
      >
        <PlusIcon className="size-4" aria-hidden />
        {children}
        {hint ? <span className="text-sm text-muted-foreground">· {hint}</span> : null}
      </button>
    </li>
  )
}
