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
  Advisory,
  ChartWindow,
  ConfigResponse,
  EnvironmentVariable,
  EventsResponse,
  LedgerEvent,
  PortfolioTotals,
  PortfolioTotalsResponse,
  Position,
  PositionsResponse,
  PriceSeriesResponse,
  Resolution,
  RuntimeState,
  SettingDescription,
  StoreState,
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
    closed_at: null,
  }

  return { ...base, ...rest }
}

/**
 * A position the owner has sold out of — `quantity` and `cost_basis` at exactly
 * zero (the dust clamp of ADR-0017 is the store's job), the realised gain and
 * the dividends surviving it, and a **closing date**, which is the one column
 * the folded section can sort on.
 */
export function aClosedPosition(options: PositionOptions & { closed_at: string }): Position {
  return aPosition({ quantity: 0, cost_basis: 0, price: null, ...options })
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

/**
 * THE SHARES PAGE'S PORTFOLIO — the three held lines above plus two closed ones,
 * and its arithmetic by hand:
 *
 *   line   qty  basis    price                value    latent  realised  divid.
 *   ----   ---  -------  -------------------  -------  ------  --------  ------
 *   ZZA     10  1 000,00 130,00 EUR           1 300,00 +300,00      0,00   25,00
 *   ZZB      4    400,00 125,00 USD × 0,80      400,00    0,00     50,00    0,00
 *   ZZC      6    600,00 none → at cost         600,00    0,00      0,00    0,00
 *   ZZD      0      0,00 closed 2025-11-04        0,00       —    120,00   10,00
 *   ZZE      0      0,00 closed 2026-01-15        0,00       —    −45,00    0,00
 *   -------------------------------------------------------------------------
 *   totals                                    2 300,00 +300,00   +125,00   35,00
 *
 *   Gain total  +300,00 + 125,00 + 35,00 = 460,00
 *
 * and **the figure the fold exists to prevent**: over the held lines alone the
 * three terms come to `+300,00 + 50,00 + 25,00 = 375,00`, which is not false —
 * it is the other correct figure, the one that is not the owner's gain. The gap
 * is 85,00 here and was 708,92 € (73 % of what was shown, over seven lines out
 * of nineteen) on the portfolio that decided it.
 */
export function sharesPortfolio(): Position[] {
  return [
    ...defaultPositions(),
    aClosedPosition({
      account: 'alpha',
      symbol: 'ZZD',
      name: 'Zeta Delta',
      realised: 120,
      dividends: 10,
      closed_at: '2025-11-04',
    }),
    aClosedPosition({
      account: 'beta',
      symbol: 'ZZE',
      name: 'Zeta Epsilon',
      realised: -45,
      closed_at: '2026-01-15',
    }),
  ]
}

/**
 * The rung the ladder serves for a window (ADR-0010) — as written under a year,
 * hourly from one to two, daily beyond. The handler answers this so a test can
 * see the resolution **change** with the range, which is the whole reason the
 * presets are `1M / 1A / 2A / MAX` and not four round numbers.
 */
export function resolutionFor(window: ChartWindow): Resolution {
  if (window === 'MAX') return 'day'
  if (window === '2Y') return 'hour'
  return 'raw'
}

export function aPriceSeries(
  overrides: Partial<PriceSeriesResponse> & { symbol?: string; window?: ChartWindow } = {},
): PriceSeriesResponse {
  const { window = '1Y', ...rest } = overrides
  return {
    symbol: 'ZZA',
    base_currency: BASE_CURRENCY,
    resolution: resolutionFor(window),
    points: [
      { ts: '2026-02-28T17:30:00.000Z', price: 126 },
      { ts: '2026-03-01T17:30:00.000Z', price: 128 },
      { ts: NOW, price: 130 },
    ],
    ...rest,
  }
}

/**
 * THE LEDGER — the shapes that decided the data page, with invented values.
 *
 * Four of them, and each is one of the readings that settled a criterion:
 *
 *  - **two purchases of the same security, on the same account**, told apart by
 *    their label alone. That is the nineteen-identical-purchases case at its
 *    smallest, and it is why the full-text search stopped being a convenience.
 *  - **a cash movement with no symbol at all** (`Apple Pay Top up` on the real
 *    portfolio). Its label is its whole identity, which is why the identity
 *    column is not `Titre`.
 *  - **a row with no provenance**, the only kind the app may edit. On the real
 *    portfolio there are 285 imported rows and 0 of these, which is exactly what
 *    the padlock column rendered 285 times.
 *
 * Every imported row carries a file **name** and a line, never a path: the
 * provenance is worth a label and a revocation unit, never an address.
 */
export function anEvent(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  const base: LedgerEvent = {
    date: '2026-02-10',
    event_type: 'BUY',
    account: 'alpha',
    symbol: 'ZZA',
    name: 'Zeta Alpha',
    notes: 'Ordre au marché, exécution partielle',
    quantity: 4,
    unit_price: 120,
    fee: 1.5,
    amount: null,
    source_id: 1,
    source_sheet: null,
    source_row: 118,
    provenance: 'zeta-events_2.csv, row 118',
    source_filename: 'zeta-events_2.csv',
    id: null,
  }
  return { ...base, ...overrides }
}

/** A row typed in the app: no source, and a key to address it by. */
export function aTypedEvent(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return anEvent({
    source_id: null,
    source_sheet: null,
    source_row: null,
    provenance: null,
    source_filename: null,
    id: 'typed-1',
    ...overrides,
  })
}

export function ledgerEvents(): LedgerEvent[] {
  return [
    anEvent({ date: '2026-02-10' }),
    // Same security, same account, same amounts to a euro: the label is the only
    // thing that tells the two apart.
    anEvent({
      date: '2026-01-12',
      notes: 'Versement programmé mensuel',
      quantity: 3,
      unit_price: 118,
      source_row: 96,
      provenance: 'zeta-events_2.csv, row 96',
    }),
    // No security at all — the label is the identity.
    anEvent({
      date: '2026-01-05',
      event_type: 'DEPOSIT',
      symbol: null,
      name: null,
      notes: 'Virement entrant depuis le compte courant',
      quantity: null,
      unit_price: null,
      fee: 0.35,
      amount: 500,
      source_row: 71,
      provenance: 'zeta-events_2.csv, row 71',
    }),
    // Typed in the app: no provenance, and therefore the one editable row.
    aTypedEvent({
      date: '2025-12-24',
      event_type: 'GRANT',
      symbol: 'ZZC',
      name: 'Zeta Gamma',
      notes: 'Attribution gratuite',
      quantity: 2,
      unit_price: null,
      fee: null,
    }),
  ]
}

/** The real portfolio's own shape: everything imported, nothing typed. */
export function importedOnly(): LedgerEvent[] {
  return ledgerEvents().filter((event) => event.source_id !== null)
}

export function aLedgerPayload(events: LedgerEvent[] = ledgerEvents()): EventsResponse {
  return events
}

export function aRuntime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    now: NOW,
    scheduler_running: true,
    rebuilding: false,
    // The ordinary installation is the mounted one (#741), so the factory's
    // default is the state that says nothing on screen; the other two are what
    // a test asks for by name.
    store: { persistence: 'persistent', path: '/data/suivi-bourse.duckdb' },
    symbols: defaultPositions().map((position, index) => ({
      symbol: position.symbol,
      next_run: NOW,
      consecutive_failures: 0,
      // Two markets open, one shut — the shape the cadence sentence exists for:
      // a portfolio-wide dial that reaches part of the portfolio has to say so,
      // or the reader concludes the rest is misconfigured.
      closed: index === 2,
      held: true,
    })),
    accounts: defaultAccounts().map((account) => ({ account: account.id, horizon: NOW })),
    ...overrides,
  }
}

