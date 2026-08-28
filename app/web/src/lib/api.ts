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
  /** One declared account. A **pattern**, like {@link ROUTES.prices} (#729). */
  account: '/api/accounts/:id',
  /**
   * The events nobody assigned, moved onto one declared account (#725).
   *
   * A **collection** gesture and never a row one: no event id crosses the wire,
   * the population is the `account` column's own value, and the mapping table a
   * client might send instead is refused by ADR-0006 — it would be a second
   * truth about the account an event names. It is a resource of the account
   * rather than of the ledger because the target is what bounds the exception:
   * an account that is neither the seeded row nor unknown *is* the first
   * declaration, which is the one instant those rows may be rewritten at.
   */
  accountReassignment: '/api/accounts/:id/reassignment',
  positions: '/api/positions',
  portfolioTotals: '/api/portfolio-totals',
  /**
   * One symbol's price series. A **pattern**, `:symbol`, because it is what the
   * harness's handler registers; {@link pricesPath} is what a caller builds.
   */
  prices: '/api/prices/:symbol',
  runtime: '/api/runtime',
  /**
   * **The one route with no `/api` prefix**, and it is not an oversight (#819,
   * ADR-0036): it is the container's own probe, written into the image's
   * `HEALTHCHECK` long before a browser read it, and renaming it to please this
   * table would break the one reader the app is sure to have.
   *
   * It is what the **status dot** reads. The trade is stated in ADR-0036: the
   * dot used to read `/api/runtime`, which touches no store and therefore
   * survives one that has failed, and health is now said in one place. The cost
   * is that the body goes when the store goes — and what survives that is the
   * half that matters then, a `503` the dot renders **red**.
   */
  health: '/health',
  /** The ledger itself — read, and written one row at a time (#723). */
  events: '/api/events',
  /** One row of it. A **pattern**, like {@link ROUTES.prices}. */
  event: '/api/events/:id',
  /**
   * A file handed over, read once, and written as ordinary events (#811,
   * ADR-0032).
   *
   * It is `/api/events/import` and not `/api/imports` because **an import is no
   * longer a resource**: nothing persists that could be named, so it is a
   * gesture on the collection it writes. What comes back is a receipt — what
   * the gesture produced — and never an id to come back to.
   */
  eventsImport: '/api/events/import',
  /**
   * The ledger back out, in the format it came in by (#710) — **the events, and
   * only them** (ADR-0034). There was a second file, the declaration, because a
   * round trip needed both; no accounts file is read back in any more, so one
   * that left would look like half a restore without being one. The accounts
   * are redeclared in the app, which is the only place they are ever declared.
   *
   * The events resource takes the ledger's own reduction on its query string
   * since #796 (`q`, `type`, `account`, repeated `symbol`), and answers it in
   * either shape: the `.csv` that re-imports bit for bit, and the `.xlsx` laid
   * out one sheet per year. The reduction is applied **there** and never here —
   * the importable form belongs to `events/export.py`, and a partial file
   * assembled on this side would be a second spelling of it.
   */
  exportEvents: '/api/export/events.csv',
  exportEventsWorkbook: '/api/export/events.xlsx',
  /** What this install is configured with: the dials and the boot variables. */
  config: '/api/config',
  /** The dials' one writer, and it is an HTTP route so headless stays whole. */
  settings: '/api/settings',
  /** What this install has been told and has not acknowledged (#709). */
  installationFacts: '/api/installation-facts',
  /** One installation fact's acknowledgement. A **pattern**, like {@link ROUTES.prices}. */
  installationFactAcknowledgement: '/api/installation-facts/:key/acknowledgement',
  /**
   * What the owner's **data** says about itself (#829, ADR-0037) — derived on
   * every read and stored nowhere, so this is a collection with no ids to come
   * back to and no dates but the instant it was derived at.
   */
  advisories: '/api/advisories',
  /**
   * One advisory put to sleep for thirty days. A **pattern**, like
   * {@link ROUTES.prices} — and it is `acknowledgement` like its neighbour
   * because it is the same gesture; what differs is how long it lasts, which is
   * the payload's business and not the route's.
   */
  advisoryAcknowledgement: '/api/advisories/:key/acknowledgement',
  /** The store's own figures — size, last ledger write, orphans (#724). */
  store: '/api/store',
  /** The orphans as a collection: the only thing done to it is removing it. */
  storeOrphans: '/api/store/orphans',
  /** One account's perf series. A **pattern**, like {@link ROUTES.prices}. */
  accountHistory: '/api/accounts/:account/history',
  /** The global perf series — the same five members, one level up (#721). */
  portfolioTotalsHistory: '/api/portfolio-totals/history',
  /**
   * What the holdings were worth day by day, against what they cost (#727) —
   * the series `/api/positions` is one instant of, and the **fallback reading**
   * of the dashboard's one chart.
   */
  positionsHistory: '/api/positions/history',
  /**
   * What moved since the last session close (#727).
   *
   * It keeps its `/portfolio/` prefix, which is the one v4 name a v5 page reads,
   * and that is a decision rather than an oversight: the payload is **already**
   * the v5 shape — no `?mode=` discriminator, no per-row currency since #702,
   * the carrying convention of ADR-0004 applied — so a second route serving the
   * identical body would be two resources over one computation. What the rule
   * *"a resource carries the name of the store's table"* forbids is reusing a v4
   * name for a **different** payload, and this is the same one.
   */
  movers: '/api/portfolio/movers',
} as const

