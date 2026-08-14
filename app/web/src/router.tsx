import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import type { RouterHistory } from '@tanstack/react-router'

import { NotFound } from '@/components/NotFound'
import { Shell } from '@/components/Shell'
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
 * The four paths do not move: `/`, `/titres`, `/comptes`, `/donnees`. The
 * accounts page leaves the **navigation** at N = 1 and never the **route** — a
 * 404 on a bookmark that was valid yesterday costs for nothing. And `/` is the
 * dashboard **unconditionally**: a redirect while the ledger is empty would make
 * it the one route in the product whose behaviour depends on the data.
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
 * The one route that reads a search parameter (#722).
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
  validateSearch: (search: Record<string, unknown>): { compte?: string } => {
    const account = typeof search.compte === 'string' ? search.compte.trim() : ''
    return account === '' ? {} : { compte: account }
  },
})

const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/comptes',
  component: AccountsPage,
})

const dataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/donnees',
  component: DataPage,
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
