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
 *    It is also why *« page 4 sur 6 »* was never on the table: what reduces is
 *    named — a type, an account, a word — and a page number means nothing on an
 *    axis of dates. What the ledger does instead is **reveal**, below.
 *  - **the reveal.** Forty rows at a time (ADR-0031), which is a rendering
 *    budget and not a fetch: the whole ledger is already in memory when the
 *    first row is drawn.
 *  - **the two parses.** `<input type="date">` silently discards what it cannot
 *    parse, and `<input type="number">` does exactly the same with a decimal
 *    comma; both hand back an empty string, which reads as *the user left it
 *    blank* one line later. Here a value that cannot be understood comes back
 *    `null` and the form **names** it, which is the whole of that criterion.
 */
import { EVENT_TYPES, type LedgerEvent, type LedgerEventType } from '@/lib/api'

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
  /**
   * The first day retained, `YYYY-MM-DD`, or `null` for *no lower bound* (#810).
   *
   * It is spelled `since` and not `from` on the wire and here, because the
   * server's `Selection` is a `NamedTuple` and `from` is a Python keyword: one
   * vocabulary means picking the pair of names both sides can spell.
   */
  since: string | null
  /** The last day retained, **inclusive** — the ledger is dated to the day. */
  until: string | null
}

export const NO_FILTERS: LedgerFilters = {
  query: '',
  type: null,
  account: null,
  symbols: null,
  since: null,
  until: null,
}

export function filterEvents(
  events: readonly LedgerEvent[],
  filters: LedgerFilters,
): LedgerEvent[] {
  const needle = fold(filters.query.trim())
  const symbols = filters.symbols === null ? null : new Set(filters.symbols)
  return events.filter((event) => {
    if (filters.since !== null || filters.until !== null) {
      // A row with no day at all belongs to no interval — the symbols rule one
      // dimension over, and the comparison is on the ISO spelling, which sorts
      // as the calendar does.
      if (event.date === null) return false
      if (filters.since !== null && event.date < filters.since) return false
      if (filters.until !== null && event.date > filters.until) return false
    }
    if (filters.type !== null && event.event_type !== filters.type) return false
    if (filters.account !== null && accountOf(event) !== filters.account) return false
    if (symbols !== null && (!event.symbol || !symbols.has(event.symbol))) return false
    if (needle === '') return true
    return haystack(event).includes(needle)
  })
}

/**
 * The reduction as the **export resource's own parameters** (#796).
 *
 * The five names are the five the chips hold, and they travel rather than the
 * rows they retain: the importable form belongs to `events/export.py`, and a
 * file assembled here would be a second spelling of a format written once — the
 * rule that has already cost this product a branch. So what crosses the wire is
 * the *question*, and the answer is rendered on the side that owns the format.
 *
 * A member that reduces nothing is **left out**, so no reduction is an empty
 * query string — which is what lets the same builder serve the whole ledger and
 * a selection of it, and what tells the server which of the two names to give
 * the file.
 *
 * The two reductions are read on two different subjects and that is deliberate,
 * not a slip: this one runs on the published snapshot the table draws, the
 * export's on the **store**, because a backup is of what is stored. They part
 * exactly where a validator refused an import — and there, the file is right.
 */
export function selectionParams(filters: LedgerFilters): URLSearchParams {
  const params = new URLSearchParams()
  const query = filters.query.trim()
  if (query !== '') params.set('q', query)
  if (filters.type !== null) params.set('type', filters.type)
  if (filters.account !== null) params.set('account', filters.account)
  // Repeated and singular, the spelling `GET /api/events?symbol=` already uses
  // on this collection.
  for (const symbol of filters.symbols ?? []) params.append('symbol', symbol)
  // The period, under the two names the server spells (#810). Each bound is
  // sent on its own: one alone opens the interval on the other side, which is
  // *everything since 2023* and a legitimate reduction.
  if (filters.since !== null) params.set('since', filters.since)
  if (filters.until !== null) params.set('until', filters.until)
  return params
}

/**
 * **A reduced ledger has an address** (#797), and it is spelled the way the
 * export resource spells one.
 *
 * The ⌘K palette leads to an event, and it leads there from another route — so
 * the reduction has to cross a navigation. It does it in the URL rather than in
 * a state a link would have to carry, which is the reason `?compte=` is a search
 * parameter on the two other pages: it survives a reload, it can be handed to
 * somebody else, and the way back is the browser's own button.
 *
 * **All five dimensions since #829**, under the names {@link selectionParams}
 * already gives them — so the address of a reduced ledger *is* the query string
 * of its own export.
 *
 * The set of securities was the one exception, and its argument was that it
 * *"arrives from a gesture made on the page itself — the assumed-currency
 * notice, one tab away"*. There is no tab and no page: the notice is a card in
 * the notifications panel, which is mounted in the shell and reachable from all
 * five routes, and ADR-0037 requires its link to land on **the figure** — the
 * ledger reduced to the events concerned, the reduction naming itself and
 * offering the way out. A reduction that has to cross a navigation travels in
 * the URL, which is the whole of `?compte=`'s own reasoning one page over.
 */
export interface LedgerSearch {
  q?: string
  type?: LedgerEventType
  account?: string
  /** Repeated, as the export resource and `GET /api/events` both spell it. */
  symbol?: string[]
  since?: string
  until?: string
}

/**
 * The address, validated rather than read raw — the rule `?compte=` follows.
 *
 * **Blank counts as unset**, which is what the server reads `?type=&account=`
 * as, and a word outside the closed set of six types reduces *nothing* rather
 * than reducing to nothing: the type is the one member with a closed set, so it
 * is the one member that can be outside it.
 *
 * The two bounds have a closed set of their own — the days that exist — so they
 * are the second member that can be outside it, and {@link parseDay} is what
 * says so: `?since=hier` and `?since=2026-02-31` both reduce **nothing** here.
 * The server answers a `422` to the same string, and the difference is the
 * subject: a refused export is a gesture the reader just made, an address is a
 * link they followed, and a page that refused to render over a bad link would
 * hide the ledger it was pointing at.
 */
