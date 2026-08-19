/**
 * The imports' own rules, pure — in the taste of `lib/ledger.ts` (#728,
 * ADR-0020, ADR-0015).
 *
 * **The unit of the gesture is the source, not the row.** That is the whole of
 * this module's subject, and it was decided against the interview by being
 * rendered: *« Oublier cet import (214) »* offered from a provenance cell gave
 * three consecutive rows carrying three identical red buttons, and somebody
 * deletes 214 events believing they are removing one. It is the padlock's rule
 * seen from the other end — what a row carries is **information**, never the
 * mass gesture attached to it.
 *
 * Four things live here rather than in the block, and each is a decision a
 * component would otherwise re-take per row:
 *
 *  - **the order**, accounts sources first. It is not a rendering choice:
 *    `event.account` references `account(id)`, so that is the order an import
 *    has to happen in, and the list shows the order the foreign key imposes.
 *  - **what a revocation takes with it, counted *before* it is made.** The box
 *    says *« Retire 214 événements, 8 symboles et 1 compte de la répartition »*,
 *    and every one of those three numbers is a difference between the ledger as
 *    it stands and the ledger without this source — never the size of the
 *    source, which would count a security two files name as leaving.
 *  - **the refusal the server will answer**, named in place of the gesture. An
 *    accounts source cannot be forgotten while an event names one of its
 *    accounts (`409`, #698, the cascade being refused rather than performed),
 *    and #729's rule applies unchanged: a control the app knows will be refused
 *    teaches nothing by being there, while the count is the exact thing the
 *    owner has to act on.
 *  - **which accounts the gesture frees.** Forgetting a source of *events* makes
 *    an account deletable **without touching it** — the box says so, and it is
 *    the one consequence a reader cannot foresee. It is read through
 *    `accounts.removalOf`, the same function the declaration block renders, so
 *    the two cannot come to disagree about what *deletable* means.
 */
import type { Account, AccountsResponse, ImportKind, ImportRecord, LedgerEvent } from '@/lib/api'
import { isDefaultAccount, removalOf } from '@/lib/accounts'
import { accountOf } from '@/lib/ledger'

/** Accounts sources first — the import order, not an alphabet. */
const KIND_RANK: Record<ImportKind, number> = { accounts: 0, events: 1 }

export function orderedImports(imports: readonly ImportRecord[]): ImportRecord[] {
  return [...imports].sort((left, right) => {
    const byKind = KIND_RANK[left.kind] - KIND_RANK[right.kind]
    if (byKind !== 0) return byKind
    return left.filename.localeCompare(right.filename)
  })
}

/**
 * What the gesture removes, in the three units a reader owns: rows, securities,
 * accounts. **Counted against what survives**, so a security another file also
 * names is not announced as leaving the allocation.
 */
export interface RevocationEffect {
  events: number
  symbols: number
  accounts: number
  /**
   * The accounts no surviving event names any more — the ticket's own
   * consequence, *forgetting a source of events changes the deletability of a
   * row it does not touch*. Empty is the ordinary answer, and the sentence goes
   * with it.
   */
  frees: string[]
}

export type Revocation =
  | { kind: 'offered'; effect: RevocationEffect }
  /** The refusal `accounts.delete_account` would answer, named before the click. */
  | { kind: 'namedByEvents'; count: number }

export function revocationOf(
  record: ImportRecord,
  events: readonly LedgerEvent[],
  payload: AccountsResponse,
): Revocation {
  const accounts = payload.accounts
  // **The seeded row is not a subject of any of this**, and the exclusion is
  // `accounts._retire`'s own, by name: `default` is never removed and never
  // refused — a file that declared it hands it back to the seed instead. Read
  // without the clause, a file that took it over is permanently unforgettable
  // from here, and on an install that declares nothing *every* event names it,
  // a blank account resolving to `default`. It is `removalOf`'s first branch,
  // and this module has to make the same test rather than inherit it.
  const declared = accounts.filter(
    (account) => (account.source_id ?? null) === record.id && !isDefaultAccount(account.id),
  )

  // The cascade is refused and never performed: the gesture is meant to be
  // undone by dropping the file again, and one that deleted a year of events on
  // the way out would not be. The order to follow is readable from the count —
  // forget the event imports first.
  const held = events.filter((event) => declared.some((account) => account.id === accountOf(event)))
  if (held.length > 0) return { kind: 'namedByEvents', count: held.length }

  return { kind: 'offered', effect: effectOf(record, events, accounts, declared) }
}

