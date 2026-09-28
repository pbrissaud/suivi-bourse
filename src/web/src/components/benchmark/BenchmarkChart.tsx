/**
 * The two curves, in euros — and **the area between them is the gap**.
 *
 * The same reading `PortfolioChart` gives *Montants*, arrived at from the other
 * end: there, the wash sits under the value curve because a fill *between* two
 * curves is a signed quantity that crosses zero inside a window and would be
 * the wrong colour half the time. Here the sign is the whole subject of the
 * screen, so the fill takes it — mint where the portfolio leads, the loss
 * colour where the reference does. **Per day**, because two curves over
 * seventeen years cross, and one colour for the window would paint the years
 * the owner was ahead in the colour of the years they were not.
 *
 * **No base-100 normalisation.** #760 is the euro question, money-weighted:
 * both curves start at the same amount on the same day by construction, so
 * rebasing them would answer *what return* — which `twr_index` already draws on
 * the dashboard — instead of *how much is left*.
 *
 * **The legend names the index, never the ticker.** `CW8.PA` is an address; the
 * MSCI World is what the owner is being compared against.
 */
import type { ReactNode } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'

import { ChartReading } from '@/components/ChartReading'
import { ChartTooltip } from '@/components/ChartTooltip'
import { EmptyState } from '@/components/EmptyState'
import { Card, CardContent } from '@/components/ui/card'
import type { BenchmarkPoint } from '@/lib/api'
import { yFloor } from '@/lib/dashboard'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

interface BenchmarkChartProps {
  points: readonly BenchmarkPoint[]
  /** The index both curves are named by — never the ticker. */
  index: string
  currency: string | null
  /**
   * The reference selector, in the card's corner. It comes after the head in
   * reading order either way — the page still answers before it asks — and it
   * sits beside the curves it changes rather than on a row of its own.
   */
  action?: ReactNode
}

