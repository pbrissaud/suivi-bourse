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
  /**
   * The validator's own messages, on a 422 (#653: a rejected save says *which*
   * row). Empty for every other problem, so a caller can render them
   * unconditionally.
   */
  readonly errors: string[]

  constructor(init: {
    status: number
    title: string
    detail?: string
    type?: string
    errors?: string[]
  }) {
    super(init.detail || init.title)
    this.name = 'ApiProblem'
    this.status = init.status
    this.title = init.title
    this.detail = init.detail
    this.type = init.type
    this.errors = init.errors ?? []
  }
}

async function unwrap<T>(response: Response, path: string): Promise<T> {
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

async function get<T>(path: string): Promise<T> {
  return unwrap<T>(
    await fetch(path, { headers: { Accept: 'application/json' } }),
    path,
  )
}

async function send<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: 'application/json', ...headers } }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return unwrap<T>(await fetch(path, init), path)
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
  /** Content fingerprint, sent back as `If-Match` on every write. */
  etag: string
  /** Display-only provenance: the file's name (#652 déc. 14's discreet column). */
  source: string
  /** False for xlsx, which is read-only on the edit path. */
  editable: boolean
  error: string | null
  /**
   * The raw cells, present **only** when the row failed to parse — and that is
   * the whole repair journey: a broken row has no typed fields to show, so
   * without these the ledger could name the problem and offer nothing to fix.
   */
  cells?: Record<string, string>
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

/** The columns a CSV row holds, in the documented order. */
export const EVENT_COLUMNS = [
  'date',
  'event_type',
  'symbol',
  'name',
  'quantity',
  'unit_price',
  'fee',
  'amount',
  'notes',
  'account',
] as const

export type EventColumn = (typeof EVENT_COLUMNS)[number]

/** One event as the write endpoints take it: cells, not types. */
export type EventDraft = Partial<Record<EventColumn, string>>

/**
 * What a write did — including the half that did not go well.
 *
 * `reloaded: false` is not an error and not a success either: the bytes landed,
 * and the configuration still will not load. It happens by design when the
 * files were *already* invalid and the edit is one step of a repair, so the
 * page has to say "saved, still broken" rather than pick one of the two.
 */
export interface WriteResult {
  reloaded: boolean
  errors: string[]
  event?: LedgerEvent
  source?: string
}

/** One event file, as the badge and the convert action see it. */
export interface EventFile {
  name: string
  /** False for a workbook: saving one would write over its formulas. */
  editable: boolean
  rows: number
}

/** A position as `config.yaml` declares it — the manual screen's content. */
export interface DeclaredShare {
  name: string
  symbol: string
  account?: string
  purchase: { quantity: number; cost_price: number; fee: number }
  estate: { quantity: number; received_dividend: number }
}

/**
 * What kind of installation this is. Asked once by the data page, which has two
 * entirely different screens to choose between — and `editable` is asked with
 * it so an unwritable mount is a sentence rather than a failed first save.
 */
export interface ConfigInfo {
  mode: 'events' | 'manual'
  editable: boolean
  read_only_reason: string | null
  log_level: string
  shares: DeclaredShare[]
}

export interface DeclaredAccount {
  id: string
  label: string
  type: string
  currency: string
}

/**
 * One row of the accounts comparison table: the declaration joined to the newest
 * `account_metrics` point.
 *
 * Every figure is nullable for two *different* reasons, and both are normal.
 * `as_of === null` means the account is declared but its first perf cycle has
 * not run — the row exists, the figures do not yet. A null `xirr` on a row that
 * *has* an `as_of` is trap 3: the rate is written only once an external flow
 * exists, so it is absent by design rather than zero.
 *
 * `as_of` is a **day**, not an instant: the series is midnight-stamped and
 * today's point is rewritten in place through the day (trap 2), which is what
 * the client cache has to expect.
 */
export interface AccountSummary extends DeclaredAccount {
  as_of: string | null
  cash_balance: number | null
  holdings_value: number | null
  total_value: number | null
  net_contributed: number | null
  gain_absolu: number | null
  xirr: number | null
  twr_index: number | null
}

export interface AccountHistoryPoint {
  t: string | null
  cash_balance: number | null
  holdings_value: number | null
  total_value: number | null
  net_contributed: number | null
  twr_index: number | null
}

/** One account's perf series. No `currency`: the collection owns it. */
export interface AccountHistory {
  account: string
  from: string
  to: string
  points: AccountHistoryPoint[]
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
  accounts: AccountSummary[]
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
  accountHistory: (id: string, from: Date, to: Date) =>
    get<AccountHistory>(
      `/api/accounts/${encodeURIComponent(id)}/history` +
        `?from=${from.toISOString()}&to=${to.toISOString()}`,
    ),
  portfolio: (since?: Date) =>
    get<Portfolio>(
      '/api/portfolio' + (since ? `?since=${since.toISOString()}` : ''),
    ),
  portfolioHistory: (from: Date, to: Date) =>
    get<PortfolioHistory>(
      `/api/portfolio/history?from=${from.toISOString()}&to=${to.toISOString()}`,
    ),
  movers: () => get<MoversResponse>('/api/portfolio/movers'),

  // ----------------------------------------------------------------------- //
  // The write half (issue #662)
  // ----------------------------------------------------------------------- //

  config: () => get<ConfigInfo>('/api/config'),

  createEvent: (draft: EventDraft) => send<WriteResult>('POST', '/api/events', draft),

  /**
   * `If-Match` is required, not optional. The id is an *address* — a position
   * in a file — so without the fingerprint a ledger reordered by hand between
   * the read and the write would silently edit a different event.
   */
  updateEvent: (id: string, etag: string, draft: EventDraft) =>
    send<WriteResult>('PATCH', `/api/events/${encodeURIComponent(id)}`, draft, {
      'If-Match': etag,
    }),

  deleteEvent: (id: string, etag: string) =>
    send<WriteResult>('DELETE', `/api/events/${encodeURIComponent(id)}`, undefined, {
      'If-Match': etag,
    }),

  eventFiles: () => get<EventFile[]>('/api/events/files'),

  importEventFile: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return send<WriteResult>('POST', '/api/events/files', form)
  },

  convertEventFile: (name: string) =>
    send<WriteResult>('POST', `/api/events/files/${encodeURIComponent(name)}/convert`),

  setAccounts: (accounts: DeclaredAccount[]) =>
    send<WriteResult>('PUT', '/api/accounts', { accounts }),

  setLogLevel: (level: string) =>
    send<{ log_level: string }>('PUT', '/api/config/log-level', { level }),
}
