import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CartesianGrid,
  Label,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { api, type LedgerEvent, type EventType } from '@/lib/api'
import { formatCurrency, formatDate, formatDateTime, formatQuantity } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/**
 * The chart of #652 déc. 11 — three layers no generic dashboard can compose:
 * the price, the cost-price line (above it means you are up, read at a glance),
 * and the portfolio events at their true dates. Grafana reads one datasource;
 * the events live in CSV/XLSX, so it can never know a point is a purchase.
 *
 * The candlestick the baseline used is *deleted*, not ported: `write_metrics`
 * sets `price_open = price_high = price_low = share_price`
 * (`influxdb_writer.py:160-165`), so live OHLC is a column of dojis and only
 * backfilled history has real bodies (trap 10). A line is the honest default.
 */

type Preset = '1M' | '3M' | '1A' | 'MAX'

/** Span in days for the named presets. `MAX` has none — see `resolveWindow`. */
const PRESETS: Record<Exclude<Preset, 'MAX'>, number> = { '1M': 30, '3M': 91, '1A': 365 }

const NAMED: Exclude<Preset, 'MAX'>[] = ['1M', '3M', '1A']

const DAY_MS = 86_400_000

/** How far back `MAX` reaches when there is nothing to anchor it to. */
const MAX_FALLBACK_DAYS = 1826

/** A marker's vertical anchor, which is the ticket's first open design point. */
type Anchor = 'price' | 'floor'

interface Marker {
  t: number
  y: number
  kind: EventType
  anchor: Anchor
  event: LedgerEvent
}

const MARKER_STYLE: Record<string, { fill: string; label: string }> = {
  BUY: { fill: 'var(--color-gain)', label: 'Achat' },
  SELL: { fill: 'var(--color-loss)', label: 'Vente' },
  GRANT: { fill: 'var(--color-grant)', label: 'Attribution' },
  DIVIDEND: { fill: 'var(--color-dividend)', label: 'Dividende' },
}

interface Props {
  symbol: string
  currency: string | null
  costPrice: number | null
}

