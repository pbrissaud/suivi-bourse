import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { api, type PortfolioHistory } from '@/lib/api'
import { roundOutward } from '@/lib/chart'
import { formatCurrency, formatDate } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/**
 * The dashboard's main chart — #652 déc. 7, and the map's most specific chart
 * request: **the area between the two curves *is* the Gain**.
 *
 * That is the whole argument for it. A value curve alone cannot answer "did I
 * gain because it went up, or because I put more in"; drawing the money put in
 * underneath it makes the answer the shaded region. The Grafana baseline has
 * this shape **per account only** (panel 3) — globally it shows the TWR index
 * and nothing else, so this chart does not exist at portfolio level today.
 *
 * Two things about it are deliberate and were decided by looking at it:
 *
 *  - The band is **two** range areas, not one. Recharts draws `[low, high]`
 *    natively (`Area.tsx`: an array `dataKey` sets `isRange`), but one area
 *    would need one colour, and this band changes sign inside a window — a
 *    portfolio under water for six months and up for six. Clamping each area to
 *    one side of the contribution line makes the losing stretch red and the
 *    winning stretch green, and the degenerate side collapses to zero height on
 *    its own. The sign is the information; a neutral band withholds it.
 *  - `connectNulls` is **true** here, which is the opposite of the shares page.
 *    Trap 5 records that the two baseline dashboards disagree about this on
 *    purpose, and Recharts puts the choice on the series where it belongs. A
 *    hole in a price series is a market that did not trade and must show; a hole
 *    in a valuation is an accounting day the recompute skipped, and breaking the
 *    line there would suggest the portfolio ceased to exist.
 */

type Preset = '1M' | '3M' | '1A' | 'MAX'

/**
 * The presets, and note what is **not** here: 1J and 1S.
 *
 * #660's trap, and it is a property of the data rather than a UX preference.
 * `portfolio_totals` is written one point per calendar day at midnight, so a
 * one-day window holds exactly one point and a one-week window holds seven —
 * a chart with nothing to draw. The shares page's 120-second cadence makes the
 * same presets natural there, which is precisely why they cannot be copied.
 */
const PRESETS: Record<Preset, number> = { '1M': 30, '3M': 91, '1A': 365, MAX: 1826 }

const ORDER: Preset[] = ['1M', '3M', '1A', 'MAX']

const DAY_MS = 86_400_000

interface Point {
  t: number
  value: number | null
  /** Net contributed in `accounts` mode, invested in `titres` mode. */
  base: number | null
}

interface Props {
  currency: string | null
}

