/**
 * The shares page's arithmetic, pure (#719, ADR-0017, ADR-0003, ADR-0004).
 *
 * Four things live here rather than in a component, and each of them is a rule
 * the page would otherwise re-decide per cell:
 *
 *  - **A row is a *symbol*, not a holding.** `/api/positions` is keyed by
 *    `(account, symbol)` — the same ETF on a PEA and on a CTO is two rows there
 *    and one line here. That grouping is the model staying multi-account while
 *    the *rendering* bends: measured, none of the nineteen symbols of the real
 *    portfolio is held on two accounts, and the fact is **contingent** rather
 *    than structural, so the column keeps a list and renders one account as
 *    plain text (#684 D11).
 *  - **The unit cost is derived, and it is undefined on a closed position.**
 *    `Σ cost_basis / Σ quantity` *is* the weighted mean and falls out of one
 *    division because the basis is stored as an amount (ADR-0003); a plain mean
 *    of per-account unit prices produces a plausible-looking wrong price. At
 *    quantity zero the basis is zero too, so the division is `0 / 0` and the
 *    honest answer is *there is nothing to compute* — the row has a realised
 *    gain instead.
 *  - **The counter is a rendering concern and never an arithmetic one.** A
 *    symbol the app has asked for N times and got nothing from renders *N
 *    consecutive readings, no price* in three cells (`lib/absence.ts`), and is
 *    still **carried at its cost** in every sum (ADR-0004). Written the other
 *    way round, a failing ticker would subtract its whole basis from the
 *    portfolio's value the day its quote went missing.
 *  - **The header's total is the same function the dashboard's is**
 *    (`lib/gain.ts`), minus its fourth term. The fees a broker takes out of a
 *    transfer belong to no security, so a table whose header sums its rows can
 *    never show them — which is the one line ADR-0017's identity had to be
 *    corrected on (ADR-0018) and the one thing this page's bubble has to say.
 *
 * **The sheet's two rules grow this module rather than a second one beside it**
 * (#720, the way `lib/accounts.ts` took the declaration at #729): the
 * per-account breakdown, which **does not exist at one account** because it
 * would then repeat the sheet's own header line for line, and the chart's event
 * markers, where *a day carrying three events is one marker announcing three*
 * and never three points merged in silence.
 */
import { absenceCase, type AbsenceCase, type PositionAbsenceInput } from '@/lib/absence'
import type { Converted, Fundamentals, LedgerEvent, Position, Quote, SeriesPoint } from '@/lib/api'
import { type Unrealised } from '@/lib/gain'
import { byDateDescending } from '@/lib/ledger'

/** One line of the page — one symbol, whatever the number of accounts on it. */
export interface ShareRow extends PositionAbsenceInput {
  symbol: string
  /** Display only. A rename must not split anything (`lib/api.ts`). */
  name: string | null
  quantity: number
  cost_basis: number
  realised: number
  dividends: number
  price: Quote | null
  converted: Converted | null
  /**
   * Who holds it — and, once nobody does, who held it. The folded section keeps
   * a `Compte` column, so a closed row that named no account would carry an
   * empty cell where the reader is looking for *which account did this happen
   * on*.
   */
  accounts: string[]
  /** The day the last account sold out. `null` while it is held. */
  closedAt: string | null
  consecutiveFailures: number
  /**
   * The instrument's own attributes — read off the first row of the group that
   * carries them, never summed (#720). `null` is *nothing has ever been observed
   * about this symbol*, and the sheet then renders no block at all.
   */
  fundamentals: Fundamentals | null
}

/** Closed is a derivation over `quantity` — there is no stored flag (ADR-0003). */
export function isClosed(row: ShareRow): boolean {
  return row.quantity === 0
}

