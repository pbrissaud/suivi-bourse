/**
 * Where the money is (#727, #831, #1281) — **bars, in a section**.
 *
 * The shares page draws the allocation once: `AllocationBars`, the dashboard's
 * half-width list, in a tinted section above the table it divides. The ring it
 * used to carry is gone (#1281) — it drew every share twice, a ring and a legend
 * that drew each one again as a bar, for a reader who decides nothing in it.
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

import { EmptyState } from '@/components/EmptyState'
import { ShareBar } from '@/components/ShareBar'
import { Section } from '@/components/ui/section'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { allocation, type AllocationSlice, type ShareRow } from '@/features/shares/lib/shares'
import { cn } from '@/lib/utils'

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
            <span className="label fig shrink-0">{f.percentPoints(slice.share * 100, 1)}</span>
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
