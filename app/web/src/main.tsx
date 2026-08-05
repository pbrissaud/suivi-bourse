import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { router } from '@/router'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 503 is the storage being unreachable, which is transient by nature —
      // retry it. A 404 or 400 is a contract error and retrying only delays the
      // message; the ApiProblem carries the status, so the policy can tell them
      // apart instead of retrying everything three times.
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status
        if (status !== undefined && status < 500) return false
        return failureCount < 2
      },
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

// Query outside Router: the router carries no loaders (#655 déc. 3 gave data
// fetching to Query), so nothing in the route tree needs the client in its
// context — the components reach it through the provider like any other hook.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
