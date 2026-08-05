/**
 * The API contract, as types.
 *
 * #655 decision 3 is explicit that TypeScript is here to make the *traps*
 * visible rather than to freeze the contract — the contract is disposable, the
 * traps are not. So the two that keep biting are encoded in the types
 * themselves:
 *
 *  - every money field is `number | null`, because `null` is a **normal**
 *    state (trap 3: a missing xirr is not a zero; a weekend hole is not missing
 *    data). A `number` would let a `?? 0` slip in and turn "no cost price" into
 *    "cost nothing";
 *  - `symbol` is the identity and `name` is display-only (trap 9 / déc. 3).
 */

/** An RFC 9457 problem, thrown for the *third* state: an actual failure. */
export class ApiProblem extends Error {
  readonly status: number
  readonly title: string
  readonly detail?: string
  readonly type?: string

  constructor(init: { status: number; title: string; detail?: string; type?: string }) {
    super(init.detail || init.title)
    this.name = 'ApiProblem'
    this.status = init.status
    this.title = init.title
    this.detail = init.detail
    this.type = init.type
  }
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } })
  const contentType = response.headers.get('content-type') ?? ''

  if (!response.ok) {
    if (contentType.includes('problem+json')) {
      throw new ApiProblem(await response.json())
    }
    // No problem+json means something in front of Flask answered — a proxy, or
    // the SPA catch-all if the /api guard ever regressed. Say that, rather than
    // failing later on a JSON parse in a component.
    throw new ApiProblem({
      status: response.status,
      title: `Réponse inattendue (${response.status})`,
      detail: `${path} n'a pas renvoyé de problem+json.`,
    })
  }
  return response.json() as Promise<T>
}

/** One share as held in one account — the detail sheet's breakdown row. */
export interface AccountPosition {
  account: string
  owned_quantity: number | null
  purchased_quantity: number | null
  cost_price: number | null
  purchased_fee: number | null
  received_dividend: number | null
  market_value: number | null
  invested: number | null
  plus_value_latente: number | null
}

/** One row of the shares table: a share aggregated across its accounts. */
export interface Share {
  /** The identity. Reads key on this, never on `name`. */
  symbol: string
  /** Display only — a rename must not split anything. */
  name: string | null
  currency: string | null
  exchange: string | null
  quote_type: string | null
  price: number | null
  price_time: string | null
  owned_quantity: number | null
  purchased_quantity: number | null
  cost_price: number | null
  purchased_fee: number | null
  received_dividend: number | null
  market_value: number | null
  invested: number | null
  /** Never call this "gain" — #652 déc. 6 keeps the two terms apart. */
  plus_value_latente: number | null
  plus_value_pct: number | null
  unit_gain: number | null
  dividend_yield: number | null
  pe_ratio: number | null
  market_cap: number | null
  accounts: AccountPosition[]
  /** Reserved for #656's live scheduler state; always null until it lands. */
  status: string | null
}

export interface PricePoint {
  t: string | null
  price: number | null
}

export interface PriceSeries {
  symbol: string
  from: string
  to: string
  /** The SQL bucket used, or null when the series is raw. Shown, not hidden. */
  bucket: string | null
  points: PricePoint[]
}

export type EventType = 'BUY' | 'SELL' | 'GRANT' | 'DIVIDEND' | 'DEPOSIT' | 'WITHDRAWAL'

export interface LedgerEvent {
  /** Opaque. Round-trip it; never parse it (#653: no file/row in the contract). */
  id: string
  /** Content fingerprint — becomes `If-Match` when the Data page can write. */
  etag: string
  /** Display-only provenance: the file's name (#652 déc. 14's discreet column). */
  source: string
  /** False for xlsx, which is read-only on the edit path. */
  editable: boolean
  error: string | null
  date?: string
  event_type?: EventType
  symbol?: string | null
  name?: string | null
  quantity?: number | null
  unit_price?: number | null
  fee?: number | null
  amount?: number | null
  notes?: string | null
  account?: string | null
}

export interface DeclaredAccount {
  id: string
  label: string
  type: string
  currency: string
}

/**
 * The dashboard head, as a **discriminated union** (#655 déc. 8).
 *
 * This is the type doing the most work in the file. #652 déc. 6 fixed two terms
 * that must never be conflated — **Gain** (total value − net contributed, needs
 * declared accounts) and **plus-value latente** (holdings + dividends − invested
 * − fees, always computable) — and the union is what makes conflating them a
 * compile error rather than a discipline: `gain_absolu` does not exist on the
 * `titres` variant, so reading it there does not typecheck.
 *
 * `mode` is decided by the server from the *configuration*, never from which
 * fields came back null. That is what keeps "you have not declared accounts"
 * and "the perf job has not run yet" two different screens.
 */