// ------------------------------------------------------------------------- //
// THE INSTALLATION (#724) — the second tab's four reads.
//
// Its fixtures reproduce the three shapes that decided it and nothing else: an
// installation with a notice standing, a store on a mount, and no orphan. The
// two states a test asks for by name are the ephemeral store and an orphan
// symbol, because both are exactly what the block exists to render.
// ------------------------------------------------------------------------- //

/**
 * One dial, as `settings_registry.py` describes it — the list the form is
 * **drawn from**. The default here is the poll cadence, the one dial whose
 * change is retroactive and whose reach has to be quantified.
 */
export function aSetting(overrides: Partial<SettingDescription> = {}): SettingDescription {
  return {
    key: 'regular_interval',
    value: 120,
    default: 120,
    type: 'integer',
    minimum: 10,
    maximum: 86400,
    effect: 'rearm_scrape',
    doc: 'Poll cadence, in seconds.',
    stored: true,
    ...overrides,
  }
}

/** The six, in the registry's order. Nothing here is written twice by the form. */
export function defaultSettings(): SettingDescription[] {
  return [
    aSetting(),
    aSetting({ key: 'backfill_interval', value: 60, default: 60, effect: 'rearm_backfill_job' }),
    aSetting({ key: 'backfill_delay', value: 10, default: 10, minimum: 0, maximum: 3600, effect: 'next_cycle' }),
    aSetting({ key: 'backfill_chunk_days', value: 365, default: 365, minimum: 1, maximum: 3650, effect: 'next_cycle' }),
    aSetting({ key: 'staleness_horizon', value: 900, default: 900, minimum: 0, effect: 'next_cycle' }),
    aSetting({
      key: 'base_currency',
      value: BASE_CURRENCY,
      default: null,
      type: 'currency',
      minimum: null,
      maximum: null,
      effect: 'next_cycle',
      doc: 'The reporting currency, as an ISO-4217 code.',
    }),
  ]
}

