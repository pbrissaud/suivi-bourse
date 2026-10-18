/**
 * One chart slot, **two readings** (#727).
 *
 * *Amounts* draws the portfolio's value against what was put into it, and the
 * area between the two **is** the gain — the clearest answer the product can
 * give to *did I gain because it went up, or because I put more in*, which a
 * value curve alone cannot. *Performance* draws the time-weighted return, which
 * answers the other question — *did my holdings do well* — and is the one
 * figure a deposit does not move.
 *
 * Four things about it are decisions:
 *
 *  - **The reading selector is a reading selector, and it is not tabs** (#831).
 *    It was `Tabs` for three tickets and the maquette never drew one: both
 *    controls of this chart are segmented **buttons** there (`readingTabs`,
 *    whose name is the only tab left in the drawing). A tab is a *place* the
 *    reader goes — the shell's own navigation is what the product has of those
 *    — and what these two press is which curve the same slot draws. So they are
 *    buttons that say whether they are in force (`aria-pressed`), grouped and
 *    named, exactly the idiom the ledger's chips and the price chart's rail
 *    already use. What survives the change is the reason they are not radios:
 *    two sibling radio groups read as two settings of the same thing, and the
 *    range beside them is the chart's one range control.
 *  - **`3M` is dead** and `1M / YTD / 1Y / MAX` is the whole list: from
 *    February to December `YTD` covers or contains `3M`, and five buttons on
 *    one control is one too many. The series is daily and dense over the
 *    calendar and it is kept **whole** — there is no ladder here, so changing
 *    the range changes the span and never the resolution, and no *aggregated by
 *    X* caption is owed.
 *  - **The x domain is the data's**, never the window asked for. Recharts' own
 *    category axis does that by construction and it is the reason nothing sets
 *    a domain here: fixing the axis to the requested window would put ticks on
 *    dates the series says nothing about, which is the mistake corrected on the
 *    value axis one line below.
 *  - **The value axis is floored at zero when nothing drawn is negative.** Left
 *    to itself it fitted the data and graduated `−1 411 €` under a series that
 *    has never been negative.
 *  - **The axes draw their scale** (#1265): three to five value ticks and time
 *    ticks on calendar boundaries, both computed by `valueAxis` / `timeTicks`
 *    rather than by Recharts. Time ticks thin out under 768 px, never to none.
 *  - **It answers the pointer, and the arrow keys** (#790, then #1003), and the
 *    answer is the page's own formatting: one day, and the curves' values on it,
 *    in the reader's language and the reporting currency. Recharts made the plot
 *    focusable and walkable all along; what #1003 added is that `ChartTooltip`
 *    is announced as it moves. The **area is not in it** — its
 *    `dataKey` is a function returning the `[contributed, value]` pair the band
 *    is drawn between, which is a drawing instruction and not a figure anybody
 *    reads. Filtering on *the entry has a string key* is what keeps it out,
 *    rather than a name test that would break the day a curve is renamed.
 *
 *  - **The two series are the page's read, not the block's** (#799), and they
 *    cross as `readonly X[] | null`. `null` is *not answered* — in flight, or
 *    failed — and the block renders **nothing at all, title included**: a frame
 *    with an empty body is a hand-written skeleton, and a plot drawn on an
 *    empty array reads as *the portfolio is worth nothing*. The two are told
 *    apart by the `failure` prop since #829: in flight the slot is empty and
 *    claims nothing, refused it carries the reason. The head is never emptied
 *    either way, which is what this block's `settled` used to cost by making a
 *    failed series and an unanswered one the same silence.
 *
 *  - **It explains no rule of the product** (#831). What is left under the plot
 *    is a legend, which names curves rather than stating rules — and, since
 *    #1003, a `<figcaption>` nobody sees: the shape of the window, for a reader
 *    who cannot see the drawing. It states figures and no rules either.
 *
 * Without a cash ledger the perf series does not exist — `total_value`,
 * `net_contributed` and `twr_index` are `NULL` by #708's per-field rule — so
 * *Amounts* falls back to valuation against cost and is **the only reading**:
 * the area is then the *latent* gain, which is a different figure and therefore
 * a different pair of names in the legend, and *Performance* is not offered
 * rather than offered empty.
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

import { ChartReading } from '@/components/ChartReading'
import { ChartTooltip } from '@/components/ChartTooltip'
import { Segmented } from '@/components/Segmented'
import { EmptyState } from '@/components/EmptyState'
import { Unreadable } from '@/components/Unreadable'
import type { PerfPoint } from '@/features/accounts/lib/api'
import type { ValuationPoint } from '@/features/dashboard/lib/api'
import {
  amountsFromTotals,
  amountsFromValuation,
  AXIS_TICKS,
  amountsValues,
  DASHBOARD_RANGES,
  performanceRows,
  READINGS,
  tickDigits,
  timeTicks,
  valueAxis,
  signSplitOffset,
  windowFloor,
  type AmountsRow,
  type DashboardRange,
  type PerformanceRow,
  type Reading,
} from '@/features/dashboard/lib/dashboard'
import { useIsMobile } from '@/hooks/use-mobile'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { signOf } from '@/lib/sign'
import type { ReadingCurve } from '@/lib/chartReading'
import type { ReadFailure } from '@/lib/status'

interface PortfolioChartProps {
  /**
   * Whether the install has a cash ledger — which is at once the discriminant
   * of the reading and of the series that is read (`hasCashLedger`).
   */
  ledger: boolean
  /**
   * The chart's window. There is **one** range control on the dashboard and it
   * is this chart's own (#838, then #1155 closed): it sits on the chart's
   * control bar, beside the readings, and sets this chart's window only. The
   * state lives on the page, which passes it in.
   */
  range: DashboardRange
  onRangeChange: (range: DashboardRange) => void
  currency: string | null
  /**
   * The two series, exactly one of which is read. `null` is *the read has not
   * answered* — in flight, or failed — and never an empty payload, which is a
   * fact about the reader's own history.
   */
  performance: readonly PerfPoint[] | null
  valuation: readonly ValuationPoint[] | null
  /**
   * The block's own read, refused — `null` when it did answer or is still in
   * flight.
   */
  failure?: ReadFailure | null
}

