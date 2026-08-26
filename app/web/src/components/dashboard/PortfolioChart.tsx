/**
 * One chart slot, **two readings** (#727, ADR-0018).
 *
 * *Amounts* draws the portfolio's value against what was put into it, and the
 * area between the two **is** the gain — the clearest answer the product can
 * give to *did I gain because it went up, or because I put more in*, which a
 * value curve alone cannot. *Performance* draws the time-weighted return, which
 * answers the other question — *did my holdings do well* — and is the one figure
 * a deposit does not move.
 *
 * Four things about it are decisions:
 *
 *  - **The reading selector is a reading selector.** It is drawn as tabs and the
 *    range as radios, deliberately: two sibling radio groups read as two
 *    settings of the same thing, which is the duplication this page has just
 *    closed (the head lost its own presets at #718, and this is the page's one
 *    range control).
 *  - **`3M` is dead** and `1M / YTD / 1Y / MAX` is the whole list: from February
 *    to December `YTD` covers or contains `3M`, and five buttons on one control
 *    is one too many. The series is daily and dense over the calendar and it is
 *    kept **whole** — there is no ladder here, so changing the range changes the
 *    span and never the resolution, and no *aggregated by X* caption is owed.
 *  - **The x domain is the data's**, never the window asked for. Recharts' own
 *    category axis does that by construction and it is the reason nothing sets a
 *    domain here: fixing the axis to the requested window would put ticks on
 *    dates the series says nothing about, which is the mistake corrected on the
 *    value axis one line below.
 *  - **The value axis is floored at zero when nothing drawn is negative.** Left
 *    to itself it fitted the data and graduated `−1 411 €` under a series that
 *    has never been negative.
 *  - **It answers the pointer** (#790), and the answer is the page's own
 *    formatting: one day, and the curves' values on it, in the reader's
 *    language and the reporting currency. The **area is not in it** — its
 *    `dataKey` is a function returning the `[contributed, value]` pair the band
 *    is drawn between, which is a drawing instruction and not a figure anybody
 *    reads. Filtering on *the entry has a string key* is what keeps it out,
 *    rather than a name test that would break the day a curve is renamed.
 *
 *  - **The two series are the page's read, not the block's** (#799), and they
 *    cross as `readonly X[] | null`. `null` is *not answered* — in flight, or
 *    failed — and the block renders **nothing at all, title included**: a frame
 *    with an empty body is a hand-written skeleton (ADR-0026), and a plot drawn
 *    on an empty array reads as *the portfolio is worth nothing*. The two are
 *    told apart by the `failure` prop since #829 (ADR-0037): in flight the slot
 *    is empty and claims nothing, refused it carries the reason. The head is
 *    never emptied either way, which is what this block's `settled` used to cost
 *    by making a failed series and an unanswered one the same silence.
 *
 * Without a cash ledger the perf series does not exist — `total_value`,
 * `net_contributed` and `twr_index` are `NULL` by #708's per-field rule — so
 * *Amounts* falls back to valuation against cost and is **the only reading**:
 * the area is then the *latent* gain, which is a different figure and therefore
 * a different sentence, and *Performance* is not offered rather than offered
 * empty.
 */
import { useState } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'

import { ChartTooltip } from '@/components/ChartTooltip'
import { EmptyState } from '@/components/EmptyState'
import { Unreadable } from '@/components/Unreadable'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { PerfPoint, ValuationPoint } from '@/lib/api'
import {
  amountsFromTotals,
  amountsFromValuation,
  amountsValues,
  DASHBOARD_RANGES,
  DEFAULT_DASHBOARD_RANGE,
  performanceRows,
  windowFloor,
  yFloor,
  type AmountsRow,
  type DashboardRange,
  type PerformanceRow,
  type Reading,
} from '@/lib/dashboard'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'
import { cn } from '@/lib/utils'

export interface PortfolioChartProps {
  /**
   * Whether the install has a cash ledger — which is at once the discriminant
   * of the reading and of the series that is read (`hasCashLedger`).
   */
  ledger: boolean
  currency: string | null
  /**
   * The two series, exactly one of which is read. `null` is *the read has not
   * answered* — in flight, or failed — and never an empty payload, which is a
   * fact about the reader's own history (ADR-0026).
   */
  performance: readonly PerfPoint[] | null
  valuation: readonly ValuationPoint[] | null
  /**
   * The block's own read, refused — `null` when it did answer or is still in
   * flight. **The two are not the same news** and that is why it is a prop: an
   * absent series in flight is nothing to say yet, and one that failed is the
   * chart's whole slot standing empty for a reason the reader is owed (#829,
   * ADR-0037, and #799's repair kept without the band).
   */
  failure?: ReadFailure | null
}

