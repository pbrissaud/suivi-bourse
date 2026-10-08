/**
 * The hero's curve: a sparkline, the page's range control under it, and the
 * full chart one click away (#1a of the dashboard redesign).
 *
 * **The page answers *how much is it worth* first, and the curve is the
 * figure's shape rather than a block of its own.** The full-width chart used
 * to be the page's second object and the largest one on it; it is now a 64 px
 * line beside the value it draws, and the chart with its two readings, its
 * legend and its sentence opens in a dialog on demand — same component, same
 * series, same range.
 *
 * **The sparkline is hidden on purpose.** It repeats the hero's own figure,
 * written beside it in text, so it is `aria-hidden` and leaves the tab order
 * (`accessibilityLayer={false}`), which is `AccountsCard`'s rule kept for the
 * one sparkline the page still draws. The reading a screen reader is owed is
 * the full chart's, behind the link.
 *
 * **One range control, and it is still the page's** (#838). It sits under the
 * curve it sets, and the dialog carries the same control bound to the same
 * state, so the two can never show two windows.
 *
 * **The series is the chart's own read**, and its failure is named here, in
 * the slot the sparkline would have filled (#829): the value beside it stays.
 */
import { ArrowRight } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts'

import { Segmented } from '@/components/Segmented'
import { Unreadable } from '@/components/Unreadable'
import { PortfolioChart } from '@/components/dashboard/PortfolioChart'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { PerfPoint, ValuationPoint } from '@/lib/api'
import {
  DASHBOARD_RANGES,
  amountsFromTotals,
  amountsFromValuation,
  windowFloor,
  type DashboardRange,
} from '@/lib/dashboard'
import { useI18n } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'

interface HeroChartProps {
  ledger: boolean
  range: DashboardRange
  onRangeChange: (range: DashboardRange) => void
  currency: string | null
  /** The two series, exactly as the page reads them — `null` while in flight. */
  performance: readonly PerfPoint[] | null
  valuation: readonly ValuationPoint[] | null
  failure?: ReadFailure | null
}

export function HeroChart({
  ledger,
  range,
  onRangeChange,
  currency,
  performance,
  valuation,
  failure = null,
}: HeroChartProps) {
  const { t } = useI18n()

  // Nothing at all while the series is in flight, and the failure in the slot
  // when it did not answer: the same two states `PortfolioChart` draws.
  if ((ledger ? performance : valuation) === null) {
    return failure === null ? null : (
      <div className="w-full sm:w-72">
        <Unreadable failure={failure} />
      </div>
    )
  }

  // The rows the chart's *Amounts* reading draws, and only their value: one
  // projection of the series, so the sparkline cannot disagree with the chart.
  const floor = windowFloor(range, new Date())
  const rows = ledger
    ? amountsFromTotals(performance ?? [], floor)
    : amountsFromValuation(valuation ?? [], floor)

  const control = (compact: boolean) => (
    <Segmented
      bordered
      mode="radio"
      size={compact ? 'compact' : 'default'}
      label={t('dashboard.chart.range')}
      value={range}
      onChange={onRangeChange}
      options={DASHBOARD_RANGES.map((candidate) => ({
        value: candidate,
        label: t('dashboard.chart.rangeName', { range: candidate }),
      }))}
    />
  )

  return (
    <div className="flex w-full flex-col gap-2.5 sm:w-60 sm:items-end">
      <span aria-hidden className="block h-16 w-full">
        {rows.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} accessibilityLayer={false} margin={{ top: 4, right: 2, bottom: 4, left: 2 }}>
              <YAxis hide domain={['dataMin', 'dataMax']} />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--price)"
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : null}
      </span>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:justify-end">
        {control(true)}
        <Dialog>
          <DialogTrigger className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {t('dashboard.chart.open')}
            <ArrowRight className="size-3" aria-hidden />
          </DialogTrigger>
          <DialogContent aria-describedby={undefined} className="gap-4 sm:max-w-4xl">
            <DialogHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pr-8">
              <DialogTitle>{t('dashboard.chart.dialog')}</DialogTitle>
              {control(false)}
            </DialogHeader>
            <PortfolioChart
              ledger={ledger}
              range={range}
              currency={currency}
              performance={performance}
              valuation={valuation}
              failure={failure}
            />
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
