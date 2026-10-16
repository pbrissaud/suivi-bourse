/**
 * The hot read of the portfolio — its positions — and each symbol's prices.
 *
 * The types are the contract of #712 §11 for this domain, and the calls go
 * through the transport of `lib/api.ts`, which also holds every path in
 * `ROUTES`: a route renamed still changes that file and the test harness, and
 * no page test.
 */

import { get, ROUTES } from '@/lib/api'
import type {
  Converted,
  Fundamentals,
  Position,
  Positions as PositionsResponse,
  Price as Quote,
} from '@/lib/api.gen'

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

export type { Converted, Fundamentals, Position, PositionsResponse, Quote }

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
