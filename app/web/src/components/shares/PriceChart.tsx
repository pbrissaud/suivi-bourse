/**
 * One symbol's price, over one of four ranges (#684 D10, ADR-0010) — **and the
 * days its ledger names, under it** (#720).
 *
 * **The presets are the rungs of the retention ladder** — `1M / 1A / 2A / MAX`
 * — and not four round numbers. A stored point's resolution is a function of its
 * age: as written under a year, hourly from one to two, daily beyond. `3M` left
 * because it changes nothing visible; these four make the archive's shape
 * legible by moving between its rungs.
 *
 * **The resolution has one announcer.** The *aggregated by X* caption reads the
 * `resolution` the API states rather than naming a bucketing of its own — the
 * server's bucket and the storage ladder are two facts about one graph, and
 * *two announcers for one fact* is the defect the map found independently on
 * four pages. It also stops a sparse far end reading as an outage.
 *
 * The event overlay is **a band under the plot rather than dots inside it**, and
 * that is a decision with two halves:
 *
 *  - **a marker has to be a control.** The link to the list is a *selection*
 *    (#675/D2 as amended by ADR-0016), so it is clicked and it is reached by
 *    keyboard — hover does not exist on a finger and says nothing to a keyboard.
 *    A `<button>` is what carries both; a Recharts dot is a shape.
 *  - **it is laid out in the chart's own width, on the chart's own abscissa.**
 *    The `XAxis` below is a **category** axis — Recharts' default, one step per
 *    point whatever the interval before it — so `lib/shares.ts` gives each day
 *    the *rank* of the point it names and the band spans the plot area: there
 *    is one statement of the x-axis rather than two, which is the same rule the
 *    resolution caption follows one line above. A fraction of the elapsed time
 *    was the second statement, and the two part company worst on `1M`, where
 *    the raw series mixes a point every 120 s in session with one per hour or
 *    per day out of it. The inset below mirrors the `YAxis` width and the
 *    `LineChart` margin, which are the only two numbers that place the plot.
 *
 * **One marker per day, announcing its count.** A single symbol of the real
 * portfolio carries `×2`, `×2`, `×3`, `×3` over four days: drawn per event those
 * points overlap, and three purchases read as one with nothing saying so.
 */
import { useQuery } from '@tanstack/react-query'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'

import { Refusal } from '@/components/Refusal'
import { EmptyState } from '@/components/EmptyState'
import { api, CHART_WINDOWS, type ChartWindow, type LedgerEvent } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { eventMarkers } from '@/lib/shares'
import { cn } from '@/lib/utils'

/** The `YAxis` width plus the `LineChart` left margin: where the plot starts. */
const PLOT_INSET_LEFT = 77
/** The `LineChart` right margin. */
const PLOT_INSET_RIGHT = 5

export interface PriceChartProps {
  symbol: string
  window: ChartWindow
  onWindowChange: (window: ChartWindow) => void
  /**
   * The ledger, whole — the markers are the days of **this** symbol and the
   * filtering is `lib/shares.ts`'s, so the sheet and the chart cannot disagree
   * about which day carries what.
   */
  events?: readonly LedgerEvent[]
  /** The selected day, or `null`. The selection is a **day**, never an event. */
  selectedDay?: string | null
  /** Clicking a marker: select that day, and take the list to it. */
  onSelectDay?: (day: string) => void
}

export function PriceChart({
  symbol,
  window,
  onWindowChange,
  events = [],
  selectedDay = null,
  onSelectDay,
}: PriceChartProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const series = useQuery({
    queryKey: ['prices', symbol, window],
    queryFn: () => api.prices(symbol, window),
  })
  // The axis is money, so it says so — the payload names the reporting currency
  // (ADR-0002) and a bare ladder of numbers leaves the reader to supply the
  // unit. `null` while the dial is unanswered, which `formatCurrency` renders as
  // the plain number rather than guessing.
  const currency = series.data?.base_currency ?? null
  const markers = eventMarkers(events, symbol, series.data?.points ?? [])

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{t('shares.chart.title')}</h3>
        {/* One control, one radio group — the reader sets the range once. */}
        <div role="radiogroup" aria-label={t('shares.chart.range')} className="flex gap-1">
          {CHART_WINDOWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={candidate === window}
              onClick={() => onWindowChange(candidate)}
              className={cn(
                'rounded px-2 py-1 text-xs',
                candidate === window ? 'bg-secondary font-medium' : 'text-muted-foreground',
              )}
            >
              {t('shares.chart.window', { window: candidate })}
            </button>
          ))}
        </div>
      </div>

      {series.error ? (
        <Refusal>{t(problemMessageKey(series.error))}</Refusal>
      ) : !series.data ? null : series.data.points.length === 0 ? (
        <EmptyState title={t('shares.chart.empty')} />
      ) : (
        <>
          {/* The one announcer, and it says what was **served**. */}
          <p className="text-xs text-muted-foreground">
            {t('shares.chart.resolution', { resolution: series.data.resolution })}
          </p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series.data.points}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="t" tickFormatter={(value: string) => f.date(value)} minTickGap={32} />
                <YAxis
                  // On the data, never on the window asked for — fixing the
                  // domain to the request repeats on one axis the mistake the
                  // dashboard corrected on the other.
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(value: number) => f.currency(value, currency, 0)}
                  width={72}
                />
                <Line
                  type="monotone"
                  dataKey="price"
                  stroke="var(--color-price)"
                  dot={false}
                  isAnimationActive={false}
                  // A missing conversion is a hole in the line, never a zero.
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* A band with nothing in it does not exist: a symbol whose events are
              all outside the visible range shows no rail rather than an empty
              one. */}
          {markers.length === 0 ? null : (
            <div
              role="group"
              aria-label={t('shares.events.markers')}
              className="relative h-6"
              style={{ marginLeft: PLOT_INSET_LEFT, marginRight: PLOT_INSET_RIGHT }}
            >
              {markers.map((marker) => {
                const selected = marker.day === selectedDay
                return (
                  <button
                    key={marker.day}
                    type="button"
                    aria-pressed={selected}
                    aria-label={t('shares.events.marker', {
                      count: marker.count,
                      date: f.date(marker.day),
                    })}
                    onClick={() => onSelectDay?.(marker.day)}
                    className="absolute top-0 -translate-x-1/2"
                    style={{ left: `${marker.offset * 100}%` }}
                  >
                    {/* The point **grows** on selection — the one thing the
                        marker owes the reader who clicked a line of the list. */}
                    <span
                      aria-hidden
                      className={cn(
                        'block rounded-full bg-grant',
                        selected ? 'size-3 ring-2 ring-grant/40' : 'size-2',
                      )}
                    />
                    {marker.count > 1 ? (
                      <span aria-hidden className="block text-[0.625rem] text-muted-foreground">
                        {t('shares.events.count', { count: marker.count })}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </section>
  )
}
