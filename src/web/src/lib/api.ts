/**
 * The one module that knows a URL, and the transport every call goes through.
 *
 * That is a rule, not an accident of layout (#712 §1). The store (#695) has not
 * frozen its paths, so the front is written **in front of** the back end: the
 * day a route is renamed, `ROUTES` and the test harness's handlers change, and
 * **no page test moves**. A component that fetched its own path would turn that
 * rename into a hunt through twenty files.
 *
 * The types and the calls of each domain live in their feature's
 * `features/<domain>/lib/api.ts` (#1202); what is left here is the transport,
 * the paths, and what the shell itself reads — the process state, the health,
 * the installation facts and the advisories.
 *
 * The contract of #712 §11 carries two traps in its shape rather than in a
 * comment:
 *
 *  - a **price** is `{ value, currency, at }` and its conversion is a *separate*
 *    object carrying the rate and the rate's timestamp — because the page has to
 *    tell *waiting for the rate* (native price known, converted `null`) from
 *    *no price at all* (`price: null`, position carried at its cost), and a
 *    single nullable number cannot;
 *  - `symbol` is the identity, `name` is display only: a rename must not split
 *    anything.
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
   * It is a resource of the account rather than of the ledger because the
   * target is what bounds the exception: an account that is neither the seeded
   * row nor unknown *is* the first declaration, which is the one instant those
   * rows may be rewritten at.
   */
  accountReassignment: '/api/accounts/:id/reassignment',
  /**
   * The owner's taxation models, **and the shape one may take** (#752).
   *
   * One read for the two, deliberately: the kinds are a closed enumeration in
   * the server's code, so a second copy over here would drift the day a kind is
   * added. What this front holds is the *words* — one message key per kind, in
   * both catalogues.
   */
  taxationModels: '/api/taxation-models',
  /** One model. A **pattern**, like {@link ROUTES.account}. */
  taxationModel: '/api/taxation-models/:id',
  positions: '/api/positions',
  portfolioTotals: '/api/portfolio-totals',
  /**
   * One symbol's price series. A **pattern**, `:symbol`, because it is what the
   * harness's handler registers; `pricesPath` (`features/shares/lib/api.ts`)
   * is what a caller builds.
   */
  prices: '/api/prices/:symbol',
  runtime: '/api/runtime',
  /**
   * **The one route with no `/api` prefix**, and it is not an oversight (#819):
   * it is the container's own probe, written into the image's `HEALTHCHECK`
   * long before a browser read it, and renaming it to please this table would
   * break the one reader the app is sure to have.
   *
   * The cost is that the body goes when the store goes — and what survives that
   * is the half that matters then, a `503` the bell renders **red**.
   */
  health: '/health',
  /** The ledger itself — read, and written one row at a time (#723). */
  events: '/api/events',
  /** One row of it. A **pattern**, like {@link ROUTES.prices}. */
  event: '/api/events/:id',
  /**
   * A file handed over, read once, and written as ordinary events (#811).
   *
   * It is `/api/events/import` and not `/api/imports` because **an import is no
   * longer a resource**: nothing persists that could be named, so it is a
   * gesture on the collection it writes. What comes back is a receipt — what
   * the gesture produced — and never an id to come back to.
   */
  eventsImport: '/api/events/import',
  /**
   * The ledger back out, in the format it came in by (#710) — **the events, and
   * only them**. There was a second file, the declaration, because a
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
  /**
   * The accounts and their positions — **the entry that is a report** (#836,
   * spec #787). Balances, weighted-average unit costs and valuations: what the
   * replay made of the ledger, rather than the ledger.
   *
   * It is not `accounts.csv`, which is a `404` and stays one. That
   * file was a *declaration* nothing reads back, and it looked like half a
   * restore; this one the import refuses by name, for want of `date` and
   * `event_type`, so it cannot be filed beside a backup and mistaken for one.
   *
   * **It takes no reduction.** The five parameters are the ledger's dimensions
   * and a position has none of them: the perimeter of this file is the
   * portfolio, and the entry that reduces is the one that says so.
   */
  exportPortfolio: '/api/export/portfolio.csv',
  /** What this install is configured with: the dials and the boot variables. */
  config: '/api/config',
  /** The dials' one writer, and it is an HTTP route so headless stays whole. */
  settings: '/api/settings',
  /**
   * The agent's provider, model and address, and of its key only `last4`
   * (#1114). Written field by field; the server refuses a row an enabled
   * agent could not run on.
   */
  agentConfig: '/api/agent/config',
  /** The provider's key: written and forgotten here, never read back. */
  agentKey: '/api/agent/key',
  /**
   * *Tester la connexion* (#1115): the stored provider's models, listed with
   * the stored key. Writes nothing.
   */
  agentTest: '/api/agent/test',
  /**
   * The agent's turn (#1114): a Vercel AI SDK UI stream, on the ASGI half
   * (`boot._is_agent`). The `/agent` page's `useChat` posts here (#1196).
   */
  agentChat: '/api/agent/chat',
  /** The conversations, the most recent first. */
  agentThreads: '/api/agent/threads',
  /** One conversation: read as UI messages, or deleted. A **pattern**. */
  agentThread: '/api/agent/threads/:id',
  /** What this install has been told and has not acknowledged (#709). */
  installationFacts: '/api/installation-facts',
  /** One installation fact's acknowledgement. A **pattern**, like {@link ROUTES.prices}. */
  installationFactAcknowledgement: '/api/installation-facts/:key/acknowledgement',
  /**
   * What the owner's **data** says about itself (#829) — derived on
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
   * What the rule *"a resource carries the name of the store's table"* forbids
   * is reusing a v4 name for a **different** payload, and this is the same one.
   */
  movers: '/api/portfolio/movers',
  /**
   * How much the owner buys in a month, and how often (#751).
   *
   * Derived on every read and stored nowhere, like {@link ROUTES.advisories}:
   * there is no table behind it and no id to come back to. It is served from
   * the published snapshot, so the rhythm and every other figure on the page
   * describe one ledger.
   */
  investmentRhythm: '/api/investment-rhythm',
  /**
   * The dashboard's saved layout — one row of the store, its shape checked and
   * its cards not: the registry of cards is the front's (`features/dashboard/lib/dashboardBlocks`).
   */
  dashboardLayout: '/api/dashboard/layout',
  /**
   * The comparison of #760 — the gap, the period it covers, and the right to
   * display either.
   *
   * One route and one payload on purpose: `state` and `gap_gross` arrive in
   * the same read, so the page can never draw a figure over a series still
   * being fetched. A second read for terminality would be a second chance for
   * the two to disagree, and what disagreement looks like here is a plausible
   * number that repairs itself an hour later.
   */
  benchmark: '/api/benchmark',
} as const

