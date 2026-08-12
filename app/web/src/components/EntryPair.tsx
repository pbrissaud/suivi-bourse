/**
 * The two ways in, at **equal weight** — the fourth shared primitive, and the
 * only one that exists to be mounted twice on purpose (#723, #726, ADR-0005).
 *
 * It replaces the shape everything else on this page refuses: an empty table
 * with a small button over it. That arrangement states an order of preference
 * the product does not have — dropping a broker export and typing a first
 * purchase are two entrances to the same room, and the second one *is* the
 * product's onboarding since manual mode died (ADR-0005: typing a position means
 * creating dated events).
 *
 * Three properties are the component rather than its usage:
 *
 *  - **no primary action.** A filled button beside an outlined one is a
 *    recommendation, and the recommendation would be wrong for whichever reader
 *    it is not addressed to.
 *  - **an unavailable entry keeps its place and says why**, instead of
 *    disappearing. A pair that renders as one entry reads as a breakage, and the
 *    reader cannot tell a missing drop folder (ADR-0015: the bind is optional)
 *    from a product that never offered the file route at all.
 *  - **it is not an `EmptyState`.** That primitive says *this is empty* in one
 *    sentence with at most one way out; here emptiness is not the news — the two
 *    ways out are.
 *
 * The first-run modal's last step is this component, mounted as it is (#726).
 * That is why it lives beside `Stat`, `EmptyState` and `Band` rather than under
 * `components/data/`: a second design of it is exactly what the criterion
 * forbids.
 */
import type { ReactNode } from 'react'

export interface Entry {
  title: string
  body: string
  /** What the reader does. Absent where the entry is an instruction. */
  action?: ReactNode
  /** Present when this way in cannot be taken — the sentence says why. */
  unavailable?: string
}

export interface EntryPairProps {
  /** Two, and the type says so: a pair with one entry is not this component. */
  entries: readonly [Entry, Entry]
}

export function EntryPair({ entries }: EntryPairProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {entries.map((entry) => (
        <section
          key={entry.title}
          aria-label={entry.title}
          className="flex flex-col gap-3 rounded-lg border p-6"
        >
          <h3 className="font-medium">{entry.title}</h3>
          <p className="text-sm text-muted-foreground">{entry.body}</p>
          {entry.unavailable ? (
            <p className="mt-auto text-sm text-attention">{entry.unavailable}</p>
          ) : (
            entry.action && <div className="mt-auto">{entry.action}</div>
          )}
        </section>
      ))}
    </div>
  )
}