export function validateLedgerSearch(search: Record<string, unknown>): LedgerSearch {
  const text = (value: unknown): string | undefined => {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    return trimmed === '' ? undefined : trimmed
  }
  const day = (value: unknown): string | undefined => {
    const trimmed = text(value)
    return trimmed === undefined ? undefined : (parseDay(trimmed) ?? undefined)
  }
  // Repeated, so one value and several arrive in two shapes — a router hands
  // over a string for `?symbol=AAA` and an array for two of them, and a hand
  // typed address may hold anything at all. Blanks are dropped for the reason
  // every other member drops them, and an empty set reduces **nothing**: it is
  // the same distinction as `?account=`, one dimension over.
  const symbols = (Array.isArray(search.symbol) ? search.symbol : [search.symbol])
    .map((value) => text(value))
    .filter((value): value is string => value !== undefined)
  const named = text(search.type)?.toUpperCase()
  const type = EVENT_TYPES.find((one) => one === named)
  return {
    ...(text(search.q) === undefined ? {} : { q: text(search.q) }),
    ...(type === undefined ? {} : { type }),
    ...(text(search.account) === undefined ? {} : { account: text(search.account) }),
    ...(symbols.length === 0 ? {} : { symbol: symbols }),
    ...(day(search.since) === undefined ? {} : { since: day(search.since) }),
    ...(day(search.until) === undefined ? {} : { until: day(search.until) }),
  }
}

/** The reduction an address carries, or `null` where it reduces nothing. */
export function filtersFromSearch(search: LedgerSearch): LedgerFilters | null {
  if (
    search.q === undefined &&
    search.type === undefined &&
    search.account === undefined &&
    search.symbol === undefined &&
    search.since === undefined &&
    search.until === undefined
  ) {
    return null
  }
  return {
    ...NO_FILTERS,
    query: search.q ?? '',
    type: search.type ?? null,
    account: search.account ?? null,
    symbols: search.symbol ?? null,
    since: search.since ?? null,
    until: search.until ?? null,
  }
}

/**
 * The reduction as an address — built off {@link selectionParams} rather than
 * beside it, so the two spellings cannot part company.
 *
 * **All five dimensions since #829**, the securities included: the panel's card
 * has to reach the ledger from any of the five routes, so the dimension that
 * *"had never needed an address"* now needs one.
 */
export function ledgerSearchOf(filters: LedgerFilters): LedgerSearch {
  const params = selectionParams(filters)
  const type = params.get('type')
  const account = params.get('account')
  const query = params.get('q')
  const symbols = params.getAll('symbol')
  const since = params.get('since')
  const until = params.get('until')
  return {
    ...(query === null ? {} : { q: query }),
    ...(type === null ? {} : { type: type as LedgerEventType }),
    ...(account === null ? {} : { account }),
    ...(symbols.length === 0 ? {} : { symbol: symbols }),
    ...(since === null ? {} : { since }),
    ...(until === null ? {} : { until }),
  }
}

/** One export route, carrying the reduction in force — or nothing at all. */
export function exportHref(route: string, filters: LedgerFilters): string {
  const params = selectionParams(filters).toString()
  return params === '' ? route : `${route}?${params}`
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

/**
 * **The rendering budget** (ADR-0031): how many rows a first reveal draws, and
 * how many each *show more* adds.
 *
 * Forty is not a page size in the usual sense, because nothing is fetched a
 * second time: `GET /api/events` answers from the published snapshot in process
 * memory and hands back the ledger entire, so what this number bounds is the
 * number of `<tr>` in the document and nothing else. It is why the control below
 * the table may speak while the table is on screen — it describes rows the app
 * already holds — and why no state of this surface has a wait to dress.
 */
export const PAGE = 40

/**
 * What is on screen, and what the two sentences under the table are true of.
 *
 * They are true of the **reduction**, never of the store: the chips are a
 * filter, so *forty of a hundred and seventy-six* and *the end of the ledger*
 * both count what survives them and both move when they move. A table silently
 * shorter than expected stays the defect it always was, which is why the count
 * is rendered beside the chips that made it.
 */
export interface Reveal {
  /** The rows to draw, in the order the reduction handed them over. */
  rows: readonly LedgerEvent[]
  /** How many of them are drawn — the first number of the sentence. */
  shown: number
  /** How many the reduction holds — the second. */
  total: number
  /** The last row of the reduction is drawn, so the end may be said. */
  atEnd: boolean
}

export function reveal(events: readonly LedgerEvent[], upTo: number): Reveal {
  // Clamped on both sides: a budget below zero draws nothing rather than
  // slicing from the end, and one above the reduction is simply the whole of it.
  const shown = Math.min(Math.max(upTo, 0), events.length)
  return { rows: events.slice(0, shown), shown, total: events.length, atEnd: shown >= events.length }
}

/** The accounts an install actually uses, in the order they first appear. */
export function accountsNamed(events: readonly LedgerEvent[]): string[] {
  return [...new Set(events.map(accountOf))]
}

/**
 * **Every row is editable** (ADR-0032, #816) — provided it is *addressable*,
 * which is all that is left of the predicate. The other half was
 * `source_id === null`: a row a mounted file had provisioned was refused by the
 * server in `409`, so offering the editor on it was offering a refusal. There is
 * one population now, and a key is the whole of what an edit needs.
 */
export function isEditable(event: LedgerEvent): boolean {
  return typeof event.id === 'string'
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
