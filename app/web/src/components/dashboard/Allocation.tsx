/**
 * Where the money is — **twelve slices and the full width** (#727, ADR-0023).
 *
 * The threshold was eight and it is measurably wrong: on the real portfolio the
 * tail *Others (4)* is worth **10,1 %**, more than four of the named slices put
 * together, so the one slice nobody can act on outweighed a third of the ones
 * they can. What decides the *layout* is what that threshold costs at half
 * width — four names out of twelve folded into the tail, a block twice the
 * height of the movers beside it, and 350 px of nothing under them. At full
 * width the twelve are named, the legend takes two columns and the movers sit
 * underneath.
 *
 * Three more things are decisions:
 *
 *  - **The legend is in the slices' own order**, descending. Position is what
 *    pairs a legend row to its slice, and that is exactly what licenses the
 *    lightness ramp of ADR-0023: colour here encodes *rank*, redundantly with
 *    the angle, and never identity. A legend in another order would fall
 *    outside the ADR and have to reopen it.
 *  - **No breakdown by account and none by type.** A second selector beside the
 *    chart's is the duplication this page keeps closing, and the question *which
 *    account is working* has a page of its own.
 *  - **It names what it could not place.** A position quoted in a currency whose
 *    rate has not resolved has no value in the reporting currency, so summing it
 *    would make every other percentage silently wrong — the exclusion was
 *    already right and its own comment said why, **without ever saying it on
 *    screen**. Excluded from the arithmetic, named beside it.
 */
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'

import { EmptyState } from '@/components/EmptyState'
import { allocation, type AllocationSlice } from '@/lib/dashboard'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ShareRow } from '@/lib/shares'

export interface AllocationProps {
  rows: readonly ShareRow[]
  currency: string | null
}

/** The rank's own token, written onto the root element by `ThemeProvider`. */
function stop(rank: number): string {
  return `var(--alloc-${rank + 1})`
}

export function Allocation({ rows, currency }: AllocationProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const { slices, total, unplaced } = allocation(rows)

  const name = (slice: AllocationSlice) =>
    slice.symbol === null ? t('dashboard.allocation.others', { count: slice.count }) : slice.label

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">{t('dashboard.allocation.title')}</h2>

      {slices.length === 0 ? (
        // It says **why** it is empty, which at *events but nothing held* is the
        // whole information: nothing is broken, there is nothing to divide.
        <EmptyState
          title={t('dashboard.allocation.empty')}
          description={t('dashboard.allocation.empty.body')}
        />
      ) : (
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:items-center">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices as AllocationSlice[]}
                  dataKey="value"
                  nameKey="symbol"
                  innerRadius="55%"
                  outerRadius="85%"
                  isAnimationActive={false}
                  stroke="var(--background)"
                >
                  {slices.map((slice, rank) => (
                    <Cell key={slice.symbol ?? 'others'} fill={stop(rank)} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Two columns, and the reading order is the slices' order — down the
              first column, then down the second, so rank stays legible. */}
          <ul
            aria-label={t('dashboard.allocation.title')}
            className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2"
          >
            {slices.map((slice, rank) => (
              <li
                key={slice.symbol ?? 'others'}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span
                    aria-hidden
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: stop(rank) }}
                  />
                  <span className="truncate">{name(slice)}</span>
                </span>
                {/* A share of a whole, never a change: `formatPercent` signs
                    what it renders (`+56,52 %`), which is right for a movement
                    and reads as one here. */}
                <span className="tabular shrink-0 text-muted-foreground">
                  {f.percentPoints(slice.share * 100)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {slices.length === 0 ? null : (
        <p className="text-sm text-muted-foreground">
          {t('dashboard.allocation.total', { amount: f.currency(total, currency) })}
        </p>
      )}

      {unplaced.length === 0 ? null : (
        <p className="text-sm text-attention">
          {t('dashboard.allocation.unplaced', {
            count: unplaced.length,
            symbols: unplaced.join(', '),
          })}
        </p>
      )}
    </section>
  )
}
