/**
 * The receipt surface (#726). `sonner`'s toaster, mounted once by the app.
 *
 * Two things are ours rather than the library's defaults, and both are the
 * criterion rather than taste: the ground follows the app's own theme (three
 * states, ADR-0024) instead of sonner's own `system` read, and **no toast is
 * ever given an infinite duration** — a receipt that never leaves is a strip
 * covering the page, and what states a condition here is a card of the
 * notifications panel (#829, ADR-0037).
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
