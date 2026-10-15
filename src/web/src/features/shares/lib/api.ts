/**
 * The hot read of the portfolio — its positions — and each symbol's prices.
 *
 * The types are the contract of #712 §11 for this domain, and the calls go
 * through the transport of `lib/api.ts`, which also holds every path in
 * `ROUTES`: a route renamed still changes that file and the test harness, and
 * no page test.
 */

import { get, ROUTES } from '@/lib/api'

/**
 * The window a chart asks for. The four are the **rungs of the retention
 * ladder** (#684 D10) and not four round numbers: as written under a
 * year, hourly from one to two, daily beyond — so changing the range changes
 * the resolution *visibly*, which is the whole reason `3M` left.
 */
export const CHART_WINDOWS = ['1M', '1Y', '2Y', 'MAX'] as const

export type ChartWindow = (typeof CHART_WINDOWS)[number]

function symbolPricesPath(symbol: string): string {
  return ROUTES.prices.replace(':symbol', encodeURIComponent(symbol))
}

function pricesPath(symbol: string, window: ChartWindow): string {
  return `${symbolPricesPath(symbol)}?window=${window}`
}

function priceAtPath(symbol: string, day: string): string {
  return `${symbolPricesPath(symbol)}?at=${encodeURIComponent(day)}`
}

// ------------------------------------------------------------------------- //
// The hot read of the portfolio (#712 §11)
// ------------------------------------------------------------------------- //

/** A price as observed, in the currency it was quoted in. */
export interface Quote {
  value: number
  /**
   * The unit the number is in — **and it can be absent** (#774).
   *
   * `_build_position` reads it off `symbol_quote.currency`, which only a
   * *successful `.info` fetch* ever writes, so a symbol Yahoo answers closes for
   * without naming a currency serves a `price` with no `currency` at all. The
   * server keeps the number rather than suppressing the whole object — dropping
   * it would turn *quoted* into *never quoted*, the one distinction this pair of
   * objects exists to carry — and it is `lib/absence.ts` that reads the pair,
   * because **a number with no unit is not a price**: no pair to fetch a rate
   * for, nothing on its way, so the line is carried at its cost and
   * never left *waiting*. Typed `string` it read as always present, and every
   * client that only tested `price !== null` inherited the wrong absence.
   */
  currency: string | null
  at: string
}

/** The same price in the base currency, with the rate that got it there. */
export interface Converted {
  value: number
  currency: string
  rate: number
  rate_at: string
}

/**
 * What the instrument **is**, beside what the holding is worth (#720).
 *
 * It rides on the position's row the way `price` does, and for the same reason:
 * P1 hands it back per `(account, symbol)`, and the shares page folds a symbol's
 * rows into one line. Nothing here is ever summed — owning the same ETF in a PEA
 * and a CTO does not double its market capitalisation.
 *
 * A `null` member is the ordinary absence: yfinance publishes no `pe_ratio` for
 * an ETF, and `quote_type` beside it is what makes that legible rather than
 * suspicious. The **object** being `null` is the other one — nothing has ever
 * been observed about this symbol — and the sheet then renders no block at all.
 */
export interface Fundamentals {
  /** The security's own quote currency, not the reporting one. */
  currency: string | null
  /**
   * The place the quote comes from.
   */
  exchange: string | null
  quote_type: string | null
  /** In **percent points**, not a ratio — the writer multiplies by 100. */
  dividend_yield: number | null
  pe_ratio: number | null
  market_cap: number | null
}

export interface Position {
  account: string
  symbol: string
  name: string | null
  /** Owned. Zero is a closed position, which stays in the table. */
  quantity: number
  /** What the position cost — the carrying price. */
  cost_basis: number
  realised: number
  dividends: number
  /** `null` — never observed. The position is carried at its cost. */
  price: Quote | null
  /** `null` with a non-null `price` — quoted, and the rate is missing. */
  converted: Converted | null
  /**
   * The day this position reached zero, `null` while it is held.
   *
   * It joins the contract with #719 and it is not a convenience: the folded
   * section of the shares page **sorts on it**, and it is the only column that
   * discriminates its rows — market value is zero across the whole section, and
   * a column of zeros orders nothing. There is no derivation available on the
   * client either: a position carries a quantity, never the event that emptied
   * it.
   */
  closed_at: string | null
  /**
   * Has the backward pass reached this symbol's first acquisition? (#845)
   *
   * The **second** term of the carrying convention, and the one that
   * did not cross the wire until this ticket: the front held *no quote
   * observed* and put the failure counter of `/api/runtime` in the place of
   * *and none is coming*, so during every rebuild the shares table valued at its
   * cost a line the dashboard's own curve refused to value — the disagreement
   * between two screens `carrying.py` declares unacceptable.
   *
   * It is a **fact and not a verdict**: the pass has reached its bound, nothing
   * more. The verdict has two terms and `lib/absence.ts` is the judge. It rides
   * on the row rather than in the head of the payload for the reason `price`
   * does: it is the *symbol's*, and P1 is keyed by `(account, symbol)`.
   */
  terminal: boolean
  /** `null` — nothing has ever been observed about this symbol. */
  fundamentals: Fundamentals | null
}

export interface PositionsResponse {
  /** The single currency everything is reported in. */
  base_currency: string | null
  positions: Position[]
}

/**
 * What the store actually served, **announced rather than guessed**.
 *
 * A price point's resolution is a function of its age — as written
 * under a year, hourly to two, daily beyond — so a five-year window comes back
 * sparse at its far end. Announced, that is a property of the archive; guessed
 * by the reader, it is an outage. And it is announced **once**: the chart's
 * *aggregated by X* caption reads this field instead of stating a second
 * bucketing of its own, two announcers on one graph being the defect the map
 * found on four pages.
 */
export type Resolution = 'raw' | 'hour' | 'day'

export interface SeriesPoint {
  /** `t` like every other series this API serves, and not a second word. */
  t: string
  /** In the reporting currency. `null` — quoted, and the rate never resolved. */
  price: number | null
}

export interface PriceSeriesResponse {
  symbol: string
  /** The single currency everything is reported in. */
  base_currency: string | null
  resolution: Resolution
  points: SeriesPoint[]
}

/**
 * **One close, and the day it belongs to** — the same resource asked `?at=`
 * (#1007).
 *
 * The two members are `null` together: a symbol nobody scraped, or a day
 * before the first point, has no close to suggest. And `day` is not the day
 * that was asked for — a Friday the market did not quote is answered by the
 * Thursday, which is exactly why the form has to be able to name it.
 */
export interface PriceAtResponse {
  symbol: string
  base_currency: string | null
  day: string | null
  price: number | null
}

export const sharesApi = {
  positions: () => get<PositionsResponse>(ROUTES.positions),
  prices: (symbol: string, window: ChartWindow) =>
    get<PriceSeriesResponse>(pricesPath(symbol, window)),
  /** The close a grant is **suggested** at, and the day it came from (#1007). */
  priceAt: (symbol: string, day: string) => get<PriceAtResponse>(priceAtPath(symbol, day)),
}
