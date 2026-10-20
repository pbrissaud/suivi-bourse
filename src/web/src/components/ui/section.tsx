import { createContext, useContext, useId, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * **A block of the page is a tinted plane, not a card** (DESIGN.md). The
 * `tint` ground, 18 px corners, no border, no shadow, no hover: it is not
 * interactive. Its first row reads like a line of a statement, the title on
 * the left and the section's own subtotal (or a meta line) on the right.
 *
 * A section never contains another one. Rows inside keep their own
 * separators, which the base rule already paints in the `rule` colour.
 *
 * **The section itself is never interactive.** The dashboard's edit mode puts
 * its drag handle (⠿) before the title and its card menu (⋯) at the end of
 * the title row through
 * {@link SectionControlsContext}: the frame the page lays around a card
 * provides it, so the blocks that render their own section change nothing,
 * and outside edit mode the context is empty and the row is what it was.
 */
export interface SectionFrame {
  /** The card menu, at the end of the title row. */
  controls: ReactNode
  /** The drag handle, before the title (desktop only). */
  leading?: ReactNode
  /**
   * The section fills its grid cell (a row's two cards end on the same line),
   * and its body is a column a block can push its last line to the bottom of.
   */
  fill: boolean
  /**
   * The body is frozen (`inert`) while the dashboard is being arranged: no
   * click in a card can leave the page and drop the draft (design review 8A).
   * The title row, and the menu in it, stay live.
   */
  inert: boolean
}

export const SectionControlsContext = createContext<SectionFrame | null>(null)

export function Section({
  title,
  aside,
  children,
  className,
  level = 2,
}: {
  /** Sentence case, rendered as the region's heading and its accessible name. */
  title: ReactNode
  /** The heading's level: `3` where the page already has an `<h2>` above the section. */
  level?: 2 | 3
  /** The subtotal or a meta line, on the title's row, right-aligned. */
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  const id = useId()
  const frame = useContext(SectionControlsContext)
  const Heading = level === 2 ? 'h2' : 'h3'
  const heading = (
    <Heading id={id} className="text-2xl font-semibold">
      {title}
    </Heading>
  )
  return (
    <section
      data-slot="section"
      aria-labelledby={id}
      className={cn(
        'rounded-section bg-muted px-6 py-5',
        frame?.fill && 'flex h-full flex-col',
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {frame?.leading ? (
          <div className="-ml-2 flex items-center gap-2">
            {frame.leading}
            {heading}
          </div>
        ) : (
          heading
        )}
        {frame?.controls ? (
          <div className="flex items-center gap-2 self-center">
            {aside}
            {frame.controls}
          </div>
        ) : (
          aside
        )}
      </div>
      <div
        className={cn('mt-3', frame?.fill && 'flex flex-1 flex-col')}
        inert={frame?.inert || undefined}
      >
        {children}
      </div>
    </section>
  )
}