export type RouteName = keyof typeof ROUTES

/**
 * The routes no page ever **reads** — every one of them is a gesture.
 *
 * The split exists for one consumer, the in-flight test (ADR-0026): it draws
 * its net from `ROUTES` rather than from a list of its own, so a fifth block
 * reading an already-served route is covered the day it is written, and a route
 * declared here that no page visits fails it. A gesture has no in-flight state
 * to hold a page hostage to — nothing is rendered on the strength of a `PUT`
 * that has not returned — so it is subtracted here rather than excused there.
 *
 * `accounts` and `events` are **not** in it: both are read and written, and the
 * read is what the net is about.
 */
export const WRITE_ONLY_ROUTES = [
  'settings',
  'event',
  // A gesture, and the plainest one on this list: nothing on any page is
  // rendered on the strength of an upload in flight — the receipt is what the
  // gesture answers, and it is the reader's own act rather than a read.
  'eventsImport',
  'account',
  'accountReassignment',
  'installationFactAcknowledgement',
  'advisoryAcknowledgement',
  'storeOrphans',
  // The two exports are in here for what they are, not for who fetches them:
  // **nothing on any page is rendered on the strength of one**, which is
  // exactly the property this list names. Since #796 the client does fetch them
  // — the receipt has to last as long as the operation, and an `href` the
  // browser follows on its own settles at no observable moment — but a gesture
  // in flight holds no surface hostage, so none of them is a read the net has
  // anything to say about.
  'exportEvents',
  'exportEventsWorkbook',
] as const satisfies readonly RouteName[]

/** Every route a page reads — the net, computed and never written down twice. */
export const READ_ROUTES: readonly string[] = (Object.keys(ROUTES) as RouteName[])
  .filter((name) => !(WRITE_ONLY_ROUTES as readonly string[]).includes(name))
  .map((name) => ROUTES[name])

export function eventPath(id: string): string {
  return `/api/events/${encodeURIComponent(id)}`
}

export function accountPath(id: string): string {
  return `/api/accounts/${encodeURIComponent(id)}`
}

export function accountReassignmentPath(id: string): string {
  return `${accountPath(id)}/reassignment`
}

