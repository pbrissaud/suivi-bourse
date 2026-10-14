/**
 * What the dashboard reads: the portfolio's totals and their series, the valuation curve, the movers, the investment rhythm, and the saved layout.
 *
 * The types are the contract of #712 §11 for this domain, and the calls go
 * through the transport of `lib/api.ts`, which also holds every path in
 * `ROUTES`: a route renamed still changes that file and the test harness, and
 * no page test.
 */

import { type PerfPoint, SERIES_ORIGIN } from '@/features/accounts/lib/api'
import { forget, get, ROUTES, send } from '@/lib/api'

// ------------------------------------------------------------------------- //
// The dashboard's layout
// ------------------------------------------------------------------------- //

/** Where a card sits: its order is its index in `blocks`. */
export interface DashboardPlacement {
  id: string
  /** `Width` in `./dashboardBlocks`, spelled here so the wire types do not import the registry. */
  width: 'half' | 'full'
  hidden: boolean
}

/** What the store keeps. Read back as `unknown`: `normalizeLayout` vets it. */
export interface DashboardLayout {
  version: 1
  blocks: DashboardPlacement[]
}

export interface PortfolioTotalsHistoryResponse {
  from: string
  to: string
  points: PerfPoint[]
}

function portfolioTotalsHistoryPath(from: string = SERIES_ORIGIN): string {
  return `${ROUTES.portfolioTotalsHistory}?from=${from}`
}

function positionsHistoryPath(from: string = SERIES_ORIGIN): string {
  return `${ROUTES.positionsHistory}?from=${from}`
}

/**
 * One day of the valuation curve — **the fallback reading** of the dashboard's
 * chart (#727).
 *
 * The two members are two different figures and their names keep them apart:
 * `invested` is what the positions **cost**, never money the owner put in, so
 * the area between the curves is the *latent* gain and the page renames it.
 * Conflating it with `net_contributed` is the mistake the server refuses to make
 * by giving them two names.
 *
 * `null` on either is a day whose sum could not be taken at all — never a zero,
 * which would draw a crater the portfolio never had.
 */
export interface ValuationPoint {
  /** The calendar day — a bare `YYYY-MM-DD`, like every other series. */
  t: string | null
  value: number | null
  invested: number | null
}

export interface PositionsHistoryResponse {
  from: string
  to: string
  points: ValuationPoint[]
}

/**
 * One security's move since the previous session close (#727).
 *
 * A share with **no baseline** (its first day) or no current price is simply not
 * in the collection: it has not failed to move, it has nothing to compare
 * against, and a zero in a movers list is a claim. It is still in the
 * allocation, which needs no history — and the block counts what it does not
 * show rather than letting it disappear.
 */
export interface Mover {
  symbol: string
  name: string | null
  price: number | null
  previous_price: number | null
  change: number | null
  /** The ratio, signed. **`0` is a value**: it is what the block must not hide. */
  change_pct: number | null
  market_value: number | null
  /** What the move did in money — `change × quantity`. */
  contribution: number | null
}

export interface MoversResponse {
  /** Each against the last price before the day of its own latest quote (#1142). */
  movers: Mover[]
}

/**
 * One investment rhythm — the portfolio's, or one account's (#751).
 *
 * **`monthly_amount` and `months_covered` are one figure in two members**, and
 * nothing on any surface may show the first without the second: `500 €` alone
 * is read as `6 000 €` a year when half of that never went in. The amount is
 * the **median of the months that carried a purchase** — months with none are
 * not averaged in as zeros, which is why the coverage is what makes it honest.
 *
 * `months_observed` is twelve, bounded by the age of the ledger and counted
 * from its first event of any kind. A month with no purchase is observed and
 * uncovered, never unobserved: that is how a stop in investing stays visible.
 *
 * `monthly_amount: null` with `months_covered: 0` is **no purchase in the
 * window** — never a rhythm of zero. With `months_observed: 0` as well, nothing
 * has been observed at all. `dispersion` is the coefficient of variation of the
 * covered months' amounts, `null` when there is nothing to disperse.
 */
interface RhythmFigures {
  monthly_amount: number | null
  months_covered: number
  months_observed: number
  dispersion: number | null
  /**
   * The observed months themselves, oldest first — `amount` is `null` on a
   * month with no purchase. The four figures above are reductions of this
   * series, and the block draws the series: the coverage and the spread are
   * **shown**, month by month, rather than quoted as two ratios.
   */
  months: RhythmMonth[]
}

export interface RhythmMonth {
  /** `YYYY-MM`. */
  month: string
  amount: number | null
}

/** The same four members, for one account — `default` included. */
interface AccountRhythm extends RhythmFigures {
  account: string
}

export interface InvestmentRhythmResponse extends RhythmFigures {
  base_currency: string | null
  /**
   * The breakdown, **by account and never by symbol**. No block
   * renders it today: the dashboard states the habit at the portfolio grain,
   * and the breakdown is what the MCP tool reaches over the same route — the
   * surface being a contract in which a field is added safely and removed
   * never.
   */
  accounts: AccountRhythm[]
}

// ------------------------------------------------------------------------- //
// The perf cache at the global level (#745, announced there before written
// here). Named after the store's table — `portfolio_totals` — and never after
// the page, the same rule that makes the hot read `positions` and not `shares`.
// ------------------------------------------------------------------------- //

/**
 * One day of the global series. Every money member is nullable **by field**,
 * which is what lets the head *shrink* instead of filling with dashes: a figure
 * that does not exist for this installation is not a missing value.
 */
export interface PortfolioTotals {
  /** The calendar day the figures describe — a day, never an instant. */
  day: string
  total_value: number | null
  holdings_value: number | null
  cash_balance: number | null
  net_contributed: number | null
  /** Money-weighted, annualised, since the origin. `null` with no external flow. */
  xirr: number | null
  /** Time-weighted, **base 100** since `twr_since`. */
  twr_index: number | null
  /** The day the index counts from. It moves while the rebuild runs. */
  twr_since: string | null
  /**
   * It belongs to no position, which is why it is here and not on
   * `/api/positions`.
   */
  transfer_fees: number | null
  /**
   * The same number written down elsewhere. **The head never reads it** — it
   * computes the total from the four terms, and a divergent value
   * here changes nothing on screen. Carried so a report can quote both.
   */
  gain_absolu: number | null
  /**
   * The year-to-date delta, `null` while the series does not reach 1 January.
   * That is the **one** figure the rebuild degrades: everything above is exact
   * from the first cycle.
   */
  ytd: { gain: number | null; twr: number | null } | null
}

export interface PortfolioTotalsResponse {
  /** The single currency everything is reported in. */
  base_currency: string | null
  /** `null` — no figures at all: no ledger, or no answered currency. */
  totals: PortfolioTotals | null
}

export const dashboardApi = {
  portfolioTotals: () => get<PortfolioTotalsResponse>(ROUTES.portfolioTotals),
  portfolioTotalsHistory: () => get<PortfolioTotalsHistoryResponse>(portfolioTotalsHistoryPath()),
  positionsHistory: () => get<PositionsHistoryResponse>(positionsHistoryPath()),
  movers: () => get<MoversResponse>(ROUTES.movers),
  investmentRhythm: () => get<InvestmentRhythmResponse>(ROUTES.investmentRhythm),
  dashboardLayout: () => get<unknown>(ROUTES.dashboardLayout),
  saveDashboardLayout: (layout: DashboardLayout) =>
    send<DashboardLayout>(ROUTES.dashboardLayout, 'PUT', layout),
  forgetDashboardLayout: () => forget(ROUTES.dashboardLayout),
}