export function PriceChart({ symbol, currency, costPrice }: Props) {
  // `null` means "not chosen yet", so the default can follow the data instead of
  // being frozen at mount — see `preset` below.
  const [chosen, setChosen] = useState<Preset | null>(null)

  // Fetched first, because the window now depends on it: the events are what
  // tell us how long this position has existed.
  const events = useQuery({
    queryKey: ['events', symbol],
    queryFn: () => api.events(symbol),
  })

  /**
   * The oldest event for this symbol — the point before which there is nothing
   * to show, since the backward backfill targets the first BUY and stops there.
   * `null` in manual mode, which has no events at all.
   */
  const firstEventTime = useMemo(() => {
    const times = (events.data ?? [])
      .filter((event) => event.date)
      .map((event) => new Date(`${event.date}T00:00:00Z`).getTime())
      .filter((t) => Number.isFinite(t))
    return times.length ? Math.min(...times) : null
  }, [events.data])

  const historyDays = useMemo(
    () => (firstEventTime === null ? null : (Date.now() - firstEventTime) / DAY_MS),
    [firstEventTime],
  )

  /**
   * A named preset is offered only when it actually *zooms in* — i.e. when it is
   * strictly narrower than the position's whole history. Buying a share three
   * months ago and being offered "1A" produces a plot that is 77 % empty, and
   * "MAX" at its old hardcoded five years produced one that was 95 % empty with
   * the data crammed against the right edge. Both were the same defect: a window
   * fixed in advance, blind to how long the position has existed.
   */
  const isEnabled = (key: Preset) =>
    key === 'MAX' || historyDays === null || PRESETS[key] < historyDays

  // Default to 3M while it still zooms in, otherwise show the whole history.
  // Derived rather than stored, so it settles by itself when the events land —
  // and a preset the user picked is dropped if it stops being offered (the sheet
  // can be handed a different symbol without remounting).
  const fallback: Preset = isEnabled('3M') ? '3M' : 'MAX'
  const preset: Preset = chosen && isEnabled(chosen) ? chosen : fallback

  const { from, to } = useMemo(
    () => resolveWindow(preset, firstEventTime),
    [preset, firstEventTime],
  )

  const prices = useQuery({
    queryKey: ['prices', symbol, from.getTime(), to.getTime()],
    queryFn: () => api.prices(symbol, from, to),
  })

  const series = useMemo(
    () => withGaps(prices.data?.points ?? []),
    [prices.data],
  )

  // Three steps, and the order is the point. A DIVIDEND marker has to sit on
  // the axis itself, so its `y` *is* the domain minimum — but the domain is
  // computed from the priced markers, so it cannot be known while they are
  // being built. Place the priced ones, derive the domain from those, then drop
  // the dividends onto its floor.
  const placed = useMemo(
    () => buildMarkers(events.data ?? [], series, from.getTime(), to.getTime()),
    [events.data, series, from, to],
  )

  const yDomain = useMemo(
    () => computeDomain(series, placed.filter((m) => m.anchor === 'price'), costPrice),
    [series, placed, costPrice],
  )

  const markers = useMemo(
    () =>
      placed.map((marker) =>
        marker.anchor === 'floor' && yDomain ? { ...marker, y: yDomain[0] } : marker,
      ),
    [placed, yDomain],
  )

  if (prices.isLoading) return <Skeleton className="h-[320px] w-full" />

  if (prices.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Cours indisponible</AlertTitle>
        <AlertDescription>{(prices.error as Error).message}</AlertDescription>
      </Alert>
    )
  }

  const hasPoints = series.some((point) => point.price !== null)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {[...NAMED, 'MAX' as const].map((key) => {
            const enabled = isEnabled(key)
            return (
              <Button
                key={key}
                size="sm"
                variant={preset === key ? 'secondary' : 'ghost'}
                disabled={!enabled}
                title={
                  enabled
                    ? undefined
                    : "Cette position n'est pas assez ancienne pour cette période."
                }
                onClick={() => setChosen(key)}
              >
                {key}
              </Button>
            )
          })}
        </div>
        {/* The server says which bucket it used, and we show it. A chart that
            silently downsamples is a chart that lies about its resolution. */}
        {prices.data?.bucket && (
          <span className="text-xs text-muted-foreground">
            agrégé par {prices.data.bucket}
          </span>
        )}
      </div>

      {!hasPoints ? (
        <div className="flex h-[320px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          Aucun cours enregistré sur cette période.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={series} margin={{ top: 12, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            {/*
              Open design point 2, settled: the axis is **numeric/temporal**,
              never categorical. `ReferenceDot` maps `x` through the axis scale,
              so on a categorical axis a marker whose date matches no existing
              point vanishes silently — and that is the *nominal* case, since a
              BUY can land on a day the market never traded (#606).
            */}
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[from.getTime(), to.getTime()]}
              tickFormatter={(value: number) => formatDate(value)}
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
            />
            <YAxis
              domain={yDomain}
              tickFormatter={(value: number) => formatCurrency(value, currency, 0)}
              tick={{ fontSize: 11 }}
              width={72}
              className="fill-muted-foreground"
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const point = payload[0].payload as SeriesPoint
                if (point.price === null) return null
                return (
                  <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
                    <div className="text-muted-foreground">
                      {formatDateTime(new Date(point.t).toISOString())}
                    </div>
                    <div className="tabular font-medium">
                      {formatCurrency(point.price, currency)}
                    </div>
                  </div>
                )
              }}
            />

            {/*
              Gaps stay visible on this page. `connectNulls` is a *per-series*
              prop, which is exactly where trap 5's disagreement belongs: the
              baseline's share panels leave holes open and its account panels
              bridge them, on purpose. A weekend is not missing data (#606).
            */}
            <Line
              type="linear"
              dataKey="price"
              dot={false}
              connectNulls={false}
              strokeWidth={1.75}
              stroke="var(--color-price)"
              isAnimationActive={false}
            />

            {costPrice !== null && (
              <ReferenceLine
                y={costPrice}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="4 4"
              >
                <Label
                  value={`PRU ${formatCurrency(costPrice, currency)}`}
                  position="insideTopLeft"
                  fontSize={11}
                  className="fill-muted-foreground"
                />
              </ReferenceLine>
            )}

            {markers.map((marker, index) => (
              <ReferenceDot
                key={`${marker.event.id}-${index}`}
                x={marker.t}
                y={marker.y}
                r={marker.anchor === 'floor' ? 3.5 : 5}
                fill={MARKER_STYLE[marker.kind]?.fill ?? 'var(--color-price)'}
                stroke="var(--color-background)"
                strokeWidth={1.5}
                ifOverflow="extendDomain"
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}

      <MarkerLegend markers={markers} currency={currency} />
    </div>
  )
}

