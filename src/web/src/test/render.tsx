/**
 * Mount the whole app, at one URL, at one instant.
 *
 * Three things are per test on purpose:
 *
 *  - **the history**, so the URL under test is an argument rather than a click
 *    path through the app;
 *  - **the `QueryClient`**, new and with `retry: false` — a shared client would
 *    carry one test's cache into the next, and a retry policy would make a test
 *    that asserts an error wait for three round trips before it can;
 *  - **`now`**, frozen. Every dated figure in this product is a function of the
 *    clock, so a suite that read the real one would go red on New Year's Eve.
 *    Only `Date` is faked, never the timers: `userEvent` schedules its own —
 *    unless a test asks for `fakeTimers`, the one way to reach the next poll
 *    (#1180). The timers then still advance with the wall clock, so `waitFor`
 *    keeps working, and `userEvent` is told to advance them.
 *
 * The client polls the live reads exactly as the browser's does.
 */
import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'

import { App } from '@/app'
import { pollLiveReads } from '@/lib/live'
import { createAppRouter } from '@/router'
import { NOW } from '@/test/factories'

export interface RenderAppOptions {
  url?: string
  now?: string | Date
  /**
   * What the browser asks for. It is an argument because the language defaults
   * to `auto`, so this *is* the reader's language until they choose one — and
   * jsdom's own answer is `en-US`, which would silently make every French
   * assertion a test of the fallback instead.
   */
  browserLanguages?: readonly string[]
  /** Fake the timers too, so `vi.advanceTimersByTimeAsync` reaches the next poll. */
  fakeTimers?: boolean
}

export function renderApp({
  url = '/',
  now = NOW,
  browserLanguages = ['fr-FR'],
  fakeTimers = false,
}: RenderAppOptions = {}) {
  vi.useFakeTimers(
    fakeTimers
      ? {
          toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
          shouldAdvanceTime: true,
          now: new Date(now),
        }
      : { toFake: ['Date'], now: new Date(now) },
  )
  Object.defineProperty(window.navigator, 'languages', {
    configurable: true,
    value: browserLanguages,
  })
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: browserLanguages[0],
  })

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  pollLiveReads(queryClient)
  const router = createAppRouter(createMemoryHistory({ initialEntries: [url] }))
  const user = userEvent.setup(fakeTimers ? { advanceTimers: vi.advanceTimersByTime } : {})
  const result = render(<App router={router} queryClient={queryClient} />)

  return { ...result, router, queryClient, user }
}
