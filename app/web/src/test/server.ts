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

import { ROUTES, type AccountDraft, type ChartWindow, type EventDraft } from '@/lib/api'
import {
  anAccount,
  anAccountHistory,
  anAccountsPayload,
  anInstallationFact,
  aConfig,
  aHealth,
  aTypedEvent,
  aLedgerPayload,
  aMoversPayload,
  aPortfolioHistory,
  aPositionsHistory,
  aPositionsPayload,
  aPriceSeries,
  aReceipt,
  aRuntime,
  aStore,
  aTotalsPayload,
} from '@/test/factories'

export function defaultHandlers() {
  return [
    http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload())),
    // The declaration's three gestures (#698, read by a client since #729). They
    // echo the row back the way the two event writes do — three members and no
    // fourth, an account being born in the app and nowhere else (ADR-0034).
    http.post(ROUTES.accounts, async ({ request }) => {
      const draft = (await request.json()) as AccountDraft
      return HttpResponse.json(anAccount({ ...draft, id: draft.id ?? '' }), { status: 201 })
    }),
    http.patch(ROUTES.account, async ({ params, request }) => {
      const draft = (await request.json()) as AccountDraft
      return HttpResponse.json(anAccount({ ...draft, id: String(params.id) }))
    }),
    http.delete(ROUTES.account, ({ params }) =>
      HttpResponse.json({ id: String(params.id), removed: true }),
    ),
    // The standing half of the reassignment (#725). The count it answers with
    // is the server's, and the block that asked reads the ledger again rather
    // than this number — one truth about how many events name what.
    http.post(ROUTES.accountReassignment, ({ params }) =>
      HttpResponse.json({ account: String(params.id), reassigned: 0 }),
    ),
    http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload())),
    http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload())),
    // The two perf series, of one shape at two levels (#721). They answer the
    // **whole** history whatever the window asked for, which is what the client
    // asks for: the longest range it offers is a `max` over the accounts'
    // openings, and only the series says when an account opened.
    http.get(ROUTES.accountHistory, ({ params }) =>
      HttpResponse.json(anAccountHistory(String(params.account))),
    ),
    http.get(ROUTES.portfolioTotalsHistory, () => HttpResponse.json(aPortfolioHistory())),
    // The dashboard's bottom (#727): the chart's fallback series and the
    // movers. Both are answered whole — the range control is a filter over a
    // series kept entire, there being no ladder on a daily one.
    http.get(ROUTES.positionsHistory, () => HttpResponse.json(aPositionsHistory())),
    http.get(ROUTES.movers, () => HttpResponse.json(aMoversPayload())),
    // The series answers for the **window it was asked for**, because the
    // resolution it announces is a function of that window (ADR-0010): a
    // handler serving one frozen payload would make the presets look like four
    // spellings of the same range.
    http.get(ROUTES.prices, ({ params, request }) => {
      const window = (new URL(request.url).searchParams.get('window') ?? '1Y') as ChartWindow
      return HttpResponse.json(aPriceSeries({ symbol: String(params.symbol), window }))
    }),
    http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime())),
    // What the status dot reads since #819 (ADR-0036). The default is a well
    // install; the amber this ticket exists for — a scrape frozen with a `200`
    // — is `aFrozenScrape()`, and the red is the route refusing at all.
    http.get(ROUTES.health, () => HttpResponse.json(aHealth())),
    http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload())),
    // The two writes echo the row back, which is the contract's own shape: the
    // id is the store's to decide, so a client cannot send one and the answer is
    // where it comes from.
    http.post(ROUTES.events, async ({ request }) => {
      const draft = (await request.json()) as EventDraft
      return HttpResponse.json(aTypedEvent({ id: 'created', ...draft }), { status: 201 })
    }),
    http.patch(ROUTES.event, async ({ params, request }) => {
      const draft = (await request.json()) as EventDraft
      return HttpResponse.json(aTypedEvent({ id: String(params.id), ...draft }))
    }),
    // The bulk removal (#814). It answers what **left**, which is the store's
    // to say — the front counted what the reduction retained before the click,
    // and the two are deliberately two. The default is a count of its own so a
    // test that does not care what came back cannot mistake it for the table's.
    http.delete(ROUTES.events, () => HttpResponse.json({ events_removed: 7 })),

    // The way in (#811): one file, one receipt. The receipt is the fixture's
    // and is not computed from what was sent — what a file holds is the
    // server's business, and a handler parsing a CSV would be a second
    // implementation of the loader living in the test harness.
    //
    // **The file itself does not survive this environment**, and that is worth
    // knowing before writing an assertion about it: jsdom builds the `File`,
    // undici serialises the body, and the two disagree — the part arrives named
    // `blob` and empty. What is observable here is the request the app made,
    // which is what these tests are about; what the server reads out of a real
    // multipart body is asserted on the Python side, over the real route.
    //
    // **The gesture is made twice** since #813, and this handler answers both
    // with the same object: `?dry_run=1` is the forecast, and it is a `200`
    // because nothing was created; the second call, with no parameter, is the
    // write and answers `201`. The receipt is the fixture's at both moments,
    // which is what *one object, two moments* means seen from a client.
    http.post(ROUTES.eventsImport, ({ request }) => {
      const previewing = new URL(request.url).searchParams.has('dry_run')
      return HttpResponse.json(aReceipt(), { status: previewing ? 200 : 201 })
    }),


    // The way back out (#710, #796). It is fetched by the client since the
    // receipt has to last as long as the operation, so it is a faked edge like
    // any other now — bytes, and the **name** the server states, which is what
    // tells a reduction from a backup.
    http.get(ROUTES.exportEvents, ({ request }) =>
      exported(new URL(request.url).search === '' ? 'events' : 'selection', 'csv'),
    ),
    http.get(ROUTES.exportEventsWorkbook, ({ request }) =>
      exported(new URL(request.url).search === '' ? 'events' : 'selection', 'xlsx'),
    ),

    // The installation tab (#724). The default install has one notice standing,
    // a store on a mount and no orphan — the ephemeral store and the orphan
    // list are what a test asks for by name, both being exactly what the block
    // exists to render.
    http.get(ROUTES.config, () => HttpResponse.json(aConfig())),
    http.get(ROUTES.installationFacts, () => HttpResponse.json([anInstallationFact()])),
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
    http.post(ROUTES.installationFactAcknowledgement, ({ params }) =>
      HttpResponse.json(
        anInstallationFact({
          key: String(params.key),
          acknowledged: true,
          acknowledged_at: '2026-03-02T12:00:00.000Z',
        }),
      ),
    ),
    http.delete(ROUTES.storeOrphans, () =>
      HttpResponse.json({ symbols: ['ZZX'], points_removed: 1204 }),
    ),
  ]
}

/**
 * One exported file as the server hands it over: bytes, and the name to save
 * them under. The body is a header alone — what the front does with it is save
 * it, and a fixture with rows in it would suggest an assertion nobody can make
 * about a file the browser owns.
 */
function exported(kind: 'events' | 'selection' | 'accounts', suffix: 'csv' | 'xlsx') {
  return new HttpResponse('date,event_type\n', {
    headers: {
      'Content-Type': suffix === 'csv' ? 'text/csv; charset=utf-8' : 'application/octet-stream',
      'Content-Disposition': `attachment; filename="suivi-bourse-${kind}.${suffix}"`,
    },
  })
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
