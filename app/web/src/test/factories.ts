/**
 * The payload factory — one factory, parameterised, never twenty frozen JSON
 * files. The model is `tests/conftest.py`'s `fake_ticker`: a test that needs an
 * account with no ledger builds it with one argument.
 *
 * ---------------------------------------------------------------------------
 * THE DEFAULT PORTFOLIO, AND ITS ARITHMETIC BY HAND
 *
 * Base currency EUR. Three accounts, three held positions, and each position is
 * one of the three cases the *real* portfolio cannot show:
 *
 *   account  symbol  qty  cost basis   price observed        valuation  unreal.
 *   -------  ------  ---  ----------   -------------------   ---------  ------
 *   alpha    ZZA      10    1 000,00   130,00 EUR            1 300,00   +300,00
 *   beta     ZZB       4      400,00   125,00 USD × 0,80       400,00      0,00
 *                                        = 100,00 EUR
 *   gamma    ZZC       6      600,00   none → carried at cost   600,00      0,00
 *   ---------------------------------------------------------------------------
 *   totals                   2 000,00                        2 300,00   +300,00
 *
 *   realised    0,00 + 50,00 + 0,00 = 50,00
 *   dividends  25,00 +  0,00 + 0,00 = 25,00
 *
 * Three terms out of four, then, and their sum is 375,00. The **fourth** comes
 * from the ledger and belongs to no position — the fees a broker takes out of a
 * transfer — and the totals fixture sets it at −5,00, so:
 *
 *   gain total  +300,00 + 50,00 + 25,00 − 5,00 = 370,00
 *
 * which is exactly what `total_value 2 800,00 − net_contributed 2 430,00`
 * comes to. That agreement is the fixture's whole point: `gain_absolu` in the
 * payload is the same number written down elsewhere, and the head is proved to
 * ignore it by handing it a different one.
 *
 * Every figure above is computable from its own terms, as `tests/test_e2e.py`
 * writes them: 10 × 130,00 = 1 300,00 and 1 300,00 − 1 000,00 = +300,00, read
 * off the page rather than off a fixture nobody can check.
 *
 * ---------------------------------------------------------------------------
 * THE THREE BLIND SPOTS, WHICH ARE WHY THE FACTORY EXISTS
 *
 *  - **N ≥ 3 accounts.** Nothing in the product was designed against it and the
 *    real portfolio has two; the navigation, the comparison and the totals are
 *    all judged at two.
 *  - **A held position in a foreign currency** (`ZZB`). The real portfolio has
 *    none — its one dollar line and its one ISIN line are both closed — so
 *    *waiting for the rate* and *no price at all* only ever appeared on closed
 *    rows, where nothing renders them.
 *  - **A held position with no price** (`ZZC`). None of the twelve held
 *    positions lacks one. The case becomes ordinary at the first boot of v5,
 *    during the rebuild, and never again.
 *
 * ---------------------------------------------------------------------------
 * AND WHAT IS *NOT* HERE: the real portfolio. Not a symbol, not an amount, not
 * a label. The decision boards the redesign was argued on embed 285 real events
 * and are git-ignored for that exact reason; a fixture that copied them would
 * walk them into a public repository. What is reproduced is the **shapes** that
 * decided — a foreign-currency line, a line with no quote, three accounts —
 * with invented values.
 */
import type {
  Account,
  AccountsResponse,
  PortfolioTotals,
  PortfolioTotalsResponse,
  Position,
  PositionsResponse,
  RuntimeState,
} from '@/lib/api'

/** The instant every fixture is written against. Tests freeze the clock to it. */
export const NOW = '2026-03-02T12:00:00.000Z'

export const BASE_CURRENCY = 'EUR'

export function anAccount(overrides: Partial<Account> = {}): Account {
  return { id: 'alpha', label: 'Alpha', type: 'PEA', ...overrides }
}

