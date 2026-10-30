/**
 * The progress read of the followed ETFs (#1312).
 *
 * It is asked again **only while a followed ETF is incomplete**: every 10 s
 * while the sheet is open, every 60 s otherwise, and never once everything
 * followed is ready. The read replays nothing, so it is cheap enough to ask
 * under an open sheet; the page's own `['benchmark']` read is invalidated when
 * an ETF turns ready, so the picker offers it without a reload.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { type BenchmarkReference, benchmarkApi } from '@/features/benchmark/lib/api'

export const REFERENCES_KEY = ['benchmark-references'] as const

export const SHEET_POLL_MS = 10_000
export const QUIET_POLL_MS = 60_000

/** Something followed has not finished downloading. */
export function downloading(rows: readonly BenchmarkReference[] | undefined): boolean {
  return rows?.some((row) => row.followed && !row.ready) ?? false
}

export function useReferences(pollMs: number = QUIET_POLL_MS) {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: REFERENCES_KEY,
    queryFn: benchmarkApi.references,
    refetchInterval: (state) => (downloading(state.state.data) ? pollMs : false),
  })

  const ready = query.data
    ?.filter((row) => row.ready)
    .map((row) => row.symbol)
    .join()
  const seen = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (ready === undefined) return
    if (seen.current !== undefined && seen.current !== ready) {
      client.invalidateQueries({ queryKey: ['benchmark'] })
    }
    seen.current = ready
  }, [ready, client])

  return query
}
