/**
 * The app, providers included — one component, so the browser entry and the
 * test harness mount **the same thing**.
 *
 * That is the whole shape of the seam (#712 Testing Decisions): the real
 * router, the real pages, the real catalogues, the real theme, a real
 * `QueryClient`, and HTTP as the only faked edge. A harness that assembled its
 * own provider stack would be testing an app nobody runs.
 */
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { I18nProvider } from '@/lib/i18n'
import { ThemeProvider } from '@/lib/theme'
import type { createAppRouter } from '@/router'

export function App({
  router,
  queryClient,
}: {
  router: ReturnType<typeof createAppRouter>
  queryClient: QueryClient
}) {
  return (
    <ThemeProvider>
      <I18nProvider>
        {/* Query outside Router: the router carries no loaders, so nothing in
            the route tree needs the client in its context — components reach it
            through the provider like any other hook. */}
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
