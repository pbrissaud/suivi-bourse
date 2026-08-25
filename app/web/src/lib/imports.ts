/**
 * What there is to hand back out (#728, #796, ADR-0032, ADR-0034).
 *
 * **The rest of this module left with the sources** (#816). It held the order
 * imported files were listed in, what a revocation would take with it counted
 * before it was made, the refusal the server would answer, and which accounts
 * the gesture freed — an apparatus whose whole subject was *the source*, and
 * there is no source any more: a file is handed over once, parsed, and never
 * seen again, so nothing persists that could be listed or revoked. Undoing an
 * import is a deletion over the ledger's own reduction (`BulkDelete`), which
 * reaches the twelve rows somebody mistyped as well.
 *
 * What is left is the one question that was never about a source: **is there
 * anything to export**. It is asked of the events alone, and that is ADR-0034:
 * the declaration has no file, so *is there an accounts file worth offering*
 * has stopped being a question at all.
 */
import type { LedgerEvent } from '@/lib/api'

/**
 * What there is to hand back. **Total or nothing** as to the ledger: the
 * export's whole justification is the round trip (*« puis-je revenir en
 * arrière ? »*), and a partial file is not one while looking exactly like one —
 * which is why a reduction leaves under a name of its own.
 */
export function exportable(events: readonly LedgerEvent[]): { events: boolean } {
  return { events: events.length > 0 }
}