export type RouteName = keyof typeof ROUTES

function installationFactAcknowledgementPath(key: string): string {
  return ROUTES.installationFactAcknowledgement.replace(':key', encodeURIComponent(key))
}

function advisoryAcknowledgementPath(key: string): string {
  return ROUTES.advisoryAcknowledgement.replace(':key', encodeURIComponent(key))
}

/**
 * An RFC 9457 problem.
 *
 * `type` is the discriminant and the **only** member the interface branches on.
 *`title` and `detail` are English diagnostics the server writes for
 * a log: they are carried here so a report can quote them, and rendered
 * nowhere — that is what put a French title over an English sentence in the
 * prototype's most consequential alert.
 */
interface ProblemBody {
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

export async function get<T>(path: string): Promise<T> {
  return unwrap<T>(await fetch(path, { headers: { Accept: 'application/json' } }), path)
}

/**
 * The write half, and it goes through the same `unwrap`: a refusal is a
 * `problem+json` whose `type` the caller branches on, exactly like a failed
 * read. There is no second error contract for writes.
 */
export async function send<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body: unknown,
): Promise<T> {
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
 * One file on its way in (#811).
 *
 * `Content-Type` is deliberately **not** set: the browser writes it, boundary
 * included, and a hand-written one is a multipart body no server can split. The
 * refusal is read exactly as every other refusal is — `problem+json`, and a
 * `type` the caller branches on — so an upload has no second error contract.
 */
export async function upload<T>(path: string, file: File, params: string[] = []): Promise<T> {
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
export async function download(path: string): Promise<DownloadedFile> {
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
export async function remove<T>(path: string): Promise<T> {
  return unwrap<T>(
    await fetch(path, { method: 'DELETE', headers: { Accept: 'application/json' } }),
    path,
  )
}

/** A `DELETE` whose success is a `204` — no body to parse. */
export async function forget(path: string): Promise<void> {
  const response = await fetch(path, { method: 'DELETE', headers: { Accept: 'application/json' } })
  if (!response.ok) throw await refusal(response, path)
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
interface RuntimeSymbol {
  symbol: string
  next_run: string | null
  /**
   * Consecutive fruitless readings. Never "never", which is not computable.
   *
   * **The name is the server's** (`runtime_view.py`), and this is the one field
   * on this interface that cannot be named from here. Spelled
   * `consecutive_failures`, it read `undefined` out of every payload: the map
   * `SharesPage` builds from it held nothing, `?? 0` made that a zero,
   * `absenceCase` therefore never returned `noQuote`, and **no row of the
   * product was ever anomalous** — a delisted ticker rendered as an ordinary
   * line carried at its cost. Neither guard could see it: `tsc` was satisfied
   * because the type declared the wrong key, and the MSW fixture agreed with
   * the client rather than with the server. The domain keeps
   * `consecutiveFailures` for what the number *means*; this is what the wire
   * says it is called.
   */
  failure_count: number
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
 * Does the store outlive the container? (issue #741)
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

/**
 * Where this build came from, derived by the server from the two facts below
 * rather than stamped a third time (`application/build_info.py`).
 *
 * `release` — an image the release workflow published, so it carries the tag
 * somebody would `docker pull`. `commit` — an image built from a branch, which
 * is what a PaaS rebuilding on every push produces: there is a revision and no
 * version, and that is a **complete** state. `checkout` — not an image at all,
 * and the word is separate from `commit` on purpose: a working tree may differ
 * from the commit it names. `unknown` — nobody stamped this build.
 */
type BuildSource = 'release' | 'commit' | 'checkout' | 'unknown'

/**
 * Which SuiviBourse is answering — the one line a bug report has to carry.
 *
 * It rides on this resource, which opens nothing, for the reason the store's
 * two facts do: it is settled at `execve` and answered from process memory, so
 * it stays legible on a store nobody can open — the exact state in which the
 * question gets asked.
 *
 * **Both halves are nullable and neither is ever invented.** An unstamped build
 * answers two `null`s, not `"dev"` and not `"0.0.0"`: a word fabricated for a
 * fact nobody carries is a word something eventually branches on.
 */
export interface RuntimeBuild {
  /** The published release, or `null`. */
  version: string | null
  /** The full commit, or `null` — abbreviating is the reader's business. */
  revision: string | null
  source: BuildSource
}

/**
 * The perf job's two verdicts (`application/runtime_state.py`). Only the one
 * the front branches on is named: `ran` is the ordinary word and nothing reads
 * it, the way `BACKFILL_RUNNING` is the only backfill verdict spelled here.
 */
export const PERF_FAILED = 'failed'

/**
 * The last perf-recompute pass — `application/runtime_view.build_perf`.
 *
 * `at` is never `null`: the record is stamped where it is written, and the
 * route serves the record or nothing at all.
 */
export interface RuntimePerf {
  at: string
  verdict: string
  /** What raised, or `null` on a pass that went through. Never rendered raw. */
  error: string | null
}

export interface RuntimeState {
  now: string
  scheduler_running: boolean
  store: RuntimeStore
  build: RuntimeBuild
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
  /**
   * The last perf pass, or `null` — this process has run none.
   *
   * It rides here for the reason `rebuilding` does: it is a fact about *this
   * process* and not about the portfolio, so it stays out of the data requests
   * and out of the figures themselves. What reads it is {@link stalePerfPass},
   * and what that decides is a **sentence** beside the figures — never whether
   * a figure exists, which is the objection `absence.ts` raised against
   * inheriting anything load-bearing from this optional read.
   */
  perf: RuntimePerf | null
  symbols: RuntimeSymbol[]
  accounts: RuntimeAccount[]
}

// ------------------------------------------------------------------------- //
// Health — the register whose reader is a person (#818, #819)
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
interface HealthJob {
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
   * It is folded into `status` by the server — it is read here by nobody, and
   * carried so a `curl` and the installation tab read the same object.
   */
  scheduler_running: boolean
  /** `null` when the fold itself failed, with `error` saying what it could not
   * say. A defect in the shaping is not a reason to restart the container. */
  jobs: HealthJobs | null
  error?: string
}

/**
 * One standing installation fact (#709).
 *
 * **#768 reversed it**, on a measurement rather than on taste: the whole
 * content of the *Notices* block was English on a French installation, beside a
 * title, a date and a button that were not, and the sentences interpolated
 * their plurals with `(s)` and their enumerations with `', '.join(...)` —
 * neither of which is how a language counts or lists. The repair **is** the
 * refused form: ten catalogue keys, two per notice, in
 * `lib/installationFacts.ts`.
 *
 * What `message` is still good for, and why it stays on the payload:
 *
 *  - **a client with no interface**, which is the reason it was not simply
 *    removed — *headless means without an interface, not without HTTP*. A key
 *    is a stable identifier, not a sentence, and asking every such consumer to
 *    write five of its own is asking each of them to redo
 *    `lib/installationFacts.ts`;
 *  - **the log**, whose line `message` is: #709's *logged once, in English, at
 *    the instant the row is created* is a property of the mechanism and is
 *    untouched by any of this;
 *  - **this front's fallback for a key outside the closed list of five** — a
 *    sixth installation fact shipping before its catalogue entry says its
 *    English sentence rather than nothing at all, and an empty notice is the
 *    one outcome a block that exists to be read cannot afford. That is the only
 *    path on which the interface still renders a string it did not write.
 *
 * The catalogue is the authority on the **phrase** those parameters are poured
 * into, which is what follows the reader (a three-state `localStorage`
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

type InstallationFactsResponse = InstallationFact[]

/**
 * One standing advisory (#829) — what the owner's **data** says about
 * itself, as opposed to what is true of the install or of the app.
 *
 * Three members carry the whole of what the panel does with it, and the split
 * is deliberately the installation fact's:
 *
 *  - **`kind`** is the family, and the front holds the *phrase* it is poured
 *    into: `message` is the log line and the headless payload, in
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

type AdvisoriesResponse = Advisory[]

/** What the acknowledgement answers: the advisory, and when it wakes up. */
interface AcknowledgedAdvisory extends Advisory {
  acknowledged_until: string
}

export const api = {
  runtime: () => get<RuntimeState>(ROUTES.runtime),
  // Typed for the caller, and **narrowed all the same** where it is read
  // (`lib/status.ts`): this is the one payload whose shape the dot has to
  // survive losing, a proxy or a stale image being able to answer `200` with
  // something that is not this object at all.
  health: () => get<HealthState>(ROUTES.health),
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
   * acknowledged one included (#829).
   *
   * The two are one route and one derivation, told apart by a query parameter,
   * because they answer two questions about the same instant. *Acknowledge for
   * thirty days* is **not now**, said to the panel; the cash is still sitting in
   * that account while it sleeps, so the chip beside the figure — which is the
   * reading and offers no gesture at all — goes on saying so. Read through the
   * inventory, the chip went out with the card and the record's distinction had
   * no effect anybody could observe.
   */
  standingAdvisories: () => get<AdvisoriesResponse>(`${ROUTES.advisories}?asleep=include`),
  acknowledgeAdvisory: (key: string) =>
    send<AcknowledgedAdvisory>(advisoryAcknowledgementPath(key), 'POST', {}),
}
