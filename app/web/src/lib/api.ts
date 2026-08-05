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
}
