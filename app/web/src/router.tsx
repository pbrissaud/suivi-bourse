import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'

import { NotFound, Shell } from '@/components/Shell'
import AccountsPage from '@/pages/AccountsPage'
import DashboardPage from '@/pages/DashboardPage'
import SharesPage from '@/pages/SharesPage'

/**
 * The route tree, written by hand — **code-based**, not file-based.
 *
 * TanStack Router supports both, and the plugin's job in the file-based mode is
 * to *generate* `routeTree.gen.ts` from `src/routes/`. With four routes that
 * trade is the wrong way round: the tree below is shorter than the protocol a
 * generated file carries — gitignore, linter, formatter and the editor settings
 * the docs devote a section to — and this repo has just been bitten by exactly
 * that class of problem (`c87a0b1`, the front's `lib/` swallowed by the root
 * gitignore). It also keeps `vite.config.ts` untouched, so `rm -rf app/web`
 * still leaves nothing behind, which is what #655 means by a disposable front.
 *
 * What it gives up is `autoCodeSplitting`: the four page components ride in the
 * main bundle. They already share Recharts, TanStack Table and shadcn, so the
 * split would have moved little — and `lazyRouteComponent` does it per route,
 * without a plugin, the day it matters.
 *
 * The crossover is roughly ten routes. The map plans four.
 */

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: NotFound,
})

/** The consolidated dashboard is the index: it is the page that answers
 *  "how am I doing", which is the question the app is opened with. */
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
})

const sharesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/titres',
  component: SharesPage,
})

const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/comptes',
  component: AccountsPage,
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([dashboardRoute, sharesRoute, accountsRoute]),
  // Data fetching stays TanStack Query's (#655 déc. 3), so there are no route
  // loaders to preload — this only warms the component chunk on hover.
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