export interface PositionOptions extends Partial<Omit<Position, 'price' | 'converted'>> {
  /** The quote, in its own currency. `null` — never observed. */
  price?: number | null
  /** The quote's currency. Different from the base is the blind spot. */
  currency?: string
  /**
   * The rate applied to reach the base currency. `null` with a non-null price
   * is *waiting for the rate*, which is not the same absence as no price.
   */
  rate?: number | null
}

export function aPosition(options: PositionOptions = {}): Position {
  const {
    price = 130,
    currency = BASE_CURRENCY,
    rate = currency === BASE_CURRENCY ? 1 : null,
    ...rest
  } = options

  const base: Position = {
    account: 'alpha',
    symbol: 'ZZA',
    name: 'Zeta Alpha',
    quantity: 10,
    cost_basis: 1000,
    realised: 0,
    dividends: 0,
    price: price === null ? null : { value: price, currency, at: NOW },
    converted:
      price === null || rate === null
        ? null
        : { value: price * rate, currency: BASE_CURRENCY, rate, rate_at: NOW },
  }

  return { ...base, ...rest }
}

export function anAccountsPayload(
  accounts: Account[] = defaultAccounts(),
  declared = true,
): AccountsResponse {
  return { declared, accounts }
}

export function defaultAccounts(): Account[] {
  return [
    anAccount({ id: 'alpha', label: 'Alpha', type: 'PEA' }),
    anAccount({ id: 'beta', label: 'Beta', type: 'CTO' }),
    anAccount({ id: 'gamma', label: 'Gamma', type: 'CTO' }),
  ]
}

export function defaultPositions(): Position[] {
  return [
    aPosition({ account: 'alpha', symbol: 'ZZA', name: 'Zeta Alpha', dividends: 25 }),
    // Held, quoted in dollars, converted at 0,80.
    aPosition({
      account: 'beta',
      symbol: 'ZZB',
      name: 'Zeta Beta',
      quantity: 4,
      cost_basis: 400,
      realised: 50,
      price: 125,
      currency: 'USD',
      rate: 0.8,
    }),
    // Held, never quoted: carried at its cost.
    aPosition({
      account: 'gamma',
      symbol: 'ZZC',
      name: 'Zeta Gamma',
      quantity: 6,
      cost_basis: 600,
      price: null,
    }),
  ]
}

export function aPositionsPayload(
  positions: Position[] = defaultPositions(),
  baseCurrency: string | null = BASE_CURRENCY,
): PositionsResponse {
  return { base_currency: baseCurrency, positions }
}

/**
 * The global perf cache, one day of it — and the two figures the whole head
 * turns on:
 *
 *  - `gain_absolu` agrees with the four terms **here**, so a test that hands it
 *    a divergent value is testing one thing and not two;
 *  - the year-to-date pair is the measured one, `+40,69 €` against `−1,25 %`,
 *    of **opposite signs over the same period** and both correct: the portfolio
 *    grew by deposits while its holdings lost. That pair is why the euro and
 *    the percentage are two figures that never share a line.
 */
export function aTotals(overrides: Partial<PortfolioTotals> = {}): PortfolioTotals {
  return {
    day: '2026-03-02',
    total_value: 2800,
    holdings_value: 2300,
    cash_balance: 500,
    net_contributed: 2430,
    xirr: 0.0322,
    twr_index: 202.89,
    twr_since: '2019-10-30',
    transfer_fees: -5,
    gain_absolu: 370,
    ytd: { gain: 40.69, twr: -0.0125 },
    ...overrides,
  }
}

export function aTotalsPayload(
  totals: PortfolioTotals | null = aTotals(),
  baseCurrency: string | null = BASE_CURRENCY,
): PortfolioTotalsResponse {
  return { base_currency: baseCurrency, totals }
}

export function aRuntime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    now: NOW,
    scheduler_running: true,
    rebuilding: false,
    symbols: defaultPositions().map((position) => ({
      symbol: position.symbol,
      next_run: NOW,
      consecutive_failures: 0,
    })),
    accounts: defaultAccounts().map((account) => ({ account: account.id, horizon: NOW })),
    ...overrides,
  }
}