/**
 * The **arithmetic** classification: the same one every cell reads, with the
 * failure counter deliberately dropped. See the header comment — *asked and got
 * nothing* and *not asked yet* are two renderings and one sum, and the sum is
 * the cost. Folding `noQuote` here rather than leaving it in every switch
 * downstream is what keeps the counter out of the arithmetic in **one** place,
 * and out of the return type: a caller cannot branch on a case it cannot get.
 */
function arithmeticCase(row: ShareRow): Exclude<AbsenceCase, 'noQuote'> {
  const decided = absenceCase(row)
  return decided === 'noQuote' ? 'carriedAtCost' : decided
}

/**
 * What the position is worth, in the reporting currency.
 *
 * `null` is *waiting for the rate* and nothing else: a position with no quote
 * at all is **carried at its cost** (ADR-0004) rather than valued at zero, and
 * a sold one is worth exactly zero, which is a figure.
 */
export function marketValue(row: ShareRow): number | null {
  switch (arithmeticCase(row)) {
    case 'nothingToCompute':
      return 0
    case 'carriedAtCost':
      return row.cost_basis
    case 'awaitingRate':
      return null
    case 'quoted':
      return (row.converted?.value ?? 0) * row.quantity
  }
}

/**
 * The latent gain — `market value − cost basis`, and neither dividends nor
 * fees, which are the two other named figures (ADR-0018).
 *
 * `null` on a closed position, where there is nothing to compute, and on one
 * waiting for its rate. Carried at its cost it is exactly **zero**, not a loss:
 * that is what makes the day of a purchase come out neutral.
 */
export function unrealised(row: ShareRow): number | null {
  if (isClosed(row)) return null
  const value = marketValue(row)
  return value === null ? null : value - row.cost_basis
}

/** The second line under the latent gain. Undefined on a nil basis (a grant). */
export function unrealisedRatio(row: ShareRow): number | null {
  const gain = unrealised(row)
  if (gain === null || row.cost_basis === 0) return null
  return gain / row.cost_basis
}

/** The PRU — the word the owner reads at their broker; PMP names the rule. */
export function unitCost(row: ShareRow): number | null {
  if (row.quantity === 0) return null
  return row.cost_basis / row.quantity
}

/**
 * A share the app cannot price and **the app is the answer**, never the market
 * (#684 D6). It is the one exception ADR-0016 allows to *icons never go on a
 * cell*: the text is a repair, not a convention.
 */
export function isAnomalous(row: ShareRow): boolean {
  return absenceCase(row) === 'noQuote'
}

/**
 * Every account's positions on one symbol, folded into one line.
 *
 * The price rides on the symbol and not on the holding (#700), so the first
 * non-null quote of the group is the group's; the amounts add. `closedAt` takes
 * the **latest** of them: the line is closed when the last account is, and it
 * is that day the section sorts on.
 */
export function buildShareRows(
  positions: readonly Position[],
  failures: ReadonlyMap<string, number>,
): ShareRow[] {
  const rows = new Map<string, ShareRow>()

  for (const position of positions) {
    const existing = rows.get(position.symbol)
    const row: ShareRow = existing ?? {
      symbol: position.symbol,
      name: null,
      quantity: 0,
      cost_basis: 0,
      realised: 0,
      dividends: 0,
      price: null,
      converted: null,
      accounts: [],
      closedAt: null,
      consecutiveFailures: failures.get(position.symbol) ?? 0,
      fundamentals: null,
    }

    row.name = row.name ?? position.name
    row.quantity += position.quantity
    row.cost_basis += position.cost_basis
    row.realised += position.realised
    row.dividends += position.dividends
    row.price = row.price ?? position.price
    row.converted = row.converted ?? position.converted
    // Read, never added: the attributes describe the security, and holding it
    // on two accounts does not double its market capitalisation.
    row.fundamentals = row.fundamentals ?? position.fundamentals
    if (position.closed_at !== null && (row.closedAt === null || position.closed_at > row.closedAt)) {
      row.closedAt = position.closed_at
    }
    rows.set(position.symbol, row)
  }

  // Who holds it, in a second pass: the holders when there are any, everyone
  // who ever named it once there are none.
  for (const row of rows.values()) {
    const named = positions.filter((position) => position.symbol === row.symbol)
    const holders = named.filter((position) => position.quantity !== 0)
    row.accounts = Array.from(new Set((holders.length > 0 ? holders : named).map((p) => p.account)))
  }

  return Array.from(rows.values())
}

