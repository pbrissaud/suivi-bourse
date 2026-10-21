/**
 * The ledger on a phone (#1339): **a list, not a table**.
 *
 * Below 768 px the table kept four columns and still wanted 632 px, so it
 * scrolled sideways inside a box that also scrolled vertically — a thumb
 * trapped in a nested scroller. This list sits in the page's flow instead, with
 * no card and no scroll box of its own, and draws what a phone reader scans for:
 *
 *     ☐  AAPL                           × 3
 *        12/03/2026 · Achat             [compte]
 *     ☐  Virement                  1 000,00 €
 *        12/03/2026 · Dépôt             [compte]
 *
 * The figure is the one the type declares: an amount for a transfer or a
 * dividend, `× quantity` for a trade (`EventFigure`, #1355).
 *
 * Quantity, unit price, fee and the label under a ticker are not drawn; they
 * live in `EventForm`, one tap away. It takes the table's props and its
 * selection state, so crossing the breakpoint changes the drawing and nothing
 * else.
 *
 * The identity is a `<button>` stretched over the whole item (`after:inset-0`),
 * which is why the checkbox rides above it (`z-10`) and why a tap on it ticks
 * the row and never opens the editor.
 */
import type { OnChangeFn, RowSelectionState } from '@tanstack/react-table'

import { Checkbox } from '@/components/ui/checkbox'
import type { LedgerEvent } from '@/features/data/lib/api'
import {
  AccountChip,
  EventFigure,
  TYPE_LABEL,
  TypePill,
} from '@/features/data/components/LedgerTable'
import { identityOf, isEditable, rowKey, selectionState } from '@/features/data/lib/ledger'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface LedgerListProps {
  /** Every row the reduction retains — not only the ones drawn. */
  events: readonly LedgerEvent[]
  /** How many of them are drawn: the reveal's budget. */
  budget: number
  currency: string | null
  /** The ticked rows, by id — held by the caller. */
  rowSelection: RowSelectionState
  onRowSelectionChange: OnChangeFn<RowSelectionState>
  /** Opens the panel on a row. Offered for every row that has a key. */
  onEdit: (event: LedgerEvent) => void
  /** The rows a merge has just written (#1119): marked, then let go of. */
  fresh?: ReadonlySet<string>
}

/** 44 × 44 on a coarse pointer, around a 16 px box, above the stretched button. */
const TICK = 'relative z-10 pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5'

export function LedgerList({
  events,
  budget,
  currency,
  rowSelection,
  onRowSelectionChange,
  onEdit,
  fresh,
}: LedgerListProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const ticks = selectionState(events, rowSelection)
  const editable = events.filter(isEditable)

  const tick = (keys: readonly string[], on: boolean) =>
    onRowSelectionChange((current) => {
      const next = { ...current }
      for (const key of keys) {
        if (on) next[key] = true
        else delete next[key]
      }
      return next
    })
  // Ticks **every** editable row the reduction retains, drawn or not, as the
  // table's header does.
  const toggleAll = (on: boolean) =>
    tick(
      editable.map((event) => event.id as string),
      on,
    )

  return (
    <div>
      <div className="flex min-h-11 items-center border-b px-1">
        <Checkbox
          aria-label={t('data.select.all', { count: editable.length })}
          checked={ticks === 'all' ? true : ticks === 'some' ? 'indeterminate' : false}
          disabled={editable.length === 0}
          onCheckedChange={(value) => toggleAll(!!value)}
          className={TICK}
        />
      </div>
      {/* `role="list"` restated: preflight removes the bullets, and Safari then
          drops the list semantics, with the name and the count that go with them. */}
      <ul role="list" aria-label={t('data.ledger.label')}>
        {events.slice(0, Math.max(budget, 0)).map((event, index) => {
          const key = rowKey(event, index)
          const identity = identityOf(event)
          const name = identity.ticker ?? identity.label
          // A ticker is short; a label alone may be long. Both take one line,
          // and the whole text stays in the DOM and in the `title`.
          const shape = 'block min-w-0 max-w-full truncate text-left font-medium'
          const title = identity.ticker === null ? (name ?? undefined) : undefined
          return (
            <li
              key={key}
              data-state={rowSelection[key] ? 'selected' : undefined}
              data-fresh={fresh?.has(String(event.id)) ? '' : undefined}
              className="relative flex min-h-15 items-center gap-3 border-b px-1 py-2 last:border-b-0 has-[button:active]:bg-muted/50 data-[state=selected]:bg-muted/50 data-fresh:bg-primary/10"
            >
              <Checkbox
                aria-label={t('data.select.row', {
                  date: f.date(event.date),
                  type: t(TYPE_LABEL[event.event_type]),
                  symbol: name ?? ABSENT,
                })}
                checked={!!rowSelection[key]}
                disabled={!isEditable(event)}
                onCheckedChange={(value) => tick([key], !!value)}
                className={TICK}
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-baseline justify-between gap-3">
                  {isEditable(event) ? (
                    // An editable row is always tappable, a label-less transfer
                    // included: the dash is then the button, named by its date and type.
                    <button
                      type="button"
                      title={title}
                      aria-label={
                        name === null
                          ? `${f.date(event.date)} · ${t(TYPE_LABEL[event.event_type])}`
                          : undefined
                      }
                      className={cn(
                        shape,
                        name === null && 'text-muted-foreground',
                        'outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring',
                      )}
                      onClick={() => onEdit(event)}
                    >
                      {name ?? ABSENT}
                    </button>
                  ) : (
                    <span
                      title={title}
                      className={cn(shape, name === null && 'text-muted-foreground')}
                    >
                      {name ?? ABSENT}
                    </span>
                  )}
                  <span className="tabular shrink-0">
                    <EventFigure event={event} currency={currency} />
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="label tabular whitespace-nowrap">{f.day(event.date)}</span>
                    <span aria-hidden className="label">
                      ·
                    </span>
                    <TypePill type={event.event_type} />
                  </div>
                  <AccountChip event={event} />
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
