/**
 * **A gesture the server refused**, in prose — what did not happen, and why
 * (#829, ADR-0037).
 *
 * It is what is left of `Band` once the band is gone, and the narrowing is the
 * decision rather than the rename. A *band* was a strip across the top of the
 * content column saying what was true of the whole installation; ADR-0037
 * retires it without replacement, and **there is no band anywhere**. Its three
 * conditions are entries of the notifications panel now, and the sentence they
 * carried descends one floor into each page's empty state.
 *
 * What is left has one subject and one place, and the rule is checkable on the
 * source:
 *
 *  - it answers **a write** — a declaration, a correction, a bulk delete, an
 *    import — and it is mounted **beside the control that made it**, inside the
 *    dialog or the block the reader is already looking at;
 *  - it is **never mounted for a read**. A read that did not answer is an
 *    absence, and an absence is said where the content would have been:
 *    `Unreadable`, which is an `EmptyState` and not an alert. A component that
 *    served both is how a page ended up empty at one end of the screen and
 *    explained at the other.
 *
 * It keeps `role="status"` rather than the primitive's default `alert`: the
 * reader is already looking at the control they pressed, and an assertive live
 * region interrupts a screen reader mid-sentence to say what it is about to
 * read out anyway.
 */
import type { ReactNode } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'

export function Refusal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Alert role="status" variant="destructive" className={className}>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