function MarkerLegend({ markers, currency }: { markers: Marker[]; currency: string | null }) {
  if (!markers.length) return null
  const kinds = Array.from(new Set(markers.map((m) => m.kind)))
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {kinds.map((kind) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ background: MARKER_STYLE[kind]?.fill }}
            />
            {MARKER_STYLE[kind]?.label ?? kind}
          </span>
        ))}
        <span className="italic">
          les dividendes sont posés sur l'axe : ils n'ont pas de cours
        </span>
      </div>
      <ul className="max-h-28 space-y-1 overflow-y-auto text-xs">
        {markers.map((marker, index) => (
          <li key={`${marker.event.id}-legend-${index}`} className="flex gap-2 tabular">
            <span className="text-muted-foreground">{formatDate(marker.t)}</span>
            <span>{MARKER_STYLE[marker.kind]?.label ?? marker.kind}</span>
            <span className="text-muted-foreground">
              {marker.event.quantity !== null && marker.event.quantity !== undefined
                ? `${formatQuantity(marker.event.quantity)} × ${formatCurrency(marker.event.unit_price ?? null, currency)}`
                : formatCurrency(marker.event.amount ?? null, currency)}
            </span>
            {marker.event.account && (
              <span className="text-muted-foreground">· {marker.event.account}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// --------------------------------------------------------------------- //
// Series shaping
// --------------------------------------------------------------------- //

interface SeriesPoint {
  t: number
  price: number | null
}

/**
 * Turn the API's *missing rows* into explicit `null` points, so the line
 * actually breaks.
 *
 * The API returns gaps as gaps (#606) — a non-trading stretch is simply absent
 * rows. But a numeric time axis happily draws one long straight segment across
 * an absence, which is the same lie `connectNulls` would tell. Recharts only
 * breaks a line on a `null` *value*, so the gap has to be materialised.
 *
 * The threshold has two terms, and the second was found by looking at the
 * chart. `3 × median spacing` alone is right in principle and shreds the line
 * in practice: at the hourly resolution a 3-month window gets, *every overnight
 * close* is 17 hours against a 1-hour median, so the curve came back as a row
 * of daily slivers — technically honest, unreadable, and not what #606 is
 * about. An overnight close is not a gap in the data; a day the market never
 * traded is.
 *
 * So the gap must also exceed **36 hours**: longer than any overnight, shorter
 * than a weekend. Weekends and holidays break, sessions join up. On a
 * daily-bucketed series the median term takes over (3 days), which leaves an
 * ordinary weekend joined and breaks a genuine suspension.
 */
const MIN_GAP_MS = 36 * 60 * 60 * 1000
/**
 * The window a preset asks for.
 *
 * `MAX` means *the whole history* — the first event minus a small margin — and
 * not a fixed five years. The margin keeps the opening purchase marker off the
 * very edge of the plot, where it would be half-clipped.
 *
 * Anchoring on the first event rather than on the oldest stored price is
 * deliberate: it is the only one of the two known *before* fetching, and the
 * two agree by construction anyway, since the backward backfill targets the
 * first BUY and stops there.
 */
export function resolveWindow(
  preset: Preset,
  firstEventTime: number | null,
): { from: Date; to: Date } {
  const to = new Date()

  if (preset !== 'MAX') {
    return { from: new Date(to.getTime() - PRESETS[preset] * DAY_MS), to }
  }
  if (firstEventTime === null) {
    return { from: new Date(to.getTime() - MAX_FALLBACK_DAYS * DAY_MS), to }
  }

  const margin = Math.max((to.getTime() - firstEventTime) * 0.02, 2 * DAY_MS)
  return { from: new Date(firstEventTime - margin), to }
}

export function withGaps(points: { t: string | null; price: number | null }[]): SeriesPoint[] {
  const parsed: SeriesPoint[] = points
    .filter((point) => point.t !== null)
    .map((point) => ({ t: new Date(point.t as string).getTime(), price: point.price }))
    .filter((point) => Number.isFinite(point.t))

  if (parsed.length < 3) return parsed

  const deltas = parsed.slice(1).map((point, index) => point.t - parsed[index].t)
  const sorted = [...deltas].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 0
  if (median <= 0) return parsed

  const threshold = Math.max(median * 3, MIN_GAP_MS)
  const withHoles: SeriesPoint[] = [parsed[0]]
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index].t - parsed[index - 1].t > threshold) {
      withHoles.push({ t: parsed[index - 1].t + median, price: null })
    }
    withHoles.push(parsed[index])
  }
  return withHoles
}

/**
 * Place the event markers — the ticket's **first open design point**, settled
 * here.
 *
 * The schema hands out `unit_price` for BUY/SELL and `amount` for DIVIDEND
 * (`events/loader.py`), so only half the event types have a natural `y`. The
 * split is not two-and-two, though, and that is what decided it:
 *
 *  - **BUY / SELL** sit at their `unit_price`. That is the whole point of the
 *    layer: the dot against the curve shows whether you executed above or below
 *    the market.
 *  - **GRANT** has a quantity but no price, and yet it *is* a share event worth
 *    the market price of its day — so it is pinned on the curve, at the last
 *    price at or before that date. (Not the price *on* that date: a grant can
 *    land on a non-trading day, which is #606 again.)
 *  - **DIVIDEND** is genuinely dimensionless against a price axis. Its `amount`
 *    is cash, not a per-share price, so pinning it on the curve would state a
 *    price that was never paid. It goes **on the axis** — the caller replaces
 *    the placeholder `y` below with the domain minimum — which is a date marker
 *    that claims nothing about `y`, and which keeps a five-year chart from
 *    growing a forest of vertical lines.
 *
 *    Looking at it settled the last detail: parking dividends merely *near* the
 *    bottom leaves a lone dot floating in the plot area, and in a price chart a
 *    floating dot reads as a price. Sitting on the axis line, it reads as a
 *    date. Same information, opposite first impression.
 */
export function buildMarkers(
  events: LedgerEvent[],
  series: SeriesPoint[],
  from: number,
  to: number,
): Marker[] {
  const priced = series.filter((point) => point.price !== null)

  const priceAt = (t: number): number | null => {
    let found: number | null = null
    for (const point of priced) {
      if (point.t > t) break
      found = point.price
    }
    // Before the first stored point there is nothing to pin to; fall back to
    // the earliest known price rather than dropping the marker.
    return found ?? (priced.length ? priced[0].price : null)
  }

  return events
    .filter((event) => event.date && event.event_type)
    .map((event) => {
      const t = new Date(`${event.date}T00:00:00Z`).getTime()
      return { event, t }
    })
    // Markers outside the visible window are dropped, not clamped. A clamped
    // marker sits at the edge of the plot and reads as an event that happened
    // then — which it did not.
    .filter(({ t }) => Number.isFinite(t) && t >= from && t <= to)
    .flatMap(({ event, t }): Marker[] => {
      const kind = event.event_type as EventType
      if (kind === 'DEPOSIT' || kind === 'WITHDRAWAL') return []

      if (kind === 'DIVIDEND') {
        // Placeholder y: the caller replaces it with the axis minimum once the
        // domain is known. It must not take part in computing that domain.
        return [{ t, y: 0, kind, anchor: 'floor', event }]
      }

      const y =
        kind === 'GRANT'
          ? priceAt(t)
          : (event.unit_price ?? priceAt(t))
      if (y === null) return []
      return [{ t, y, kind, anchor: 'price', event }]
    })
}

function computeDomain(
  series: SeriesPoint[],
  markers: Marker[],
  costPrice: number | null,
): [number, number] | undefined {
  const values = series
    .filter((point) => point.price !== null)
    .map((point) => point.price as number)
  if (!values.length) return undefined

  // Marker anchors join the domain on purpose. A purchase far below today's
  // price would otherwise be clipped out of the plot — and a marker you cannot
  // see is worse than a slightly stretched axis, since the stretch is itself
  // the information ("you bought there, it is here now").
  const all = [...values, ...markers.map((marker) => marker.y)]
  if (costPrice !== null) all.push(costPrice)

  const min = Math.min(...all)
  const max = Math.max(...all)
  const pad = (max - min || Math.abs(max) * 0.1 || 1) * 0.06
  return [min - pad, max + pad]
}
