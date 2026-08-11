/**
 * One symbol's price, over one of four ranges (#684 D10, ADR-0010).
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
 * The chart's event overlay — a day carrying several events being **one** marker
 * that announces its count, and the selection that links it to the list under it
 * — is #720's, and it lands on this component.
 */
import { useQuery } from '@tanstack/react-query'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'

import { Band } from '@/components/Band'
import { EmptyState } from '@/components/EmptyState'
import { api, CHART_WINDOWS, type ChartWindow } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { cn } from '@/lib/utils'

export interface PriceChartProps {
  symbol: string
  window: ChartWindow
  onWindowChange: (window: ChartWindow) => void
}

export function PriceChart({ symbol, window, onWindowChange }: PriceChartProps) {
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
        <Band>{t(problemMessageKey(series.error))}</Band>
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
                <XAxis dataKey="ts" tickFormatter={(value: string) => f.date(value)} minTickGap={32} />
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
        </>
      )}
    </section>
  )
}
