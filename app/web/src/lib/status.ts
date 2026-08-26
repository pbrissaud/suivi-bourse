/**
 * What is true of the **installation**, pure, and read by one control.
 *
 * `installationState` folds `/health` into the five words the bell wears: its
 * icon carries the colour, its badge carries the count, and its panel says the
 * state in prose (ADR-0037). There is **one** global indicator in the whole
 * app, which is what ADR-0022 asked for and what the sidebar's status card was
 * a fourth rendering of until #829 took it away.
 *
 * **The banner's half of this module left with the banner.** `shellConditions`
 * built an ordered list of live conditions for a band at the top of every page;
 * ADR-0037 retires that band and does not replace it — the conditions are
 * entries of the panel now (`lib/notifications.ts`) and the sentence descends
 * into each page's empty state. What is left below is the *page's own* failed
 * read, which is a different claim and has nowhere else to be said.
 */
import {
  BACKFILL_RUNNING,
  HEALTH_STATUSES,
  type HealthState,
  type RuntimeAccount,
} from '@/lib/api'
import type { MessageKey, MessageValues } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

/**
 * A state, never a count (ADR-0021). A counter stuck at "1" for the life of an
 * install is the noise the rule was written against.
 */
export type InstallationState = 'unknown' | 'ok' | 'attention' | 'rebuilding' | 'unreachable'

/**
 * A health payload, or `null` for *the route answered and said nothing this
 * function can read* (#819).
 *
 * The narrowing exists because the dot's whole job is to stay true when the
 * detail disappears, and the detail can disappear in more ways than a failed
 * request: a proxy answering `200` with its own JSON, an image whose body has
 * moved on, a route the SPA catch-all served. `get` throws on anything that is
 * not JSON at all, so what is left for this to catch is JSON that is not *this*
 * object — read at the wire and not at the compiler, which is the only place
 * the question is actually asked.
 *
 * A **word this front does not know** is refused here too, and deliberately:
 * `unknown` means *nothing has been observed yet*, so borrowing it for *the
 * server said something else* would put a grey dot on a claim nobody made.
 *
 * The **four required members** are all asked for, and not `status` alone: a
 * proxy's own `{"status":"ok"}` is the most ordinary shape of the case above,
 * and reading one member out of four would let it paint the dot **green** — the
 * one colour that must never be borrowed. `jobs` is the one that may be `null`,
 * which is the server's own way of saying the fold failed, and `error` is
 * optional because it rides with it.
 */
function readHealth(payload: unknown): HealthState | null {
  if (typeof payload !== 'object' || payload === null) return null
  const body = payload as Partial<Record<keyof HealthState, unknown>>
  if (typeof body.status !== 'string') return null
  if (!(HEALTH_STATUSES as readonly string[]).includes(body.status)) return null
  if (typeof body.now !== 'string') return null
  if (typeof body.scheduler_running !== 'boolean') return null
  if (typeof body.jobs !== 'object') return null
  return payload as HealthState
}

/** Is the reconstruction still covering windows? A member of the backfill job. */
function isRebuilding(health: HealthState): boolean {
  return health.jobs?.backfill?.verdict === BACKFILL_RUNNING
}

/**
 * **Green means the quotes are read *and* the performance is up to date** — and
 * that invariant is the whole of #787's amendment to this function.
 *
 * It used to hold one predicate, the scheduler, on the argument that it is the
 * one the reader can act on. That left the dot **green while a red band
 * announced a reconstruction at the top of every page** — two surfaces
 * disagreeing about the same installation, and the one the reader is taught to
 * trust saying the wrong thing.
 *
 * Worse, it made the dot unable to answer the question it exists for. A reader
 * asking *are the figures I am looking at any good* got *the scheduler is
 * running*, which does not imply it: during a rebuild the consolidated figures
 * are behind, and nothing green should say otherwise. With the rebuild folded
 * in, one glance answers it — and three pages lost the dated mention they
 * carried to answer it themselves, because the dot now does.
 *
 * **And it reads `/health` since #819** (ADR-0036), which repairs the half
 * #787 could not reach. The five states were derived from `/api/runtime`, whose
 * only detectable problem is the **scheduler being stopped** — so a scrape
 * frozen since Tuesday, a backfill wedged on yfinance, a perf pass raising
 * every cycle all left the dot **green**, on an install where nothing on screen
 * had moved for days. `status` is the server's own fold over the three jobs and
 * the scheduler, so those four facts are one word now, and the dot says
 * *attention* on all of them.
 *
 * The order is causal, like the banner's: the app not answering is stronger
 * than anything the body could say, and *attention* is stronger than a rebuild —
 * a stopped scheduler is *why* a rebuild would never finish, so naming the
 * rebuild there would name the symptom over the cause.
 *
 * **Rebuilding is its own state and not `attention`**, because the two ask
 * opposite things of the reader: *attention* needs a hand, and a rebuild needs
 * only time. One word for both would make the dot's own sentence wrong half the
 * time — which is the defect it is being fixed of. It is read off the backfill's
 * **verdict** rather than off `status`, that job being deliberately `ok` while
 * it runs: a reconstruction is not something to look at, and the fold is right
 * to say so.
 */
