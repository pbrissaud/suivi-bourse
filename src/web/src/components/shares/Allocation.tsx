/**
 * Where the money is — **twelve slices, above the table they divide** (#727,
 * #831, ADR-0023).
 *
 * **It is the shares page's block, and it always was the shares page's figure.**
 * It shipped on the dashboard at #727 and stayed there for five tickets; what
 * moved it is the maquette, read *rendered* for the first time — the ring and
 * its legend are drawn in the `Titres` branch and there is nothing of them in
 * the dashboard's. The reading holds on its own arithmetic too: the divisor is
 * the value of the lines that can be placed, which is what the page header
 * above the table sums, so the figure in the ring's hole and that header's
 * `Valorisation` are one number said twice — *wherever every line on screen
 * has a value* — rather than two figures that agree. They part on exactly one
 * case, and it is inherited rather than this block's: a held line quoted in a
 * currency whose rate has not resolved empties the **header** outright
 * (`valuationTotal` leaves at the first null, `lib/shares.ts`), while the ring
 * goes on dividing the lines it could place and names the others under it — an
 * em dash above a figure, for the one quantity. That tension was the `Poids`
 * column's before it was this one's, and settling it is a ticket of its own.
 * That is also how the reduction and the anomaly lens are answered
 * without a rule of their own: the block is handed the rows on screen, so a page
 * reduced to one account draws that account's split under a header that sums
 * that account's lines.
 *
 * It is what the maquette answers *the weight of a line* with on that page, and
 * the reason there is no `Poids` column beside `Valorisation` any more (#831,
 * `SharesTable.tsx`): a share is read off a ring and a legend of bars, which is
 * a figure of the whole, rather than off a tenth cell repeated on every row.
 *
 * The threshold was eight and it is measurably wrong: on the real portfolio the
 * tail *Others (4)* is worth **10,1 %**, more than four of the named slices put
 * together, so the one slice nobody can act on outweighed a third of the ones
 * they can. What decided the *layout* was what that threshold cost at half
 * width — four names out of twelve folded into the tail, a block twice the
 * height of the movers beside it, and 350 px of nothing under them. Here the
 * question does not arise at all: the block has the page's whole width, the
 * twelve are named and the legend takes two columns.
 *
 * Three more things are decisions:
 *
 *  - **The legend is in the slices' own order**, descending. Position is what
 *    pairs a legend row to its slice, and that is exactly what licenses the
 *    lightness ramp of ADR-0023: colour here encodes *rank*, redundantly with
 *    the angle, and never identity. A legend in another order would fall
 *    outside the ADR and have to reopen it.
 *  - **No breakdown by account and none by type.** The question *which account
 *    is working* has a page of its own, and this page already answers *by
 *    account* with a gesture that is not a selector: the grouping under it,
 *    which is a partition of the very same lines. A selector here would be a
 *    second, disagreeing one.
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
 *  - **Each legend row draws its share as well as writing it** (#800). The
 *    percentage is exact and comparing two of them is arithmetic; the bar is
 *    the glance. It is `ShareBar`, the one component that draws a share, and it
 *    is handed the slice's own rank stop — the ramp is ADR-0023's and the bar
 *    picks no colour of its own.
 *  - **It names what it could not place.** A position quoted in a currency whose
 *    rate has not resolved has no value in the reporting currency, so summing it
 *    would make every other percentage silently wrong — the exclusion was
 *    already right and its own comment said why, **without ever saying it on
 *    screen**. Excluded from the arithmetic, named beside it.
 */
import type { CSSProperties } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'

