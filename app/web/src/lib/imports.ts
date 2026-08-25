/**
 * What there is to hand back out, per file (#728, #796, ADR-0032).
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
 * anything to export**.
 */
import type { AccountsResponse, LedgerEvent } from '@/lib/api'

/**
 * What there is to hand back, per file. **Total or nothing**: there is no
 * option here and above all no export of the current reduction — the export's
 * whole justification is the round trip (*« puis-je revenir en arrière ? »*),
 * and a partial file is not one while looking exactly like one.
 *
 * The accounts file is offered only where something is **declared**: the seeded
 * row is not a declaration (ADR-0013), so on that install the file is a header
 * with no rows under it.
 */
export function exportable(
  events: readonly LedgerEvent[],
  accounts: AccountsResponse | null,
): { events: boolean; accounts: boolean } {
  return { events: events.length > 0, accounts: accounts?.declared === true }
}
