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
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'

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
}

export function BenchmarkChart({ points, index, currency }: BenchmarkChartProps) {
  const { t } = useI18n()
  const f = useFormatters()

  if (points.length === 0) {
    // A fact and not a wait: the payload answered `ready`, so there is a period
    // and it holds no drawable day. *Not answered* never reaches here — the
    // page returns before this mounts.
    return (
      <Card>
        <CardContent className="py-6">
          <EmptyState title={t('benchmark.chart.empty')} />
        </CardContent>
      </Card>
    )
  }

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
      <CardContent className="py-6">
        {/* **`aria-hidden`, and the legend below is not.** Honest here and
            only here: §2 puts the whole answer in the head — in prose and in
            figures — so a non-visual reader loses the shape and nothing else.
            That no chart in this product has a non-visual reading is a
            product-wide gap and has its own ticket, not a clause in this one.

            Kept at 390 px, shorter. Seventeen years on 350 px does not read to
            the day, but *the gap is widening* and *the gap is closing* read
            perfectly well, and no other screen here removes content by width. */}
        <div className="h-60 sm:h-75" aria-hidden>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows}>
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

              {/* Both bands answer the pointer with a figure the two lines
                  already state, so they take function keys and drop out of the
                  tooltip (`ChartTooltip`). */}
              <Area
                dataKey={(row: { floor: number | null }) => row.floor}
                name={t('benchmark.chart.floor')}
                stackId="gap"
                stroke="none"
                fill="none"
                isAnimationActive={false}
                connectNulls={false}
              />
              <Area
                dataKey={(row: { gapAhead: number | null }) => row.gapAhead}
                name={t('benchmark.chart.area')}
                stackId="gap"
                stroke="none"
                fill="var(--color-price)"
                fillOpacity={0.14}
                isAnimationActive={false}
                connectNulls={false}
              />
              <Area
                dataKey={(row: { gapBehind: number | null }) => row.gapBehind}
                name={t('benchmark.chart.area')}
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

        {/* Written here rather than left to the library, for the reason
            `PortfolioChart` gives: the legend pairs a curve to its **name**,
            and that is all it does. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
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
            <span className="text-muted-foreground">
              {t('benchmark.chart.theirs', { index })}
            </span>
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
