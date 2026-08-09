import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient } from '@tanstack/react-query'

import { App } from '@/app'
import { createAppRouter } from '@/router'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 503 is the store being unreachable, which is transient by nature —
      // retry it. A 404 or a 400 is a contract error and retrying only delays
      // the message; `ApiProblem` carries the status, so the policy can tell
      // them apart instead of retrying everything three times.
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App router={createAppRouter()} queryClient={queryClient} />
  </StrictMode>,
)
