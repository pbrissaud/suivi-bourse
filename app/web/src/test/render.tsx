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
 *    Only `Date` is faked, never the timers: `userEvent` schedules its own.
 */
import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'

import { App } from '@/app'
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
}

export function renderApp({
  url = '/',
  now = NOW,
  browserLanguages = ['fr-FR'],
}: RenderAppOptions = {}) {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) })
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
  const router = createAppRouter(createMemoryHistory({ initialEntries: [url] }))
  const user = userEvent.setup()
  const result = render(<App router={router} queryClient={queryClient} />)

  return { ...result, router, queryClient, user }
}