export function installationFactAcknowledgementPath(key: string): string {
  return `/api/installation-facts/${encodeURIComponent(key)}/acknowledgement`
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
export interface ProblemBody {
  status: number
  type?: string | null
  title?: string | null
  detail?: string | null
  /** Everything else the server put in the object — see `members` below. */
  [member: string]: unknown
}

export class ApiProblem extends Error {
  readonly status: number
  readonly type: string | null
  readonly title: string | null
  readonly detail: string | null
  /**
   * The **extension members** (#824). RFC 9457 lets a problem object carry any
   * other member, and this app uses that for the facts a sentence needs as
   * *data* rather than as prose: `key` names the field a `422` refused,
   * `limit` the bound a `413` states, `symbol`/`wanted`/`owned` the three
   * numbers an oversell is about.
   *
   * Kept whole and untyped on purpose: whoever branches on a `type` knows which
   * members that type carries, and a union declared here would be a second copy
   * of `problem.py`'s catalogue that nothing forces to stay in step. Read them
   * through the narrowing helpers in `lib/problem.ts`, never by casting.
   */
  readonly members: Readonly<Record<string, unknown>>

  constructor(init: ProblemBody) {
    super(typeof init.title === 'string' ? init.title : `HTTP ${init.status}`)
    this.name = 'ApiProblem'
    this.status = init.status
    this.type = typeof init.type === 'string' ? init.type : null
    this.title = typeof init.title === 'string' ? init.title : null
    this.detail = typeof init.detail === 'string' ? init.detail : null
    const { status: _status, type: _type, title: _title, detail: _detail, ...rest } = init
    this.members = rest
  }
}

async function unwrap<T>(response: Response, path: string): Promise<T> {
  if (!response.ok) throw await refusal(response, path)
  return response.json() as Promise<T>
}

/**
 * What a failed response *is*, read once — every caller throws it, none of them
 * decides what it means. A second copy of this would eventually stop reading
 * the media type and turn a proxy's HTML error page into a `type` the front
 * branches on.
 */
async function refusal(response: Response, path: string): Promise<ApiProblem> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('problem+json')) {
    return new ApiProblem(await response.json())
  }
  // No problem+json means something in front of the app answered — a proxy,
  // or the SPA catch-all if its `/api` guard ever regressed. A `type` of
  // `null` is what the interface reads as "not even the app answered".
  return new ApiProblem({ status: response.status, title: `${path}: no problem+json` })
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
 * One file on its way in (#811, ADR-0032).
 *
 * `Content-Type` is deliberately **not** set: the browser writes it, boundary
 * included, and a hand-written one is a multipart body no server can split. The
 * refusal is read exactly as every other refusal is — `problem+json`, and a
 * `type` the caller branches on — so an upload has no second error contract.
 */
async function upload<T>(path: string, file: File, params: string[] = []): Promise<T> {
  const body = new FormData()
  // The **third argument is the filename**, and it is not optional in practice:
  // the receipt is named after the file, and an implementation that reads the
  // `File`'s own name rather than the part's states `blob` back at the reader.
  body.append('file', file, file.name)
  // The gesture's own parameters travel on the query string and never in the
  // form (#813): they are *how* the file is to be read, not part of it, and a
  // second part in the body would make the route parse the reader's intention
  // out of the same multipart payload it parses their ledger out of.
  const target = params.length === 0 ? path : `${path}?${params.join('&')}`
  return unwrap<T>(
    await fetch(target, { method: 'POST', headers: { Accept: 'application/json' }, body }),
    path,
  )
}

/**
 * The three files a reader can ask for (#796, ADR-0034), named so a receipt can
 * say which one is being made. They are names of *files*, not of routes: all
 * three are one resource — two reductions of it, and one of those in the other
 * shape. There was a fourth, the declaration, and it left with the accounts
 * file it was half of.
 */
export const EXPORT_FILES = ['events', 'workbook', 'selection'] as const

export type ExportFile = (typeof EXPORT_FILES)[number]

/** Bytes the server named, on their way to the reader's own *Save as*. */
export interface DownloadedFile {
  blob: Blob
  /** What to save it as — the server's word (`Content-Disposition`). */
  filename: string
}

/**
 * One exported file, **fetched** rather than followed (#796).
 *
 * An `<a download>` hands the request to the browser and reports nothing back,
 * so a receipt over it could only be a guess with a timer on it — which is the
 * three-second confirmation the criterion refuses by name. Fetched, the gesture
 * has an end, and the receipt can last exactly as long as it does.
 *
 * What is lost is the browser's own naming, so the name is read off the
 * response: the server states it, and it is the server's to state — a reduction
 * does not carry the backup's name, and that rule lives on the one side that
 * knows whether anything was held back.
 */
async function download(path: string): Promise<DownloadedFile> {
  const response = await fetch(path, { headers: { Accept: '*/*' } })
  if (!response.ok) throw await refusal(response, path)
  return { blob: await response.blob(), filename: filenameOf(response, path) }
}

/**
 * The name the response states, or the last segment of the path it came from.
 *
 * The fallback is not decoration: a file saved as `events` with no suffix is
 * one no spreadsheet opens and one the drop folder ignores, so a header a proxy
 * happened to strip must not cost the reader the extension.
 */
function filenameOf(response: Response, path: string): string {
  const stated = /filename="?([^";]+)"?/.exec(response.headers.get('content-disposition') ?? '')
  return stated?.[1]?.trim() || path.split('?')[0].split('/').pop() || 'export'
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
  /**
   * What the owner called it — **except on `default` while it still wears the
   * name the schema seeded**, where the interface reads its own catalogue
   * (#745). That row is `NOT NULL` in the store, so it always arrives named, but
   * what it arrives with is documentation for whoever opens the file: it is the
   * one row *every* install owns, headless ones included, and a value seeded
   * once will never follow the reader's language. Every other account — and that
   * one from the moment #729's block relabels it — shows what it declares.
   *
   * Nullable on the wire because `AccountSummary` publishes it so: the store's
   * own column is, and the declaration falls back to the id where a file left it
   * empty. The fold lives in `lib/accounts.ts` rather than in each cell.
   */
  label: string | null
  /** Same clause, same row: `default`'s seeded type is the catalogue's too. */
  type: string | null
  /**
   * The account's **newest** `account_metrics` row, ridden on this resource
   * rather than on a second one — one accounts resource with two consumers, the
   * shares filter reading `id`/`label` and the comparison table reading the
   * rest. Every member below is nullable *by field* since #708: `holdings_value`
   * and `gain_absolu` are written always, the four cash-derived ones need a cash
   * event and `xirr` an external flow. That is what makes *five dashes out of
   * eight* a shape the page has to render rather than a fault.
   *
   * `as_of` is the day they describe — a **day**, never an instant — and `null`
   * on an account for which no cycle has written anything at all, which is the
   * other degraded shape: *eight* dashes, and a different sentence.
   */
  as_of?: string | null
  cash_balance?: number | null
  holdings_value?: number | null
  total_value?: number | null
  net_contributed?: number | null
  gain_absolu?: number | null
  /** Money-weighted, annualised **since the origin**: it has no window to narrow. */
  xirr?: number | null
  /**
   * Time-weighted, base 100 since the account's own first day — and the
   * comparison table **never renders it** (ADR-0019). Two indices counted from
   * two origins share a unit without being a comparison: `pea 171,5` against
   * `TR 115,0` puts 6,8 years beside 2,4. What the `perf` column shows is the
   * series rebased to 100 at the start of the visible window, computed in
   * `lib/accounts.ts` from {@link AccountHistoryResponse}.
   */
  twr_index?: number | null
  /**
   * ADR-0018's fourth term for **this** account (#722), signed as it enters the
   * sum — negative, the money having left. It is the one member of this row
   * that is not a column of `account_metrics`: it belongs to no position, so
   * the account's panel could not read it off `/api/positions` with the other
   * three, and the server derives it from `event` bounded by this row's own
   * day, exactly as `/api/portfolio-totals` derives the global one.
   *
   * `null` where no cycle has written this account a day: there is nothing to
   * bound the fees by, and a term measured over another period does not belong
   * in a sum with the figures beside it. Zero is a **figure** and means the
   * broker moved the money for free — the panel then shows three terms and
   * never learns the fourth exists.
   */
  transfer_fees?: number | null
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

