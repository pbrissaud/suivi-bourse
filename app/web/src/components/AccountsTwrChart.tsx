import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { api, type AccountHistory, type AccountSummary } from '@/lib/api'
import { roundOutward } from '@/lib/chart'
import { formatDate, formatNumber, formatPercent } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/**
 * TWR by account, base 100 — #652 déc. 13, and the page's reason to open with a
 * chart rather than with the table.
 *
 * It is the baseline's panel 20, and the only multi-series query in either
 * dashboard. What makes it the right comparison is that a base-100 index carries
 * **neither size nor currency**: a 3 000 € PEA and a 40 000 € CTO are on the
 * same axis without one of them being a flat line at the bottom, and a
 * mixed-currency portfolio — which the consolidated dashboard has to refuse
 * outright — is perfectly legible here. Every money column of the table below
 * states its own currency; this chart needs none.
 *
 * Fetched as N parallel `GET /api/accounts/{id}/history` (N = 2–5 declared
 * accounts), each cached on its own key. #655 accepted that cost rather than
 * inventing a multi-series endpoint, and the sheet's curve reuses the very same
 * entries.
 *
 * `connectNulls` is **true**, the opposite of the price chart and the same as
 * the dashboard's — trap 5, which records that the two baseline dashboards
 * disagree on purpose (`spanNulls: true` on panels 3, 15 and 20). A hole in a
 * price series is a market that did not trade and must show; a hole here is an
 * accounting day the gated recompute skipped, and breaking the line there would
 * suggest the account ceased to exist.
 */

type Preset = '1M' | '3M' | '1A' | 'MAX'

/** One point per calendar day, so 1J and 1S are degenerate — #660's trap. */
const PRESETS: Record<Preset, number> = { '1M': 30, '3M': 91, '1A': 365, MAX: 1826 }

const ORDER: Preset[] = ['1M', '3M', '1A', 'MAX']

const DAY_MS = 86_400_000

/** The base of the index, and the line every curve is read against. */
const BASE = 100

interface Row {
  t: number
  /** `s0`, `s1`, … — see `seriesKey`. */
  [key: string]: number | null
}

/**
 * Series are keyed by position, never by account id.
 *
 * Recharts resolves a `dataKey` string as a *path* (`a.b`, `a[0]`), so an
 * account id containing a dot or a bracket would silently read nothing — and
 * `id: "t"` would collide with the timestamp outright. Ids come from a
 * user-written `settings.yaml`, so neither is hypothetical.
 */
function seriesKey(index: number): string {
  return `s${index}`
}

