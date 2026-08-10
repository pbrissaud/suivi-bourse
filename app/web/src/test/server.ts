/**
 * The one faked edge: HTTP, and nothing else.
 *
 * Everything above it is the app as it ships — the real router, the real pages,
 * the real catalogues, the real theme, a real `QueryClient`. That is the exact
 * parallel of the Python seam (real runtime, faked yfinance): one boundary, the
 * outermost one. It is also what makes the front writable **in front of** the
 * store: the handlers below serve the contract, and the day a route is renamed
 * they and `lib/api.ts` change while no page test moves.
 *
 * `onUnhandledRequest: 'error'` in the setup file is the second half of "no
 * network": a request this file does not name fails the test rather than
 * reaching outside.
 */
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'

import { ROUTES } from '@/lib/api'
import { anAccountsPayload, aPositionsPayload, aRuntime, aTotalsPayload } from '@/test/factories'

export function defaultHandlers() {
  return [
    http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload())),
    http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload())),
    http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload())),
    http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime())),
  ]
}

/**
 * An RFC 9457 answer, media type included — the front branches on `type`, and
 * a body served as plain `application/json` is *not* a problem as far as the
 * client is concerned, which is a distinction worth being able to fake.
 */
export function problemHandler(
  path: string,
  problem: { status: number; type: string; title: string; detail?: string },
) {
  return http.get(path, () =>
    HttpResponse.json(problem, {
      status: problem.status,
      headers: { 'Content-Type': 'application/problem+json' },
    }),
  )
}

export const server = setupServer(...defaultHandlers())
