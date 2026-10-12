/**
 * The receipt surface (#726). `sonner`'s toaster, mounted once by the app.
 *
 * It carries one thing that is not a receipt: **the outage toast echoes the
 * bell** (#1180, `Notifications.tsx`) — the bell stays the one announcer of
 * the installation's state, and this surface only repeats its `unreachable`.
 */
import { Toaster as Sonner } from 'sonner'

import { useTheme } from '@/lib/theme'

export function Toaster() {
  const { ground } = useTheme()

  return (
    <Sonner
      theme={ground}
      position="bottom-right"
      // The colours are the app's tokens, so a receipt looks like the product
      // and not like the library.
      toastOptions={{
        classNames: {
          toast: 'bg-card text-card-foreground border border-border shadow-lg',
          description: 'text-muted-foreground',
        },
      }}
    />
  )
}
