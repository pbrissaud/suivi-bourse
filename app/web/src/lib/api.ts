/**
 * The one module that knows a URL.
 *
 * That is a rule, not an accident of layout (#712 §1). The store (#695) has not
 * frozen its paths, so the front is written **in front of** the back end: the
 * day a route is renamed, this file and the test harness's handlers change, and
 * **no page test moves**. A component that fetched its own path would turn that
 * rename into a hunt through twenty files.
 *
 * The types below are the contract of #712 §11, and they carry two traps in
 * their shape rather than in a comment:
 *
 *  - a **price** is `{ value, currency, at }` and its conversion is a *separate*
 *    object carrying the rate and the rate's timestamp — because the page has to
 *    tell *waiting for the rate* (native price known, converted `null`) from
 *    *no price at all* (`price: null`, position carried at its cost), and a
 *    single nullable number cannot;
 *  - `symbol` is the identity, `name` is display only: a rename must not split
 *    anything.
 *
 * It grows one page ticket at a time. What is here is what the shell reads.
 */

/**
 * The paths, in one object, because the test harness fakes exactly this edge
 * (#712 Testing Decisions) and a fake that hardcoded its own strings would drift
 * from the client silently.
 */
export const ROUTES = {
  accounts: '/api/accounts',
  positions: '/api/positions',
  portfolioTotals: '/api/portfolio-totals',
  /**
   * One symbol's price series. A **pattern**, `:symbol`, because it is what the
   * harness's handler registers; {@link pricesPath} is what a caller builds.
   */
  prices: '/api/prices/:symbol',
  runtime: '/api/runtime',
} as const

/**
 * The window a chart asks for. The four are the **rungs of the retention
 * ladder** (ADR-0010, #684 D10) and not four round numbers: as written under a
 * year, hourly from one to two, daily beyond — so changing the range changes
 * the resolution *visibly*, which is the whole reason `3M` left.
 */
export const CHART_WINDOWS = ['1M', '1Y', '2Y', 'MAX'] as const

export type ChartWindow = (typeof CHART_WINDOWS)[number]

export function pricesPath(symbol: string, window: ChartWindow): string {
  return `/api/prices/${encodeURIComponent(symbol)}?window=${window}`
}

/**
 * An RFC 9457 problem.
 *
 * `type` is the discriminant and the **only** member the interface branches on
 * (ADR-0024). `title` and `detail` are English diagnostics the server writes for
 * a log: they are carried here so a report can quote them, and rendered
 * nowhere — that is what put a French title over an English sentence in the
 * prototype's most consequential alert.
 */
export class ApiProblem extends Error {
  readonly status: number
  readonly type: string | null
  readonly title: string | null
  readonly detail: string | null

  constructor(init: { status: number; type?: string | null; title?: string | null; detail?: string | null }) {
    super(init.title ?? `HTTP ${init.status}`)
    this.name = 'ApiProblem'
    this.status = init.status
    this.type = init.type ?? null
    this.title = init.title ?? null
    this.detail = init.detail ?? null
  }
}

async function unwrap<T>(response: Response, path: string): Promise<T> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) {
    if (contentType.includes('problem+json')) {
      throw new ApiProblem(await response.json())
    }
    // No problem+json means something in front of the app answered — a proxy,
    // or the SPA catch-all if its `/api` guard ever regressed. A `type` of
    // `null` is what the interface reads as "not even the app answered".
    throw new ApiProblem({ status: response.status, title: `${path}: no problem+json` })
  }
  return response.json() as Promise<T>
}

async function get<T>(path: string): Promise<T> {
  return unwrap<T>(await fetch(path, { headers: { Accept: 'application/json' } }), path)
}

// ------------------------------------------------------------------------- //
// Accounts (ADR-0013)
// ------------------------------------------------------------------------- //

export interface Account {
  /** The id events carry. `default` is the bucket of the unassigned. */
  id: string
  label: string
  type: string
}

export interface AccountsResponse {
  /**
   * **Mandatory in the client contract** (#745). `false` is a *designed* state
   * — the install that has declared nothing, which every default produces — and
   * it is not an empty array: the seeded `default` row is always there. A client
   * that drops this member cannot tell *you have declared no accounts* from
   * *your accounts have no figures*.
   */
  declared: boolean
  accounts: Account[]
}