/**
 * What the declaration form sends (#729, ADR-0013, ADR-0002).
 *
 * **There is no `currency` member and there will not be one.** ADR-0002 deleted
 * `Account.currency` rather than converting it: there are two currency levels —
 * the reporting currency, and the security's quote currency — and not three, so
 * *an account whose positions disagree with its currency* stops being a sentence
 * with a referent. A field for it here would put the third level back on the one
 * surface that creates the rows.
 *
 * `id` is sent on a creation and **never on an edit**: it is the value events
 * name, so changing it would rewrite every event that names it. An event is
 * addressed by its own key and never by a column somebody else may rewrite
 * (#816, ADR-0032) — the server refuses it for that reason, and the form does
 * not offer it. Reassignment is the gesture that moves events, and it names its
 * subject.
 */
export interface AccountDraft {
  id?: string
  type: string
  label: string
  /**
   * Move the events still naming the seeded row onto this account, in the same
   * request (#725). Sent on a **declaration** only, where the offer is checked
   * by default; omitted is what a client that never heard of it sends, and the
   * declaration is never refused for want of it.
   */
  reassign?: boolean
}

/**
 * One day of a perf series, at either level (#721).
 *
 * **One shape for the account and for the portfolio**, deliberately: the
 * accounts page draws N account curves and reads a portfolio scalar off the
 * same rebasing, so two shapes would mean two rebasings and, sooner or later,
 * two answers to *how did this period go*. The five members are the ones
 * `account_metrics` and `portfolio_totals` have in common.
 */
export interface PerfPoint {
  /** The calendar day — a bare `YYYY-MM-DD`, never an instant (the store's rule). */
  t: string | null
  cash_balance: number | null
  holdings_value: number | null
  total_value: number | null
  net_contributed: number | null
  /** Base 100 since the series' own origin. Rebased before it is ever shown. */
  twr_index: number | null
}

export interface AccountHistoryResponse {
  account: string
  from: string
  to: string
  points: PerfPoint[]
}

export interface PortfolioTotalsHistoryResponse {
  from: string
  to: string
  points: PerfPoint[]
}

/**
 * The day a perf series is asked from, and it is the **origin of time** on
 * purpose (#721, ADR-0019).
 *
 * `MAX` is not offered as a *range* — a time-weighted index has no bounded
 * amplitude, and one account's spike at +542 % crushes every other curve into
 * the bottom sixth of the plot. But the longest window offered, *since the
 * opening*, is `max` over the accounts' first days, and no payload states an
 * account's first day: the only place it is written is the series itself. So
 * the page reads each series whole and applies the bound to the **drawing**,
 * which is where ADR-0019 puts it. Asking the server for a bounded window
 * instead would mean knowing the bound before reading what defines it.
 *
 * The cost is stated rather than hidden: on a 6,8-year account the series is
 * ~2 500 days, dense over calendar days, five numbers each — and it is read
 * **once** for the four presets rather than once per preset, which is the same
 * property that makes the chart and the table's scalar column one announcer
 * instead of two.
 */
export const SERIES_ORIGIN = '1970-01-01'

export function accountHistoryPath(account: string, from: string = SERIES_ORIGIN): string {
  return `/api/accounts/${encodeURIComponent(account)}/history?from=${from}`
}

export function portfolioTotalsHistoryPath(from: string = SERIES_ORIGIN): string {
  return `${ROUTES.portfolioTotalsHistory}?from=${from}`
}

export function positionsHistoryPath(from: string = SERIES_ORIGIN): string {
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
 * which would draw a crater the portfolio never had (ADR-0004).
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
  /** The cut the rule defines — midnight of the newest observation's own day. */
  since: string | null
  /**
   * The newest price actually found at or before the cut, and it is what the
   * block names: the cut is a rule, and printing it announced a close that had
   * not happened yet.
   */
  reference: string | null
  movers: Mover[]
}