export function BenchmarkChart({ points, index, currency, action }: BenchmarkChartProps) {
  const { t } = useI18n()
  const f = useFormatters()

  // **One return, two bodies** (#1003). The empty state used to be an early
  // return of its own, which put it and the drawing in two separate nodes — and
  // a live region has to outlive what it reports on: pressing the reference
  // selector can swap one for the other, and a region that unmounts announces
  // nothing. So the two share a node below, and the `<Header>` is written once.
  const empty = points.length === 0

  // Recharts fills from a baseline and not between two series, so the band is
  // stacked: the lower curve is an invisible floor, and the gap rides on it.
  // **Two gap bands, not one**, each carrying the days where its side leads and
  // `null` on the others — that is what makes the colour switch at a crossing
  // without computing the crossing itself. The switch lands on the day rather
  // than on the exact intersection, which over 900 points is under a pixel.
  //
  // A day the portfolio has no value for is a hole in both bands, never a day
  // the reference won by default.
  const rows = points.map((point) => {
    if (point.portfolio === null) {
      return { ...point, floor: null, gapAhead: null, gapBehind: null }
    }
    const gap = Math.abs(point.portfolio - point.reference)
    const leading = point.portfolio >= point.reference
    return {
      ...point,
      floor: Math.min(point.portfolio, point.reference),
      gapAhead: leading ? gap : null,
      gapBehind: leading ? null : gap,
    }
  })

  return (
    <Card>
      <CardContent className="space-y-4 py-6">
        <Header action={action}>{empty ? null : <Legend index={index} />}</Header>

        {/* **The plot is reachable, and it is named** (#1003). It used to carry
            `aria-hidden`, on the argument that the head says the whole answer in
            prose and in figures, so a non-visual reader lost the shape and
            nothing else. That argument was half right and the mechanism was
            wrong: Recharts turns its own `accessibilityLayer` on by default, so
            this `<svg>` is focusable and its arrows already walk seventeen years
            of days — hiding it left a stop in the tab order that announced
            nothing at all. The head still carries the verdict and the figure of
            today, which is why the sentence below states the **crossings** and
            never the gap.

            The live region wraps the swap rather than the drawing: pressing the
            reference selector can replace the plot with the empty state, and a
            region living inside the drawn branch would unmount instead of
            changing.

            Kept at 390 px, shorter. Seventeen years on 350 px does not read to
            the day, but *the gap is widening* and *the gap is closing* read
            perfectly well, and no other screen here removes content by width. */}
        <div aria-live="polite">
          {empty ? (
            // A fact and not a wait: the payload answered `ready`, so there is a
            // period and it holds no drawable day. *Not answered* never reaches
            // here — the page returns before this mounts.
            <EmptyState title={t('benchmark.chart.empty')} />
          ) : (
            <figure>
              <div className="h-60 sm:h-75">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={rows} aria-label={t('benchmark.chart.plot')}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="t" hide />
                    {/* Floored at zero whenever nothing drawn is negative, which is
                        `yFloor`'s own rule: neither a portfolio value nor a replayed
                        holding goes below zero, so the plot keeps its baseline and
                        the two curves keep their proportion to each other. */}
                    <YAxis
                      domain={[
                        yFloor(rows.flatMap((row) => [row.portfolio, row.reference])),
                        'auto',
                      ]}
                      hide
                    />

                    <ChartTooltip format={(value) => f.currency(value, currency)} />

                    {/* All three bands answer the pointer with a figure the two
                        lines already state, so they take function keys and drop out
                        of the tooltip (`ChartTooltip`) — which is also why none of
                        them carries a name: nothing renders it. */}
                    <Area
                      dataKey={(row: { floor: number | null }) => row.floor}
                      stackId="gap"
                      stroke="none"
                      fill="none"
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                    <Area
                      dataKey={(row: { gapAhead: number | null }) => row.gapAhead}
                      stackId="gap"
                      stroke="none"
                      fill="var(--color-price)"
                      fillOpacity={0.14}
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                    <Area
                      dataKey={(row: { gapBehind: number | null }) => row.gapBehind}
                      stackId="gap"
                      stroke="none"
                      fill="var(--loss)"
                      fillOpacity={0.14}
                      isAnimationActive={false}
                      connectNulls={false}
                    />

                    <Line
                      type="monotone"
                      dataKey="portfolio"
                      name={t('benchmark.chart.yours')}
                      stroke="var(--color-price)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="reference"
                      name={t('benchmark.chart.theirs', { index })}
                      stroke="var(--muted-foreground)"
                      strokeWidth={1.25}
                      strokeDasharray="4 4"
                      dot={false}
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              {/* The crossings are this screen's subject and nothing stated them:
                  the head says the gap of today, the legend says which curve is
                  which, and until now the day the two changed places was in the
                  drawing alone. */}
              <ChartReading
                rows={rows}
                curves={[
                  { name: t('benchmark.chart.yours'), key: 'portfolio' },
                  // **The index, and not the legend's own string.** The legend
                  // reads `MSCI World, même argent investi` because it has a
                  // swatch beside it and one line to make its claim; inside a
                  // spoken sentence that clause comes back three times and
                  // buries the figures. *Same money invested* is already said
                  // once, by the card's heading above.
                  { name: index, key: 'reference' },
                ]}
                format={currency === null ? null : (value) => f.currency(value, currency)}
              />
            </figure>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** The card's title and legend on one side, the selector on the other. */
function Header({ action, children }: { action?: ReactNode; children?: ReactNode }) {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold">{t('benchmark.chart.title')}</h2>
        {children}
      </div>
      {action}
    </div>
  )
}

/**
 * Written here rather than left to the library, for the reason
 * `PortfolioChart` gives: the legend pairs a curve to its **name**, and that is
 * all it does.
 */
function Legend({ index }: { index: string }) {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-1.5 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5">
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-0.75 w-3.5 rounded-xs"
          style={{ backgroundColor: 'var(--color-price)' }}
        />
        <span className="text-muted-foreground">{t('benchmark.chart.yours')}</span>
      </span>
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-0.5 w-4"
          style={{ backgroundColor: 'var(--muted-foreground)' }}
        />
        <span className="text-muted-foreground">{t('benchmark.chart.theirs', { index })}</span>
      </span>
    </div>
  )
}
