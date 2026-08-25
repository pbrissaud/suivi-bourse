/**
 * **A read in flight is not an absence** (#775, ADR-0026), attested once for
 * the whole front rather than block by block.
 *
 * The rule was stated at #718 and restated six times in six spellings, each
 * with the same sentence recopied in a comment beside it — and four blocks
 * written in between missed it. The cause is mechanical: nothing made it true
 * by construction, and **no test exercised it**, every block test doing
 * `waitFor` on the value it expects and therefore stepping straight over the
 * one state this file is about.
 *
 * Three things about the shape are decisions:
 *
 *  - **It is driven by the routes, not by the blocks.** For each surface the
 *    routes it actually requests are recorded off the MSW lifecycle, then
 *    replayed one at a time with that single read left unresolved. A fifth
 *    block reading a route already served is covered the day it is written, by
 *    nobody's discipline — which is the whole point, the four occurrences this
 *    ticket closes having been written by four authors who each held the rule
 *    in the block next door.
 *  - **It fails when a route of `lib/api.ts`'s own table is visited by no
 *    surface.** Without that half, a request armed under a condition that is
 *    false by default (`enabled:`) leaves the net in silence — which is exactly
 *    what `/api/portfolio/movers` and `/api/positions/history` are, and the
 *    first of the two is occurrence 1.
 *  - **What it observes is the emptiness primitives** — `EmptyState` and
 *    `EntryPair`, marked by a `data-empty` attribute rather than by a role: an
 *    empty state is a state and not a change to announce, and the banner
 *    already owns `status` on the page — **and, since #777, every phrase
 *    carrying a word**, which is an amendment to ADR-0026 rather than a detail
 *    of this file: a sentence composed out of the absence of a value is a claim
 *    about the reader's own data that no marker could carry. Bare figures stay
 *    out (see {@link phrases}), and totals and counting sentences stay in the
 *    block's own test — they are too bound to the block's meaning to be read
 *    from outside — so #722's fourth term and the account panel's curve are
 *    asserted in `accountSheet.test.tsx`, where their figures are.
 *
 * The comparison is against a **baseline**: whatever the surface says when
 * every read has landed. An empty state that is already true of the fixture is
 * not this ticket's subject; one that appears *because* a read has not answered
 * is.
 */