export interface PortfolioBaseline {
  since: string
  total_value: number | null
  change: number | null
  change_pct: number | null
}

export interface AccountsPortfolio {
  mode: 'accounts'
  currency: string | null
  as_of: string | null
  total_value: number | null
  cash_balance: number | null
  holdings_value: number | null
  net_contributed: number | null
  gain_absolu: number | null
  xirr: number | null
  twr_index: number | null
  baseline: PortfolioBaseline | null
}

export interface TitresPortfolio {
  mode: 'titres'
  currency: string | null
  as_of: string | null
  holdings_value: number | null
  invested: number | null
  received_dividend: number | null
  purchased_fee: number | null
  plus_value_latente: number | null
  plus_value_pct: number | null
  baseline: null
}

/**
 * The third case. `portfolio_totals` is not written at all when the declared
 * accounts disagree on currency, so there is no consolidated head to render and
 * none is invented — the API states the condition instead. What a consolidated
 * view of a mixed portfolio *should* show is still an open product question.
 */
export interface MultiCurrencyPortfolio {
  mode: 'multi_currency'
  currencies: string[]
  accounts: { id: string; label: string; currency: string }[]
}

export type Portfolio =
  | AccountsPortfolio
  | TitresPortfolio
  | MultiCurrencyPortfolio

/**
 * The main chart. The field names carry #652 déc. 7's distinction rather than
 * describing it: `contributed` is money the investor put in, `invested` is what
 * the positions cost. Two different curves; one name for both is how they would
 * end up conflated.
 */
export interface PortfolioHistoryWindow {
  from: string
  to: string
}

export type PortfolioHistory = PortfolioHistoryWindow &
  (
    | { mode: 'accounts'; points: { t: string | null; value: number | null; contributed: number | null }[] }
    | { mode: 'titres'; points: { t: string | null; value: number | null; invested: number | null }[] }
    | { mode: 'multi_currency'; points: never[] }
  )

export interface Mover {
  symbol: string
  name: string | null
  /** Per row, not per response — which is what lets the block survive a
   *  mixed-currency portfolio the head refuses to consolidate. */
  currency: string | null
  price: number | null
  previous_price: number | null
  change: number | null
  change_pct: number | null
  market_value: number | null
  /** `change × owned_quantity` — what the move was worth. A 12 % jump on a token
   *  holding and a 0.4 % drift on the biggest line are not the same news. */
  contribution: number | null
}

export interface MoversResponse {
  /**
   * The **cut** the rule defines — midnight of the newest observation's day.
   * `null` on a fresh install, where there is no observation to anchor on.
   */
  since: string | null
  /**
   * The newest price actually found at or before that cut, i.e. the close the
   * comparison rests on. Label the block with **this**, not with `since`: on the
   * afternoon of 5 August the cut is 5 August 00:00, and naming it announced a
   * close that had not happened yet.
   */
  reference: string | null
  movers: Mover[]
}

/**
 * `declared: false` is a designed state, not an empty list — the opt-out setup
 * every default install runs. #655 decision 8's discriminator rule: the server
 * states the condition instead of leaving the front to infer it from `[]`.
 */
export interface AccountsResponse {
  declared: boolean
  accounts: DeclaredAccount[]
}

export const api = {
  shares: () => get<Share[]>('/api/shares'),
  share: (symbol: string) => get<Share>(`/api/shares/${encodeURIComponent(symbol)}`),
  prices: (symbol: string, from: Date, to: Date) =>
    get<PriceSeries>(
      `/api/shares/${encodeURIComponent(symbol)}/prices` +
        `?from=${from.toISOString()}&to=${to.toISOString()}`,
    ),
  events: (symbol?: string) =>
    get<LedgerEvent[]>('/api/events' + (symbol ? `?symbol=${encodeURIComponent(symbol)}` : '')),
  accounts: () => get<AccountsResponse>('/api/accounts'),
  portfolio: (since?: Date) =>
    get<Portfolio>(
      '/api/portfolio' + (since ? `?since=${since.toISOString()}` : ''),
    ),
  portfolioHistory: (from: Date, to: Date) =>
    get<PortfolioHistory>(
      `/api/portfolio/history?from=${from.toISOString()}&to=${to.toISOString()}`,
    ),
  movers: () => get<MoversResponse>('/api/portfolio/movers'),
}
