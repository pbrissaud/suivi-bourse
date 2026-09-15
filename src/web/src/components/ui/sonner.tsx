/**
 * The receipt surface (#726). `sonner`'s toaster, mounted once by the app.
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
