/**
 * **The facets** — the three filter menus of the ledger's toolbar (#834, #1278).
 *
 * The reduction was six controls in a bar until #834: two groups of chips, a
 * search, two date fields and a chip that appeared once a bound was in force.
 * What that bar could not do is the thing a ledger is opened for — *how many
 * dividends did I receive last year* — because a chip states an axis and says
 * nothing about what pressing it would leave. So the axes got a panel of their
 * own and each option **carries its count**. #1278 folds the panel into the
 * toolbar, as three menus over the table: a data page filters above its table,
 * and the table gets its width back.
 *
 * **Every count excludes its own axis**, which is the whole semantics of a
 * facet and the reason the arithmetic is `features/data/lib/ledger.ts`'s rather than this
 * component's: the number beside *Dividende* is *what is left if I press
 * Dividende*, so it is the reduction in force with **this axis replaced** — the
 * account, the period and the search still applying. Counted the naive way, off
 * the rows on screen, every option but the one pressed would read zero the
 * instant a type was chosen, and the menu would answer a question nobody asks.
 *
 * **Pressing an option applies it and leaves the menu open**, so a year then a
 * month is two clicks in one popover. The way out of a dimension is its chip on
 * the summary line, which is why a trigger whose axis is in force only *wears*
 * the chips' look and names its value.
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
 * The account menu is offered only where there are two accounts to tell apart.
 * The exception is a reduction already in force, because a filter with no way
 * out is worse than a filter that cannot filter.
 */
import { useMemo, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

import { periodSentence } from '@/features/data/components/LedgerFilters'
import { TYPE_LABEL } from '@/features/data/components/LedgerTable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { LedgerEvent } from '@/features/data/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import {
  accountFacets,
  monthBounds,
  monthFacets,
  parseDay,
  rangeYear,
  typeFacets,
  yearBounds,
  yearFacets,
  type Facet,
  type LedgerFilters as Filters,
} from '@/features/data/lib/ledger'
import { cn } from '@/lib/utils'

interface LedgerFacetsProps {
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
  const forAccounts = useMemo(() => accountFacets(events, filters, named), [events, filters, named])
  const years = useMemo(() => yearFacets(events, filters), [events, filters])
  const months = useMemo(() => monthFacets(events, filters), [events, filters])
  const year = rangeYear(filters)

  return (
    <>
      <FilterMenu
        axis={t('data.filter.type')}
        value={filters.type === null ? null : t(TYPE_LABEL[filters.type])}
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
      </FilterMenu>

      {named.length > 1 || filters.account !== null ? (
        <FilterMenu axis={t('data.filter.account')} value={filters.account}>
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
        </FilterMenu>
      ) : null}

      <FilterMenu
        axis={t('data.filter.period')}
        value={
          filters.since !== null || filters.until !== null ? periodSentence(t, f, filters) : null
        }
      >
        <div className="flex flex-col gap-5">
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
              <h3 className="label">{t('data.filter.months')}</h3>
              <div
                role="group"
                aria-label={t('data.filter.months')}
                className="grid grid-cols-3 gap-1.5"
              >
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
                    <span aria-hidden className="text-2xs tabular">
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
            <h3 className="label">{t('data.filter.exact')}</h3>
            <label
              htmlFor="ledger-since"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <span className="w-6 shrink-0">{t('data.filter.since')}</span>
              <Input
                id="ledger-since"
                type="date"
                className="h-8 min-w-0 font-mono text-xs"
                value={filters.since ?? ''}
                onChange={(event) => onChange({ ...filters, since: parseDay(event.target.value) })}
              />
            </label>
            <label
              htmlFor="ledger-until"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
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
      </FilterMenu>
    </>
  )
}

/**
 * One toolbar trigger and the popover under it. A trigger whose axis is in force
 * takes the chips' look and **names its value**, its visible text staying the
 * axis: the chip on the summary line is the way out, the trigger is the way in.
 */
function FilterMenu({
  axis,
  value,
  children,
}: {
  axis: string
  value: string | null
  children: ReactNode
}) {
  const { t } = useI18n()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={value === null ? undefined : t('data.toolbar.filter.active', { axis, value })}
          className={cn(
            value !== null &&
              'border-primary bg-primary/12 text-primary hover:bg-primary/20 hover:text-primary dark:border-primary dark:bg-primary/12 dark:hover:bg-primary/20',
          )}
        >
          {axis}
          <ChevronDown aria-hidden className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={axis}
        className="max-h-(--radix-popover-content-available-height) w-60 overflow-y-auto"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** One axis: the question above, its options under it, as a group. */
function Axis({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="label">{label}</h3>
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
      <span aria-hidden className="shrink-0 text-xs tabular">
        {facet.count}
      </span>
    </button>
  )
}
