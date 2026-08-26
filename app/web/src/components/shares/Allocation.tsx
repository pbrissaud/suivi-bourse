/**
 * Where the money is — **twelve slices, above the table they divide** (#727,
 * #831, ADR-0023).
 *
 * **It is the shares page's block, and it always was the shares page's figure.**
 * It shipped on the dashboard at #727 and stayed there for five tickets; what
 * moved it is the maquette, read *rendered* for the first time — the ring and
 * its legend are drawn in the `Titres` branch and there is nothing of them in
 * the dashboard's. The reading holds on its own arithmetic too: the divisor is
 * the value of the lines that can be placed, which is exactly what the page
 * header above the table sums, so the figure in the ring's hole and that
 * header's `Valorisation` are one number said twice rather than two figures
 * that agree. That is also how the reduction and the anomaly lens are answered
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

  const name = (slice: AllocationSlice) =>
    slice.symbol === null ? t('shares.allocation.others', { count: slice.count }) : slice.label

  return (
    <Card className="gap-4">
      <CardHeader>
        {/* A real heading, and not the primitive's `<div>`: the block is a
            section of the page and a reader jumping by heading must find it. */}
        <h2 className="text-sm font-medium">{t('shares.allocation.title')}</h2>
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

            {/* Two columns, and the reading order is the slices' order — down the
                first column, then down the second, so rank stays legible. */}
            <ul
              aria-label={t('shares.allocation.title')}
              className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm xl:grid-cols-2"
            >
              {slices.map((slice, rank) => (
                <li key={slice.symbol ?? 'others'} className="flex flex-col gap-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span
                        aria-hidden
                        className="inline-block size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: stop(rank) }}
                      />
                      <span className="truncate">{name(slice)}</span>
                    </span>
                    {/* A share of a whole, never a change: `formatPercent` signs
                        what it renders (`+56,52 %`), which is right for a
                        movement and reads as one here. */}
                    <span className="tabular shrink-0 text-muted-foreground">
                      {f.percentPoints(slice.share * 100)}
                    </span>
                  </span>
                  {/* The same figure, drawn (#800). The percentages are exact
                      and comparing two of them is arithmetic; the bars are the
                      glance, and they are in the ramp the slice already wears,
                      so the row and its arc stay one object. */}
                  <ShareBar share={slice.share} fill={stop(rank)} />
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
