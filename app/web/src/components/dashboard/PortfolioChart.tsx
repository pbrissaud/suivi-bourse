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
 * Without a cash ledger the perf series does not exist — `total_value`,
 * `net_contributed` and `twr_index` are `NULL` by #708's per-field rule — so
 * *Amounts* falls back to valuation against cost and is **the only reading**:
 * the area is then the *latent* gain, which is a different figure and therefore
 * a different sentence, and *Performance* is not offered rather than offered
 * empty.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'

import { ChartTooltip } from '@/components/ChartTooltip'
import { EmptyState } from '@/components/EmptyState'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import {
  amountsFromTotals,
  amountsFromValuation,
  amountsValues,
  DASHBOARD_RANGES,
  DEFAULT_DASHBOARD_RANGE,
  hasCashLedger,
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
import { cn } from '@/lib/utils'

export function PortfolioChart() {
  const { t } = useI18n()
  const f = useFormatters()
  const [chosen, setChosen] = useState<Reading>('amounts')
  const [range, setRange] = useState<DashboardRange>(DEFAULT_DASHBOARD_RANGE)

  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: api.portfolioTotals })
  const ledger = hasCashLedger(totals.data?.totals ?? null)
  // Exactly one of the two series is read, and the discriminant is the same one
  // that decides the reading: an install with no cash event has no perf series
  // at all, and one with a cash ledger has no use for the valuation curve.
  const perf = useQuery({
    queryKey: ['portfolio-totals-history'],
    queryFn: api.portfolioTotalsHistory,
    enabled: totals.isSuccess && ledger,
  })
  const valuation = useQuery({
    queryKey: ['positions-history'],
    queryFn: api.positionsHistory,
    enabled: totals.isSuccess && !ledger,
  })

  // A read that has not landed is not a fact, and a failed one is the head's
  // band to name: this block draws nothing rather than an empty plot, which
  // would read as *the portfolio is worth nothing*.
  if (!totals.data) return null

  const currency = totals.data.base_currency
  const reading: Reading = ledger ? chosen : 'amounts'
  const floor = windowFloor(range, new Date())
  const rows = ledger
    ? amountsFromTotals(perf.data?.points ?? [], floor)
    : amountsFromValuation(valuation.data?.points ?? [], floor)
  const performance = performanceRows(perf.data?.points ?? [], floor)
  const drawn: (AmountsRow | PerformanceRow)[] = reading === 'amounts' ? rows : performance
  const settled = ledger ? perf.isSuccess : valuation.isSuccess

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
          settled ? (
            <EmptyState title={t('dashboard.chart.empty')} />
          ) : null
        ) : (
          <>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={drawn}>
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
                        : yFloor(performance.map((row) => row.performance)),
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
                      {/* The area **is** the gain, and it is drawn in the neutral
                          of the surface rather than in the colour of a sign: it
                          crosses zero inside a window often enough that one
                          colour for the whole band would be plausibly wrong half
                          the time. The caption under it names what it is.

                          **And it is drawn strongly enough to be seen.** At
                          `0.14` of the muted foreground the band was barely
                          perceptible on the midnight ground, while the caption
                          under it promised *l'écart entre les deux courbes est
                          votre gain total* — a reading the drawing did not
                          deliver. A caption that names a mark nobody can find is
                          a caption about nothing. */}
                      <Area
                        dataKey={(row: { value: number | null; contributed: number | null }) =>
                          row.value === null || row.contributed === null
                            ? null
                            : [row.contributed, row.value]
                        }
                        name={t('dashboard.chart.area')}
                        stroke="none"
                        fill="var(--foreground)"
                        fillOpacity={0.16}
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="value"
                        name={t(ledger ? 'dashboard.chart.value' : 'dashboard.chart.valuation')}
                        stroke="var(--color-price)"
                        strokeWidth={1.75}
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
                        strokeDasharray="4 3"
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

            {/* The legend is written here rather than left to the library: it is
                what pairs a curve to its name, and the caption is what names the
                surface between them — which changes with its subject. */}
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
