/**
 * What the ⌘K palette offers, pure — in the taste of `lib/ledger.ts` (#797).
 *
 * The palette is five sections over three reads, and every rule about *what is
 * in a section* lives here rather than in the render: the titles are folded to
 * one entry per symbol, the events are the ledger's own search, and the
 * reduction an event leads to is built out of the ledger's own dimensions.
 *
 * **The three sections that read are optional** (ADR-0026): the palette opens
 * with its pages and its actions while all three are in flight, and a read that
 * has not landed **removes a section** instead of holding the surface. That is
 * one of the rare places `?? []` is legitimate, and it is annotated as such at
 * the three sites in `components/Palette.tsx`.
 */
import type { LedgerEvent, Position } from '@/lib/api'
import {
  accountOf,
  byDateDescending,
  filterEvents,
  fold,
  identityOf,
  NO_FILTERS,
  type LedgerFilters,
} from '@/lib/ledger'

/**
 * How many entries a section that reads may draw.
 *
 * A palette is a way through, not a table: what does not fit is one route away,
 * and a list long enough to scroll would make the keyboard the slower of the
 * two paths. The events are capped harder because they are the only section
 * whose population is unbounded — a ledger has hundreds of rows and three
 * accounts.
 */
export const SHARES_SHOWN = 5
export const ACCOUNTS_SHOWN = 5
export const EVENTS_SHOWN = 5

/**
 * The one matching rule, and it is the ledger's: accents folded, case dropped,
 * a substring rather than a prefix — a French label is searched as it is heard.
 * An empty query matches, which is what makes a section *what you own* before it
 * is *what you typed*.
 */
export function matchesQuery(query: string, texts: readonly (string | null | undefined)[]): boolean {
  const needle = fold(query.trim())
  if (needle === '') return true
  return texts.some((text) => text != null && fold(text).includes(needle))
}

/** A title, which is a **symbol** and not a line (`lib/shares.ts`'s own rule). */
export interface Title {
  symbol: string
  name: string | null
}

/**
 * The titles the owner holds, one entry per symbol.
 *
 * Two rules, and both are the shares page's: a row of that table is a symbol
 * across its accounts, so a security held on two of them is **one** entry here;
 * and a position sold out of is a row of the folded section — the palette
 * reaches what is held, and a closed line answers no question a reader types a
 * ticker to ask.
 */
export function heldTitles(positions: readonly Position[]): Title[] {
  const titles = new Map<string, Title>()
  for (const position of positions) {
    if (position.quantity <= 0) continue
    const known = titles.get(position.symbol)
    if (known === undefined) {
      titles.set(position.symbol, { symbol: position.symbol, name: position.name })
      continue
    }
    // The name is an attribute of the security and not of the line, so the
    // first non-empty one wins rather than the last account read.
    if (known.name === null && position.name !== null) known.name = position.name
  }
  return [...titles.values()]
}

export function titlesMatching(titles: readonly Title[], query: string): Title[] {
  return titles
    .filter((title) => matchesQuery(query, [title.symbol, title.name]))
    .slice(0, SHARES_SHOWN)
}

/**
 * An account, named as the reader sees it — the fold of `declaredLabel` is the
 * caller's, because the seeded row reads its name from the catalogue and a
 * catalogue is not a pure module's to hold.
 */
export interface NamedAccountEntry {
  id: string
  name: string
}

export function accountsMatching(
  accounts: readonly NamedAccountEntry[],
  query: string,
): NamedAccountEntry[] {
  return accounts
    // The id as well as the name: it is what the ledger's own column shows, and
    // what an address carries.
    .filter((account) => matchesQuery(query, [account.name, account.id]))
    .slice(0, ACCOUNTS_SHOWN)
}

/**
 * The events a query names — **the ledger's own search**, called rather than
 * spelled a second time (a rule written twice loses a branch, and this one
 * already reads the ticker, the label and the account with the accents folded).
 *
 * **Nothing at all until something is typed**: a section listing the newest five
 * events of a ledger nobody asked about is a table in a palette, and the ledger
 * itself is one entry above it.
 */
export function eventsMatching(events: readonly LedgerEvent[], query: string): LedgerEvent[] {
  if (query.trim() === '') return []
  return byDateDescending(filterEvents(events, { ...NO_FILTERS, query })).slice(0, EVENTS_SHOWN)
}

/**
 * The reduction an event result leads to — the event's **three coordinates**.
 *
 * Not the row itself, and that is a decision rather than an approximation: a
 * ledger row is identified by its position in a list the store sorted
 * (ADR-0020), an imported one carries no key at all, and a reduction that
 * pretended to hold one event would be an address the product refuses to give.
 * What the ledger can retain is what the ledger can *name* — a type, an account
 * and a word — so that is what the reduction says it retains, and it says it in
 * those terms.
 *
 * The three are also, and not by accident, three of the four parameters the
 * export resource parses (`selectionParams`): the address of a reduced ledger is
 * the query string of its own export.
 */
export function eventReduction(event: LedgerEvent): LedgerFilters {
  const identity = identityOf(event)
  return {
    ...NO_FILTERS,
    query: identity.ticker ?? identity.label ?? '',
    type: event.event_type,
    account: accountOf(event),
  }
}
