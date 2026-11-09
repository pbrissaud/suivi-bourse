import { useEffect, useState } from 'react'

import { systemApi } from '@/features/system/lib/api'
import type { JournalJob, JournalRow } from '@/lib/api'

/** « En direct »: how often the journal asks for what came after. */
export const POLL_MS = 5000

/** The ring keeps 5 000 records; the page keeps no more than twice what one read returns. */
const KEPT = 2000

export type JournalSpan = '1h' | '24h' | '7d'

const SPAN_MS: Record<JournalSpan, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
}

export interface JournalFilters {
  job: JournalJob | 'all'
  span: JournalSpan
  q: string
}

export type JournalState =
  | { status: 'loading'; rows: JournalRow[] }
  | { status: 'ready'; rows: JournalRow[] }
  | { status: 'failed'; rows: JournalRow[]; error: unknown }

/**
 * The journal under its filters, newest first. A change of filter reads again
 * from the start; while `live`, the cursor of the last read asks only for what
 * came after and prepends it (§ 3.7). A poll that fails keeps what is drawn.
 */
export function useJournal({ job, span, q }: JournalFilters, live: boolean): JournalState {
  const [state, setState] = useState<JournalState>({ status: 'loading', rows: [] })

  useEffect(() => {
    let cancelled = false
    let cursor = 0
    const since = new Date(Date.now() - SPAN_MS[span]).toISOString()
    setState({ status: 'loading', rows: [] })

    async function load(first: boolean) {
      try {
        const page = await systemApi.logs({
          job: job === 'all' ? undefined : job,
          since,
          q: q.trim(),
          cursor: first ? undefined : cursor,
        })
        if (cancelled) return
        cursor = page.cursor
        setState((previous) => ({
          status: 'ready',
          rows: first ? page.rows : [...page.rows, ...previous.rows].slice(0, KEPT),
        }))
      } catch (error) {
        if (cancelled) return
        setState((previous) => (first ? { status: 'failed', rows: [], error } : previous))
      }
    }

    void load(true)
    const timer = live ? setInterval(() => void load(false), POLL_MS) : undefined
    return () => {
      cancelled = true
      if (timer !== undefined) clearInterval(timer)
    }
  }, [job, span, q, live])

  return state
}
