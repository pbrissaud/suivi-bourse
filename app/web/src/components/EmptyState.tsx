/**
 * The empty state — **one**, where the prototype had eight written by hand,
 * `<Alert>` by `<Alert>`, with no shared component anywhere.
 *
 * Eight copies is eight chances to say *nothing here* in eight registers, and
 * it is how *the database is unreachable* and *you own nothing yet* ended up
 * looking alike. Here they cannot: this component says a thing is **empty**,
 * and a failure is the banner's job, one band or none.
 *
 * It is deliberately **not** `role="status"`. A live region announces a change,
 * and an empty section is a state the page is simply in; giving it one would
 * also put a second `status` on a page whose banner already owns that role.
 *
 * It carries a `data-empty` attribute for the same reason it carries no role:
 * the marker is for **a test**, not for a reader (ADR-0026). Every page is
 * replayed with one of its reads left unresolved and the assertion is that no
 * such marker appears — *empty* being a claim about the reader's own data, and
 * never one to make on a request still in flight. An attribute is what says
 * that to a query selector without saying anything to a screen reader.
 *
 * It arrives here because the dashboard is the first surface that needs it, and
 * it replaces the eight hard-written ones **as the pages land**, one ticket at
 * a time — never in a sweep across pages that are being rewritten anyway.
 */
import type { ReactNode } from 'react'

export interface EmptyStateProps {
  title: string
  /** Why it is empty, when the reason is not obvious from the title. */
  description?: string
  /** The one way out, when there is one. Never two of equal weight here. */
  action?: ReactNode
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div data-empty className="rounded-lg border border-dashed px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {description ? (
        <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}
