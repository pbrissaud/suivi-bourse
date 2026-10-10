import { useId, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * **A block of the page is a tinted plane, not a card** (DESIGN.md). The
 * `tint` ground, 18 px corners, no border, no shadow, no hover: it is not
 * interactive. Its first row reads like a line of a statement, the title on
 * the left and the section's own subtotal (or a meta line) on the right.
 *
 * A section never contains another one: a long page is a sequence of
 * sections, not a grid of tiles. Rows inside keep their own separators, which
 * the base rule already paints in the `rule` colour.
 */
export function Section({
  title,
  aside,
  children,
  className,
}: {
  /** Sentence case, rendered as the region's `<h2>` and its accessible name. */
  title: ReactNode
  /** The subtotal or a meta line, on the title's row, right-aligned. */
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <section
      data-slot="section"
      aria-labelledby={id}
      className={cn('rounded-section bg-muted px-6 py-5', className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="text-2xl font-semibold">
          {title}
        </h2>
        {aside}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}
