/**
 * Where the money is — **twelve slices, above the table they divide** (#727,
 * #831).
 *
 * **It is the shares page's block, and it always was the shares page's
 * figure.** It shipped on the dashboard at #727 and stayed there for five
 * tickets; what moved it is the maquette, read *rendered* for the first time —
 * the ring and its legend are drawn in the `Titres` branch and there is nothing
 * of them in the dashboard's. The reading holds on its own arithmetic too: the
 * divisor is the value of the lines that can be placed, which is what the page
 * header above the table sums, so the figure in the ring's hole and that
 * header's `Valorisation` are one number said twice — *wherever every line on
 * screen has a value* — rather than two figures that agree. They part on
 * exactly one case, and it is inherited rather than this block's: a held line
 * quoted in a currency whose rate has not resolved empties the **header**
 * outright (`valuationTotal` leaves at the first null, `features/shares/lib/shares.ts`), while
 * the ring goes on dividing the lines it could place and names the others under
 * it — an em dash above a figure, for the one quantity. That tension was the
 * `Poids` column's before it was this one's, and settling it is a ticket of its
 * own. That is also how the reduction and the anomaly lens are answered without
 * a rule of their own: the block is handed the rows on screen, so a page
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
 *  - **The legend is in the slices' own order**, descending. A legend in
 *    another order would fall outside the ADR and have to reopen it.
 *  - **No breakdown by account and none by type on this page.** The question
 *    *which account is working* has a page of its own, and this page already
 *    answers *by account* with a gesture that is not a selector: the grouping
 *    under it, which is a partition of the very same lines. A selector here
 *    would be a second, disagreeing one. The dashboard's card has no such
 *    table under it, so it does carry the selector (#1206) and draws its
 *    figure with `AllocationFigure` below, without this card's header.
 *  - **The total is at the centre of the donut** (#790), which is the one place
 *    on the figure where it is not a fourteenth line competing with the twelve
 *    slices and the tail. It is **one object and two lines**: #790 wrote it as
 *    one sentence so that the figure and what it is the amount *of* could not
 *    be separated, and a sentence does not fit a hole — `2 300,00 € de titres`
 *    measured 144 px inside a 139 px ring and was drawn over the slices it
 *    divides. `Stat` keeps the pair whole where it matters, which is the
 *    accessible tree: one named group, read *Titres, 2 300,00 €*. That is why
 *    the primitive gained an alignment rather than this file gaining a fifth
 *    copy of it.
 *  - **Each legend row draws its share as well as writing it** (#800). The
 *    percentage is exact and comparing two of them is arithmetic; the bar is
 *    the glance.
 *  - **It names what it could not place.** A position quoted in a currency
 *    whose rate has not resolved has no value in the reporting currency, so
 *    summing it would make every other percentage silently wrong — the
 *    exclusion was already right and its own comment said why, **without ever
 *    saying it on screen**. Excluded from the arithmetic, named beside it.
 */
import type { CSSProperties } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'

import { EmptyState } from '@/components/EmptyState'
import { ShareBar } from '@/components/ShareBar'
import { Stat } from '@/components/Stat'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import {
  allocation,
  type Allocation as Split,
  type AllocationSlice,
  type ShareRow,
} from '@/features/shares/lib/shares'
import { cn } from '@/lib/utils'

interface AllocationProps {
  rows: readonly ShareRow[]
  currency: string | null
}

/** The rank's own token, the primary mixed into the ground in `index.css`. */
function stop(rank: number): string {
  return `var(--alloc-${rank + 1})`
}

/**
 * A slice's React key. The tail has no symbol, and its key cannot be a word an
 * account id could also be (an account called `others` would share it).
 */
export function sliceKey(slice: AllocationSlice): string {
  return slice.symbol === null ? '\u0000tail' : `slice:${slice.symbol}`
}

/** The lines (or accounts) the last slice folds together, `0` with no fold. */
function foldedCount(slices: readonly AllocationSlice[]): number {
  return slices.reduce((count, slice) => (slice.symbol === null ? slice.count : count), 0)
}

