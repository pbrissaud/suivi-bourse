/**
 * The reduction, said above the table — **the search, the count, and the
 * pastilles that name what is retained** (#723, #795, #834, ADR-0020,
 * ADR-0031).
 *
 * The reduction is made in three places since #834 and they are three
 * questions, not three copies:
 *
 *  - the **panel** (`LedgerFacets.tsx`) is where an axis is *chosen*, and every
 *    option there carries the count it would leave;
 *  - the **search** is here, because it is the one dimension with no vocabulary
 *    at all to lay out. It is not a convenience either: on nineteen purchases of
 *    the same ETF the free-text label is the only discriminant a row owns, and
 *    on a cash movement it is the only name there is. It reads the ticker, the
 *    label and the account — everything the identity and account columns show —
 *    with accents folded;
 *  - the **pastilles** are here too, and they are where a reduction is *read
 *    back and let go of*. One per dimension in force, each stating what it
 *    retains and clearing itself, which is #724's rule applied to all five at
 *    once rather than to the one dimension that had arrived from a gesture.
 *
 * **The count is the reduction's, and it says so.** *Réduction · 47 événements*
 * where something is in force, the bare count where nothing is: ADR-0031 asks
 * that both sentences under this table be true of the reduction rather than of
 * the store, and a number that does not say which of the two it counts is the
 * defect that record names — a table silently shorter than expected.
 *
 * The securities are a pastille like the rest since #834. They were a line of
 * their own, in a dashed box, because they arrive from a gesture and have no
 * control to type into; with every other dimension wearing a pastille that
 * exception has nothing left to be an exception to, and the sentence it carried
 * — *« Réduit à trois titres : … »* — is the pastille's own label, a set stated
 * as its first element reading as its whole.
 */
import { Search, X } from 'lucide-react'

import { TYPE_LABEL } from '@/components/data/LedgerTable'
import { Input } from '@/components/ui/input'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { reduces, type LedgerFilters as Filters } from '@/lib/ledger'

export interface LedgerSearchProps {
  filters: Filters
  onChange: (filters: Filters) => void
  /** How many rows survive the reduction, stated where the reduction is made. */
  shown: number
}

/** The free-text field, and the count of what the reduction retains. */
export function LedgerSearch({ filters, onChange, shown }: LedgerSearchProps) {
  const { t } = useI18n()

  return (
    <>
      {/* **The magnifier is inside the field** (#838): the drawing sets the
          search as a field with its own mark rather than as a bare box, which
          is what tells it apart from the form's inputs at a glance. The label
          stays screen-reader only — the icon is decoration and never a name. */}
      <div className="relative min-w-0 grow basis-60 sm:max-w-md">
        <label htmlFor="ledger-search" className="sr-only">
          {t('data.search.label')}
        </label>
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3.5 size-3.75 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id="ledger-search"
          type="search"
          value={filters.query}
          placeholder={t('data.search.placeholder')}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
          className="h-9.5 rounded-lg bg-card pl-9.5"
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {t('data.filter.count', {
          count: shown,
          reduced: reduces(filters) ? 'yes' : 'no',
        })}
      </p>
    </>
  )
}

export interface LedgerChipsProps {
  filters: Filters
  onChange: (filters: Filters) => void
}

/**
 * The pastilles: one per dimension in force, and nothing at all while nothing
 * is reduced — a heading over an empty row would be a block with nothing in it.
 */
export function LedgerChips({ filters, onChange }: LedgerChipsProps) {
  const { t } = useI18n()
  const f = useFormatters()

  const chips: { key: string; label: string; clear: () => void }[] = []
  const query = filters.query.trim()
  if (query !== '') {
    chips.push({
      key: 'query',
      label: t('data.chip.query', { subject: query }),
      clear: () => onChange({ ...filters, query: '' }),
    })
  }
  if (filters.type !== null) {
    chips.push({
      key: 'type',
      label: t(TYPE_LABEL[filters.type]),
      clear: () => onChange({ ...filters, type: null }),
    })
  }
  if (filters.account !== null) {
    chips.push({
      key: 'account',
      label: filters.account,
      clear: () => onChange({ ...filters, account: null }),
    })
  }
  if (filters.symbols && filters.symbols.length > 0) {
    chips.push({
      key: 'symbols',
      label: t('data.filter.symbols', {
        count: filters.symbols.length,
        // A sentence, so the enumeration is the language's (#768) and not a
        // machine-readable list wearing a sentence's clothes.
        symbols: f.list(filters.symbols),
      }),
      clear: () => onChange({ ...filters, symbols: null }),
    })
  }
  if (filters.since !== null || filters.until !== null) {
    chips.push({
      key: 'period',
      // The three sentences a period reads out: the interval, and each bound
      // typed alone — an interval open on the other side, which is a legitimate
      // reduction and has to be readable as one.
      label: t('data.filter.period.chip', {
        bounds:
          filters.since !== null && filters.until !== null
            ? 'both'
            : filters.since !== null
              ? 'since'
              : 'until',
        since: f.date(filters.since),
        until: f.date(filters.until),
      }),
      clear: () => onChange({ ...filters, since: null, until: null }),
    })
  }

  if (chips.length === 0) return null

  return (
    <div role="group" aria-label={t('data.chips.title')} className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {t('data.chips.title')}
      </span>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          // The name says the **gesture**, the label being on screen beside it:
          // a control whose accessible name is only what it retains reads as a
          // second way of pressing that dimension rather than as the way out.
          aria-label={t('data.chips.clear', { label: chip.label })}
          onClick={chip.clear}
          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-primary bg-primary/12 px-3 text-xs font-medium text-primary"
        >
          <span aria-hidden>{chip.label}</span>
          <X className="size-3" aria-hidden />
        </button>
      ))}
    </div>
  )
}