export function PortfolioChart({
  ledger,
  currency,
  performance,
  valuation,
  failure = null,
}: PortfolioChartProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const [chosen, setChosen] = useState<Reading>('amounts')
  const [range, setRange] = useState<DashboardRange>(DEFAULT_DASHBOARD_RANGE)

  // **Nothing at all, title included** (ADR-0026): the block's one series is
  // in flight, and a frame carrying two tab labels and a range control over an
  // empty plot is a skeleton written by hand.
  //
  // A series that **failed** is the other news, and it is said here rather than
  // in a strip at the top of the page (#829, ADR-0037): the slot the chart would
  // have filled says the read did not answer, so what is missing and why are in
  // one place. #799's repair survives the band's removal — the head keeps its
  // figures either way.
  if ((ledger ? performance : valuation) === null) {
    return failure === null ? null : <Unreadable failure={failure} />
  }

  const reading: Reading = ledger ? chosen : 'amounts'
  const floor = windowFloor(range, new Date())
  // The `?? []` below are `tsc`'s bookkeeping and not a flattening: the guard
  // above has already returned from the branch each one fills, and the series
  // the *other* reading would draw is not read on this install at all.
  const rows = ledger
    ? amountsFromTotals(performance ?? [], floor)
    : amountsFromValuation(valuation ?? [], floor)
  const performanceSeries = performanceRows(performance ?? [], floor)
  const drawn: (AmountsRow | PerformanceRow)[] = reading === 'amounts' ? rows : performanceSeries

  return (
    <Card className="gap-4">
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Tabs and not radios: the reading is not a second setting of the
              range, and the two must not look like siblings. At one reading
              there is nothing to choose, so there is no control at all. */}
          {ledger ? (
            <Tabs value={reading} onValueChange={(value) => setChosen(value as Reading)}>
              <TabsList>
                <TabsTrigger value="amounts">{t('dashboard.chart.amounts')}</TabsTrigger>
                <TabsTrigger value="performance">{t('dashboard.chart.performance')}</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : (
            <h2 className="text-sm font-medium">{t('dashboard.chart.amounts')}</h2>
          )}

          {/* **The** range control of the page. */}
          <div role="radiogroup" aria-label={t('dashboard.chart.range')} className="flex gap-1">
            {DASHBOARD_RANGES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={candidate === range}
                onClick={() => setRange(candidate)}
                className={cn(
                  'rounded px-2 py-1 text-xs',
                  candidate === range ? 'bg-secondary font-medium' : 'text-muted-foreground',
                )}
              >
                {t('dashboard.chart.rangeName', { range: candidate })}
              </button>
            ))}
          </div>
        </div>

        {drawn.length === 0 ? (
          // A **fact**: the series answered and says nothing over this window.
          // *Not answered* never reaches here — the guard above returned.
          <EmptyState title={t('dashboard.chart.empty')} />
        ) : (
          <>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={drawn}>
                  {/* The grid the maquette **does** draw: horizontal only, and
                      a hair rather than a rule — `2 4` on the border colour,
                      where Recharts' own default is a `3 3` in a grey it picked
                      itself. It is a ground for the eye to rest a level on, not
                      a scale: the scale left with the gradations. */}
                  <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />

                  {/* **The axes are hidden, not removed.** What they drew — a
                      grid and two rows of gradations — is what the redesign took
                      off the chart, and it is said elsewhere: the window by the
                      range control (a second announcer of it is what ADR-0019
                      refuses), the magnitude by the head's own statistics, the
                      exact figure by the pointer. What they *decide* stays, and
                      is the whole reason they are still mounted: the value
                      scale's floor (`yFloor`) is what keeps the curve off the
                      bottom sixth of the plot, and the category axis is what
                      keeps the days the series holds from being interpolated. */}
                  <XAxis dataKey="t" hide />
                  <YAxis
                    domain={[
                      reading === 'amounts'
                        ? yFloor(amountsValues(rows))
                        : yFloor(performanceSeries.map((row) => row.performance)),
                      'auto',
                    ]}
                    hide
                  />

                  {/* What the pointer answers, and since #787 the **only**
                      thing that does: the axes went with the grid, so the exact
                      figure is a hover away and the magnitude at rest is the
                      head's two statistics one card up. */}
                  <ChartTooltip
                    format={(value) =>
                      reading === 'amounts' ? f.currency(value, currency) : f.percent(value)
                    }
                  />

                  {reading === 'amounts' ? (
                    <>
                      {/* **The wash is under the value curve, not between the
                          two** (#787) — the maquette's own arrangement, and it
                          answers the objection that kept the band neutral for
                          three tickets. A fill *between* the curves is a signed
                          quantity: it is the gain, it crosses zero inside a
                          window often enough that one colour would be wrong half
                          the time, and it therefore had to stay grey — which
                          made it invisible on midnight, under a caption that
                          promised a mark nobody could find.

                          A fill under the **value** claims nothing about a sign:
                          the value is what it is, the curve is already drawn in
                          the mint, and the wash is that curve's own weight. The
                          gap the caption names is still read between the two
                          lines — it is the mint above the dashed one — and it is
                          legible precisely because the region under it is no
                          longer empty.

                          The gradient is the maquette's to the stop: `0.22` of
                          the mint at the curve, `0.02` at the floor. */}
                      <defs>
                        <linearGradient id="portfolio-value-wash" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--color-price)" stopOpacity={0.22} />
                          <stop offset="100%" stopColor="var(--color-price)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <Area
                        // A **function** key, so the tooltip drops it: the wash
                        // repeats the value line's own figure, and answering the
                        // pointer twice with one number is two announcers of it
                        // (`ChartTooltip`).
                        dataKey={(row: { value: number | null }) => row.value}
                        name={t('dashboard.chart.area')}
                        baseValue="dataMin"
                        stroke="none"
                        fill="url(#portfolio-value-wash)"
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="value"
                        name={t(ledger ? 'dashboard.chart.value' : 'dashboard.chart.valuation')}
                        stroke="var(--color-price)"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="contributed"
                        name={t(ledger ? 'dashboard.chart.contributed' : 'dashboard.chart.cost')}
                        stroke="var(--muted-foreground)"
                        strokeWidth={1.25}
                        strokeDasharray="4 4"
                        dot={false}
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                    </>
                  ) : (
                    <>
                      <ReferenceLine y={0} stroke="var(--border)" />
                      <Line
                        type="monotone"
                        dataKey="performance"
                        name={t('dashboard.chart.performance')}
                        // **Not `--color-price`**, which is the mint: this curve
                        // crosses the zero line, and a portfolio down 8 % would
                        // draw its whole descent in the colour the app uses for a
                        // gain. It is the reason the Area above stays neutral,
                        // one line further down. The foreground says nothing
                        // about sign, and this is the only curve on the plot.
                        stroke="var(--foreground)"
                        strokeWidth={1.75}
                        dot={false}
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                    </>
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* The legend is written here rather than left to the library: it
                is what pairs a curve to its name, and the caption names the
                **gap** between them — which changes with its subject. *Gap* and
                not *area* since #787: the wash under the value curve is the one
                area drawn, and it is not the gain. A caption naming a fill the
                chart no longer draws that way is a caption pointing at the wrong
                mark. */}
            {reading === 'amounts' ? (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block size-2.5 rounded-full"
                    style={{ backgroundColor: 'var(--color-price)' }}
                  />
                  <span className="text-muted-foreground">
                    {t(ledger ? 'dashboard.chart.value' : 'dashboard.chart.valuation')}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-0.5 w-4"
                    style={{ backgroundColor: 'var(--muted-foreground)' }}
                  />
                  <span className="text-muted-foreground">
                    {t(ledger ? 'dashboard.chart.contributed' : 'dashboard.chart.cost')}
                  </span>
                </span>
                <p className="text-muted-foreground">
                  {t(ledger ? 'dashboard.chart.area.gain' : 'dashboard.chart.area.unrealised')}
                </p>
              </div>
            ) : (
              // No base **date** here, deliberately: the curve is rebased on the
              // first day of the visible window, so it does not move as the
              // reconstruction reaches further back — only the head's scalar
              // does, and that one carries the date while it is still moving.
              <p className="text-sm text-muted-foreground">{t('dashboard.chart.performance.base')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
