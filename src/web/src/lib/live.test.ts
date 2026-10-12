import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { LIVE_KEYS, LIVE_REFRESH_MS, pollLiveReads } from '@/lib/live'

describe('the live reads poll, the seeds of a form do not (#1180)', () => {
  const client = new QueryClient()
  pollLiveReads(client)

  it.each(LIVE_KEYS)('asks %s again every minute', (key) => {
    expect(client.getQueryDefaults([key]).refetchInterval).toBe(LIVE_REFRESH_MS)
    expect(LIVE_REFRESH_MS).toBe(60_000)
    expect(client.getQueryDefaults([key]).refetchOnWindowFocus).toBe(true)
  })

  it.each(['config', 'events', 'dashboard-layout'])('never polls %s', (key) => {
    expect(client.getQueryDefaults([key]).refetchInterval).toBeUndefined()
    expect(client.getQueryDefaults([key]).refetchOnWindowFocus).toBeUndefined()
  })

  it('asks for the health even offline, so a lost network turns the bell red', () => {
    expect(client.getQueryDefaults(['health']).networkMode).toBe('always')
    expect(client.getQueryDefaults(['positions']).networkMode).toBeUndefined()
  })
})