// ------------------------------------------------------------------------- //
// The hot read of the portfolio (#712 §11)
// ------------------------------------------------------------------------- //

/** A price as observed, in the currency it was quoted in. */
export interface Quote {
  value: number
  /**
   * The unit the number is in — **and it can be absent** (#774).
   *
   * `_build_position` reads it off `symbol_quote.currency`, which only a
   * *successful `.info` fetch* ever writes, so a symbol Yahoo answers closes for
   * without naming a currency serves a `price` with no `currency` at all. The
   * server keeps the number rather than suppressing the whole object — dropping
   * it would turn *quoted* into *never quoted*, the one distinction this pair of
   * objects exists to carry — and it is `lib/absence.ts` that reads the pair,
   * because **a number with no unit is not a price**: no pair to fetch a rate
   * for, nothing on its way, so the line is carried at its cost (ADR-0004) and
   * never left *waiting*. Typed `string` it read as always present, and every
   * client that only tested `price !== null` inherited the wrong absence.
   */
  currency: string | null
  at: string
}

/** The same price in the base currency, with the rate that got it there. */
export interface Converted {
  value: number
  currency: string
  rate: number
  rate_at: string
}

/**
 * What the instrument **is**, beside what the holding is worth (#720).
 *
 * It rides on the position's row the way `price` does, and for the same reason:
 * P1 hands it back per `(account, symbol)`, and the shares page folds a symbol's
 * rows into one line. Nothing here is ever summed — owning the same ETF in a PEA
 * and a CTO does not double its market capitalisation.
 *
 * A `null` member is the ordinary absence: yfinance publishes no `pe_ratio` for
 * an ETF, and `quote_type` beside it is what makes that legible rather than
 * suspicious. The **object** being `null` is the other one — nothing has ever
 * been observed about this symbol — and the sheet then renders no block at all.
 */