export function installationState(input: {
  health?: unknown
  error?: unknown
}): InstallationState {
  // The `503` of a store that will not open, and every other failed read. This
  // is the trade ADR-0036 states in as many words: the body goes when the store
  // goes, and red is the one colour that needs no body to be true.
  if (input.error) return 'unreachable'
  if (input.health === undefined) return 'unknown'
  const health = readHealth(input.health)
  // The route answered and there is nothing readable in it. Red rather than
  // grey: grey is *nobody has looked yet*, and somebody has.
  if (health === null) return 'unreachable'
  if (health.status === 'attention') return 'attention'
  if (isRebuilding(health)) return 'rebuilding'
  return health.status === 'unknown' ? 'unknown' : 'ok'
}

/**
 * How far the reconstruction has got, and **which account is holding it back**
 * (#727, #708).
 *
 * The bar is `(horizon → today) / (first event → today)`, and the two ends are
 * the two facts the reader has: today, and the oldest day their own ledger
 * names. The **max** of the horizons is what the bar reports, because the global
 * series is written only where *every* account is written (ADR-0018) — so
 * without naming that account the rule *"one slow account delays the whole home
 * page"* is invisible, and the owner reads the delay as a fault of the whole
 * portfolio.
 *
 * `ratio: null` is *nothing to draw* — no account reports a horizon, or the
 * ledger's first event is today — and the block then says the reconstruction is
 * running without pretending to measure it. An account **absent** from the list
 * is a pass that computed nothing (a perf job that has not run, or one that
 * raised), which is not a horizon of today: it is no observation at all.
 */
export interface RebuildProgress {
  /** The account whose horizon bounds the global series. `null` — none says. */
  account: string | null
  ratio: number | null
}

function asDay(value: string): number {
  return Date.parse(`${value.slice(0, 10)}T00:00:00Z`)
}

export function rebuildProgress(
  accounts: readonly RuntimeAccount[],
  firstEvent: string | null,
  now: Date,
): RebuildProgress {
  const horizons = accounts.filter(
    (account): account is RuntimeAccount & { horizon: string } => account.horizon !== null,
  )
  const lagging = horizons.reduce<(RuntimeAccount & { horizon: string }) | null>(
    (latest, account) => (latest === null || account.horizon > latest.horizon ? account : latest),
    null,
  )
  if (lagging === null || firstEvent === null) {
    return { account: lagging?.account ?? null, ratio: null }
  }

  const today = now.getTime()
  const span = today - asDay(firstEvent)
  if (!Number.isFinite(span) || span <= 0) return { account: lagging.account, ratio: null }
  const covered = today - asDay(lagging.horizon)
  if (!Number.isFinite(covered)) return { account: lagging.account, ratio: null }
  return { account: lagging.account, ratio: Math.min(Math.max(covered / span, 0), 1) }
}

/**
 * A read of a page that failed, and the sentence that names it.
 *
 * **It is not a band, and there is none left anywhere** (#829, ADR-0037). The
 * banner is retired: its three conditions — a missing base currency, a running
 * reconstruction, a stopped scheduler — are entries of the notifications panel
 * now, and its *sentence* descends one floor, into the empty state of each page
 * it used to explain. What survives here is the other thing the component was
 * used for and which the panel cannot say: **this page asked for something and
 * did not get it**, which is true of the page rather than of the installation.
 *
 * It carries no gesture. The one condition that had one was the currency's, and
 * what it led to is a card's link now.
 */
export interface ReadFailure {
  /** What the reader is told. Its own key, so nothing renders `detail`. */
  message: MessageKey
  /** What the sentence names — never anything read off a payload's prose. */
  values?: MessageValues
}

/**
 * The first failure, or none. Takes the conditions **already in causal order**
 * and keeps the first: a page that names six failed reads has said one thing
 * six times, and an unreadable store fails every read it is made of at once.
 */
export function oneFailure(failures: readonly ReadFailure[]): ReadFailure | null {
  return failures[0] ?? null
}

/**
 * The failures a surface's own reads can observe, in causal order.
 *
 * **Every page names its own now** (#829). `shellError` used to be the banner's
 * and short-circuited this list to nothing, on the argument that the strip at
 * the top of the column was already saying it. There is no strip: a page that
 * stayed silent over a `503` would render nothing and no reason, which turns
 * *"the store is unreadable"* and *"you own nothing yet"* into one empty screen.
 * So a page lists `/api/runtime` first among its own errors — the app not
 * answering is the cause of every failed read under it — and `oneFailure` keeps
 * that one.
 *
 * What is left of the parameter is `namedElsewhere`, and it has exactly one
 * caller: the notifications panel, whose **health card** already says *the
 * store is not answering* in prose. Naming it a second time three lines above
 * would put two announcers on one fact.
 */
export function readConditions(input: {
  namedElsewhere?: unknown
  errors: readonly unknown[]
}): ReadFailure[] {
  if (input.namedElsewhere) return []
  return input.errors
    .filter((error) => Boolean(error))
    .map((error) => ({ message: problemMessageKey(error) }))
}

