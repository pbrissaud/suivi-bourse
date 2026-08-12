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
  /** The ledger itself — read, and written one row at a time (#723). */
  events: '/api/events',
  /** One row of it. A **pattern**, like {@link ROUTES.prices}. */
  event: '/api/events/:id',
  /** What this install is configured with: the dials and the boot variables. */
  config: '/api/config',
  /** The dials' one writer, and it is an HTTP route so headless stays whole. */
  settings: '/api/settings',
  /** What this install has been told and has not acknowledged (#709). */
  advisories: '/api/advisories',
  /** One advisory's acknowledgement. A **pattern**, like {@link ROUTES.prices}. */
  advisoryAcknowledgement: '/api/advisories/:key/acknowledgement',
  /** The store's own figures — size, last ledger write, orphans (#724). */
  store: '/api/store',
  /** The orphans as a collection: the only thing done to it is removing it. */
  storeOrphans: '/api/store/orphans',
} as const

export function eventPath(id: string): string {
  return `/api/events/${encodeURIComponent(id)}`
}

export function advisoryAcknowledgementPath(key: string): string {
  return `/api/advisories/${encodeURIComponent(key)}/acknowledgement`
}

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

/**
 * The write half, and it goes through the same `unwrap`: a refusal is a
 * `problem+json` whose `type` the caller branches on, exactly like a failed
 * read. There is no second error contract for writes.
 */
