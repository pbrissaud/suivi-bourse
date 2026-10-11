/**
 * The hero's chart: the portfolio's curve across the full width of the head,
 * under the value and its pills, with the page's range control above it
 * (dashboard grid, decisions 17A and D25, 11/10/2026).
 *
 * **It is the real chart, not a picture of it.** The head used to draw a 64 px
 * sparkline beside the value, hidden from screen readers, and open the chart
 * — its two readings, its legend, its sentence — in a dialog (#1099, direction
 * 1a). Paul asked for the large chart back on the page; drawing a large
 * decorative line *and* keeping the real chart behind a link would say the
 * same thing twice and leave the large one mute. So `PortfolioChart` is drawn
 * here, with its non-visual reading (#1067), and the dialog is gone.
 *
 * **One range control, and it is still the page's** (#838), above the curve
 * it sets.
 *
 * **The series is the chart's own read**, and its failure is named by the
 * chart, in its own slot (#829): the value above it stays.
 */
import { PortfolioChart } from '@/components/dashboard/PortfolioChart'
import { Segmented } from '@/components/Segmented'
import type { PerfPoint, ValuationPoint } from '@/lib/api'
import { DASHBOARD_RANGES, type DashboardRange } from '@/lib/dashboard'
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

  return (
    <div data-hero-chart className="flex flex-col gap-3">
      <div className="flex justify-end">
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
      <PortfolioChart
        ledger={ledger}
        range={range}
        currency={currency}
        performance={performance}
        valuation={valuation}
        failure={failure}
      />
    </div>
  )
}
