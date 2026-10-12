/**
 * The hero's chart: the portfolio's curve across the full width of the head,
 * under the value and its pills, its range control beside its readings
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
 * **One range control, and it is the chart's own** (#838, then #1155 closed):
 * it sits on the chart's control bar, beside the readings (#1150). The state
 * stays on the page, which passes it through.
 *
 * **The series is the chart's own read**, and its failure is named by the
 * chart, in its own slot (#829): the value above it stays.
 */
import { PortfolioChart } from '@/components/dashboard/PortfolioChart'
import { Unreadable } from '@/components/Unreadable'
import type { PerfPoint, ValuationPoint } from '@/lib/api'
import type { DashboardRange } from '@/lib/dashboard'
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
  // The chart's own two states, before any control: nothing while the series
  // is in flight, and only the failure when it did not answer — a range
  // control over an empty slot sets nothing.
  if ((ledger ? performance : valuation) === null) {
    return failure === null ? null : <Unreadable failure={failure} />
  }

  return (
    <div data-hero-chart>
      <PortfolioChart
        ledger={ledger}
        range={range}
        onRangeChange={onRangeChange}
        currency={currency}
        performance={performance}
        valuation={valuation}
        failure={failure}
      />
    </div>
  )
}