/**
 * What the ring divides and what it folds. **The lines the ring divides, and
 * not the rows the page holds**: a closed position is worth nothing and is not
 * a slice, so counting it here would say *14 lignes · top 7 détaillé, 3
 * regroupées* over a ring that divides ten. The dashboard counts accounts with
 * the same sentence (`unit`).
 */
export function AllocationScope({
  slices,
  unit = 'lines',
  className,
}: {
  slices: readonly AllocationSlice[]
  unit?: 'lines' | 'accounts'
  className?: string
}) {
  const { t } = useI18n()
  if (slices.length === 0) return null
  const folded = foldedCount(slices)
  const placed = folded === 0 ? slices.length : slices.length - 1 + folded
  const top = slices.length - 1
  return (
    <span className={className}>
      {unit === 'lines'
        ? folded === 0
          ? t('shares.allocation.scope.all', { lines: placed })
          : t('shares.allocation.scope', { lines: placed, top, folded })
        : folded === 0
          ? t('dashboard.allocation.scope.accounts.all', { accounts: placed })
          : t('dashboard.allocation.scope.accounts', { accounts: placed, top, folded })}
    </span>
  )
}

export function Allocation({ rows, currency }: AllocationProps) {
  const { t } = useI18n()
  const split = allocation(rows)

  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* A real heading, and not the primitive's `<div>`: the block is a
            section of the page and a reader jumping by heading must find it.
            Set as the label (DESIGN.md). */}
        <h2 className="label">{t('shares.allocation.title')}</h2>
        {/* What the ring divides and what it folds — the drawing states it
            beside the heading, because a ring of twelve over a portfolio of
            twenty is a reading and not a truncation. */}
        <AllocationScope slices={split.slices} className="text-2xs text-muted-foreground" />
      </CardHeader>

      <CardContent>
        <AllocationFigure
          {...split}
          currency={currency}
          title={t('shares.allocation.title')}
          name={(slice) =>
            slice.symbol === null
              ? t('shares.allocation.others', { count: slice.count })
              : (slice.label ?? slice.symbol)
          }
        />
      </CardContent>
    </Card>
  )
}

interface AllocationFigureProps extends Split {
  currency: string | null
  /** The legend's accessible name. */
  title: string
  /** What a slice is called — the tail's word (« lignes », « comptes ») is the surface's. */
  name: (slice: AllocationSlice) => string
  /** Each legend row also writes its amount (the dashboard's full width). */
  amounts?: boolean
  /**
   * `page` is the shares page's: a third of the width, 256 px high. `card` is
   * the dashboard's (#1206): a fixed 220 px ring beside the legend from `lg:`,
   * above it under that — at 768 px the card is ~470 px wide, and a ring and a
   * legend of amounts side by side left the ring under its total and the names
   * a few letters long.
   */
  ring?: 'page' | 'card'
}

/**
 * The figure without its frame — ring, total in its hole, legend and the
 * lines it could not place — so the shares page and the dashboard's card draw
 * one figure under two headers.
 */
