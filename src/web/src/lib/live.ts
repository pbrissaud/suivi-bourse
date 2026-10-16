/**
 * **The reads that follow the market, and how often they are asked again**
 * (#1180).
 *
 * The server writes quotes and the perf pass every 120 s at best, so a minute
 * is often enough for a figure on screen never to be more than one pass behind
 * — and a tab that is hidden asks nothing (`refetchIntervalInBackground` stays
 * `false`). No call site changes: the interval is a default of the key.
 *
 * They also refetch on focus, which the client turns off everywhere else: a
 * reader coming back to the tab after an hour should not wait up to a minute
 * for figures that are an hour old.
 *
 * `config`, `events` and `dashboard-layout` are **not** here, and must not be:
 * forms are seeded from them, and a refetch under a form being typed in would
 * reseed it.
 */
import type { QueryClient } from '@tanstack/react-query'

import type { BenchmarkResponse } from '@/features/benchmark/lib/api'

export const LIVE_REFRESH_MS = 60_000

export const LIVE_KEYS = [
  'health',
  'runtime',
  'positions',
  'portfolio-totals',
  'movers',
  'portfolio-totals-history',
  'positions-history',
] as const

/** Called by the browser entry and the test harness alike, so both poll. */
export function pollLiveReads(client: QueryClient) {
  for (const key of LIVE_KEYS) {
    client.setQueryDefaults([key], {
      refetchInterval: LIVE_REFRESH_MS,
      refetchOnWindowFocus: true,
      // Offline, a query *pauses* rather than fails, which would leave the
      // bell green over figures that have stopped moving. The health read asks
      // anyway, so a lost network is said like a server that stopped answering.
      ...(key === 'health' && { networkMode: 'always' as const }),
    })
  }
  // The comparison does not follow the market (#1205): only a reference being
  // rebuilt moves under it, so it is asked again while that lasts, and then
  // never. The dashboard card and the page share the key.
  client.setQueryDefaults(['benchmark'], {
    refetchInterval: (query) => {
      const state = (query.state.data as BenchmarkResponse | undefined)?.state
      return state === 'rebuilding' || state === 'splits_unknown' ? LIVE_REFRESH_MS : false
    },
  })
}
