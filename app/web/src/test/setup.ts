/**
 * What every test file gets before it runs. Three jobs, and the third is the
 * one that keeps the suite honest.
 *
 *  1. jest-dom's matchers, so an assertion reads like a sentence about the
 *     screen.
 *  2. The gaps jsdom leaves under a component library — `matchMedia`, pointer
 *     capture, `ResizeObserver`, `scrollIntoView`. None of them is a stand-in
 *     for a decision; they are browser API jsdom never implemented.
 *  3. **No network, no configuration.** MSW answers the faked edge and errors on
 *     any request no handler names; the clock, the storage and the root element
 *     are reset between tests, so nothing a test does can reach the next one.
 */
import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'

import { installMatchMedia } from '@/test/media'
import { server } from '@/test/server'

// Neither jsdom 30 nor the Node it runs on provides Web Storage here, and the
// app degrades to *not remembered* when it is missing — which would quietly
// make "the choice survives a remount" untestable. A Map-backed `Storage` puts
// the browser's behaviour back so the persistence is really exercised.
if (!window.localStorage) {
  const entries = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return entries.size
      },
      key: (index: number) => Array.from(entries.keys())[index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, String(value)),
      removeItem: (key: string) => void entries.delete(key),
      clear: () => entries.clear(),
    } satisfies Storage,
  })
}

// jsdom has no layout engine, so Radix's pointer-capture and scroll calls hit
// methods that simply do not exist there.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
// The router restores scroll on every navigation, and jsdom answers that one
// with a "Not implemented" line per route change.
window.scrollTo = () => {}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// `fetch` in this environment is Node's, and Node's refuses a relative URL —
// while `lib/api.ts` uses relative paths precisely because the app is served
// from the same origin as its API. Resolve them the way a browser would, once,
// here, rather than teaching the client an absolute base it does not need.
const nodeFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    return nodeFetch(new URL(input, window.location.origin), init)
  }
  return nodeFetch(input, init)
}) as typeof fetch

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  installMatchMedia()
})

afterEach(() => {
  server.resetHandlers()
  vi.useRealTimers()
  window.localStorage.clear()
  document.cookie = 'sidebar_state=; Max-Age=0; path=/'
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
})