async function send<T>(path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown): Promise<T> {
  return unwrap<T>(
    await fetch(path, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    path,
  )
}

/**
 * A removal, with no body either way in. It is a third verb rather than a
 * `POST` to a verb-shaped path because what the one caller does to the orphan
 * collection is remove it whole (#724).
 */
async function remove<T>(path: string): Promise<T> {
  return unwrap<T>(await fetch(path, { method: 'DELETE', headers: { Accept: 'application/json' } }), path)
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
  /**
   * Was this symbol's market shut on its **last completed pass**? `null` — it
   * has never completed one.
   *
   * It is what the scheduler *acted on*, which is why the settings form counts
   * the reach of a new cadence off it rather than off `next_run`: the armed time
   * cannot tell a dead-ticker back-off from a market close, and it inverts the
   * moment the dial it would be compared against is the one being changed
   * (#701). Optional in the type, because a client that has it must not break
   * on a server that has not published it yet.
   */
  closed?: boolean | null
  /**
   * Whether anybody holds it. A sold line is reconstructed and not polled, so
   * it is in this row set and out of the cadence's reach.
   */
  held?: boolean
}

export interface RuntimeAccount {
  account: string
  /** How far back the rebuild has reached for this account. */
  horizon: string | null
}

/**
 * Does the store outlive the container? (issue #741, ADR-0015)
 *
 * Observed once at boot from `/proc/self/mountinfo` and answered from process
 * memory, which is why it travels on this resource and not beside the figures.
 *
 * `unknown` is a real answer and not a placeholder: the observation is a
 * property of the kernel, so a deployment with no `/proc` — a developer on
 * macOS — has nothing to report, and a reader must not turn that silence into
 * either of the other two. The data page's *store* block (#724) is what renders
 * the three; nothing else on the front branches on it.
 */
export type StorePersistence = 'persistent' | 'ephemeral' | 'unknown'

export interface RuntimeStore {
  persistence: StorePersistence
  /**
   * Where the file is. Boot knowledge, so it travels beside the persistence
   * rather than on the store's own resource — the two are read as one line
   * (*the path, and whether it survives*), and the pair has to stay legible on
   * the one failure where the store cannot answer for itself.
   *
   * `null` is a process that named no store, which a browser will not meet and
   * a test runtime does. Never an empty string, which reads as a root.
   */
  path: string | null
}

export interface RuntimeState {
  now: string
  scheduler_running: boolean
  store: RuntimeStore
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

// ------------------------------------------------------------------------- //
// The ledger (#723, ADR-0020, ADR-0005)
//
// **The shape below is the one `GET /api/events` already serves**, field for
// field, and that is deliberate: #718 mounted a head over two routes nobody had
// written and turned a page from *not built yet* into *the app is not
// answering*, which took #763 to repair. Here the read exists, so the page is
// written on it rather than on a nicer shape somebody would have to catch up
// with — a client that had renamed the members would render an **empty ledger**
// on a full install, which is worse than a 404 because it reads as a fact.
//
// Two members are **additions**, both optional in the type so that today's
// server renders the page whole, and each is what one criterion of #723 rests
// on:
//
//  - **`source_filename`** — the provenance is worth exactly two things
//    (ADR-0020): a displayable label and the unit of revocation. Never an
//    address, and never the file's presence on disk — the drop folder is an
//    optional read-only bind (ADR-0015), so *file not found* would be a
//    permanent false defect on every install without one. The store renders a
//    label of its own (`2024.csv, row 14`) and the front cannot use it: a
//    rendering follows the **reader's** language (ADR-0024), so what the front
//    needs is the file's name, not a sentence about it. Absent, the served
//    label is shown rather than an em dash — which would say *typed here*, and
//    that is a different row.
//  - **`id`** — a row the app itself created is the one kind it may edit, and
//    editing needs an address. That address is a **primary key**, which is the
//    whole of what killed #662's apparatus: the opaque token over `(file, sheet,
//    row)`, the content fingerprint as an `ETag` and its `409` existed because
//    the *file* was the address and a file address goes stale between the read
//    and the write. Absent — today, on every row — the editor is not offered at
//    all, which is exactly what the criterion says happens on an install that
//    has only ever imported.
//
// And one route is genuinely new: **`POST /api/events`**, without which the
// create form has nowhere to write. It is ADR-0005's onboarding rather than a
// convenience — manual mode is gone, so typing a position *is* creating dated
// events — and it is announced here, in the one module that knows a URL.
// `PATCH` is its bounded sibling: `web/api.py` states that no sibling edits an
// *imported* event, and that argument is about a file being read-only, not
// about a row somebody typed here a minute ago.
// ------------------------------------------------------------------------- //

/**
 * The six, in the order the form offers them — the two acquisitions, the
 * disposal, the income, then the two cash movements. The catalogue names them by
 * their **effect** (`Free shares`, `Cash in`, `Cash out`) rather than by their
 * code: six codes are a decoding exercise at the exact moment a first-time owner
 * has nothing yet to decode them against.
 */
export const EVENT_TYPES = ['BUY', 'SELL', 'GRANT', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL'] as const

export type LedgerEventType = (typeof EVENT_TYPES)[number]

export interface LedgerEvent {
  /** A calendar day, `YYYY-MM-DD` — never an instant (the store's own rule). */
  date: string | null
  event_type: LedgerEventType
  /** `null` on a cash movement, which names no security at all. */
  symbol: string | null
  /** The security's name. Read by no column of the ledger — see #723. */
  name: string | null
  quantity: number | null
  /** In the reporting currency — an event amount is a debit (ADR-0002). */
  unit_price: number | null
  fee: number | null
  amount: number | null
  /** The row's free text. On a cash movement it is the whole identity. */
  notes: string | null
  /** Blank means `default`, which is the aggregator's own rule. */
  account: string
  /** The import this row came from — `null` is *typed in the app*. */
  source_id: number | null
  source_sheet: string | null
  source_row: number | null
  /** The store's own label. A fallback, never the rendering (ADR-0024). */
  provenance: string | null
  /** #723: the file's **name**, so the label follows the reader's language. */
  source_filename?: string | null
  /** #723: the key a row typed here is addressed by. Absent on an import. */
  id?: string | null
}

/** A bare collection, as served: `200` + `[]` on an install that has nothing. */
export type EventsResponse = LedgerEvent[]

/**
 * What the form sends. Deliberately **not** a `LedgerEvent` minus a few fields:
 * the row's key and its provenance are the store's to write, and a client that
 * could name either would be a client that could forge one.
 *
 * `name` is not a member either. It is an attribute of the *security*, not of
 * each of its events — the reason `Nom` left the table is the reason it never
 * enters here — and the symbol is what identifies the line.
 */
export interface EventDraft {
  date: string
  event_type: LedgerEventType
  account: string
  symbol: string | null
  notes: string | null
  quantity: number | null
  unit_price: number | null
  fee: number | null
  amount: number | null
}

// ------------------------------------------------------------------------- //
// The installation (#724, ADR-0014, ADR-0020, ADR-0021)
//
// The second tab of the data page reads four resources and writes two, and the
// split between them is **ADR-0014's boot test**, not a grouping of
// convenience: what the process had to know before it could open the store
// (`environment`) can never be a dial, and what lives in the store (`settings`)
// can never need a restart. That line is why the two halves render as two
// sections of **one** surface, the second a description rather than a form.
// ------------------------------------------------------------------------- //

/**
 * One dial, as the registry describes it — `settings_registry.py` is the single
 * list, and this is that list crossing HTTP. The form is **drawn from it**
 * rather than written out: a second enumeration of the dials in a component
 * would agree with the registry on the day it was written and not much longer,
 * which is the whole argument of ADR-0014.
 */
export interface SettingDescription {
  key: string
  /** The effective value: the row if there is one, the code's default otherwise. */
  value: string | number | null
  default: string | number | null
  type: 'integer' | 'string' | 'currency'
  minimum: number | null
  maximum: number | null
  /** What changing it triggers, as a token the catalogue turns into a sentence. */
  effect: string
  /** The registry's own English note. Diagnostic, like `problem.detail`. */
  doc: string
  /**
   * Whether the store holds an answer. Published rather than derived from
   * `value !== default`: a dial answered *at* its default is answered, and
   * `base_currency` is the one whose two states decide a whole screen.
   */
  stored: boolean
}

/**
 * One boot variable — what the process had to know before it could open the
 * store (ADR-0014). **Six and no seventh** (#740).
 *
 * It is a *description*: rendered as greyed-out fields it invites the click and
 * reads as a form that refused, when the honest statement is that nothing here
 * is answerable from in here at all. The section says *changes when the
 * container is recreated* **once**, for all of them.
 */
export interface EnvironmentVariable {
  name: string
  /** What the app is running on — the variable's, or the app's own default. */
  value: string | null
  /** Whether the environment named it at all. */
  set: boolean
  /**
   * Where the value came from, and it is **factual rather than helpful**:
   * reporting a variable as *unset, using the default* because it happens to
   * equal the default would be a guess (#654 trap 2).
   */
  source: 'environment' | 'default'
}

export interface ConfigResponse {
  log_level: string
  settings: SettingDescription[]
  environment: EnvironmentVariable[]
  /** Set in the environment and obeyed by nothing. Computed, so it cannot drift. */
  unread_environment: string[]
}

/** What `PUT /api/settings` answers: the new list, what moved, and what it reached. */
export interface SettingsWriteResponse {
  settings: SettingDescription[]
  changed: string[]
  /**
   * The effect, **quantified**. A portfolio-wide cadence that reaches 3 symbols
   * out of 12 has to say so — the other nine are not misconfigured, they read
   * the new value when their market opens.
   */
  effect: Record<string, unknown>
}

/**
 * One standing advisory (#709, ADR-0021).
 *
 * `message` is the **server's** sentence, in English, and it is the one place
 * the front renders a string it did not write. That is not a hole in ADR-0024:
 * an advisory names paths, variables and symbols this installation holds, the
 * closed list of five lives in `advisories.py` beside its predicate, and a
 * catalogue key per advisory would be a second authority on what each one says.
 * What the interface writes in the reader's language is everything around it —
 * the block, the gesture, and what to do when there is nothing to press.
 */
export interface Advisory {
  key: string
  first_seen_at: string
  acknowledged: boolean
  acknowledged_at: string | null
  message: string
  /** What it names right now, re-derived per read. `null` — not observable here. */
  detail: Record<string, unknown> | null
}

export type AdvisoriesResponse = Advisory[]

/** One orphan symbol: nothing declares it, and this is the series it holds. */
export interface OrphanSymbol {
  symbol: string
  points: number
}

/**
 * The store's own figures. The path and the persistence are **not** here — they
 * are process memory and ride on `/api/runtime`, which opens nothing and is
 * therefore still answering when this resource is not.
 */
export interface StoreState {
  /** The file and its write-ahead log. `null` — nothing written yet. */
  size_bytes: number | null
  /**
   * The newest import, and never the newest observed price: that second one is
   * liveness, it belongs to the banner, and here it would make a store whose
   * last import was a year ago read as freshly written.
   */
  ledger_last_write: string | null
  orphans: OrphanSymbol[]
  /** Repeated from the runtime so a report quoting this resource is whole. */
  persistence: StorePersistence
}

/** What the purge answers: rows, and never bytes. */
export interface PurgeResult {
  symbols: string[]
  points_removed: number
}

export const api = {
  accounts: () => get<AccountsResponse>(ROUTES.accounts),
  events: () => get<EventsResponse>(ROUTES.events),
  createEvent: (draft: EventDraft) => send<LedgerEvent>(ROUTES.events, 'POST', draft),
  updateEvent: (id: string, draft: EventDraft) => send<LedgerEvent>(eventPath(id), 'PATCH', draft),
  positions: () => get<PositionsResponse>(ROUTES.positions),
  portfolioTotals: () => get<PortfolioTotalsResponse>(ROUTES.portfolioTotals),
  prices: (symbol: string, window: ChartWindow) =>
    get<PriceSeriesResponse>(pricesPath(symbol, window)),
  runtime: () => get<RuntimeState>(ROUTES.runtime),
  config: () => get<ConfigResponse>(ROUTES.config),
  saveSettings: (values: Record<string, string | number>) =>
    send<SettingsWriteResponse>(ROUTES.settings, 'PUT', values),
  advisories: () => get<AdvisoriesResponse>(ROUTES.advisories),
  acknowledgeAdvisory: (key: string) =>
    send<Advisory>(advisoryAcknowledgementPath(key), 'POST', {}),
  store: () => get<StoreState>(ROUTES.store),
  purgeOrphans: () => remove<PurgeResult>(ROUTES.storeOrphans),
}