/**
 * The live table, heaviest first. Value is the only ordering a portfolio reads
 * naturally, and a line whose rate has not resolved has none — so it goes last
 * rather than pretending to be worth nothing.
 */
export function heldRows(rows: readonly ShareRow[]): ShareRow[] {
  return rows
    .filter((row) => !isClosed(row))
    .sort((a, b) => {
      const left = marketValue(a)
      const right = marketValue(b)
      if (left === right) return a.symbol.localeCompare(b.symbol)
      if (left === null) return 1
      if (right === null) return -1
      return right - left
    })
}

/**
 * The folded section, **closing date descending**. Market value is zero across
 * the whole section, so a column of zeros orders nothing; this is the one
 * column that discriminates its rows, and the live table does not have it.
 */
export function closedRows(rows: readonly ShareRow[]): ShareRow[] {
  return rows
    .filter(isClosed)
    .sort((a, b) => {
      if (a.closedAt === b.closedAt) return a.symbol.localeCompare(b.symbol)
      if (a.closedAt === null) return 1
      if (b.closedAt === null) return -1
      return a.closedAt < b.closedAt ? 1 : -1
    })
}

/**
 * The portfolio's market value — a sum, **or the reason there is not one**.
 *
 * It borrows `lib/gain.ts`'s discriminant rather than returning `number | null`
 * for the reason written there: the nullity survives a return and the *case*
 * does not, so a caller holding only the null writes an em dash and says *there
 * is nothing to compute* about a rate the app fetches by itself.
 */
export function valuationTotal(rows: readonly ShareRow[]): Unrealised {
  let total = 0
  for (const row of rows) {
    const value = marketValue(row)
    if (value === null) return { known: false, because: 'awaitingRate' }
    total += value
  }
  return { known: true, value: total }
}

/**
 * The sheet's per-account breakdown — **and it does not exist at one account**
 * (#720).
 *
 * The empty answer at N = 1 is the rule and not a shortcut: a breakdown of one
 * repeats the sheet's own header line for line, quantity for quantity, and a
 * table whose every column already appears three centimetres above it teaches
 * nothing. It comes back the moment a symbol is held on two accounts — which is
 * the most ordinary case of the domain even though none of the nineteen real
 * symbols shows it, so the rendering is what bends and never the model
 * (`buildShareRows`' own argument, one level down).
 *
 * Each line is a `ShareRow` of one account, so every figure on it is computed by
 * the functions above — the breakdown cannot drift from the line it decomposes.
 */
export function accountBreakdown(
  positions: readonly Position[],
  symbol: string,
  failures: ReadonlyMap<string, number>,
): ShareRow[] {
  const held = positions.filter((position) => position.symbol === symbol)
  const accounts = Array.from(new Set(held.map((position) => position.account)))
  if (accounts.length < 2) return []
  return accounts.map((account) => {
    const [row] = buildShareRows(
      held.filter((position) => position.account === account),
      failures,
    )
    return { ...row, accounts: [account] }
  })
}

/** The events of one security, newest first — what the sheet's list renders. */
export function shareEvents(
  events: readonly LedgerEvent[],
  symbol: string,
): LedgerEvent[] {
  return byDateDescending(events.filter((event) => event.symbol === symbol))
}

/**
 * A day of the ledger, as the chart announces it (#720).
 *
 * **One marker per day, carrying its count**, never one point per event: a
 * single symbol of the real portfolio carries `×2`, `×2`, `×3`, `×3` over four
 * days, so points drawn per event overlap and the reader is shown three
 * purchases as one with nothing saying so. The collision is measured, not
 * hypothetical.
 */
