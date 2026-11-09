import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/utils'

/**
 * **The buttons of « Relevé »** (DESIGN.md › Components).
 *
 * Two heights: a **page** button is 32 px, 13/500, padding 0 12 (the default and
 * `sm`); a **sheet** button — in a side panel, a dialog or the first run — is
 * 36 px, 14/500, padding 0 14 (`size="sheet"`). Outline is the default: every
 * secondary action is `border`, transparent. **One `primary` (filled ink) per
 * screen** — `lint/one-primary-per-page.grit` counts them on a page — and
 * `destructive` filled only in a destructive dialog, where it replaces the ink.
 * `ghost` is not a page variant any more: it survives for the vendored
 * components (`sidebar`, `attachment`) only.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        outline:
          'border bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'border border-destructive bg-destructive text-primary-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-foreground underline underline-offset-4',
      },
      size: {
        default: 'h-8 px-3 text-sm has-[>svg]:px-2.5',
        sm: 'h-8 px-3 text-sm has-[>svg]:px-2.5',
        sheet: 'h-9 px-3.5 text-md has-[>svg]:px-3',
        icon: 'size-8 text-sm',
        'icon-sm': 'size-7 text-sm',
        'icon-xs': "size-6 text-xs [&_svg:not([class*='size-'])]:size-3",
      },
    },
    defaultVariants: {
      variant: 'outline',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'outline',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