function effectOf(
  record: ImportRecord,
  events: readonly LedgerEvent[],
  accounts: readonly Account[],
  declared: readonly Account[],
): RevocationEffect {
  const removed = events.filter((event) => event.source_id === record.id)
  const surviving = events.filter((event) => event.source_id !== record.id)

  const survivingSymbols = new Set(surviving.map((event) => event.symbol).filter(Boolean))
  const survivingAccounts = new Set(surviving.map(accountOf))

  const symbols = new Set(
    removed
      .map((event) => event.symbol)
      .filter((symbol): symbol is string => Boolean(symbol) && !survivingSymbols.has(symbol)),
  )
  // An account leaves the allocation on either of two grounds — nothing names it
  // any more, or the file that declared it is what is being forgotten — and the
  // two are folded into one set rather than added, since a declared account an
  // event names never reaches here at all.
  const leaving = new Set<string>(declared.map((account) => account.id))
  for (const event of removed) {
    const id = accountOf(event)
    // `default` is seeded and never removed (ADR-0013), so announcing it as
    // leaving the allocation is a statement about a row that stays — and on a
    // single-account install it is the only row there is.
    if (!survivingAccounts.has(id) && !isDefaultAccount(id)) leaving.add(id)
  }

  return {
    events: removed.length,
    symbols: symbols.size,
    accounts: leaving.size,
    frees: freed(accounts, events, surviving),
  }
}

/**
 * The accounts whose blocker this gesture lifts, read through the declaration's
 * own classification rather than through a count of its own — so *what blocks a
 * removal* is one rule and not two.
 *
 * The predicate is **the events stop naming it**, and not *it becomes deletable
 * in one click*: the ticket's own example is an account a **second** file
 * declares, which is `fromFile` afterwards and removable by forgetting that
 * second import. Both readings are the same fact — this gesture changed the
 * deletability of a row it does not touch — and the narrower one would say
 * nothing about the exact case the criterion was written on. The seeded row is
 * excluded for free: it is `seeded` before and after, never `namedByEvents`.
 */
function freed(
  accounts: readonly Account[],
  before: readonly LedgerEvent[],
  after: readonly LedgerEvent[],
): string[] {
  return accounts
    .filter((account) => {
      const named = before.filter((event) => accountOf(event) === account.id).length
      const left = after.filter((event) => accountOf(event) === account.id).length
      return (
        removalOf(account, named).kind === 'namedByEvents' &&
        removalOf(account, left).kind !== 'namedByEvents'
      )
    })
    .map((account) => account.id)
}

export interface ImportRow {
  record: ImportRecord
  revocation: Revocation
}

/**
 * The list, each source with what forgetting it would do.
 *
 * `null` is *the read has not landed* on **either** of the two, and it answers
 * `[]` — the list is withheld rather than stating *you have imported nothing*,
 * which is a claim about the reader's own data (ADR-0026).
 *
 * The declaration is one of those two and it is **needed**, not optional: it is
 * what the verdict rests on. Read as *nothing is declared*, a source whose
 * accounts an event holds offers the gesture the server answers a `409` to, and
 * its box states *« Retire 0 compte déclaré »* — both said on a silence. And no
 * net can catch it, the same words being on screen once the read lands.
 */
export function importRows(
  imports: readonly ImportRecord[] | null,
  events: readonly LedgerEvent[],
  accounts: AccountsResponse | null,
): ImportRow[] {
  if (accounts === null) return []
  return orderedImports(imports ?? []).map((record) => ({
    record,
    revocation: revocationOf(record, events, accounts),
  }))
}

/**
 * What there is to hand back, per file. **Total or nothing**: there is no
 * option here and above all no export of the current reduction — the export's
 * whole justification is the round trip (*« puis-je revenir en arrière ? »*),
 * and a partial file is not one while looking exactly like one.
 *
 * The accounts file is offered only where something is **declared**: the seeded
 * row is not a declaration (ADR-0013), so on that install the file is a header
 * with no rows under it — and v4's loader refuses the whole directory over it,
 * which is the one trip this export exists to make possible.
 */
export function exportable(
  events: readonly LedgerEvent[],
  accounts: AccountsResponse | null,
): { events: boolean; accounts: boolean } {
  return { events: events.length > 0, accounts: accounts?.declared === true }
}
