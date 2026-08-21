/**
 * The ledger's own rules, pure — in the taste of `lib/shares.ts` (#723,
 * ADR-0020, ADR-0005).
 *
 * Four things live here rather than in a component, and each is a decision the
 * page would otherwise re-take per cell:
 *
 *  - **which fields a type has.** The create form shows *only* the fields of the
 *    type chosen, and that list is also what a row renders — a `DEPOSIT` has no
 *    security at all, so its `Quantité`, `Prix unitaire` and `Titre` are not
 *    missing values but questions the event does not raise. Written twice, the
 *    copy would eventually let a quantity through on a transfer.
 *  - **the identity of a row.** Ticker first, label second, and the label alone
 *    on a cash movement (ADR-0020): one column doing the work for **both**
 *    families of event, in place of a `Symbole` column empty 105 times out of
 *    285 doubled by a truncated `Notes`.
 *  - **the reduction.** Full-text search is not a convenience here: on nineteen
 *    purchases of the same ETF the label is the only discriminant the row owns.
 *    It is also what pays for *no pagination* — filters and search reduce, and
 *    « page 4 sur 6 » means nothing on an axis of dates.
 *  - **the two parses.** `<input type="date">` silently discards what it cannot
 *    parse, and `<input type="number">` does exactly the same with a decimal
 *    comma; both hand back an empty string, which reads as *the user left it
 *    blank* one line later. Here a value that cannot be understood comes back
 *    `null` and the form **names** it, which is the whole of that criterion.
 */
import type { LedgerEvent, LedgerEventType } from '@/lib/api'

/**
 * What a type asks for. `unitPrice` is three-valued rather than a boolean
 * because a `GRANT`'s is the one field in the product whose **emptiness is a
 * statement**: left blank the award is a dilution (contribution and cost basis
 * both nil), filled it feeds the two together — which is what ADR-0016's second
 * bubble on this page exists to say, at the moment the reader is leaving it
 * blank.
 */
export interface FieldSet {
  security: boolean
  quantity: boolean
  unitPrice: 'required' | 'optional' | 'none'
  fee: boolean
  amount: boolean
}

export const FIELDS: Record<LedgerEventType, FieldSet> = {
  BUY: { security: true, quantity: true, unitPrice: 'required', fee: true, amount: false },
  SELL: { security: true, quantity: true, unitPrice: 'required', fee: true, amount: false },
  GRANT: { security: true, quantity: true, unitPrice: 'optional', fee: false, amount: false },
  DIVIDEND: { security: true, quantity: false, unitPrice: 'none', fee: true, amount: true },
  DEPOSIT: { security: false, quantity: false, unitPrice: 'none', fee: true, amount: true },
  WITHDRAWAL: { security: false, quantity: false, unitPrice: 'none', fee: true, amount: true },
}

/**
 * The identity column, for both families at once: the ticker in first rank and
 * the label in second when both exist, the label alone on a transfer.
 */
export interface Identity {
  ticker: string | null
  label: string | null
}

export function identityOf(event: LedgerEvent): Identity {
  return {
    ticker: event.symbol && event.symbol.trim() !== '' ? event.symbol : null,
    label: event.notes && event.notes.trim() !== '' ? event.notes : null,
  }
}

/**
 * **A blank account is `default`**, which is the aggregator's own rule and not a
 * rendering nicety: an install that has declared nothing writes its events under
 * a seeded row nobody named (ADR-0013), and the payload reports the blank it
 * resolved. Left blank on screen the column would read as *no account*, which is
 * a state the product declares impossible.
 */
export function accountOf(event: LedgerEvent): string {
  return event.account.trim() === '' ? 'default' : event.account
}

/**
 * A key for the render, and **not an address** — which is the whole of
 * ADR-0020. A row that has a key says so; the rest are identified by their
 * position in a list the store sorted, which is exactly as durable as the render
 * that consumes it and no more.
 */
export function rowKey(event: LedgerEvent, index: number): string {
  return event.id ?? `row-${index}`
}

/** Accents folded and case dropped: a French label is searched as it is heard. */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/** What the search reads — everything the identity and the account column show. */
function haystack(event: LedgerEvent): string {
  return fold([event.symbol, event.notes, accountOf(event)].filter(Boolean).join(' '))
}

export interface LedgerFilters {
  /** Free text. Empty is *no reduction*, never *no match*. */
  query: string
  /** `null` — every type. */
  type: LedgerEventType | null
  /** `null` — every account. */
  account: string | null
  /**
   * A **set** of securities, or `null` for every one of them (#724).
   *
   * It is a dimension of its own rather than a word in `query` because the
   * search is single-term — `haystack(event).includes(needle)` — so a notice
   * naming three symbols would have to drop two of them to be expressible
   * there, and a field showing `AAA` where the sentence above said
   * `(AAA, BBB, CCC)` reads as the whole subject. Nothing in the reduction bar
   * types into it: it arrives from a gesture and leaves by its own clear
   * button, which is what makes the reduction **nameable** on screen rather
   * than a table quietly shorter than it should be.
   *
   * A cash movement names no security at all, so a non-null set excludes every
   * one of them — which is what a notice about quoted lines means.
   */
  symbols: readonly string[] | null
}

export const NO_FILTERS: LedgerFilters = { query: '', type: null, account: null, symbols: null }

export function filterEvents(
  events: readonly LedgerEvent[],
  filters: LedgerFilters,
): LedgerEvent[] {
  const needle = fold(filters.query.trim())
  const symbols = filters.symbols === null ? null : new Set(filters.symbols)
  return events.filter((event) => {
    if (filters.type !== null && event.event_type !== filters.type) return false
    if (filters.account !== null && accountOf(event) !== filters.account) return false
    if (symbols !== null && (!event.symbol || !symbols.has(event.symbol))) return false
    if (needle === '') return true
    return haystack(event).includes(needle)
  })
}

/**
 * **Date descending, and there is no second ordering to offer.** A ledger is
 * opened to check what has just happened. The sort is **stable**, so two events
 * of one day keep the order the store handed them in — the aggregator sorted
 * them, and re-deciding here would make the ledger disagree with the replay that
 * produced the positions.
 */
export function byDateDescending(events: readonly LedgerEvent[]): LedgerEvent[] {
  return [...events].sort((left, right) => {
    const earlier = left.date ?? ''
    const later = right.date ?? ''
    if (earlier === later) return 0
    return earlier < later ? 1 : -1
  })
}

/** The accounts an install actually uses, in the order they first appear. */
export function accountsNamed(events: readonly LedgerEvent[]): string[] {
  return [...new Set(events.map(accountOf))]
}

/**
 * A row typed in the app is the only one the app may edit (ADR-0020) — and it
 * has to be **addressable** to be edited, which is the second half of the same
 * sentence. On an install that has only ever imported, this is false on every
 * row and the editor is therefore never rendered at all.
 */
export function isEditable(event: LedgerEvent): boolean {
  return event.source_id === null && typeof event.id === 'string'
}

/**
 * A calendar day, or `null` — and `null` is what the form **names** instead of
 * dropping. The shape alone does not settle it (`0000-00-00` matches it), so the
 * value is parsed and written back: a day that does not survive the round trip
 * is not a day, and saying so is the whole of that criterion.
 */
export function parseDay(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10) === value ? value : null
}

/**
 * A number, or `null`. The comma is accepted because the form is rendered in a
 * language whose readers type one, and the thin spaces a paste brings along are
 * dropped rather than refused.
 */
export function parseDecimal(value: string): number | null {
  const cleaned = value.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (cleaned === '') return null
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}
