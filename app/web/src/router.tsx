import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import type { RouterHistory } from '@tanstack/react-router'

import { NotFound } from '@/components/NotFound'
import { Shell } from '@/components/Shell'
import { validateLedgerSearch, type LedgerSearch } from '@/lib/ledger'
import AccountsPage from '@/pages/AccountsPage'
import DashboardPage from '@/pages/DashboardPage'
import DataPage from '@/pages/DataPage'
import SharesPage from '@/pages/SharesPage'

/**
 * The route tree, written by hand — **code-based**, not file-based.
 *
 * TanStack Router supports both, and the plugin's job in the file-based mode is
 * to *generate* `routeTree.gen.ts` from `src/routes/`. With four routes that
 * trade is the wrong way round: the tree below is shorter than the protocol a
 * generated file carries — gitignore, linter, formatter and the editor settings
 * the docs devote a section to — and this repo has been bitten by exactly that
 * class of problem (`c87a0b1`, the front's `lib/` swallowed by the root
 * gitignore). The crossover is roughly ten routes; the map plans four.
 *
 * The four paths do not move: `/`, `/titres`, `/comptes`, `/donnees`, and all
 * four are in the navigation at every N — the accounts page used to leave it at
 * one account, and ADR-0028 removed the argument by making that page a reading
 * of *one* account rather than a comparison. And `/` is the dashboard
 * **unconditionally**: a redirect while the ledger is empty would make it the
 * one route in the product whose behaviour depends on the data.
 */

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: NotFound,
})

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
})

/**
 * The first route that reads a search parameter (#722).
 *
 * `?compte=` is the reduction an account's panel leads to, and it lives in the
 * **URL** rather than in a state the link would have to carry: it survives a
 * reload, it can be handed to somebody else, and the way out of it is the
 * browser's own back button as much as the bar the page draws. It is validated
 * rather than read raw — a blank one is *no reduction* and never a filter onto
 * an account named by the empty string.
 */
const sharesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/titres',
  component: SharesPage,
  validateSearch: (search: Record<string, unknown>): { compte?: string; titre?: string } => {
    const account = typeof search.compte === 'string' ? search.compte.trim() : ''
    // **And `?titre=`, since #797**: the ⌘K palette reaches a held security from
    // any of the four routes, and a sheet opened by a state no link can carry is
    // a place nothing outside this page can lead to. It is the same clause as
    // the reduction above, one object down — validated, a blank one being *no
    // sheet* — and a symbol naming no row of the table simply opens nothing,
    // there being no first security to fall back to the way there is a first
    // declared account.
    const symbol = typeof search.titre === 'string' ? search.titre.trim() : ''
    return {
      ...(account === '' ? {} : { compte: account }),
      ...(symbol === '' ? {} : { titre: symbol }),
    }
  },
})

/**
 * The second route that reads a search parameter (ADR-0028).
 *
 * `?compte=` is **which account the detail is about** — the master-detail's own
 * selection, in the URL for the reasons the shares page's reduction is: it
 * survives a reload, it can be handed to somebody else, and the way back is the
 * browser's own button. Validated rather than read raw, and an id naming no
 * declared account falls back to the first one rather than to an empty page.
 */
const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/comptes',
  component: AccountsPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { compte?: string; ouvrir?: 'compte' } => {
    const account = typeof search.compte === 'string' ? search.compte.trim() : ''
    return {
      ...(account === '' ? {} : { compte: account }),
      // **A gesture, not an address** (#797): the palette's *declare an account*
      // has to open the declaration, or it is a page entry wearing an action's
      // name. The page spends it on arrival — nothing of it survives a reload,
      // which is exactly what tells it from the reduction beside it.
      ...(search.ouvrir === 'compte' ? { ouvrir: 'compte' as const } : {}),
    }
  },
})

/**
 * The third route that reads a search parameter, and the first whose parameters
 * are a **reduction** (#797).
 *
 * `q`, `type` and `account` are the ledger's own dimensions under the names the
 * export resource already parses (`lib/ledger.ts`): the address of a reduced
 * ledger is the query string of its own export, which is what an event result in
 * the ⌘K palette leads to. `ouvrir` is the other species — a gesture, spent on
 * arrival — and the two live side by side here because they arrive by the same
 * door and leave by two.
 */
const dataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/donnees',
  component: DataPage,
  validateSearch: (search: Record<string, unknown>): LedgerSearch & { ouvrir?: 'evenement' } => ({
    ...validateLedgerSearch(search),
    ...(search.ouvrir === 'evenement' ? { ouvrir: 'evenement' as const } : {}),
  }),
})

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  sharesRoute,
  accountsRoute,
  dataRoute,
])

/**
 * One router per mount, and the history is an argument — which is the whole
 * reason this is a factory rather than a module-level constant. A page test
 * mounts the *real* tree on a memory history at the URL under test; the browser
 * passes nothing and gets its own.
 */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    // Data fetching stays TanStack Query's, so there are no route loaders to
    // preload — this only warms the component chunk on hover.
    defaultPreload: 'intent',
    scrollRestoration: true,
    ...(history ? { history } : {}),
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
