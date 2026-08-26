/**
 * A refusal, in prose — **what did not happen, and why** (#829, ADR-0037).
 *
 * It is what is left of `Band`, and the rename is the decision rather than a
 * tidy-up. A *band* was a strip across the top of the content column saying
 * what was true of the whole installation, and ADR-0037 retires it without
 * replacement: those conditions are entries of the notifications panel now, and
 * the sentence they carried descends one floor into each page's empty state.
 * **There is no band anywhere.**
 *
 * What the component was *also* used for has nowhere else to go, and it is one
 * thing said from two sides:
 *
 *  - a **gesture the server refused** — a declaration, a correction, a bulk
 *    delete — whose sentence is the answer to something the reader just did;
 *  - a **read that did not answer**, named by the page that asked for it,
 *    because a block rendering nothing turns *the store is unreadable* and *you
 *    own nothing yet* into the same empty screen.
 *
 * It keeps `role="status"` rather than the primitive's default `alert`: an
 * assertive live region interrupts a screen reader, and a store that will not
 * answer is a condition that *lasts* — it would interrupt on every navigation
 * for as long as it holds. A refusal answering a gesture is read where the
 * reader is already looking.
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