import { EmptyState } from '@/components/EmptyState'
import { ShareBar } from '@/components/ShareBar'
import { Stat } from '@/components/Stat'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { allocation, type AllocationSlice, type ShareRow } from '@/lib/shares'

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
  // The bar under each name is drawn full at the **largest** slice, which is
  // the drawing's own scale: read down a column, shares of 26, 18 and 11 per
  // cent are told apart by the comparison and not by the distance to a hundred.
  const largest = slices.reduce((most, slice) => Math.max(most, slice.share), 0)
  // The lines the last slice folds together, which is what the note counts.
  const folded = slices.reduce((count, slice) => (slice.symbol === null ? slice.count : count), 0)
  // **The lines the ring divides, and not the rows the page holds**: a closed
  // position is worth nothing and is not a slice, so counting it here would say
  // *14 lignes · top 7 détaillé, 3 regroupées* over a ring that divides ten.
  const placed = folded === 0 ? slices.length : slices.length - 1 + folded

  const name = (slice: AllocationSlice) =>
    slice.symbol === null ? t('shares.allocation.others', { count: slice.count }) : slice.label

  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* A real heading, and not the primitive's `<div>`: the block is a
            section of the page and a reader jumping by heading must find it.
            Set as the eyebrow every card is headed with (#838). */}
        <h2 className="eyebrow">
          {t('shares.allocation.title')}
        </h2>
        {/* What the ring divides and what it folds — the drawing states it
            beside the heading, because a ring of twelve over a portfolio of
            twenty is a reading and not a truncation. Said only where there is
            something folded: at twelve lines or fewer the sentence would count
            nothing. */}
        {slices.length === 0 ? null : (
          <span className="text-2xs text-muted-foreground">
            {folded === 0
              ? t('shares.allocation.scope.all', { lines: placed })
              : t('shares.allocation.scope', {
                  lines: placed,
                  top: slices.length - 1,
                  folded,
                })}
          </span>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {slices.length === 0 ? (
          // It says **why** it is empty, which at *events but nothing held* is the
          // whole information: nothing is broken, there is nothing to divide.
          <EmptyState
            title={t('shares.allocation.empty')}
            description={t('shares.allocation.empty.body')}
          />
        ) : (
          /* The ring on the left and the legend beside it, at every width that
             has room for the pair. The `lg:grid-cols-1` that used to close this
             grid back up belonged to the dashboard's **rail**, where this block
             sat until the plateau put it on the wide track: left there, it
             stacked a one-column legend under a centred ring on exactly the
             screens the redesign was drawn for. The page it is on now has one
             track and no rail at all. */
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
                    label={t('shares.allocation.total')}
                    value={f.currency(total, currency)}
                  />
                </div>
              </div>
            </div>

            {/* Two columns, and the reading order is the slices' own — **down the
                first column, then down the second** (#831). The comment said so
                from #727 and the grid did the opposite: a default `grid-flow-row`
                fills across, so twelve slices were laid out 1·2 / 3·4 / 5·6 and
                the eye read the second-biggest beside the biggest, the third
                under it. That is a *ranking* the ramp then coloured against
                itself, which is the one thing ADR-0023 licenses the ramp on —
                the list being sorted and legended, position has to pair a row to
                its slice. The maquette flows by column and this now does too:
                `grid-flow-col` with an explicit row count, since an implicit one
                would let the browser choose the split.

                It is two columns at **every** width, because the drawing
                is: the maquette's legend carries `grid-template-columns:1fr 1fr`
                under no condition at all, and the one split that does have a
                condition is ring-beside-legend — its `donutCols`, at 768 px,
                which is the `md:` on the grid above. Under `xl:` this rendered
                a single column from 768 to 1279 px, a shape the drawing never
                takes. The row count stays explicit for the same reason as the
                flow: an implicit one would let the browser choose the split. */}
            <ul
              aria-label={t('shares.allocation.title')}
              style={{ '--legend-rows': Math.ceil(slices.length / 2) } as CSSProperties}
              className="grid grid-flow-col grid-cols-2 gap-x-6 gap-y-1.5 text-sm [grid-template-rows:repeat(var(--legend-rows),auto)]"
            >
              {slices.map((slice, rank) => (
                <li key={slice.symbol ?? 'others'} className="flex flex-col gap-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span
                        aria-hidden
                        className="inline-block size-2.25 shrink-0 rounded-xs"
                        style={{ backgroundColor: stop(rank) }}
                      />
                      <span className="truncate">{name(slice)}</span>
                    </span>
                    {/* A share of a whole, never a change: `formatPercent` signs
                        what it renders (`+56,52 %`), which is right for a
                        movement and reads as one here. */}
                    <span className="tabular shrink-0 font-mono text-xs text-muted-foreground">
                      {f.percentPoints(slice.share * 100, 1)}
                    </span>
                  </span>
                  {/* The same figure, drawn (#800). The percentages are exact
                      and comparing two of them is arithmetic; the bars are the
                      glance, and they are in the ramp the slice already wears,
                      so the row and its arc stay one object. */}
                  <ShareBar share={slice.share} scale={largest} fill={stop(rank)} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {unplaced.length === 0 ? null : (
          <p className="text-sm text-attention">
            {t('shares.allocation.unplaced', {
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
