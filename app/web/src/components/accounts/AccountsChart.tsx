/**
 * The comparison itself (#721, ADR-0019).
 *
 * **One reading, and one range control.** *Amounts* mounted here draws four
 * curves at two accounts — a full value line and a dotted contributed line per
 * account — the two pairs overlap, and **no surface is anybody's gain**. At five
 * accounts it is ten curves. The value-against-contributed shape is not lost: it
 * is the dashboard's at portfolio level and the account sheet's per account,
 * which are the two places where the area between two lines means something.
 *
 * **The strip carries one scalar per drawn curve, and the portfolio is not
 * drawn** — its own curve is the dashboard's, so its performance lives in the
 * table's `Portefeuille` row and nowhere else. Mounted here it sat at
 * `+102,72 %` beside `+71,49 %` and `+15,00 %` in the same typographic weight,
 * for a value that had no curve under it.
 *
 * **The entry marker keeps its subject.** An account opened three weeks ago
 * enters in the middle of a one-year window — a dated dot, a label and a dotted
 * rule — and that is never a reason to move the window. What moves the window is
 * the reader.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts'

import { EmptyState } from '@/components/EmptyState'
import {
  chartRows,
  DIMMED_OPACITY,
  RANGES,
  seriesColour,
  seriesKey,
  type Range,
  type RebasedSeries,
} from '@/lib/accounts'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { signClass } from '@/lib/sign'
import { cn } from '@/lib/utils'

export interface AccountsChartProps {
  /**
   * The drawn curves, already rebased — the portfolio is deliberately not one —
   * or **`null` while the N reads are in flight** (ADR-0026).
   *
   * `readonly RebasedSeries[]` alone let an empty array stand for two things,
   * and the block rendered *« rien à comparer »* on both: a perf cache with
   * nothing in it, which is a fact, and a page whose `useQueries` had not
   * answered yet, which is not. *Empty* is a claim about the reader's data.
   */
  series: readonly RebasedSeries[] | null
  /** What each curve is called, by key. */
  labels: ReadonlyMap<string, string>
  range: Range
  onRangeChange: (range: Range) => void
  /** The isolated curve, chosen by clicking a row of the table. */
  selected: string | null
}

export function AccountsChart({
  series,
  labels,
  range,
  onRangeChange,
  selected,
}: AccountsChartProps) {
  const { t } = useI18n()
  const f = useFormatters()

  // **Nothing at all, title included** (ADR-0026). A frame with an empty body
  // is a skeleton written by hand and this product has none; if one is ever
  // owed it arrives once, in the shell, never per block.
  if (series === null) return null

  const drawn = series.filter((one) => one.points.length > 0)
  const rows = chartRows(drawn)

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{t('accounts.chart.title')}</h2>
        {/* **The** control — it drives this chart and the table's `perf`
            column, which is what stops the two contradicting each other. */}
        <div role="radiogroup" aria-label={t('accounts.chart.range')} className="flex gap-1">
          {RANGES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={candidate === range}
              onClick={() => onRangeChange(candidate)}
              className={cn(
                'rounded px-2 py-1 text-xs',
                candidate === range ? 'bg-secondary font-medium' : 'text-muted-foreground',
              )}
            >
              {t('accounts.chart.rangeName', { range: candidate })}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={t('accounts.chart.empty')} />
      ) : (
        <>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="t"
                  tickFormatter={(value: string) => f.date(value)}
                  minTickGap={32}
                />
                {/* Base 100 is the unit, so the axis says so rather than
                    leaving a ladder of bare numbers to be read as money. */}
                <YAxis
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(value: number) => f.number(value, 0)}
                  width={56}
                />
                {drawn.map((one, index) => (
                  <Line
                    key={one.key}
                    type="monotone"
                    dataKey={seriesKey(one.key)}
                    name={labels.get(one.key) ?? one.key}
                    stroke={seriesColour(index)}
                    strokeOpacity={selected === null || selected === one.key ? 1 : DIMMED_OPACITY}
                    strokeWidth={selected === one.key ? 2.5 : 1.5}
                    dot={false}
                    isAnimationActive={false}
                    // A day this account has no point for is a day it did not
                    // exist, not a day it was worth nothing.
                    connectNulls={false}
                  />
                ))}
                {/* The entry marker — only for a curve that starts after the
                    window does, which is the only case a reader has to be told
                    about. */}
                {drawn.map((one, index) =>
                  one.entry === null ? null : (
                    <ReferenceLine
                      key={`${one.key}-entry-line`}
                      x={one.entry.t}
                      stroke={seriesColour(index)}
                      strokeDasharray="4 4"
                    />
                  ),
                )}
                {drawn.map((one, index) =>
                  one.entry === null ? null : (
                    <ReferenceDot
                      key={`${one.key}-entry-dot`}
                      x={one.entry.t}
                      y={one.entry.index}
                      r={4}
                      fill={seriesColour(index)}
                      stroke="none"
                      label={{
                        value: t('accounts.chart.entry', {
                          account: labels.get(one.key) ?? one.key,
                          date: f.date(one.entry.t),
                        }),
                        position: 'top',
                        fontSize: 11,
                      }}
                    />
                  ),
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* One scalar per drawn curve, and no portfolio scalar. */}
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {drawn.map((one, index) => (
              <li key={one.key} className="flex items-baseline gap-2 text-sm">
                <span
                  aria-hidden
                  className="inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: seriesColour(index) }}
                />
                <span className="text-muted-foreground">{labels.get(one.key) ?? one.key}</span>
                <span className={`tabular font-medium ${signClass(one.performance)}`}>
                  {f.percent(one.performance)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
