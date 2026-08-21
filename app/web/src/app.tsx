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

import { Toaster } from '@/components/ui/sonner'
import { DensityProvider } from '@/lib/density'
import { I18nProvider } from '@/lib/i18n'
import { PageHeadingProvider } from '@/lib/pageHeading'
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
        {/* The reader's third preference, in the same shape as the two ADR-0024
            decided (#789) — three keys in the browser, no dial in the store. */}
        <DensityProvider>
          {/* Query outside Router: the router carries no loaders, so nothing in
              the route tree needs the client in its context — components reach it
              through the provider like any other hook. */}
          <QueryClientProvider client={queryClient}>
            {/* Above the router, because the shell's header draws what the page
                under it declares: the title is the header's now (#789). */}
            <PageHeadingProvider>
              <RouterProvider router={router} />
            </PageHeadingProvider>
            {/* The receipt surface (#726). One mount for the app: a receipt
                acknowledges a gesture, and a gesture can be made from any page. */}
            <Toaster />
          </QueryClientProvider>
        </DensityProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}
