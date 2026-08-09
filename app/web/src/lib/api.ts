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
  runtime: '/api/runtime',
} as const

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
}

export interface PositionsResponse {
  /** The single currency everything is reported in (ADR-0002). */
  base_currency: string | null
  positions: Position[]
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
  symbols: RuntimeSymbol[]
  accounts: RuntimeAccount[]
}

export const api = {
  accounts: () => get<AccountsResponse>(ROUTES.accounts),
  positions: () => get<PositionsResponse>(ROUTES.positions),
  runtime: () => get<RuntimeState>(ROUTES.runtime),
}
