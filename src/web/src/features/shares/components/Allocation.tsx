/**
 * Where the money is (#727, #831, #1281) — **bars, in a section**.
 *
 * The shares page draws the allocation once: `AllocationBars`, the dashboard's
 * half-width list, in a tinted section above the table it divides. The ring it
 * used to carry is gone (#1281) — it drew every share twice, a ring and a legend
 * that drew each one again as a bar, for a reader who decides nothing in it. The
 * dashboard's full width still draws its ring (`AllocationFigure`).
 *
 * Four things are decisions and stay so:
 *
 *  - **The list is in the slices' own order**, descending, and the fold is
 *    `foldSlices`' (`features/shares/lib/shares.ts`), the dashboard's.
 *  - **No breakdown by account and none by type on this page.** The page
 *    already answers *by account* with a gesture that is not a selector: the
 *    grouping of the table under it, a partition of the very same lines. The
 *    dashboard's card has no such table, so it carries the selector (#1206).
 *  - **The block is handed the rows the table's total row sums**, which is how
 *    the reduction and the anomaly lens reach it with no rule of its own. They
 *    part on one inherited case: a held line whose rate has not resolved empties
 *    the total's Valorisation, while the list goes on dividing the lines it
 *    could place and names the others under it.
 *  - **It names what it could not place.** A position quoted in a currency whose
 *    rate has not resolved has no value in the reporting currency, so summing it
 *    would make every other percentage silently wrong: excluded from the
 *    arithmetic, named beside it.
 */
import type { CSSProperties } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'

import { EmptyState } from '@/components/EmptyState'
import { ShareBar } from '@/components/ShareBar'
import { Stat } from '@/components/Stat'
import { Section } from '@/components/ui/section'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import {
  allocation,
  type Allocation as Split,
  type AllocationSlice,
  type ShareRow,
} from '@/features/shares/lib/shares'
import { cn } from '@/lib/utils'

/** The rank's own token: a chart hue, or the muted foreground for the fold (`index.css`). */
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
 * What the allocation divides and what it folds. **The lines it divides, and
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
  const folded = foldedCount(slices)
  // Nothing folded: the list under it already counts itself (#1412).
  if (slices.length === 0 || folded === 0) return null
  const placed = slices.length - 1 + folded
  const top = slices.length - 1
  return (
    <span className={className}>
      {unit === 'lines'
        ? t('shares.allocation.scope', { lines: placed, top, folded })
        : t('dashboard.allocation.scope.accounts', { accounts: placed, top, folded })}
    </span>
  )
}

export function Allocation({ rows }: { rows: readonly ShareRow[] }) {
  const { t } = useI18n()
  const split = allocation(rows)

  return (
    <Section
      title={t('shares.allocation.title')}
      aside={<AllocationScope slices={split.slices} className="label" />}
    >
      <div className="space-y-3">
        {split.slices.length === 0 ? (
          // It says **why** it is empty, which at *events but nothing held* is the
          // whole information: nothing is broken, there is nothing to divide.
          <EmptyState
            title={t('shares.allocation.empty')}
            description={t('shares.allocation.empty.body')}
          />
        ) : (
          <AllocationBars
            slices={split.slices}
            title={t('shares.allocation.title')}
            columns={2}
            name={(slice) =>
              slice.symbol === null
                ? t('shares.allocation.others', { count: slice.count })
                : (slice.label ?? slice.symbol)
            }
          />
        )}
        <AllocationUnplaced unplaced={split.unplaced} />
      </div>
    </Section>
  )
}

/**
 * The weight bars: one colour (`muted-foreground`), a 6 px bar per row drawn
 * full at the **largest** slice — read down a column, shares of 26, 18 and 11
 * per cent are told apart by the comparison and not by the distance to a
 * hundred. With no ring beside it the bars are the drawing, so they wear no rank.
 *
 * `columns={2}` fills **down the first column, then down the second** from
 * 768 px (an explicit row count, since an implicit one would let the browser
 * choose the split), and is one column below.
 */