/** The six boot variables — a **description**, never a form (ADR-0014, #740). */
export function defaultEnvironment(): EnvironmentVariable[] {
  return [
    { name: 'SB_STORE_DIR', value: '/data', set: false, source: 'default' },
    { name: 'SB_IMPORT_DIR', value: '/import', set: false, source: 'default' },
    { name: 'SB_WEB_PORT', value: '8080', set: true, source: 'environment' },
    { name: 'SB_PROMETHEUS_ENABLED', value: 'true', set: false, source: 'default' },
    { name: 'SB_METRICS_PORT', value: '8081', set: false, source: 'default' },
    { name: 'LOG_LEVEL', value: 'INFO', set: true, source: 'environment' },
  ]
}

export function aConfig(overrides: Partial<ConfigResponse> = {}): ConfigResponse {
  return {
    log_level: 'INFO',
    settings: defaultSettings(),
    environment: defaultEnvironment(),
    unread_environment: [],
    ...overrides,
  }
}

/**
 * One notice. The default is the **one the app cannot recompute** — *your
 * amounts were read as already being in the reporting currency* — because it is
 * the one a bulk acknowledgement would sweep away unread, and the only one with
 * a gesture inside the app.
 */
export function anAdvisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    key: 'assumed_base_currency',
    first_seen_at: '2026-03-01T09:00:00.000Z',
    acknowledged: false,
    acknowledged_at: null,
    message:
      'Your amounts were read as EUR. 2 event(s) on 1 line(s) quoted in USD (ZZB) were imported before any price had been observed.',
    detail: { base_currency: BASE_CURRENCY, symbols: ['ZZB'], events: [1, 2], currencies: ['USD'] },
    ...overrides,
  }
}

/** A notice about a file on disk: outside the app's reach, so no gesture in it. */
export function aLegacyFileAdvisory(overrides: Partial<Advisory> = {}): Advisory {
  return anAdvisory({
    key: 'legacy_config_file',
    message:
      '/config/config.yaml is still there and this version does not read it: a portfolio is a dated event ledger and nothing else.',
    detail: { path: '/config/config.yaml' },
    ...overrides,
  })
}

export function aStore(overrides: Partial<StoreState> = {}): StoreState {
  return {
    size_bytes: 26 * 1024 * 1024,
    ledger_last_write: '2026-02-10T08:30:00.000Z',
    // Absent at zero on screen: the list is the visible consequence of a forget
    // the reader has just made, not a maintenance table.
    orphans: [],
    persistence: 'persistent',
    ...overrides,
  }
}