// ------------------------------------------------------------------------- //
// The hot read of the portfolio (#712 §11)
// ------------------------------------------------------------------------- //

/** A price as observed, in the currency it was quoted in. */
export interface Quote {
  value: number
  currency: string
  at: string
}

/** The same price in the base currency, with the rate that got it there. */
export interface Converted {
  value: number
  currency: string
  rate: number
  rate_at: string
}

export interface Position {
  account: string
  symbol: string
  name: string | null
  /** Owned. Zero is a closed position, which stays in the table (ADR-0017). */
  quantity: number
  /** What the position cost — the carrying price of ADR-0004. */
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
}

export interface PositionsResponse {
  /** The single currency everything is reported in (ADR-0002). */
  base_currency: string | null
  positions: Position[]
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
   * ADR-0018's fourth term, **signed as it enters the sum** — negative, the
   * money having left. It belongs to no position, which is why it is here and
   * not on `/api/positions`.
   */
  transfer_fees: number | null
  /**
   * The same number written down elsewhere. **The head never reads it** — it
   * computes the total from the four terms (ADR-0018), and a divergent value
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
  /** The single currency everything is reported in (ADR-0002). */
  base_currency: string | null
  /** `null` — no figures at all: no ledger, or no answered currency. */
  totals: PortfolioTotals | null
}

// ------------------------------------------------------------------------- //
// One symbol's price series (#712 §11, ADR-0010)
// ------------------------------------------------------------------------- //

/**
 * What the store actually served, **announced rather than guessed**.
 *
 * A price point's resolution is a function of its age (ADR-0010) — as written
 * under a year, hourly to two, daily beyond — so a five-year window comes back
 * sparse at its far end. Announced, that is a property of the archive; guessed
 * by the reader, it is an outage. And it is announced **once**: the chart's
 * *aggregated by X* caption reads this field instead of stating a second
 * bucketing of its own, two announcers on one graph being the defect the map
 * found on four pages.
 */
export type Resolution = 'raw' | 'hour' | 'day'

export interface SeriesPoint {
  ts: string
  /** In the reporting currency. `null` — quoted, and the rate never resolved. */
  price: number | null
}

export interface PriceSeriesResponse {
  symbol: string
  /** The single currency everything is reported in (ADR-0002). */
  base_currency: string | null
  resolution: Resolution
  points: SeriesPoint[]
}

// ------------------------------------------------------------------------- //
// The app's own state — process memory, never a data query (#712 §11)
// ------------------------------------------------------------------------- //

/**
 * Answered from the scheduler's memory and reading no store at all. That is the
 * one rule of the four proved in production rather than at the eye: a status
 * riding in `/api/positions` disappears exactly when it is the only thing able
 * to explain the empty table.
 */
export interface RuntimeSymbol {
  symbol: string
  next_run: string | null
  /** Consecutive fruitless readings. Never "never", which is not computable. */
  consecutive_failures: number
}

export interface RuntimeAccount {
  account: string
  /** How far back the rebuild has reached for this account. */
  horizon: string | null
}

export interface RuntimeState {
  now: string
  scheduler_running: boolean
  /**
   * The backfill still has windows to cover. It is here rather than beside the
   * figures because it is a fact about *this process*, and rule four of the map
   * is that the app's state never travels in a data request.
   *
   * What it decides on screen is small and exact: the time-weighted return
   * carries its base date **only while that date is still moving**. Once the
   * reconstruction is done the base stops moving and the date stops being news.
   */
  rebuilding: boolean
  symbols: RuntimeSymbol[]
  accounts: RuntimeAccount[]
}

export const api = {
  accounts: () => get<AccountsResponse>(ROUTES.accounts),
  positions: () => get<PositionsResponse>(ROUTES.positions),
  portfolioTotals: () => get<PortfolioTotalsResponse>(ROUTES.portfolioTotals),
  prices: (symbol: string, window: ChartWindow) =>
    get<PriceSeriesResponse>(pricesPath(symbol, window)),
  runtime: () => get<RuntimeState>(ROUTES.runtime),
}
