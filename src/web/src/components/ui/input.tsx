import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Keeps password managers (1Password, LastPass, Bitwarden, generic) off a field:
 * nothing in this app is a login but the PIN screen, which says so with
 * `autoComplete="current-password"` and is then left alone.
 */
export function noPasswordManager(autoComplete?: string) {
  if (autoComplete === 'current-password') return {}
  return {
    autoComplete: 'off',
    'data-1p-ignore': true,
    'data-lpignore': 'true',
    'data-bwignore': true,
    'data-form-type': 'other',
  }
}

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      {...noPasswordManager(props.autoComplete)}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
