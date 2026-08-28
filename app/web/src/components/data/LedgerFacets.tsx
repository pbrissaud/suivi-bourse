/**
 * **The facets** — the panel on the left of the ledger (#834, ADR-0031).
 *
 * The reduction was six controls in a bar until this ticket: two groups of
 * chips, a search, two date fields and a chip that appeared once a bound was in
 * force. What that bar could not do is the thing a ledger is opened for — *how
 * many dividends did I receive last year* — because a chip states an axis and
 * says nothing about what pressing it would leave. So the axes move into a
 * panel of their own and each option **carries its count**.
 *
 * **Every count excludes its own axis**, which is the whole semantics of a
 * facet and the reason the arithmetic is `lib/ledger.ts`'s rather than this
 * component's: the number beside *Dividende* is *what is left if I press
 * Dividende*, so it is the reduction in force with **this axis replaced** — the
 * account, the period and the search still applying. Counted the naive way, off
 * the rows on screen, every option but the one pressed would read zero the
 * instant a type was chosen, and the panel would answer a question nobody asks.
 *
 * **The period is one axis with three controls**, and they write to the same
 * two bounds. The years are the vocabulary — laid out like the types, because
 * they are what the ledger names — and the months appear **only once the period
 * fits inside a year**, which is the state pressing a year puts the reader in;
 * a grid of twelve otherwise would have to name a year on every cell. The two
 * date fields stay underneath for the interval no year and no month spells, and
 * they remain the one control here that is not a facet: the days are all of
 * them, so there is no vocabulary to lay out and nothing to count.
 *
 * **The account facets appear at N ≥ 2 only**, which is #795's rule kept whole:
 * ADR-0013 seeds a `default` row that is never removed, so a single-account
 * install would get a group holding one option beside its own exit — a filter
 * that cannot filter. The exception is a reduction already in force, because a
 * filter with no way out is worse than a filter that cannot filter.
 *
 * **Under 768 px the panel folds**, and the fold is a class rather than a
 * measurement: `hidden md:flex` on the body means the state can only ever hide
 * it on the narrow layout, so a reader who folded it on a phone and rotated
 * into the wide one does not find the ledger's whole vocabulary missing. The
 * toggle is `md:hidden` for the same reason — a control that does nothing must
 * not be on screen.
 */
import { useMemo, useState, type ReactNode } from 'react'

import { TYPE_LABEL } from '@/components/data/LedgerTable'
import { Input } from '@/components/ui/input'
import type { LedgerEvent } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import {
  accountFacets,
  monthBounds,
  monthFacets,
  parseDay,
  rangeYear,
  reduces,
  typeFacets,
  yearBounds,
  yearFacets,
  NO_FILTERS,
  type Facet,
  type LedgerFilters as Filters,
} from '@/lib/ledger'
import { cn } from '@/lib/utils'

export interface LedgerFacetsProps {
  filters: Filters
  onChange: (filters: Filters) => void
  /** The ledger entire — what the counts are taken on, never the rows on screen. */
  events: readonly LedgerEvent[]
  /** The accounts the ledger actually names, never the declared list. */
  accounts: readonly string[]
}

