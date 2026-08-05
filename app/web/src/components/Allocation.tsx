import { useMemo } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'

import type { Share } from '@/lib/api'
import { formatCurrency, formatPercent } from '@/lib/format'

/**
 * The allocation donut — half of #652 déc. 8's third block, and one of the two
 * objective gaps of the Grafana baseline it names: **no allocation panel
 * exists** there at all.
 *
 * Served by `/api/shares`, the very query the Titres page runs. That is déc. 8's
 * "one query, two consumers" honoured where it actually pays: both pages share
 * a single TanStack Query cache entry, so opening the dashboard after the table
 * costs nothing.
 *
 * A share whose price was never observed has `market_value === null` and is
 * **absent** from the donut rather than drawn at zero. A zero-width slice is
 * invisible either way; the difference is that summing it into the total would
 * make every other slice's percentage quietly wrong.
 */

/** How many slices stay individual before the tail is pooled. */
const TOP_N = 8

interface Slice {
  key: string
  label: string
  value: number
  colour: string
}

export function Allocation({ shares }: { shares: Share[] }) {
  const slices = useMemo(() => buildSlices(shares), [shares])
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const currency = useMemo(() => singleCurrency(shares), [shares])

  if (slices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aucune position valorisée : aucun cours n'a encore été enregistré.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <ResponsiveContainer width="100%" height={220} className="max-w-[220px]">
        <PieChart>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            innerRadius={58}
            outerRadius={88}
            paddingAngle={1}
            isAnimationActive={false}
          >
            {slices.map((slice) => (
              <Cell key={slice.key} fill={slice.colour} stroke="var(--background)" />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const slice = payload[0].payload as Slice
              return (
                <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
                  <div className="font-medium">{slice.label}</div>
                  <div className="tabular text-muted-foreground">
                    {formatCurrency(slice.value, currency)} ·{' '}
                    {formatPercent(total ? slice.value / total : null)}
                  </div>
                </div>
              )
            }}
          />
        </PieChart>
      </ResponsiveContainer>

      <ul className="flex-1 space-y-1 text-sm">
        {slices.map((slice) => (
          <li key={slice.key} className="flex items-center gap-2">
            <span
              className="inline-block size-2.5 shrink-0 rounded-full"
              style={{ background: slice.colour }}
            />
            <span className="truncate">{slice.label}</span>
            <span className="ml-auto tabular text-muted-foreground">
              {formatPercent(total ? slice.value / total : null)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Biggest first, and everything past the eighth pooled into "Autres".
 *
 * Not a rendering nicety: a donut of twenty slices is a colour wheel, and the
 * question the block answers — *what is this portfolio actually made of* — stops
 * having an answer somewhere around eight. Pooling the tail keeps the total
 * honest while the legend stays readable.
 */
export function buildSlices(shares: Share[]): Slice[] {
  const valued = shares
    .filter((share) => share.market_value !== null && share.market_value > 0)
    .map((share) => ({
      key: share.symbol,
      label: share.name ?? share.symbol,
      value: share.market_value as number,
    }))
    .sort((a, b) => b.value - a.value)

  const head = valued.slice(0, TOP_N)
  const tail = valued.slice(TOP_N)
  const pooled =
    tail.length > 0
      ? [{
          key: '__others__',
          label: `Autres (${tail.length})`,
          value: tail.reduce((sum, item) => sum + item.value, 0),
        }]
      : []

  return [...head, ...pooled].map((slice, index) => ({
    ...slice,
    colour: `var(--alloc-${(index % TOP_N) + 1})`,
  }))
}

function singleCurrency(shares: Share[]): string | null {
  const found = new Set(shares.map((share) => share.currency).filter(Boolean))
  return found.size === 1 ? ([...found][0] as string) : null
}