export interface EventMarker {
  /** The calendar day, `YYYY-MM-DD` — it is what the selection is keyed on. */
  day: string
  /** How many events fall on it. Above one it is announced as `×N`. */
  count: number
  /**
   * Where it sits along the visible series: the **rank** of the point it names,
   * `0` at the first and `1` at the last. A fraction rather than a pixel,
   * because the band that draws it is laid out in the chart's own width; and a
   * fraction of the **index** rather than of the elapsed time, because that is
   * the abscissa the chart itself uses — a Recharts category axis gives every
   * point one step whatever the interval before it. Written as a fraction of
   * the span it was a *second* statement of the x-axis, and the two part
   * company exactly where the reader needs them together: on `1M`, whose rung
   * is the raw series, the live scrape writes a point every 120 s in session
   * and the reconstruction one per hour or per day, so the density varies by a
   * factor of ~25 inside one window and a three-week-old event lands under the
   * curve of six days ago.
   */
  offset: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** One drawn point: where it is in time, and **which step of the axis it is**. */
interface Stop {
  index: number
  at: number
}

/**
 * The step nearest a day — zero distance to any point falling inside it.
 *
 * A day holding several points takes the **first** of them: a tie broken the
 * other way would put the marker of a purchase made at the open under the last
 * close of that session. Everything else is a plain distance to the nearer end
 * of the day, so an event on a closed market lands on the session that framed
 * it rather than on an edge of the plot.
 */
function nearestStop(stops: readonly Stop[], start: number): Stop {
  const end = start + DAY_MS
  let best = stops[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const stop of stops) {
    const distance = stop.at < start ? start - stop.at : stop.at < end ? 0 : stop.at - end
    if (distance < bestDistance) {
      bestDistance = distance
      best = stop
    }
  }
  return best
}

/**
 * The markers of one symbol over the points the chart is showing.
 *
 * Three decisions. **The window bounds the markers**, so changing the range
 * genuinely changes what is announced instead of piling every event the ledger
 * holds onto one edge; a day is kept when the *day* intersects the span, not
 * when its midnight does — a series whose first point is an afternoon close
 * would otherwise drop the very purchase that opened it. **A span of one point
 * has no abscissa**, so it carries no marker at all: placing one at a fraction
 * of nothing would be an invented position, which is the one thing a marker
 * must not be. And **a marker names a point of the series**, never an instant
 * of its span — which is what makes the chart and its band one statement of the
 * x-axis rather than two (see `offset` above).
 */
export function eventMarkers(
  events: readonly LedgerEvent[],
  symbol: string,
  points: readonly SeriesPoint[],
): EventMarker[] {
  if (points.length < 2) return []
  const stops: Stop[] = []
  for (const [index, point] of points.entries()) {
    const at = Date.parse(point.ts)
    if (Number.isFinite(at)) stops.push({ index, at })
  }
  if (stops.length < 2) return []
  // The span is read off the stops rather than off the first and last rows, so
  // one unparseable timestamp shortens the range instead of voiding it.
  const first = Math.min(...stops.map((stop) => stop.at))
  const last = Math.max(...stops.map((stop) => stop.at))
  if (last <= first) return []
  const steps = points.length - 1

  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.symbol !== symbol || !event.date) continue
    counts.set(event.date, (counts.get(event.date) ?? 0) + 1)
  }

  return Array.from(counts.entries())
    .map(([day, count]) => ({ day, count, start: Date.parse(`${day}T00:00:00Z`) }))
    .filter(({ start }) => Number.isFinite(start) && start + DAY_MS > first && start <= last)
    .sort((left, right) => left.start - right.start)
    .map(({ day, count, start }) => ({
      day,
      count,
      offset: nearestStop(stops, start).index / steps,
    }))
}
