/**
 * The search, and the one reduction no control types into (#723, #795, #834,
 * #1278, « Relevé »).
 *
 *  - the **search** is a framed field, 32 px on a page, with its magnifier
 *    inside. It is not a convenience: on nineteen purchases of the same ETF the
 *    free-text label is the only discriminant a row owns, and on a cash
 *    movement it is the only name there is. It reads the ticker, the label and
 *    the account — everything the event and account columns show — with accents
 *    folded;
 *  - the **securities** a gesture asked for (the assumed-currency notice) are a
 *    reduction with no control to type into, so the control line names it and
 *    lets go of it: one text action, the way out being the whole of it. Every
 *    other dimension is a control that shows its own value, so nothing else
 *    needs a mark.
 */
import { Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { LedgerFilters as Filters } from '@/features/data/lib/ledger'

interface LedgerSearchProps {
  filters: Filters
  onChange: (filters: Filters) => void
}

/** The free-text field. */
export function LedgerSearch({ filters, onChange }: LedgerSearchProps) {
  const { t } = useI18n()

  // The magnifier is inside the field; the label stays screen-reader only — the
  // icon is decoration and never a name.
  return (
    <div className="relative min-w-45 shrink grow-0 basis-65">
      <label htmlFor="ledger-search" className="sr-only">
        {t('data.search.label')}
      </label>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        id="ledger-search"
        type="search"
        value={filters.query}
        placeholder={t('data.search.placeholder')}
        onChange={(event) => onChange({ ...filters, query: event.target.value })}
        className="h-8 bg-background pr-2.5 pl-8 md:text-md pointer-coarse:h-11"
      />
    </div>
  )
}

/**
 * The three sentences a period reads out: the interval, and each bound typed
 * alone — an interval open on the other side, which is a legitimate reduction
 * and has to be readable as one. The *Période* filter shows it as its value
 * when the period is none of the years.
 */
export function periodSentence(
  t: ReturnType<typeof useI18n>['t'],
  f: ReturnType<typeof useFormatters>,
  filters: Filters,
): string {
  return t('data.filter.period.chip', {
    bounds:
      filters.since !== null && filters.until !== null
        ? 'both'
        : filters.since !== null
          ? 'since'
          : 'until',
    since: f.date(filters.since),
    until: f.date(filters.until),
  })
}

/**
 * The set of securities a gesture reduced the ledger to, and its way out: a
 * text action (13 px, `muted-foreground`, underlined) on the control line, shown
 * only while the set is in force.
 */
export function SymbolsReduction({
  filters,
  onChange,
}: {
  filters: Filters
  onChange: (filters: Filters) => void
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const symbols = filters.symbols
  if (!symbols || symbols.length === 0) return null
  const label = t('data.filter.symbols', { count: symbols.length, symbols: f.list(symbols) })
  return (
    <button
      type="button"
      // The name says the **gesture**, the label being on screen beside it.
      aria-label={t('data.chips.clear', { label })}
      onClick={() => onChange({ ...filters, symbols: null })}
      className="text-sm text-muted-foreground underline decoration-border underline-offset-3 hover:text-foreground"
    >
      {label}
    </button>
  )
}