export function AllocationBars({
  slices,
  name,
  columns,
  title,
}: {
  slices: readonly AllocationSlice[]
  /** What a slice is called — the tail's word (« lignes », « comptes ») is the surface's. */
  name: (slice: AllocationSlice) => string
  columns: 1 | 2
  /** The list's accessible name. */
  title: string
}) {
  const f = useFormatters()
  const largest = slices.reduce((most, slice) => Math.max(most, slice.share), 0)
  return (
    <ul
      aria-label={title}
      style={{ '--bars-rows': Math.ceil(slices.length / 2) } as CSSProperties}
      // `grid-cols-1` is not decoration (#1374): the implicit track is `auto`,
      // so a long name took it to its max-content and `truncate` never applied,
      // widening the page past a phone (`lint/grid-base-columns.grit`).
      className={cn(
        'grid grid-cols-1 gap-x-6 gap-y-2 text-sm',
        columns === 2 &&
          'md:grid-flow-col md:grid-cols-2 md:[grid-template-rows:repeat(var(--bars-rows),auto)]',
      )}
    >
      {slices.map((slice) => (
        <li key={sliceKey(slice)} className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="truncate">{name(slice)}</span>
            {/* A share of a whole, never a change: `formatPercent` signs what it
                renders (`+56,52 %`), which reads as a movement here. */}
            <span className="label tabular shrink-0">{f.percentPoints(slice.share * 100, 1)}</span>
          </span>
          <ShareBar
            share={slice.share}
            scale={largest}
            fill="var(--muted-foreground)"
            size="weight"
          />
        </li>
      ))}
    </ul>
  )
}

interface AllocationFigureProps extends Split {
  currency: string | null
  /** The legend's accessible name. */
  title: string
  /** What a slice is called — the tail's word (« lignes », « comptes ») is the surface's. */
  name: (slice: AllocationSlice) => string
  /** What the total in the hole is the total of — the whole every share divides (#1426). */
  totalLabel: string
  /** Each legend row also writes its amount (the dashboard's full width). */
  amounts?: boolean
}

/**
 * The dashboard's full-width figure without its frame — ring, total in its
 * hole, legend and the lines it could not place. A fixed 220 px ring beside the
 * legend from `lg:`, above it under that: at 768 px the card is ~470 px wide,
 * and a ring and a legend of amounts side by side left the ring under its
 * total and the names a few letters long.
 */
export function AllocationFigure({
  slices,
  total,
  unplaced,
  currency,
  title,
  name,
  totalLabel,
  amounts = false,
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
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-center">
          {/* **The one drawing here that really is `aria-hidden`** (#1003), and
                the reason is that nothing in it navigates. Every other chart in
                this product keeps Recharts' `accessibilityLayer`, because its
                arrows walk a series and a reader can ask about a day. This ring
                mounts no tooltip at all, so the arrows have nowhere to go: left
                focusable it would be a stop in the tab order that answers no key.
                And its legend beside it already names every slice with its exact
                percentage, which makes the arcs a repeat of the text — exactly
                the case `ShareBar`'s rule was written for. */}
          <div className="relative mx-auto h-[220px] w-full max-w-[220px]">
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
                <Stat align="center" label={totalLabel} value={f.currency(total, currency)} />
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
                '--legend-rows-three': Math.ceil(slices.length / 3),
              } as CSSProperties
            }
            // With amounts, a row holds a name, a sum and a share: two columns
            // beside the ring leave the name a few letters under `xl:`, so it
            // is one column there (the dashboard's full width, #1206). Across
            // the three tracks of 1 600 px and up it is three (#1325).
            className={cn(
              'grid grid-flow-col gap-x-6 gap-y-1.5 text-sm',
              amounts
                ? 'grid-cols-1 [grid-template-rows:repeat(var(--legend-rows-one),auto)] xl:grid-cols-2 xl:[grid-template-rows:repeat(var(--legend-rows),auto)] 3xl:grid-cols-3 3xl:[grid-template-rows:repeat(var(--legend-rows-three),auto)]'
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
                    <span className="tabular text-xs text-muted-foreground">
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
