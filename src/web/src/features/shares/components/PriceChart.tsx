/**
 * One symbol's price, over one of four ranges (#684 D10) — **and the days its
 * ledger names, under it** (#720).
 *
 * **The presets are the rungs of the retention ladder** — `1M / 1A / 2A / MAX`
 * — and not four round numbers. A stored point's resolution is a function of
 * its age: as written under a year, hourly from one to two, daily beyond. `3M`
 * left because it changes nothing visible; these four make the archive's shape
 * legible by moving between its rungs.
 *
 * The event overlay is **a band under the plot rather than dots inside it**:
 *
 *  - **it is laid out in the chart's own width, on the chart's own abscissa.**
 *    The `XAxis` below is a **category** axis — Recharts' default, one step per
 *    point whatever the interval before it — so `features/shares/lib/shares.ts` gives each day
 *    the *rank* of the point it names and the band spans the plot area: there
 *    is one statement of the x-axis rather than two. A fraction of the elapsed time
 *    was the second statement, and the two part company worst on `1M`, where
 *    the raw series mixes a point every 120 s in session with one per hour or
 *    per day out of it. The inset below mirrors the `YAxis` width and the
 *    `LineChart` margin, which are the only two numbers that place the plot.
 *
 * **One marker per plotted point, announcing its count.** A single symbol of the
 * real portfolio carries `×2`, `×2`, `×3`, `×3` over four days: drawn per event
 * those points overlap, and three purchases read as one with nothing saying so.
 * Days that land on one point, or close enough for their labels to touch, are one
 * marker (#1273): it names its dates.
 */
import { useQuery } from '@tanstack/react-query'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'

import { ChartReading } from '@/components/ChartReading'
import { Unreadable } from '@/components/Unreadable'
import { EmptyState } from '@/components/EmptyState'
import { Segmented } from '@/components/Segmented'
import type { LedgerEvent } from '@/features/data/lib/api'
import { CHART_WINDOWS, type ChartWindow, sharesApi } from '@/features/shares/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { averageCostSeries, eventMarkers } from '@/features/shares/lib/shares'

/** The `YAxis` width plus the `LineChart` left margin: where the plot starts. */
const PLOT_INSET_LEFT = 77
/** The `LineChart` right margin. */
const PLOT_INSET_RIGHT = 5

interface PriceChartProps {
  symbol: string
  window: ChartWindow
  onWindowChange: (window: ChartWindow) => void
  /**
   * The ledger, whole — the markers are the days of **this** symbol and the
   * filtering is `features/shares/lib/shares.ts`'s, so the sheet and the chart cannot disagree
   * about which day carries what.
   */
  events?: readonly LedgerEvent[]
  /** The average purchase price, drawn as a dashed line and named in the legend. */
  averageCost?: number | null
}