export function AllocationFigure({
  slices,
  total,
  unplaced,
  currency,
  title,
  name,
  amounts = false,
  ring = 'page',
}: AllocationFigureProps) {
  const { t } = useI18n()
  const f = useFormatters()
  // The bar under each name is drawn full at the **largest** slice, which is
  // the drawing's own scale: read down a column, shares of 26, 18 and 11 per
  // cent are told apart by the comparison and not by the distance to a hundred.
  const largest = slices.reduce((most, slice) => Math.max(most, slice.share), 0)

  return (
    <div className="space-y-3">
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
        <div
          className={cn(
            'grid grid-cols-1 gap-6',
            ring === 'page'
              ? 'md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:items-center'
              : 'lg:grid-cols-[220px_minmax(0,1fr)] lg:items-center',
          )}
        >
          {/* **The one drawing here that really is `aria-hidden`** (#1003), and
                the reason is that nothing in it navigates. Every other chart in
                this product keeps Recharts' `accessibilityLayer`, because its
                arrows walk a series and a reader can ask about a day. This ring
                mounts no tooltip at all, so the arrows have nowhere to go: left
                focusable it would be a stop in the tab order that answers no key.
                And its legend beside it already names every slice with its exact
                percentage, which makes the arcs a repeat of the text — exactly
                the case `ShareBar`'s rule was written for. */}
          <div
            className={cn(
              'relative',
              ring === 'page' ? 'h-64' : 'mx-auto h-[220px] w-full max-w-[220px]',
            )}
          >
            {/* `aria-hidden` on **this** node and not on the one above it: the
                  total in the ring's hole is a real figure and `Stat` keeps it
                  whole in the accessible tree, read *Titres, 2 300,00 €*. Hiding
                  its container would have taken that with the arcs. */}
            <div aria-hidden className="h-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart accessibilityLayer={false}>
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
                      <Cell key={sliceKey(slice)} fill={stop(rank)} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
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
            fills across, so twelve slices were laid out 1·2 / 3·4 / 5·6 and the
            eye read the second-biggest beside the biggest, the third under it.
            The maquette flows by column and this now does too: `grid-flow-col`
            with an explicit row count, since an implicit one would let the
            browser choose the split.

            It is two columns at **every** width, because the drawing is: the
            maquette's legend carries `grid-template-columns:1fr 1fr` under no
            condition at all, and the one split that does have a condition is
            ring-beside-legend — its `donutCols`, at 768 px, which is the `md:`
            on the grid above. Under `xl:` this rendered a single column from
            768 to 1279 px, a shape the drawing never takes. The row count stays
            explicit for the same reason as the flow: an implicit one would let
            the browser choose the split. */}
          <ul
            aria-label={title}
            style={
              {
                '--legend-rows': Math.ceil(slices.length / 2),
                '--legend-rows-one': slices.length,
              } as CSSProperties
            }
            // With amounts, a row holds a name, a sum and a share: two columns
            // beside the ring leave the name a few letters under `xl:`, so it
            // is one column there (the dashboard's full width, #1206).
            className={cn(
              'grid grid-flow-col gap-x-6 gap-y-1.5 text-sm',
              amounts
                ? 'grid-cols-1 [grid-template-rows:repeat(var(--legend-rows-one),auto)] xl:grid-cols-2 xl:[grid-template-rows:repeat(var(--legend-rows),auto)]'
                : 'grid-cols-2 [grid-template-rows:repeat(var(--legend-rows),auto)]',
            )}
          >
            {slices.map((slice, rank) => (
              <li key={sliceKey(slice)} className="flex flex-col gap-1">
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
                  <span className="flex shrink-0 items-baseline gap-3">
                    {amounts ? (
                      <span className="tabular text-xs">{f.currency(slice.value, currency)}</span>
                    ) : null}
                    <span className="tabular font-mono text-xs text-muted-foreground">
                      {f.percentPoints(slice.share * 100, 1)}
                    </span>
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

      <AllocationUnplaced unplaced={unplaced} />
    </div>
  )
}

/**
 * **It names what it could not place.** A position quoted in a currency whose
 * rate has not resolved has no value in the reporting currency, so summing it
 * would make every other percentage silently wrong: excluded from the
 * arithmetic, named beside it. Said even when nothing could be placed, where
 * the empty state alone would be wrong about lines that are held.
 */
export function AllocationUnplaced({ unplaced }: { unplaced: readonly string[] }) {
  const { t } = useI18n()
  const f = useFormatters()
  if (unplaced.length === 0) return null
  return (
    <p className="text-sm text-attention">
      {t('shares.allocation.unplaced', {
        count: unplaced.length,
        // `f.list` and not `join(', ')`: this is a sentence, and a
        // language does not enumerate with a separator (#768). English
        // closes on *and*, French on *et*.
        symbols: f.list(unplaced),
      })}
    </p>
  )
}
