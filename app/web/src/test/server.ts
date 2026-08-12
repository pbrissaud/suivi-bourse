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

import { ROUTES, type ChartWindow, type EventDraft } from '@/lib/api'
import {
  anAccountsPayload,
  anAdvisory,
  aConfig,
  aTypedEvent,
  aLedgerPayload,
  aPositionsPayload,
  aPriceSeries,
  aRuntime,
  aStore,
  aTotalsPayload,
} from '@/test/factories'

export function defaultHandlers() {
  return [
    http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload())),
    http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload())),
    http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload())),
    // The series answers for the **window it was asked for**, because the
    // resolution it announces is a function of that window (ADR-0010): a
    // handler serving one frozen payload would make the presets look like four
    // spellings of the same range.
    http.get(ROUTES.prices, ({ params, request }) => {
      const window = (new URL(request.url).searchParams.get('window') ?? '1Y') as ChartWindow
      return HttpResponse.json(aPriceSeries({ symbol: String(params.symbol), window }))
    }),
    http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime())),
    http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload())),
    // The two writes echo the row back, which is the contract's own shape: the
    // id and the provenance are the store's to decide, so a client cannot send
    // them and the answer is where they come from.
    http.post(ROUTES.events, async ({ request }) => {
      const draft = (await request.json()) as EventDraft
      return HttpResponse.json(aTypedEvent({ id: 'created', ...draft }), { status: 201 })
    }),
    http.patch(ROUTES.event, async ({ params, request }) => {
      const draft = (await request.json()) as EventDraft
      return HttpResponse.json(aTypedEvent({ id: String(params.id), ...draft }))
    }),

    // The installation tab (#724). The default install has one notice standing,
    // a store on a mount and no orphan — the ephemeral store and the orphan
    // list are what a test asks for by name, both being exactly what the block
    // exists to render.
    http.get(ROUTES.config, () => HttpResponse.json(aConfig())),
    http.get(ROUTES.advisories, () => HttpResponse.json([anAdvisory()])),
    http.get(ROUTES.store, () => HttpResponse.json(aStore())),
    // The write answers with the new list and **quantifies its effect**: a
    // portfolio-wide cadence that reaches part of the portfolio has to say so.
    http.put(ROUTES.settings, async ({ request }) => {
      const values = (await request.json()) as Record<string, string>
      return HttpResponse.json({
        settings: aConfig().settings,
        changed: Object.keys(values),
        effect: { symbols_rescheduled: 2, symbols_at_market_open: 1, jobs_rescheduled: [] },
      })
    }),
    http.post(ROUTES.advisoryAcknowledgement, ({ params }) =>
      HttpResponse.json(
        anAdvisory({ key: String(params.key), acknowledged: true, acknowledged_at: '2026-03-02T12:00:00.000Z' }),
      ),
    ),
    http.delete(ROUTES.storeOrphans, () =>
      HttpResponse.json({ symbols: ['ZZX'], points_removed: 1204 }),
    ),
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