export function PriceChart({
  symbol,
  window,
  onWindowChange,
  events = [],
  averageCost = null,
}: PriceChartProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const series = useQuery({
    queryKey: ['prices', symbol, window],
    queryFn: () => sharesApi.prices(symbol, window),
  })
  // The axis is money, so it says so — the payload names the reporting currency
  // and a bare ladder of numbers leaves the reader to supply the
  // unit. `null` while the dial is unanswered, which `formatCurrency` renders as
  // the plain number rather than guessing.
  const currency = series.data?.base_currency ?? null
  const points = series.data?.points ?? []
  const markers = eventMarkers(events, symbol, points)
  const steps = averageCost === null ? null : averageCostSeries(events, symbol, points, averageCost)
  const plotted = points.map((point, index) => ({ ...point, average: steps?.[index] ?? null }))

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b">
        <h3 className="pb-2.5 text-prose font-medium">{t('shares.chart.title')}</h3>
        <div className="pb-2">
          <Segmented
            label={t('shares.chart.range')}
            mode="radio"
            size="compact"
            bordered
            options={CHART_WINDOWS.map((candidate) => ({
              value: candidate,
              label: t('shares.chart.window', { window: candidate }),
            }))}
            value={window}
            onChange={onWindowChange}
          />
        </div>
      </div>

      {/* **A read that did not answer, said where the plot would have been**
          (#829): an empty state and never an alert, so that *there is
          nothing to draw* and *this could not be read* are told apart by the
          sentence and not by a colour. */}
      {series.error ? (
        <Unreadable failure={{ message: problemMessageKey(series.error) }} />
      ) : !series.data ? null : series.data.points.length === 0 ? (
        <EmptyState title={t('shares.chart.empty')} />
      ) : (
        <>
          {/* **No live region on this surface, and the reason is the cache key**
              (#1003). `['prices', symbol, window]` carries the window, so
              pressing *1A* refetches and this block renders `null` while the
              read is in flight: a live region only announces reliably when its
              node existed before the change, and here it is unmounted at the
              moment the change happens. The gesture is not unanswered — the
              range control is a `radiogroup` and announces the window it just
              selected — what is lost is hearing the new shape without coming
              back to the figure. The day that key drops the window, this gains
              one attribute. */}
          <figure>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                {/* **Named, and not hidden** (#1003): the `<svg>` Recharts
                    renders is focusable and its arrows walk the series, so the
                    name is what tells a reader where they have landed. */}
                <LineChart data={plotted} aria-label={t('shares.chart.plot')}>
                  {/* **The chrome comes from the tokens** (#841).
                      Left to itself Recharts paints a `#ccc` grid and `#666`
                      gradations, and it paints the *same two greys on both
                      grounds* — which is not a light-ground defect but a chart
                      with no theme at all, and it is why the audit that closed
                      #837 route by route walked past it: the sheet only exists
                      once something is clicked. Measured on midnight the grid
                      stood at 11,6:1 against its ground where the dashboard's is
                      at 1,2:1 — ten times too loud, so the scale read as data
                      over the one curve it serves — and the gradations at 3,24:1,
                      under the 4,5:1 floor that being **text** imposes on them.

                      The two are therefore coloured **apart**, and that is the
                      one place the substitution is not mechanical: Recharts fills
                      a tick label with the axis' own `stroke`, so a single token
                      would either shout the grid or hide the figures.

                       - the grid and the axis lines are **chrome**, so they carry
                         `--border` — the dashboard's grid entire, its `2 4` hair
                         included, a grid being no more legible for hanging in a
                         sheet than on a card;
                       - the gradations are **text**, so they carry
                         `--muted-foreground`, which clears the floor on both
                         grounds rather than being assumed to.

                      `chartChrome.test.ts` measures both, and refuses any chart
                      that goes back to mounting a grid or an axis with no colour
                      of its own. */}
                  <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tickFormatter={(value: string) => f.date(value)}
                    minTickGap={32}
                    stroke="var(--border)"
                    tick={{ fill: 'var(--muted-foreground)' }}
                  />
                  <YAxis
                    // On the data, never on the window asked for — fixing the
                    // domain to the request repeats on one axis the mistake the
                    // dashboard corrected on the other.
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(value: number) => f.currency(value, currency, 0)}
                    width={72}
                    stroke="var(--border)"
                    tick={{ fill: 'var(--muted-foreground)' }}
                  />
                  {averageCost === null ? null : (
                    // A series of its own rather than a reference line: the axis
                    // domain then spans it, so it is drawn on any window.
                    <Line
                      type="stepAfter"
                      dataKey="average"
                      stroke="var(--muted-foreground)"
                      strokeDasharray="5 4"
                      dot={false}
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                  )}
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
            {/* The shape, and **neither the resolution nor the events**: the
                *aggregated by X* caption above is already readable text and the
                markers already carry their own labels, so repeating either here
                would put two announcers on one fact. */}
            <ChartReading
              rows={series.data.points}
              curves={[{ name: t('shares.chart.title'), key: 'price' }]}
              format={currency === null ? null : (value) => f.currency(value, currency)}
            />
          </figure>

          {/* The days the ledger bought on: one dot per plotted point, announcing
              its count. Not a control — the events are listed under the chart. A
              band with nothing in it does not exist. */}
          {markers.length === 0 ? null : (
            <div
              role="group"
              aria-label={t('shares.events.markers')}
              className="relative h-6"
              style={{ marginLeft: PLOT_INSET_LEFT, marginRight: PLOT_INSET_RIGHT }}
            >
              {markers.map((marker) => {
                const from = marker.days[0]
                const to = marker.days[marker.days.length - 1]
                return (
                  <span
                    key={from}
                    role="img"
                    aria-label={
                      from === to
                        ? t('shares.events.marker', { count: marker.count, date: f.date(from) })
                        : t('shares.events.markerRange', {
                            count: marker.count,
                            from: f.date(from),
                            to: f.date(to),
                          })
                    }
                    className="absolute top-0 flex h-6 min-w-6 -translate-x-1/2 flex-col items-center"
                    style={{ left: `${marker.offset * 100}%` }}
                  >
                    <span aria-hidden className="block size-2 rounded-full bg-foreground" />
                    {marker.count > 1 ? (
                      <span aria-hidden className="block text-xs text-muted-foreground">
                        {t('shares.events.count', { count: marker.count })}
                      </span>
                    ) : null}
                  </span>
                )
              })}
            </div>
          )}

          <p
            className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground"
            style={{ paddingLeft: PLOT_INSET_LEFT }}
          >
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="block h-0.5 w-3.5 bg-price" />
              {t('shares.chart.legend.price')}
            </span>
            {markers.length === 0 ? null : (
              <span className="inline-flex items-center gap-2">
                <span aria-hidden className="block size-2 rounded-full bg-foreground" />
                {t('shares.chart.legend.buys')}
              </span>
            )}
            {averageCost === null ? null : (
              <span className="inline-flex items-center gap-2">
                <svg aria-hidden width="14" height="2" className="shrink-0">
                  <line
                    x1="0"
                    x2="14"
                    y1="1"
                    y2="1"
                    stroke="var(--muted-foreground)"
                    strokeWidth="2"
                    strokeDasharray="5 4"
                  />
                </svg>
                {t('shares.chart.legend.avgCost')}{' '}
                <span className="fig text-foreground">{f.currency(averageCost, currency)}</span>
              </span>
            )}
          </p>
        </>
      )}
    </section>
  )
}
