/**
 * What a chart answers the pointer — **one tooltip, two charts** (#787).
 *
 * It exists because the axes went. The design draws no gradations and no grid,
 * and that is legible only where the exact figure is a gesture away: the axis
 * answered *roughly how much* at rest, a pointer — or, since #1003, an arrow
 * key — answers *exactly how much* on demand, and the scale at rest is stated by the block above each chart —
 * the dashboard's head carries `Valeur totale` and `Versé net`, the account's
 * detail carries its composition. Strip the axes without this and the chart
 * becomes a shape.
 *
 * It is a component rather than a copy for the reason `Stat`, `EmptyState`,
 * `Refusal` and `EntryPair` are: the prototype had four spellings of the same
 * object, and two charts answering the pointer in two registers is that defect
 * arriving one surface at a time.
 *
 * **It is also the per-point reading, and that is what makes the series
 * navigable without a pointer** (#1003). Recharts turns its own
 * `accessibilityLayer` on by default, so every plot here is focusable and the
 * left and right arrows already move this tooltip's index — they always did, and
 * nothing said a word as they went, because the library's own wrapper carries no
 * live region. The content below is one, politely, so a reader arrowing along
 * the series hears each day and the curves' values on it. Three consequences
 * worth knowing:
 *
 *  - **Polite, never assertive.** It is the answer to a gesture the reader just
 *    made, so it must not cut across a reading in progress. Same reasoning as
 *    `Refusal`'s `role="status"`.
 *  - **It cannot speak while nobody is there.** Recharts keeps its wrapper at
 *    `visibility: hidden` until a point is active, and a hidden subtree is not
 *    announced — so the region says something exactly when a pointer or an arrow
 *    key has put a day under the reader, and is silent otherwise.
 *  - **It never collides with `ChartReading`.** That one speaks when a control
 *    changes what is drawn; this one speaks when the reader moves along what is
 *    drawn. Two live regions, two gestures, never the same one.
 *
 * Three more things it does are decisions:
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

interface ChartTooltipProps {
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
          // The drawing's own box: the sidebar's ground rather than the
          // popover's, a hairline, and the date above the figures at the size
          // of a caption. Each row is the curve's **name in the curve's own
          // colour** and its figure in the mono face — the pairing is what
          // makes a tooltip readable without a legend under the pointer.
          //
          // `aria-live` sits **here** rather than on the library's wrapper,
          // which we do not own: this node exists only while a point is
          // active, so what is announced is a day and its figures and never an
          // empty box (#1003).
          <div
            aria-live="polite"
            className="min-w-42.5 rounded-lg border bg-sidebar px-3 py-2.5 text-sm shadow-lg"
          >
            <p className="mb-1.5 text-2xs text-muted-foreground">{f.date(label)}</p>
            {lines.map((line) => (
              <p key={line.key} className="flex items-baseline gap-3.5">
                <span style={{ color: line.colour }}>{line.name}</span>
                <span className="tabular ml-auto font-mono">{format(line.value)}</span>
              </p>
            ))}
          </div>
        )
      }}
    />
  )
}