import { cleanup, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { READ_ROUTES, ROUTES } from '@/lib/api'
import { aTotals, aTotalsPayload } from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

// ------------------------------------------------------------------------- //
// Reading the wire
// ------------------------------------------------------------------------- //

/** A route pattern (`/api/prices/:symbol`) as a matcher on a pathname. */
function matcherFor(route: string): RegExp {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/:[A-Za-z_]+/g, '[^/]+')}$`)
}

const MATCHERS = READ_ROUTES.map((route) => [route, matcherFor(route)] as const)

/** Which declared route this request is one of, or `null` for a write. */
function routeOf(url: string): string | null {
  const { pathname } = new URL(url)
  return MATCHERS.find(([, matcher]) => matcher.test(pathname))?.[0] ?? null
}

/**
 * The wire's own clock. `Date` is frozen by the harness (every dated figure in
 * this product is a function of it), so quiescence is measured on
 * `performance.now()`, which is not.
 */
let lastActivity = 0

/** Wait until nothing has crossed the wire for a moment — landed or hanging. */
async function quiet() {
  await waitFor(() => expect(performance.now() - lastActivity).toBeGreaterThan(60), {
    timeout: 5_000,
    interval: 20,
  })
}

/**
 * **Every phrase the surface renders that carries a word** (#777).
 *
 * This is the amendment, and it is one: the net observed the emptiness
 * primitives and nothing else, and *« Rien n’a encore été importé »* is neither
 * — it is a sentence, chosen from the absence of a value, asserting something
 * about the reader's own ledger. Nothing in `data-empty` could ever see it.
 *
 * What makes the wider reading tractable is a property the product already
 * has: **a block that waits renders nothing at all**, so what is on screen
 * while a read hangs is a *subset* of what is on screen once it lands. A
 * phrase that appears **only** in flight is therefore, by construction, said on
 * a silence.
 *
 * **A bare figure is deliberately not one of them**, and the exclusion is
 * measured rather than defensive: `/api/portfolio-totals` carries the reporting
 * currency, so with that one read hanging every amount on the ledger and in the
 * account panel renders as `1 300,00` where it landed as `1 300,00 €` — a unit
 * that follows another read, which is #773's rule and another ticket's
 * subject, not a statement composed out of an absence. A sentence carries
 * words; that is the whole of the filter.
 */
function phrases(): string[] {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const seen = new Set<string>()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim()
    if (text && /\p{L}/u.test(text)) seen.add(text)
  }
  return Array.from(seen).sort()
}

/** What the surface currently says is **empty**, by the text it says it with. */
function emptyMarkers(): string[] {
  return Array.from(document.querySelectorAll('[data-empty]'))
    .map((node) => (node.textContent ?? '').trim())
    .sort()
}

// ------------------------------------------------------------------------- //
// The surfaces, and what a reader does on them
// ------------------------------------------------------------------------- //

type View = ReturnType<typeof renderApp>

interface Surface {
  name: string
  url: string
  /** The page's own title, which every surface renders whatever it has read. */
  heading: string
  /** Payloads this surface needs to reach the state under test. */
  handlers?: () => void
  /** What the reader does once the page is up — a panel, a tab, a sheet. */
  open?: (view: View) => Promise<unknown>
}

/**
 * Seven surfaces for four pages: two are a reader's gesture away — the share's
 * sheet and the data page's two other tabs — and two more are a state of the
 * dashboard, whose chart reads **one** of two series and picks by the same
 * discriminant that decides its reading. Without the second the valuation
 * series is armed under a condition false by default and never enters the net.
 *
 * The notices tab is here for a reason the others are not: it is the one block
 * in the product that exists when it is empty (ADR-0030), so it is the one
 * whose *empty* sentence a read in flight could produce out of nothing. The tab
 * stays mounted; the sentence waits.
 */
const SURFACES: readonly Surface[] = [
  { name: 'le tableau de bord', url: '/', heading: 'Tableau de bord' },
  {
    name: 'le tableau de bord sans grand livre de liquidités',
    url: '/',
    heading: 'Tableau de bord',
    handlers: () =>
      server.use(
        http.get(ROUTES.portfolioTotals, () =>
          HttpResponse.json(
            aTotalsPayload(
              aTotals({
                total_value: null,
                cash_balance: null,
                net_contributed: null,
                twr_index: null,
                xirr: null,
              }),
            ),
          ),
        ),
      ),
  },
  {
    name: 'les titres, une fiche ouverte',
    url: '/titres',
    heading: 'Titres',
    open: async ({ user }) => {
      const title = await screen.findByRole('button', { name: 'Zeta Alpha' })
      await user.click(title)
      return screen.findByRole('dialog')
    },
  },
  // Since ADR-0028 the account's detail is the page rather than a panel a
  // gesture away, so the six reads it makes are on the mount: there is nothing
  // left to open.
  { name: 'les comptes', url: '/comptes', heading: 'Comptes' },
  { name: 'les données · le grand livre', url: '/donnees', heading: 'Données' },
  {
    name: 'les données · les notices',
    url: '/donnees',
    heading: 'Données',
    open: async ({ user }) => {
      await user.click(await screen.findByRole('tab', { name: /Les notices/ }))
      return screen.findByRole('heading', { name: 'Faits d’installation' })
    },
  },
  {
    // The palette is the one surface whose sections are **optional** (#797): an
    // absent read removes one instead of holding the whole of it, which is a
    // property this net reads the right way round — what disappears is not a
    // claim, and what must never appear is the sentence about nothing matching.
    // The query is one that reaches all three sections, so all three are in the
    // baseline and each one's read can be seen to take its own away.
    name: 'la palette ⌘K, une recherche tapée',
    url: '/',
    heading: 'Tableau de bord',
    open: async ({ user }) => {
      await user.click(await screen.findByRole('button', { name: /^Rechercher/ }))
      const field = await screen.findByRole('searchbox', {
        name: 'Rechercher dans votre portefeuille',
      })
      await user.type(field, 'alpha')
      return field
    },
  },
  {
    name: 'les données · l’installation',
    url: '/donnees',
    heading: 'Données',
    open: async ({ user }) => {
      await user.click(await screen.findByRole('tab', { name: /L’installation/ }))
      return screen.findByRole('heading', { name: 'Le magasin' })
    },
  },
]

// ------------------------------------------------------------------------- //
// The net
// ------------------------------------------------------------------------- //

/** Every route any surface was seen to read — the coverage half of the rule. */
const visited = new Set<string>()
/** What the pass currently running has read, in the order it asked for it. */
let recording = new Set<string>()

/** The handlers this surface needs, and nothing left over from the last pass. */
function stage(surface: Surface): void {
  server.resetHandlers()
  surface.handlers?.()
}

beforeAll(() => {
  server.events.on('request:start', ({ request }) => {
    lastActivity = performance.now()
    const route = routeOf(request.url)
    if (route === null) return
    visited.add(route)
    recording.add(route)
  })
  server.events.on('request:end', () => {
    lastActivity = performance.now()
  })
})

beforeEach(() => {
  lastActivity = performance.now()
})

afterEach(() => {
  cleanup()
})

describe('a read that has not landed is never rendered as an absence', () => {
  for (const surface of SURFACES) {
    it(
      `${surface.name} says nothing about what it has not read`,
      async () => {
        // 1. What this surface reads, and what it says when everything answers.
        stage(surface)
        recording = new Set()
        const view = renderApp({ url: surface.url })
        await screen.findByRole('heading', { level: 1, name: surface.heading })
        await surface.open?.(view)
        await quiet()

        const baseline = emptyMarkers()
        const said = phrases()
        const requested = Array.from(recording)
        cleanup()

        // 2. The same surface, one read at a time left in flight for ever.
        for (const route of requested) {
          stage(surface)
          server.use(http.get(route, () => new Promise<never>(() => {})))
          const replay = renderApp({ url: surface.url })
          await screen
            .findByRole('heading', { level: 1, name: surface.heading })
            .catch(() => null)
          // The gesture may not be available at all — a table that has not
          // rendered has no row to click — and that is an ordinary outcome
          // here: what is asserted is an absence either way.
          await surface.open?.(replay).catch(() => null)
          await quiet()

          const appeared = emptyMarkers().filter((marker) => !baseline.includes(marker))
          expect(
            appeared,
            `${surface.name} declares something empty while ${route} is in flight`,
          ).toEqual([])
          const invented = phrases().filter((phrase) => !said.includes(phrase))
          expect(
            invented,
            `${surface.name} says something it has not read while ${route} is in flight`,
          ).toEqual([])
          cleanup()
        }

        // Every surface reads something, or the loop above asserted nothing.
        expect(requested.length).toBeGreaterThan(0)
      },
      60_000,
    )
  }

  it('leaves no declared route unvisited', () => {
    // The other half of the rule: a route armed under a condition false by
    // default (`enabled:`) would otherwise never be exercised, and it is
    // precisely those two — the movers and the valuation series — that carried
    // this ticket's first occurrence. `READ_ROUTES` is computed from `ROUTES`
    // rather than written down here, so a route added tomorrow joins the net
    // without a line of this file moving.
    expect(READ_ROUTES.filter((route) => !visited.has(route))).toEqual([])
  })
})
