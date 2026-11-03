import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { authFetch } from '@/lib/api'
import { isBackground, resetInput, watchInput } from '@/lib/session'

/**
 * A request sent long after the tab's last input is marked, so the server
 * never extends the session for it (#1313).
 */
describe('a request from an untouched tab says so', () => {
  const sent: Headers[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-03T10:00:00Z'))
    resetInput()
    watchInput()
    sent.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Headers(init?.headers))
        return new Response('{}', { status: 200 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('sends no mark within a minute of an input', async () => {
    vi.advanceTimersByTime(30_000)
    await authFetch('/api/positions')
    expect(sent[0].has('X-SB-Background')).toBe(false)
  })

  it('marks a poll from a tab nobody touched for over a minute', async () => {
    vi.advanceTimersByTime(61_000)
    expect(isBackground()).toBe(true)
    await authFetch('/api/positions')
    expect(sent[0].get('X-SB-Background')).toBe('1')
  })

  it.each([
    ['keydown', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))],
    ['pointerdown', () => window.dispatchEvent(new Event('pointerdown'))],
    ['focus', () => window.dispatchEvent(new FocusEvent('focus'))],
  ])('a %s makes the next request a foreground one again', async (_name, input) => {
    vi.advanceTimersByTime(61_000)
    input()
    await authFetch('/api/positions')
    expect(sent[0].has('X-SB-Background')).toBe(false)
  })

  it("keeps the caller's headers beside the mark", async () => {
    vi.advanceTimersByTime(61_000)
    await authFetch('/api/events', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(sent[0].get('Accept')).toBe('application/json')
    expect(sent[0].get('Content-Type')).toBe('application/json')
    expect(sent[0].get('X-SB-Background')).toBe('1')
  })
})
