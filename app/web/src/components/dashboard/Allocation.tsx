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
 *  - **The total is at the centre of the donut** (#790), which is the one
 *    place on the figure where it is not a fourteenth line competing with the
 *    twelve slices and the tail. It is **one object and two lines**: #790 wrote
 *    it as one sentence so that the figure and what it is the amount *of* could
 *    not be separated, and a sentence does not fit a hole — `2 300,00 € de
 *    titres` measured 144 px inside a 139 px ring and was drawn over the slices
 *    it divides. `Stat` keeps the pair whole where it matters, which is the
 *    accessible tree: one named group, read *Titres, 2 300,00 €*. That is why
 *    the primitive gained an alignment rather than this file gaining a fifth
 *    copy of it.
 *  - **It names what it could not place.** A position quoted in a currency whose
 *    rate has not resolved has no value in the reporting currency, so summing it
 *    would make every other percentage silently wrong — the exclusion was
 *    already right and its own comment said why, **without ever saying it on
 *    screen**. Excluded from the arithmetic, named beside it.
 */
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'

import { EmptyState } from '@/components/EmptyState'
import { Stat } from '@/components/Stat'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
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
    <Card className="gap-4">
      <CardHeader>
        {/* A real heading, and not the primitive's `<div>`: the block is a
            section of the page and a reader jumping by heading must find it. */}
        <h2 className="text-sm font-medium">{t('dashboard.allocation.title')}</h2>
      </CardHeader>

      <CardContent className="space-y-3">
        {slices.length === 0 ? (
          // It says **why** it is empty, which at *events but nothing held* is the
          // whole information: nothing is broken, there is nothing to divide.
          <EmptyState
            title={t('dashboard.allocation.empty')}
            description={t('dashboard.allocation.empty.body')}
          />
        ) : (
          /* The ring on the left and the legend beside it, at every width that
             has room for the pair. The `lg:grid-cols-1` that used to close this
             grid back up belonged to the **rail**, where this block sat until
             the plateau put it on the wide track: left there, it stacked a
             one-column legend under a centred ring on exactly the screens the
             redesign was drawn for. */
          <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:items-center">
            <div className="relative h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={slices as AllocationSlice[]}
                    dataKey="value"
                    nameKey="symbol"
                    innerRadius="62%"
                    outerRadius="88%"
                    isAnimationActive={false}
                    stroke="var(--background)"
                  >
                    {slices.map((slice, rank) => (
                      <Cell key={slice.symbol ?? 'others'} fill={stop(rank)} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              {/* The total, in the hole it left: the ring has a middle and the
                  figure it is the division of belongs in it. `pointer-events-none`
                  so the slices under it stay reachable. */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="max-w-[9rem]">
                  <Stat
                    align="center"
                    label={t('dashboard.allocation.total')}
                    value={f.currency(total, currency)}
                  />
                </div>
              </div>
            </div>

            {/* Two columns, and the reading order is the slices' order — down the
                first column, then down the second, so rank stays legible. */}
            <ul
              aria-label={t('dashboard.allocation.title')}
              className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm xl:grid-cols-2"
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

        {unplaced.length === 0 ? null : (
          <p className="text-sm text-attention">
            {t('dashboard.allocation.unplaced', {
              count: unplaced.length,
              // `f.list` and not `join(', ')`: this is a sentence, and a
              // language does not enumerate with a separator (#768). English
              // closes on *and*, French on *et*.
              symbols: f.list(unplaced),
            })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
