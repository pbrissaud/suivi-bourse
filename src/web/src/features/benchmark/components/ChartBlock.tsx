/**
 * The chart of the comparison: two text tabs and the period on one rule, the
 * plot under them (« Relevé »).
 *
 * *Écart* draws the gap between the two curves in euros against its zero line;
 * *Montants* draws both curves. The tabs choose **what the plot reads**
 * (`TextTabs`); the period only narrows the window drawn — the comparison
 * itself always replays the flows from the beginning, and a narrower window
 * does not change the answer, it only looks at less of it.
 */
import { useState } from 'react'

import { Segmented } from '@/components/Segmented'
import { TextTabs } from '@/components/TextTabs'
import { BenchmarkChart } from '@/features/benchmark/components/BenchmarkChart'
import type { BenchmarkPoint } from '@/features/benchmark/lib/api'
import { inRange, RANGES, type Range } from '@/features/benchmark/lib/comparison'
import { useI18n } from '@/lib/i18n'

type View = 'gap' | 'amounts'

const PANEL = 'benchmark-chart-panel'

export function ChartBlock({
  points,
  index,
  currency,
}: {
  points: readonly BenchmarkPoint[]
  index: string
  currency: string | null
}) {
  const { t } = useI18n()
  const [view, setView] = useState<View>('gap')
  const [range, setRange] = useState<Range>('MAX')

  return (
    <div className="mt-9 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b">
        <TextTabs<View>
          label={t('benchmark.chart.reading')}
          tabs={[
            { value: 'gap', label: t('benchmark.chart.tab.gap') },
            { value: 'amounts', label: t('benchmark.chart.tab.amounts') },
          ]}
          value={view}
          onChange={setView}
          panelId={PANEL}
          className="self-end border-b-0"
        />
        <div className="pb-2">
          <Segmented<Range>
            label={t('benchmark.chart.range')}
            mode="radio"
            size="compact"
            bordered
            options={RANGES.map((value) => ({ value, label: t(`benchmark.range.${value}`) }))}
            value={range}
            onChange={setRange}
          />
        </div>
      </div>
      <BenchmarkChart
        bare
        panelId={PANEL}
        view={view}
        points={inRange(points, range)}
        index={index}
        currency={currency}
      />
    </div>
  )
}