export function LedgerFacets({ filters, onChange, events, accounts }: LedgerFacetsProps) {
  const { t } = useI18n()
  const f = useFormatters()
  // Folded by default, and it only shows on the narrow layout: the wide one
  // never reads this state, `hidden md:flex` overriding it either way.
  const [open, setOpen] = useState(false)

  // One pass over the ledger per option, which is what a count that excludes
  // its own axis costs. Memoised on the reduction, so a keystroke in the search
  // field pays it once rather than once per render of the table beside it.
  const types = useMemo(() => typeFacets(events, filters), [events, filters])
  const named = useMemo(
    () =>
      filters.account !== null && !accounts.includes(filters.account)
        ? [...accounts, filters.account]
        : accounts,
    [accounts, filters.account],
  )
  const forAccounts = useMemo(
    () => accountFacets(events, filters, named),
    [events, filters, named],
  )
  const years = useMemo(() => yearFacets(events, filters), [events, filters])
  const months = useMemo(() => monthFacets(events, filters), [events, filters])
  const year = rangeYear(filters)

  return (
    <aside
      aria-label={t('data.facets.title')}
      className="flex flex-col gap-4 rounded-lg border p-4 lg:sticky lg:top-4"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {t('data.facets.title')}
        </h2>
        {/* The way out of **everything at once**, offered only while there is
            something to come out of — the chips above the table are the way out
            of one dimension, and this is the way out of the reduction. */}
        {reduces(filters) ? (
          <button
            type="button"
            onClick={() => onChange(NO_FILTERS)}
            className="text-xs text-muted-foreground underline underline-offset-4"
          >
            {t('data.facets.reset')}
          </button>
        ) : null}
      </div>

      <button
        type="button"
        aria-expanded={open}
        aria-controls="ledger-facets"
        onClick={() => setOpen((current) => !current)}
        className="flex h-9 items-center justify-between rounded-md border px-3 text-sm md:hidden"
      >
        {t('data.facets.toggle', { open: open ? 'yes' : 'no' })}
      </button>

      <div
        id="ledger-facets"
        className={cn('flex-col gap-5', open ? 'flex' : 'hidden md:flex')}
      >
        <Axis label={t('data.filter.type')}>
          {types.map((facet) => (
            <FacetButton
              key={facet.value ?? 'all'}
              facet={facet}
              label={facet.value === null ? t('data.filter.type.all') : t(TYPE_LABEL[facet.value])}
              onPress={() => onChange({ ...filters, type: facet.value })}
            />
          ))}
        </Axis>

        {named.length > 1 || filters.account !== null ? (
          <Axis label={t('data.filter.account')}>
            {forAccounts.map((facet) => (
              <FacetButton
                key={facet.value ?? 'all'}
                facet={facet}
                label={facet.value === null ? t('data.filter.account.all') : facet.value}
                mono={facet.value !== null}
                onPress={() => onChange({ ...filters, account: facet.value })}
              />
            ))}
          </Axis>
        ) : null}

        <Axis label={t('data.filter.period')}>
          {years.map((facet) => (
            <FacetButton
              key={facet.value ?? 'all'}
              facet={facet}
              label={facet.value === null ? t('data.filter.period.all') : facet.value}
              mono={facet.value !== null}
              onPress={() =>
                onChange({
                  ...filters,
                  ...(facet.value === null
                    ? { since: null, until: null }
                    : yearBounds(facet.value)),
                })
              }
            />
          ))}
        </Axis>

        {/* The months of the year in force, three to a row — and pressing the
            one that is pressed goes back **up** to its year rather than
            releasing the period whole: the reader came from the year, and that
            is where a month lets go to. */}
        {year === null ? null : (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {t('data.filter.months')}
            </h3>
            <div role="group" aria-label={t('data.filter.months')} className="grid grid-cols-3 gap-1.5">
              {months.map((facet) => (
                <button
                  key={facet.value}
                  type="button"
                  aria-pressed={facet.active}
                  aria-label={t('data.facet.label', {
                    label: f.month(year, facet.value),
                    count: facet.count,
                  })}
                  onClick={() =>
                    onChange({
                      ...filters,
                      ...(facet.active ? yearBounds(year) : monthBounds(year, facet.value)),
                    })
                  }
                  className={cn(
                    'flex flex-col items-center rounded-md border px-1 py-1 text-xs',
                    'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                    facet.active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input text-muted-foreground hover:text-foreground',
                    !facet.active && facet.count === 0 && 'opacity-60',
                  )}
                >
                  <span aria-hidden>{f.month(year, facet.value)}</span>
                  <span aria-hidden className="font-mono text-[0.625rem] tabular">
                    {facet.count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* The interval no year and no month spells. Both bounds inclusive
            (#810), and a day the field could not read is *no bound* — which is
            what `parseDay` is for: `<input type="date">` hands back an empty
            string for a day it refuses, and that reads as *left blank* one line
            later. */}
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {t('data.filter.exact')}
          </h3>
          <label htmlFor="ledger-since" className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="w-6 shrink-0">{t('data.filter.since')}</span>
            <Input
              id="ledger-since"
              type="date"
              className="h-8 min-w-0 font-mono text-xs"
              value={filters.since ?? ''}
              onChange={(event) => onChange({ ...filters, since: parseDay(event.target.value) })}
            />
          </label>
          <label htmlFor="ledger-until" className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="w-6 shrink-0">{t('data.filter.until')}</span>
            <Input
              id="ledger-until"
              type="date"
              className="h-8 min-w-0 font-mono text-xs"
              value={filters.until ?? ''}
              onChange={(event) => onChange({ ...filters, until: parseDay(event.target.value) })}
            />
          </label>
        </div>
      </div>
    </aside>
  )
}

/** One axis: the question above, its options under it, as a group. */
function Axis({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </h3>
      <div role="group" aria-label={label} className="flex flex-col gap-0.5">
        {children}
      </div>
    </div>
  )
}

/**
 * One option, and **it says its count out loud**.
 *
 * The accessible name is the label *and* the count rather than the label alone:
 * the count is what makes this a facet and not a chip, and a reader who cannot
 * see the figure beside the word would be choosing blind between six options
 * the panel has already counted for them. `aria-pressed` and not a `radio`, for
 * #795's reason one surface over — a radiogroup is one tab stop and the arrows
 * would hide five options behind a gesture these controls exist to remove.
 *
 * An option retaining nothing is **dimmed and still pressable**: it is a fact
 * about the reader's ledger (*no withdrawal in 2024*), and removing it would
 * make the vocabulary move under the hand at every gesture.
 */
function FacetButton({
  facet,
  label,
  mono,
  onPress,
}: {
  facet: Facet<unknown>
  label: string
  mono?: boolean
  onPress: () => void
}) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      aria-pressed={facet.active}
      aria-label={t('data.facet.label', { label, count: facet.count })}
      onClick={onPress}
      className={cn(
        'flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm transition-colors',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        facet.active
          ? 'bg-primary/12 font-medium text-primary'
          : 'text-muted-foreground hover:text-foreground',
        !facet.active && facet.count === 0 && 'opacity-60',
      )}
    >
      <span aria-hidden className={cn('truncate', mono && 'font-mono text-xs')}>
        {label}
      </span>
      <span aria-hidden className="shrink-0 font-mono text-xs tabular">
        {facet.count}
      </span>
    </button>
  )
}