export function AccountsTwrChart({ accounts }: { accounts: AccountSummary[] }) {
  const [preset, setPreset] = useState<Preset>('1A')

  const { from, to } = useMemo(() => {
    const stop = new Date()
    return { from: new Date(stop.getTime() - PRESETS[preset] * DAY_MS), to: stop }
  }, [preset])

  const results = useQueries({
    queries: accounts.map((account) => ({
      queryKey: ['account-history', account.id, preset],
      queryFn: () => api.accountHistory(account.id, from, to),
      // The perf job runs every SB_PERF_INTERVAL (120 s) and is gated, so
      // nothing new can land faster than that. Trap 2 is why it is polled at
      // all rather than fetched once: today's point is rewritten in place.
      refetchInterval: 120_000,
    })),
  })

  const loading = results.some((result) => result.isLoading)
  const failed = accounts.filter((_, index) => results[index]?.isError)

  // Not memoised: `useQueries` returns a fresh result array on every render, so
  // a dependency on it memoises nothing, and a hand-rolled signature key costs
  // more than the merge — five accounts of daily points is a few thousand
  // numbers.
  const rows = mergeSeries(results.map((result) => result.data))
  const domain = computeIndexDomain(rows, accounts.length)

  if (loading && rows.length === 0) return <Skeleton className="h-[320px] w-full" />

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
        <span className="text-xs text-muted-foreground">base 100, un point par jour</span>
      </div>

      {/* A partial failure stays partial: the accounts that answered are drawn,
          and the ones that did not are named. Blanking the whole chart because
          one of five queries failed would hide four correct curves. */}
      {failed.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Historique incomplet</AlertTitle>
          <AlertDescription>
            {failed.map((account) => account.label).join(', ')} —{' '}
            {(results.find((result) => result.isError)?.error as Error | undefined)?.message}
          </AlertDescription>
        </Alert>
      )}

      {rows.length === 0 ? (
        <div className="flex h-[320px] items-center justify-center rounded-md border border-dashed px-6 text-center text-sm text-muted-foreground">
          Aucun indice TWR sur cette période. Il est écrit dès qu'un compte a une
          valorisation non nulle.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={rows} margin={{ top: 12, right: 16, bottom: 4, left: 8 }}>
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
              domain={domain}
              tickFormatter={(value: number) => formatNumber(value, 0)}
              tick={{ fontSize: 11 }}
              width={56}
              className="fill-muted-foreground"
            />
            {/* The base is the whole reading of the chart: above it the account
                has made money, below it has lost it. Recharts would not draw it,
                and without it a bundle of curves around 104 says nothing. */}
            <ReferenceLine y={BASE} stroke="var(--color-muted-foreground)" strokeDasharray="4 4" />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const row = payload[0].payload as Row
                return (
                  <div className="space-y-1 rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
                    <div className="text-muted-foreground">{formatDate(row.t)}</div>
                    {accounts.map((account, index) => {
                      const value = row[seriesKey(index)]
                      if (value === null || value === undefined) return null
                      return (
                        <div key={account.id} className="flex items-center gap-2">
                          <span
                            className="inline-block size-2 shrink-0 rounded-full"
                            style={{ background: colourFor(index) }}
                          />
                          <span className="truncate">{account.label}</span>
                          <span className="ml-auto tabular font-medium">
                            {formatNumber(value, 1)}
                          </span>
                          <span className="tabular text-muted-foreground">
                            {formatPercent((value - BASE) / BASE)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )
              }}
            />
            {accounts.map((account, index) => (
              <Line
                key={account.id}
                type="linear"
                dataKey={seriesKey(index)}
                dot={false}
                connectNulls
                strokeWidth={2}
                stroke={colourFor(index)}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        {accounts.map((account, index) => (
          <span key={account.id} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ background: colourFor(index) }} />
            {account.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** The categorical ramp the allocation donut uses: equal lightness, spread hues,
 *  so no account's curve shouts louder than another's. */
function colourFor(index: number): string {
  return `var(--alloc-${(index % 8) + 1})`
}

/**
 * Fold N per-account series into one row per instant.
 *
 * The accounts are written in the same cycle at the same midnight stamp, so in
 * practice the timestamps align — but merging on the union rather than assuming
 * it is what keeps an account created last month from shifting every other
 * curve. A series with no point at an instant contributes `null` there, which
 * `connectNulls` then bridges.
 */
export function mergeSeries(series: (AccountHistory | undefined)[]): Row[] {
  const byInstant = new Map<number, Row>()

  series.forEach((history, index) => {
    if (!history) return
    for (const point of history.points) {
      if (point.t === null) continue
      const t = new Date(point.t).getTime()
      if (!Number.isFinite(t)) continue
      const row = byInstant.get(t) ?? { t }
      row[seriesKey(index)] = point.twr_index
      byInstant.set(t, row)
    }
  })

  return [...byInstant.values()].sort((a, b) => a.t - b.t)
}

/**
 * The Y domain, and it has to be computed for #660's reason: Recharts anchors a
 * positive series at zero, which would put every curve of a base-100 index in
 * the top few percent of the plot and make a 4 % divergence invisible.
 *
 * `BASE` is always inside the domain — an index chart whose reference line falls
 * outside the visible range has lost its meaning.
 */
export function computeIndexDomain(
  rows: Row[],
  count: number,
): [number, number] | undefined {
  const values: number[] = []
  for (const row of rows) {
    for (let index = 0; index < count; index += 1) {
      const value = row[seriesKey(index)]
      if (typeof value === 'number') values.push(value)
    }
  }
  if (values.length === 0) return undefined

  const min = Math.min(...values, BASE)
  const max = Math.max(...values, BASE)
  const pad = (max - min || BASE * 0.02) * 0.1
  // Rounded outward by the app's one axis rule (#660, `lib/chart`): a domain
  // read straight off the data puts the series' own extreme on the axis, and a
  // gradation reading "103" is a number about *this* portfolio rather than a
  // scale — worse here than anywhere, since the whole point of a base-100 index
  // is that its gradations are comparable.
  return roundOutward(min - pad, max + pad)
}
