import { get, ROUTES, send } from '@/lib/api'
import type { JournalJob, JournalLevel, JournalPage } from '@/lib/api'

/** What `GET /api/logs` narrows by; `cursor` is the last row already seen. */
export interface JournalQuery {
  level?: JournalLevel
  job?: JournalJob
  /** An ISO 8601 instant: nothing older. */
  since?: string
  q?: string
  cursor?: number
}

export const systemApi = {
  logs: (query: JournalQuery = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    const suffix = params.size > 0 ? `?${params}` : ''
    return get<JournalPage>(`${ROUTES.logs}${suffix}`)
  },
  /** « Lancer »: answers 202, the pass runs off the request. */
  runJob: (id: string) =>
    send<{ id: string; started: true }>(
      ROUTES.jobRun.replace(':job', encodeURIComponent(id)),
      'POST',
      {},
    ),
}