export function PortfolioChart({
  ledger,
  range,
  onRangeChange,
  currency,
  performance,
  valuation,
  failure = null,
}: PortfolioChartProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const [chosen, setChosen] = useState<Reading>('amounts')
  const phone = useIsMobile()

  // **Nothing at all, title included**: the block's one series is
  // in flight, and a frame carrying two reading buttons and a range control
  // over an empty plot is a skeleton written by hand.
  //
  // A series that **failed** is the other news, and it is said here rather than
  // in a strip at the top of the page (#829): the slot the chart would
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
  const performanceValues = performanceSeries.map((row) => row.performance)
  const offset = signSplitOffset(performanceValues)
  // The gradient only where the curve really crosses zero. At 0 or 1 one colour
  // covers the whole path, and the series always opens on 0 % (rebased), so the
  // solid colour is read off the first value that is not zero.
  const split = offset !== null && offset > 0 && offset < 1 ? offset : null
  const solidSign = signOf(performanceValues.find((value) => value !== null && value !== 0) ?? null)
  const solidStroke =
    solidSign === 'gain'
      ? 'var(--gain)'
      : solidSign === 'loss'
        ? 'var(--loss)'
        : 'var(--foreground)'
  const drawn: (AmountsRow | PerformanceRow)[] = reading === 'amounts' ? rows : performanceSeries
  // The scale (#1265): ticks are the chart's own, because Recharts' nice ticks
  // graduated `−35 %, 0, 35 %` and stretched the domain. Value ticks follow the
  // plot's height, which a phone keeps; time ticks follow its width, which it
  // does not.
  const x = timeTicks(
    drawn.map((row) => row.t),
    phone ? AXIS_TICKS.time.phone : AXIS_TICKS.time.wide,
  )
  const y = valueAxis(
    reading === 'amounts' ? amountsValues(rows) : performanceSeries.map((row) => row.performance),
  )
  const digits = tickDigits(y.ticks, (value, d) =>
    reading === 'amounts' ? f.compact(value, currency, d) : f.percent(value, 0, d),
  )
  // What the reading announces, named exactly as the legend names it and keyed
  // exactly as the `<Line>` below draws it (#1003). The pair is the sentence's
  // own order: the value first, the reference it is read against second.
  const curves: ReadingCurve[] =
    reading === 'amounts'
      ? [
          { name: t(ledger ? 'dashboard.chart.value' : 'dashboard.chart.valuation'), key: 'value' },
          {
            name: t(ledger ? 'dashboard.chart.contributed' : 'dashboard.chart.cost'),
            key: 'contributed',
          },
        ]
      : [{ name: t('dashboard.chart.performance'), key: 'performance' }]
  // The tooltip writes a bare number when the dial has not answered — the
  // reader is looking at the chart they pointed at — but the sentence does not
  // claim a shape in an unknown unit: `null` is *say nothing* (`ChartReading`).
  const write =
    reading === 'amounts'
      ? currency === null
        ? null
        : (value: number) => f.currency(value, currency)
      : (value: number) => f.percent(value)

  return (
    // Bare, with no card of its own: it is drawn inside the hero, which sits
    // on the ground, and a card there would decorate nothing the user decides.
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* **Buttons, and neither tabs nor radios** (#831). The maquette draws
              this selector segmented exactly as the range beside it, and
              nothing here is a place to go: pressing one swaps what the slot
              below draws, which is what `aria-pressed` says and what a tab
              would misname. At one reading there is nothing to choose, so there
              is no control at all, only the heading — and the range sits beside
              it and sets this chart's window only. One bar, one track look
              (#1150): on a narrow screen the range wraps under the reading. */}
        {ledger ? (
          <Segmented
            bordered
            mode="pressed"
            size="compact"
            label={t('dashboard.chart.reading')}
            value={reading}
            onChange={setChosen}
            options={READINGS.map((candidate) => ({
              value: candidate,
              label: t(
                candidate === 'amounts' ? 'dashboard.chart.amounts' : 'dashboard.chart.performance',
              ),
            }))}
          />
        ) : (
          <h2 className="label">{t('dashboard.chart.amounts')}</h2>
        )}
        <Segmented
          bordered
          mode="radio"
          size="compact"
          label={t('dashboard.chart.range')}
          value={range}
          onChange={onRangeChange}
          options={DASHBOARD_RANGES.map((candidate) => ({
            value: candidate,
            label: t('dashboard.chart.rangeName', { range: candidate }),
          }))}
        />
      </div>
      {/* **The live region wraps the swap, and not the plot** (#1003). A range
            press on a young ledger replaces the drawing with the empty state, so
            a region living inside the drawn branch would *unmount* rather than
            change, and a region that unmounts announces nothing — on the one
            gesture that changes the screen most. What is read back is therefore
            whichever of the two fills this node. The legend is deliberately
            outside it: it does not move under the range, and hearing it again on
            every press is noise. */}
      <div aria-live="polite">
        {drawn.length === 0 ? (
          // A **fact**: the series answered and says nothing over this window.
          // *Not answered* never reaches here — the guard above returned.
          <EmptyState title={t('dashboard.chart.empty')} />
        ) : (
          <figure>
            <div className="h-75 tabular">
              <ResponsiveContainer width="100%" height="100%">
                {/* **Named, and not hidden** (#1003). Recharts turns its own
                      `accessibilityLayer` on by default, so this `<svg>` is
                      focusable and the arrows already walk the series: hiding it
                      would leave a stop in the tab order that announces nothing.
                      The name goes on `aria-label` rather than the library's
                      `title` prop, because `Surface` emits an empty `<title>`
                      whether one was passed or not. */}
                <ComposedChart data={drawn} aria-label={t('dashboard.chart.plot')}>
                  {/* The grid the maquette **does** draw: horizontal only, and
                        a hair rather than a rule — `2 4` on the border colour,
                        where Recharts' own default is a `3 3` in a grey it picked
                        itself. It is a ground for the eye to rest a level on, and
                        since #1265 it falls on the value ticks below. */}
                  <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />

                  {/* The scale (#1265): `rule` and `text-muted` only, no axis line and
                    no tick mark, so the dashed grid above stays the one line
                    and now falls on the value ticks. The category axis is still
                    what keeps the days the series holds from being interpolated,
                    and its domain is the data's. */}
                  <XAxis
                    dataKey="t"
                    ticks={x.ticks}
                    tickFormatter={(day: string) => f.axisDate(day, x.unit)}
                    minTickGap={8}
                    axisLine={false}
                    tickLine={false}
                    stroke="var(--border)"
                    tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
                  />
                  <YAxis
                    domain={y.domain}
                    ticks={y.ticks}
                    tickFormatter={(value: number) =>
                      reading === 'amounts'
                        ? f.compact(value, currency, digits)
                        : f.percent(value, 0, digits)
                    }
                    width="auto"
                    axisLine={false}
                    tickLine={false}
                    stroke="var(--border)"
                    tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
                  />

                  {/* What the pointer answers: the exact figure, where the axes
                        give the scale (#1265) and the reading sentence the
                        shape. */}
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
                            made it invisible on midnight, under the caption the
                            block still carried then and which promised a mark
                            nobody could find. That caption went with #831.

                            A fill under the **value** claims nothing about a sign:
                            the value is what it is, the curve is already drawn in
                            the mint, and the wash is that curve's own weight. The
                            gap is still read between the two lines — it is the
                            mint above the dashed one — and it is legible precisely
                            because the region under it is no longer empty.

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
                      {/* **Coloured by its sign, split exactly at zero** (#1263):
                            the one curve that crosses 0 %. Drawn in the mint it
                            painted a loss as a gain, drawn in the foreground it
                            fell outside the palette. The 0 % line and the
                            sentence under the plot carry the sign without colour.
                            A flat series has a zero-height box, which paints
                            nothing with a bounding-box gradient, and a curve that
                            never crosses zero needs one colour only: both are
                            stroked solid instead. */}
                      {split === null ? null : (
                        <defs>
                          <linearGradient id="performance-sign" x1="0" y1="0" x2="0" y2="1">
                            <stop offset={split} stopColor="var(--gain)" />
                            <stop offset={split} stopColor="var(--loss)" />
                          </linearGradient>
                        </defs>
                      )}
                      <Line
                        type="monotone"
                        dataKey="performance"
                        name={t('dashboard.chart.performance')}
                        stroke={split === null ? solidStroke : 'url(#performance-sign)'}
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
            {/* The sentence, in the slot the drawing occupies in the reading
                  order: head, controls, the named plot, this, the legend. The
                  rows are the ones the plot draws, by the keys the `<Line>`s
                  name, so the two cannot come apart. */}
            <ChartReading
              rows={drawn}
              curves={curves}
              format={write}
              reference={reading === 'performance' ? 0 : undefined}
            />
          </figure>
        )}
      </div>

      {drawn.length === 0 ? null : (
        <>
          {/* The legend is written here rather than left to the library: it is
            what pairs a curve to its **name**, and since #831 that is all it
            does. The maquette draws the two swatches and nothing else, which is
            the same arrangement arrived at from the other end.

            Nothing is lost by the removal that the page does not go on saying:
            the fallback's own reason — *this portfolio records no cash
            movement* — is the head's `dashboard.withoutLedger`, said once,
            where the figures it removes are; and which pair of curves is drawn
            is said by the two names below, `Valorisation` / `Prix de revient`
            against `Valeur totale` / `Versé net`. */}
          {reading === 'amounts' ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-0.75 w-3.5 rounded-xs"
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
            </div>
          ) : // Nothing under the performance reading, and no base **date**
          // either. The date was already refused here — the curve is rebased
          // on the first day of the visible window, so it does not move as
          // the reconstruction reaches further back, and only the head's
          // scalar carries a date, which it always states (the IRR's bubble,
          // #1263), since it moves while the reconstruction runs. The two marks
          // that state it without a sentence stay — the zero reference line
          // the curve crosses, and the range control that names the window it
          // is rebased on.
          null}
        </>
      )}
    </div>
  )
}