export interface Fundamentals {
  /** The security's own quote currency, not the reporting one (ADR-0002). */
  currency: string | null
  /**
   * The place the quote comes from. Not decoration: ADR-0004's one surviving
   * mis-valuation is an Amsterdam execution priced against the NASDAQ quote of
   * the same company, and the sheet is where a reader can see it.
   */
  exchange: string | null
  quote_type: string | null
  /** In **percent points**, not a ratio — the writer multiplies by 100. */
  dividend_yield: number | null
  pe_ratio: number | null
  market_cap: number | null
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
  /** `null` — nothing has ever been observed about this symbol. */
  fundamentals: Fundamentals | null
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
  /** `t` like every other series this API serves, and not a second word. */
  t: string
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
// Health — the register whose reader is a person (#818, #819, ADR-0036)
//
// **Two registers, and they never mix.** The status code is for the
// orchestrator and asks one question, *should this container be restarted*: the
// worker serves and the store answers. The body is for a person and carries the
// three jobs — scrape, backfill, performance — each with its last pass and its
// verdict, plus one word for the whole.
//
// A silent scrape is therefore **amber with a `200`**, and that is the reason
// the dot moved here: restarting repairs nothing yfinance or the market broke,
// so a writer frozen since Tuesday leaves the code green and has to be read off
// the body instead.
// ------------------------------------------------------------------------- //

/**
 * The three words a job — or the whole — is said in. **Red is not among them,
 * and its absence is the design**: red is what a reader concludes when the
 * route answers `503` and there is no body at all, which is precisely the
 * colour that needs nothing published to be true.
 */
export const HEALTH_STATUSES = ['ok', 'attention', 'unknown'] as const

export type HealthStatus = (typeof HEALTH_STATUSES)[number]

/**
 * The verdict of a backfill that still has windows to cover — the one word the
 * front branches on out of the server's per-job vocabulary.
 *
 * It is read rather than folded into `status` because the two say different
 * things: a reconstruction under way is **not** something to look at, so the
 * job's own `status` is `ok` while it runs, and the dot's fifth state (#787)
 * would be lost if it were read off that word alone. Green means *the quotes
 * are read **and** the performance is up to date*; a rebuild breaks the second
 * half without breaking anything.
 */
export const BACKFILL_RUNNING = 'running'

/** One job's line: what it last did, and what that is worth looking at. */
export interface HealthJob {
  status: HealthStatus
  /** The instant of its last pass. `null` — this process has seen none. */
  at: string | null
  /** The job's own word, out of its own vocabulary. Never rendered raw. */
  verdict: string
}

export interface HealthJobs {
  /** Held symbols only: a sold line keeps no scrape job and no record. */
  scrape: HealthJob & { held: number; attention: string[] }
  /** `complete`/`in_scope` ride beside the verdict: *is it advancing* is a pair
   * of numbers and not a word. */
  backfill: HealthJob & { complete: number; in_scope: number; attention: string[] }
  /** One error and not a list: the record holds the last pass only. */
  performance: HealthJob & { error: string | null }
}

export interface HealthState {
  status: HealthStatus
  now: string
  /**
   * The one problem the dot could already detect before ADR-0036, and it
   * survives it: a worker whose scheduler has stopped will not run any of the
   * three jobs again, however well their last pass went. It is folded into
   * `status` by the server — it is read here by nobody, and carried so a
   * `curl` and the installation tab read the same object.
   */
  scheduler_running: boolean
  /** `null` when the fold itself failed, with `error` saying what it could not
   * say. A defect in the shaping is not a reason to restart the container. */
  jobs: HealthJobs | null
  error?: string
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
//  - **`id`** — every row is editable and editing needs an address. That
//    address is a **primary key**, which is the whole of what killed #662's
//    apparatus: the opaque token over `(file, sheet, row)`, the content
//    fingerprint as an `ETag` and its `409` existed because the *file* was the
//    address and a file address goes stale between the read and the write.
//    Absent, the editor is not offered on that row — a shape today's server
//    never sends, and one the type has to allow all the same.
//
// **And the provenance is gone** (#816, ADR-0032): the three columns and the
// sentence composed from them described a row a *mounted* file had provisioned,
// and they existed because that file was re-read. A file is a payload now, so
// there is one population of rows and nothing on the wire that could tell two
// apart.
//
// And one route is genuinely new: **`POST /api/events`**, without which the
// create form has nowhere to write. It is ADR-0005's onboarding rather than a
// convenience — manual mode is gone, so typing a position *is* creating dated
// events — and it is announced here, in the one module that knows a URL.
// `PATCH` is its sibling, and since #816 it is bounded by nothing: the `409`
// that refused a row a file had laid down went with the mount that justified it.
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
  /** #723: the key a row is addressed by. Optional, never absent in practice. */
  id?: string | null
}

/** A bare collection, as served: `200` + `[]` on an install that has nothing. */
export type EventsResponse = LedgerEvent[]

/**
 * What the form sends. Deliberately **not** a `LedgerEvent` minus a few fields:
 * the row's key is the store's to write, and a client that could name one would
 * be a client that could forge one.
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

/**
 * What a bulk removal answers (#814): how many rows the reduction took with it.
 *
 * The **server's** count and not the table's. The front knows what the
 * reduction retained before the click — that is what the confirmation is made
 * of — and this is what actually left, read off the store: the two are two, and
 * the second is the only one that is a fact.
 *
 * It is spelled `events_removed`, the word the revocation this gesture replaces
 * already answered under: the unit did not change road, only the subject did.
 */
export interface BulkRemoval {
  events_removed: number
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
   * Whether the app must be told before it can do its work (ADR-0035). The
   * first run is a predicate over **this mark and `stored`** — *a required dial
   * nobody has answered* — which is why the front carries no key of its own:
   * `base_currency` wears it today, and the second one to wear it will not need
   * this decision reopened.
   */
  required: boolean
  /**
   * Whether the store holds an answer. Published rather than derived from
   * `value !== default`: a dial answered *at* its default is answered, and a
   * required one with nothing stored is the question itself.
   */
  stored: boolean
}

/**
 * One boot variable — what the process had to know before it could open the
 * store (ADR-0014). **Four and no fifth** (#740, ADR-0033).
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
 * One standing installation fact (#709, ADR-0021, ADR-0024).
 *
 * **`message` is the server's sentence, in English, and no reader is served it
 * for a key the catalogues answer.** This docstring used to say the opposite —
 * that rendering `message` verbatim was not a hole in ADR-0024, and that *a
 * catalogue key per installation fact would be a second authority on what each one
 * says*. **#768 reversed it**, on a measurement rather than on taste: the whole
 * content of the *Notices* block was English on a French installation, beside a
 * title, a date and a button that were not, and the sentences interpolated
 * their plurals with `(s)` and their enumerations with `', '.join(...)` —
 * neither of which is how a language counts or lists. The repair **is** the
 * refused form: ten catalogue keys, two per notice, in `lib/installationFacts.ts`.
 *
 * What `message` is still good for, and why it stays on the payload:
 *
 *  - **a client with no interface**, which is the reason it was not simply
 *    removed — *headless means without an interface, not without HTTP*
 *    (ADR-0015). A key is a stable identifier, not a sentence, and asking every
 *    such consumer to write five of its own is asking each of them to redo
 *    `lib/installationFacts.ts`;
 *  - **the log**, whose line `message` is: #709's *logged once, in English, at
 *    the instant the row is created* is a property of the mechanism and is
 *    untouched by any of this;
 *  - **this front's fallback for a key outside the closed list of five** — a
 *    sixth installation fact shipping before its catalogue entry says its English
 *    sentence rather than nothing at all, and an empty notice is the one
 *    outcome a block that exists to be read cannot afford. That is the only
 *    path on which the interface still renders a string it did not write.
 *
 * **It is not a second authority, and the split is exactly ADR-0024's.** The
 * server stays the authority on the **predicate** — whether an installation fact stands
 * at all — and on the **parameters**: `key` is a closed list of five (ADR-0021)
 * and `detail` is re-derived per read, so the paths, the variables, the symbols
 * and the counts a sentence names are the server's observations and nothing
 * else. The catalogue is the authority on the **phrase** those parameters are
 * poured into, which is what follows the reader (a three-state `localStorage`
 * preference with **no dial in the store**, so this process could not know it
 * and `Accept-Language` has no subject here). What crosses this boundary is
 * therefore **data, never prose**: an array of variables rather than a joined
 * string, a count rather than a `(s)`.
 */
export interface InstallationFact {
  key: string
  first_seen_at: string
  acknowledged: boolean
  acknowledged_at: string | null
  message: string
  /** What it names right now, re-derived per read. `null` — not observable here. */
  detail: Record<string, unknown> | null
}

export type InstallationFactsResponse = InstallationFact[]

/**
 * One standing advisory (#829, ADR-0037) — what the owner's **data** says about
 * itself, as opposed to what is true of the install or of the app.
 *
 * Three members carry the whole of what the panel does with it, and the split
 * is deliberately the installation fact's:
 *
 *  - **`kind`** is the family, and the front holds the *phrase* it is poured
 *    into (ADR-0024): `message` is the log line and the headless payload, in
 *    English for ever, and the reader is served a catalogue key instead;
 *  - **`subject`** is the panel's heading, and it is the **server's** answer.
 *    A front deriving it from the key would be a second authority on the
 *    grouping, and it would have nothing at all to say about a family it does
 *    not know;
 *  - **`observed_at`** is the instant this was derived, which is the only date
 *    an advisory has: it is recomputed on every read and stored nowhere, so
 *    *noticed on* is *read on* and no older memory is claimed.
 *
 * There is no `acknowledged` here, and that is not an omission: an
 * acknowledged advisory is **absent from this collection** for thirty days and
 * then comes back on its own.
 */
export interface Advisory {
  key: string
  kind: string
  subject: string
  message: string
  detail: Record<string, unknown>
  observed_at: string
}

export type AdvisoriesResponse = Advisory[]

/** What the acknowledgement answers: the advisory, and when it wakes up. */
export interface AcknowledgedAdvisory extends Advisory {
  acknowledged_until: string
}

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
   * liveness, which the bell answers (#829, ADR-0037), and here it would make a
   * store whose last import was a year ago read as freshly written.
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

// ------------------------------------------------------------------------- //
// The import — a gesture, and no resource behind it (#811, #813, ADR-0032)
//
// There was a `GET /api/imports` and a `DELETE /api/imports/<id>` here, with a
// record type and a revocation to go with them. They left with the population
// they existed for (#816): nothing persists that could be listed, and undoing an
// import is `deleteEvents` over the ledger's own reduction. What is left is the
// receipt, which describes a gesture and outlives nothing.
// ------------------------------------------------------------------------- //

/** The period an import covered — its two days, or nothing at all. */
export interface ImportPeriod {
  from: string
  to: string
}

/**
 * **What the gesture produced** (#811) — the receipt, in the units the owner
 * counts in: lines written, the period they cover, the accounts and the
 * securities they touched.
 *
 * `period` is an object or `null` and never two nullable members: the two days
 * are absent **together**, on a file with no row in it, and half a period is a
 * figure nobody's file carries.
 *
 * The same shape answers the preview of #813 before anything is written — one
 * object, two moments — so the forecast and the fact are one thing read twice.
 *
 * **Three numbers, and they close**: `rows === written + duplicates`. `rows` is
 * what the file holds, `duplicates` what of it the ledger already has, `written`
 * what was — or will be — added. The period, the accounts and the securities
 * describe the **file**, not the subset that landed, which is what lets the
 * forecast and the fact say the same thing about a file that is half already
 * imported.
 */
export interface ImportReceipt {
  filename: string
  rows: number
  written: number
  duplicates: number
  period: ImportPeriod | null
  accounts: string[]
  symbols: string[]
}

/** How the file is to be read — the gesture's two parameters (#813). */
export interface ImportOptions {
  /** Judge and count, and **write nothing**: the forecast the owner may refuse. */
  dryRun?: boolean
  /** *These are real orders, write them* — the rows the ledger already has. */
  writeDuplicates?: boolean
}

export const api = {
  accounts: () => get<AccountsResponse>(ROUTES.accounts),
  // The declaration's three gestures (#698, served since that ticket; read by a
  // client since #729). They are the accounts half of the pair
  // `POST`/`PATCH`/`DELETE /api/events` is the ledger half of.
  createAccount: (draft: AccountDraft) => send<Account>(ROUTES.accounts, 'POST', draft),
  updateAccount: (id: string, draft: AccountDraft) =>
    send<Account>(accountPath(id), 'PATCH', draft),
  removeAccount: (id: string) => remove<{ id: string; removed: boolean }>(accountPath(id)),
  reassignEvents: (id: string) =>
    send<{ account: string; reassigned: number }>(
      accountReassignmentPath(id),
      'POST',
      {},
    ),
  events: () => get<EventsResponse>(ROUTES.events),
  createEvent: (draft: EventDraft) => send<LedgerEvent>(ROUTES.events, 'POST', draft),
  updateEvent: (id: string, draft: EventDraft) => send<LedgerEvent>(eventPath(id), 'PATCH', draft),
  /**
   * **One row, removed** (#834, ADR-0032).
   *
   * The pair of the edit above, and the gesture the bulk one is not: an event
   * recorded twice, or on the wrong day, is removed rather than corrected — and
   * a reduction that would retain it retains its neighbours too. The server
   * refuses nothing here that `PATCH` does not, the population being one since
   * #816; a ledger that would not replay without the row is the `409` both
   * meet.
   */
  removeEvent: (id: string) => remove<{ id: string; removed: boolean }>(eventPath(id)),
  /**
   * The reduction, deleted whole (#814, ADR-0032).
   *
   * It carries the **five export parameters** and never a list of ids: what the
   * table shows is what the server retains, arrived at once over one contract —
   * and a list assembled here would be a second reading of the reduction, made
   * against a snapshot rather than against the store.
   *
   * An empty query string is refused by the server in `422`, deliberately: the
   * caller is expected not to offer the gesture at all, and the route is the
   * guard for the client that forgot its own.
   */
  deleteEvents: (params: URLSearchParams) =>
    remove<BulkRemoval>(`${ROUTES.events}?${params.toString()}`),
  accountHistory: (account: string) =>
    get<AccountHistoryResponse>(accountHistoryPath(account)),
  positions: () => get<PositionsResponse>(ROUTES.positions),
  portfolioTotals: () => get<PortfolioTotalsResponse>(ROUTES.portfolioTotals),
  portfolioTotalsHistory: () =>
    get<PortfolioTotalsHistoryResponse>(portfolioTotalsHistoryPath()),
  positionsHistory: () => get<PositionsHistoryResponse>(positionsHistoryPath()),
  movers: () => get<MoversResponse>(ROUTES.movers),
  prices: (symbol: string, window: ChartWindow) =>
    get<PriceSeriesResponse>(pricesPath(symbol, window)),
  runtime: () => get<RuntimeState>(ROUTES.runtime),
  // Typed for the caller, and **narrowed all the same** where it is read
  // (`lib/status.ts`): this is the one payload whose shape the dot has to
  // survive losing, a proxy or a stale image being able to answer `200` with
  // something that is not this object at all.
  health: () => get<HealthState>(ROUTES.health),
  config: () => get<ConfigResponse>(ROUTES.config),
  saveSettings: (values: Record<string, string | number>) =>
    send<SettingsWriteResponse>(ROUTES.settings, 'PUT', values),
  installationFacts: () => get<InstallationFactsResponse>(ROUTES.installationFacts),
  acknowledgeInstallationFact: (key: string) =>
    send<InstallationFact>(installationFactAcknowledgementPath(key), 'POST', {}),
  /**
   * **The inventory**: what is left to act on, asleep ones removed. This is
   * what the notifications panel reads.
   */
  advisories: () => get<AdvisoriesResponse>(ROUTES.advisories),
  /**
   * **The reading**: every advisory this portfolio raises right now, an
   * acknowledged one included (#829, ADR-0037).
   *
   * The two are one route and one derivation, told apart by a query parameter,
   * because they answer two questions about the same instant. *Acknowledge for
   * thirty days* is **not now**, said to the panel; the cash is still sitting in
   * that account while it sleeps, so the chip beside the figure — which is the
   * reading and offers no gesture at all — goes on saying so. Read through the
   * inventory, the chip went out with the card and the record's distinction had
   * no effect anybody could observe.
   */
  standingAdvisories: () =>
    get<AdvisoriesResponse>(`${ROUTES.advisories}?asleep=include`),
  acknowledgeAdvisory: (key: string) =>
    send<AcknowledgedAdvisory>(advisoryAcknowledgementPath(key), 'POST', {}),
  // The way in (#811), and since #813 it is made twice on purpose: once with
  // `dryRun` for the forecast, once without it to commit — **the same file**,
  // re-sent. There is no pending-import id to hold instead, because holding one
  // would be the table this lot deleted under another name.
  importEvents: (file: File, options: ImportOptions = {}) =>
    upload<ImportReceipt>(ROUTES.eventsImport, file, [
      ...(options.dryRun ? ['dry_run=1'] : []),
      ...(options.writeDuplicates ? ['write_duplicates=1'] : []),
    ]),
  store: () => get<StoreState>(ROUTES.store),
  purgeOrphans: () => remove<PurgeResult>(ROUTES.storeOrphans),
  // The way back out (#710, #796). It answers bytes and a name rather than a
  // payload, and it is the one call whose result no cache holds: a file is
  // handed to the reader, not rendered.
  download: (path: string) => download(path),
}
