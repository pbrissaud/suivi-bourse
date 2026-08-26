/**
 * What a chart answers the pointer — **one tooltip, two charts** (#787).
 *
 * It exists because the axes went. The design draws no gradations and no grid,
 * and that is legible only where the exact figure is a hover away: the axis
 * answered *roughly how much* at rest, the pointer answers *exactly how much*
 * on demand, and the scale at rest is stated by the block above each chart —
 * the dashboard's head carries `Valeur totale` and `Versé net`, the account's
 * detail carries its composition. Strip the axes without this and the chart
 * becomes a shape.
 *
 * It is a component rather than a copy for the reason `Stat`, `EmptyState`,
 * `Refusal` and `EntryPair` are: the prototype had four spellings of the same
 * object, and two charts answering the pointer in two registers is that defect
 * arriving one surface at a time.
 *
 * Two things it does are decisions:
 *
 *  - **The `cursor` is the border, never the library's grey band**, which paints
 *    over the very marks it is helping read.
 *  - **An entry whose `dataKey` is a function is dropped.** On the dashboard
 *    that is the *area*, whose key returns the `[contributed, value]` pair the
 *    band is drawn between — a drawing instruction, not a figure anybody reads.
 *    Filtering on *the entry has a string key* is what keeps it out, rather than
 *    a name test that would break the day a curve is renamed.
 */
import { Tooltip } from 'recharts'

import { useFormatters } from '@/lib/format'

export interface ChartTooltipProps {
  /** How a value is written. The chart owns its unit; this owns the shape. */
  format: (value: number) => string
}

export function ChartTooltip({ format }: ChartTooltipProps) {
  const f = useFormatters()

  return (
    <Tooltip
      cursor={{ stroke: 'var(--border)' }}
      isAnimationActive={false}
      content={({ active, payload, label }) => {
        if (!active || typeof label !== 'string') return null
        const lines = (payload ?? []).flatMap((entry) =>
          typeof entry.dataKey === 'string' && typeof entry.value === 'number'
            ? [
                {
                  key: entry.dataKey,
                  name: String(entry.name ?? ''),
                  value: entry.value,
                  colour: entry.color,
                },
              ]
            : [],
        )
        if (lines.length === 0) return null
        return (
          <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
            <p className="mb-1 font-medium">{f.date(label)}</p>
            {lines.map((line) => (
              <p key={line.key} className="flex items-baseline gap-3">
                <span className="text-muted-foreground">{line.name}</span>
                <span className="tabular ml-auto" style={{ color: line.colour }}>
                  {format(line.value)}
                </span>
              </p>
            ))}
          </div>
        )
      }}
    />
  )
}