export function PortfolioChart({ currency }: Props) {
  const [preset, setPreset] = useState<Preset>('1A')

  const { from, to } = useMemo(() => {
    const stop = new Date()
    return { from: new Date(stop.getTime() - PRESETS[preset] * DAY_MS), to: stop }
  }, [preset])

  const history = useQuery({
    queryKey: ['portfolio-history', preset],
    queryFn: () => api.portfolioHistory(from, to),
    refetchInterval: 120_000,
  })

  const points = useMemo(() => toPoints(history.data), [history.data])
  const yDomain = useMemo(() => computeDomain(points), [points])
  const labels = legendFor(history.data?.mode)

  if (history.isLoading) return <Skeleton className="h-[320px] w-full" />

  if (history.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Historique indisponible</AlertTitle>
        <AlertDescription>{(history.error as Error).message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {ORDER.map((key) => (
            <Button
              key={key}
              size="sm"
              variant={preset === key ? 'secondary' : 'ghost'}
              onClick={() => setPreset(key)}
            >
              {key}
            </Button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">un point par jour</span>
      </div>

      {points.length === 0 ? (
        <div className="flex h-[320px] items-center justify-center rounded-md border border-dashed px-6 text-center text-sm text-muted-foreground">
          {history.data?.mode === 'multi_currency'
            ? "Portefeuille multidevise : aucune série consolidée n'est calculée."
            : 'Aucun historique sur cette période.'}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={points} margin={{ top: 12, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            {/* Numeric/temporal, never categorical — the same rule the price
                chart carries, and here it also lets the domain follow the data
                instead of the requested window, so a young portfolio does not
                get five years of empty plot. */}
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(value: number) => formatDate(value)}
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
            />
            <YAxis
              domain={yDomain}
              tickFormatter={(value: number) => formatCurrency(value, currency, 0)}
              tick={{ fontSize: 11 }}
              width={80}
              className="fill-muted-foreground"
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const point = payload[0].payload as Point
                if (point.value === null && point.base === null) return null
                const gap =
                  point.value !== null && point.base !== null
                    ? point.value - point.base
                    : null
                return (
                  <div className="space-y-1 rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
                    <div className="text-muted-foreground">{formatDate(point.t)}</div>
                    <div className="tabular font-medium">
                      {labels.value} {formatCurrency(point.value, currency)}
                    </div>
                    <div className="tabular text-muted-foreground">
                      {labels.base} {formatCurrency(point.base, currency)}
                    </div>
                    <div
                      className={
                        gap === null || gap === 0
                          ? 'tabular text-muted-foreground'
                          : gap > 0
                            ? 'tabular text-[var(--gain)]'
                            : 'tabular text-[var(--loss)]'
                      }
                    >
                      {labels.gap} {formatCurrency(gap, currency)}
                    </div>
                  </div>
                )
              }}
            />

            {/* The band, clamped to one side each. `[low, high]` is a Recharts
                primitive, so the winning stretch and the losing stretch are two
                declarations rather than a clipping exercise. */}
            <Area
              dataKey={gainBand}
              stroke="none"
              fill="var(--color-gain)"
              fillOpacity={0.16}
              connectNulls
              isAnimationActive={false}
              activeDot={false}
            />
            <Area
              dataKey={lossBand}
              stroke="none"
              fill="var(--color-loss)"
              fillOpacity={0.16}
              connectNulls
              isAnimationActive={false}
              activeDot={false}
            />

            <Line
              type="linear"
              dataKey="base"
              dot={false}
              connectNulls
              strokeWidth={1.5}
              strokeDasharray="4 4"
              stroke="var(--color-muted-foreground)"
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="value"
              dot={false}
              connectNulls
              strokeWidth={2}
              stroke="var(--color-price)"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4" style={{ background: 'var(--price)' }} />
          {labels.value}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-4"
            style={{
              backgroundImage:
                'repeating-linear-gradient(to right, var(--muted-foreground) 0 4px, transparent 4px 8px)',
            }}
          />
          {labels.base}
        </span>
        <span className="italic">l'aire entre les deux courbes est {labels.area}</span>
      </div>
    </div>
  )
}

/**
 * The wording follows the mode, because the two charts mean different things.
 *
 * In `accounts` mode the lower curve is money the investor put in, so the area
 * is the **Gain**. In the degraded mode it is what the positions cost, so the
 * area is the **plus-value latente**. #652 déc. 6 keeps those two terms apart
 * everywhere else; a chart legend that called both "gain" would undo it in the
 * one place the reader is actually looking.
 */
function legendFor(mode: PortfolioHistory['mode'] | undefined) {
  if (mode === 'accounts') {
    return {
      value: 'Valeur totale',
      base: 'Montant investi net',
      gap: 'Gain',
      area: 'le gain',
    }
  }
  return {
    value: 'Valorisation',
    base: "Prix de revient",
    gap: 'Plus-value latente',
    area: 'la plus-value latente',
  }
}

export function toPoints(history: PortfolioHistory | undefined): Point[] {
  if (!history) return []
  return history.points
    .map((point) => ({
      t: point.t === null ? NaN : new Date(point.t).getTime(),
      value: point.value,
      base: 'contributed' in point ? point.contributed : point.invested,
    }))
    .filter((point) => Number.isFinite(point.t))
}

/**
 * The upper half of the band: from the contribution line up to the value, and
 * nowhere when the value is below it.
 *
 * `Math.max` is what makes the degenerate side collapse instead of drawing a
 * mirrored band — on a losing day the range is `[base, base]`, zero height.
 * Returning `null` when either term is missing is what lets `connectNulls`
 * bridge the hole rather than the band spilling to the axis.
 */
export function gainBand(point: Point): [number, number] | null {
  if (point.value === null || point.base === null) return null
  return [point.base, Math.max(point.value, point.base)]
}

export function lossBand(point: Point): [number, number] | null {
  if (point.value === null || point.base === null) return null
  return [Math.min(point.value, point.base), point.base]
}

/**
 * Fit the axis to the two curves instead of anchoring it at zero — found by
 * looking at the page, and it was undoing the chart's whole reason to exist.
 *
 * Recharts anchors a positive series at `0`. On a real portfolio (15 000 €
 * contributed, 19 330 € today) that put the contribution line three quarters of
 * the way up and left the band — the thing déc. 7 says **is** the Gain — as a
 * strip along the top, above an empty white expanse that carried no
 * information. And it degrades as the portfolio grows: a 2 % gain on a mature
 * portfolio would have been invisible.
 *
 * A zero baseline is the honest default when the *height of a bar* is the
 * quantity. Here the quantity is the **gap between two lines**, and zero is not
 * one of them. Both curves keep their absolute values on the axis labels and in
 * the tooltip, so nothing is hidden — and this is already what the shares
 * page's price chart does, which settles it: two charts in one app disagreeing
 * about their axis policy is worse than either policy.
 */
export function computeDomain(points: Point[]): [number, number] | undefined {
  const values = points
    .flatMap((point) => [point.value, point.base])
    .filter((value): value is number => value !== null)
  if (values.length === 0) return undefined

  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = (max - min || Math.abs(max) * 0.1 || 1) * 0.08

  // Round outward to a round number, which is the second half of dropping the
  // zero baseline: a data-derived domain makes Recharts put the series' own
  // extreme on the axis, and a top gradation reading "19 733 €" looks like a
  // defect rather than a scale. Costs a little tightness, buys an axis a reader
  // can use to estimate a value instead of only compare two curves. Shared with
  // the accounts page's index chart — see `lib/chart`.
  return roundOutward(min - pad, max + pad)
}
