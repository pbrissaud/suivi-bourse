import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { api, type AccountHistory } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/**
 * The account's own curve — the baseline's panel 3, kept nearly as it was
 * because its shape is already the right one.
 *
 * Liquidités and Titres are **stacked**, so their combined height *is* the total
 * value and the split between them is readable at a glance; the versements nets
 * ride on top as a single line, unstacked. Reading the chart is then: where the
 * stack is above the line, the account is ahead of what was put into it.
 *
 * This is the one chart in the app whose Y axis is honestly anchored at zero,
 * and the reason is #660's own rule read the other way: zero is the right
 * baseline when the *height of the mark* is the quantity, which is exactly what
 * a stacked composition is. The dashboard's value-vs-contributed chart drops it
 * because there the quantity is the *gap between two lines*.
 */

type Preset = '1M' | '3M' | '1A' | 'MAX'

const PRESETS: Record<Preset, number> = { '1M': 30, '3M': 91, '1A': 365, MAX: 1826 }

const ORDER: Preset[] = ['1M', '3M', '1A', 'MAX']

const DAY_MS = 86_400_000

interface Point {
  t: number
  cash: number | null
  holdings: number | null
  contributed: number | null
}

interface Props {
  account: string
  currency: string | null
}

export function AccountHistoryChart({ account, currency }: Props) {
  const [preset, setPreset] = useState<Preset>('1A')

  const { from, to } = useMemo(() => {
    const stop = new Date()
    return { from: new Date(stop.getTime() - PRESETS[preset] * DAY_MS), to: stop }
  }, [preset])

  // The **same cache entry** the TWR chart above already filled for this
  // account and this preset: one endpoint, two consumers reading different
  // fields of it. Opening a sheet after looking at the comparison costs nothing.
  const history = useQuery({
    queryKey: ['account-history', account, preset],
    queryFn: () => api.accountHistory(account, from, to),
    refetchInterval: 120_000,
  })

  const points = useMemo(() => toPoints(history.data), [history.data])

  if (history.isLoading) return <Skeleton className="h-[260px] w-full" />

  if (history.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Historique indisponible</AlertTitle>
        <AlertDescription>{(history.error as Error).message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {ORDER.map((key) => (
            <Button
              key={key}
              size="sm"
              variant={preset === key ? 'secondary' : 'ghost'}
              onClick={() => setPreset(key)}
            >
              {key}
            </Button>
          ))}
        </div>
      </div>

      {points.length === 0 ? (
        <div className="flex h-[260px] items-center justify-center rounded-md border border-dashed px-6 text-center text-sm text-muted-foreground">
          Aucun historique sur cette période.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={points} margin={{ top: 12, right: 12, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(value: number) => formatDate(value)}
              tick={{ fontSize: 11 }}
              className="fill-muted-foreground"
            />
            <YAxis
              tickFormatter={(value: number) => formatCurrency(value, currency, 0)}
              tick={{ fontSize: 11 }}
              width={72}
              className="fill-muted-foreground"
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const point = payload[0].payload as Point
                const total =
                  point.cash === null && point.holdings === null
                    ? null
                    : (point.cash ?? 0) + (point.holdings ?? 0)
                return (
                  <div className="space-y-1 rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
                    <div className="text-muted-foreground">{formatDate(point.t)}</div>
                    <div className="tabular font-medium">
                      Valeur totale {formatCurrency(total, currency)}
                    </div>
                    <div className="tabular text-muted-foreground">
                      Titres {formatCurrency(point.holdings, currency)}
                    </div>
                    <div className="tabular text-muted-foreground">
                      Liquidités {formatCurrency(point.cash, currency)}
                    </div>
                    <div className="tabular text-muted-foreground">
                      Versements nets {formatCurrency(point.contributed, currency)}
                    </div>
                  </div>
                )
              }}
            />

            <Area
              dataKey="holdings"
              stackId="value"
              stroke="var(--color-alloc-1)"
              fill="var(--color-alloc-1)"
              fillOpacity={0.25}
              strokeWidth={1}
              connectNulls
              isAnimationActive={false}
            />
            <Area
              dataKey="cash"
              stackId="value"
              stroke="var(--color-alloc-2)"
              fill="var(--color-alloc-2)"
              fillOpacity={0.25}
              strokeWidth={1}
              connectNulls
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="contributed"
              dot={false}
              connectNulls
              strokeWidth={2}
              stroke="var(--color-grant)"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <Key colour="var(--alloc-1)" label="Titres" />
        <Key colour="var(--alloc-2)" label="Liquidités" />
        <Key colour="var(--grant)" label="Versements nets" />
      </div>
    </div>
  )
}

function Key({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-0.5 w-4" style={{ background: colour }} />
      {label}
    </span>
  )
}

export function toPoints(history: AccountHistory | undefined): Point[] {
  if (!history) return []
  return history.points
    .map((point) => ({
      t: point.t === null ? NaN : new Date(point.t).getTime(),
      cash: point.cash_balance,
      holdings: point.holdings_value,
      contributed: point.net_contributed,
    }))
    .filter((point) => Number.isFinite(point.t))
}
