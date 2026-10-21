/**
 * The reduction, said above the table — **the search and the pastilles that
 * name what is retained** (#723, #795, #834, #1278).
 *
 * The reduction is made in three places since #834 and they are three
 * questions, not three copies:
 *
 *  - the **menus** (`LedgerFacets.tsx`) are where an axis is *chosen*, and every
 *    option there carries the count it would leave;
 *  - the **search** is here, because it is the one dimension with no vocabulary
 *    at all to lay out. It is not a convenience either: on nineteen purchases
 *    of the same ETF the free-text label is the only discriminant a row owns,
 *    and on a cash movement it is the only name there is. It reads the ticker,
 *    the label and the account — everything the identity and account columns
 *    show — with accents folded;
 *  - the **pastilles** are here too, and they are where a reduction is *read
 *    back and let go of*. One per dimension in force, each stating what it
 *    retains and clearing itself, which is #724's rule applied to all five at
 *    once rather than to the one dimension that had arrived from a gesture.
 *
 * The securities are a pastille like the rest since #834. They were a line of
 * their own, in a dashed box, because they arrive from a gesture and have no
 * control to type into; with every other dimension wearing a pastille that
 * exception has nothing left to be an exception to, and the sentence it carried
 * — *« Réduit à trois titres : … »* — is the pastille's own label, a set stated
 * as its first element reading as its whole.
 */
import { Search, X } from 'lucide-react'

import { TYPE_LABEL } from '@/features/data/components/LedgerTable'
import { Input } from '@/components/ui/input'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { LedgerFilters as Filters } from '@/features/data/lib/ledger'

interface LedgerSearchProps {
  filters: Filters
  onChange: (filters: Filters) => void
}

/** The free-text field. The count it used to sit beside is the summary line's. */
export function LedgerSearch({ filters, onChange }: LedgerSearchProps) {
  const { t } = useI18n()

  // **The magnifier is inside the field** (#838): the drawing sets the search as
  // a field with its own mark rather than as a bare box, which is what tells it
  // apart from the form's inputs at a glance. The label stays screen-reader
  // only — the icon is decoration and never a name.
  return (
    <div className="relative min-w-0 grow basis-60 sm:max-w-80">
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
        className="h-8 rounded-lg bg-card pl-9.5 pointer-coarse:h-11"
      />
    </div>
  )
}

/**
 * The three sentences a period reads out: the interval, and each bound typed
 * alone — an interval open on the other side, which is a legitimate reduction
 * and has to be readable as one. The chip says it, and so does the *Période*
 * menu's trigger (#1278).
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

interface LedgerChipsProps {
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
      label: periodSentence(t, f, filters),
      clear: () => onChange({ ...filters, since: null, until: null }),
    })
  }

  if (chips.length === 0) return null

  return (
    <div
      role="group"
      aria-label={t('data.chips.title')}
      className="flex flex-wrap items-center gap-2"
    >
      <span className="label">{t('data.chips.title')}</span>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          // The name says the **gesture**, the label being on screen beside it:
          // a control whose accessible name is only what it retains reads as a
          // second way of pressing that dimension rather than as the way out.
          aria-label={t('data.chips.clear', { label: chip.label })}
          onClick={chip.clear}
          className="inline-flex h-7 items-center gap-1.5 rounded-full pointer-coarse:h-11 border border-primary bg-primary/12 px-3 text-xs font-medium text-primary"
        >
          <span aria-hidden>{chip.label}</span>
          <X className="size-3" aria-hidden />
        </button>
      ))}
    </div>
  )
}
