/**
 * The two derivations the shell needs, pure and side by side because they are
 * the same fact seen by two surfaces with two different jobs (ADR-0021):
 *
 *  - the **status dot** says what is true of the *installation*, indicates
 *    without demanding, and leads to the tab that explains it;
 *  - the **banner** says why *what you are looking at* is wrong or empty, and
 *    shows **one** band or none — never two.
 *
 * The banner's list is now complete and it is **an ordered list, not a second
 * mechanism**. The order is **causal, not a ranking**, and each step is the
 * cause of the one under it: as long as the app is not answering, nothing
 * downstream has a figure to excuse; as long as the reporting currency is
 * unanswered nothing is converted and nothing is computed, so the
 * reconstruction has no figure to excuse either — answering frees the slot
 * (#726).
 */
import type { RuntimeAccount, RuntimeState } from '@/lib/api'
import type { MessageKey, MessageValues } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

/**
 * A state, never a count (ADR-0021). A counter stuck at "1" for the life of an
 * install is the noise the rule was written against.
 */
export type InstallationState = 'unknown' | 'ok' | 'attention' | 'unreachable'

export function installationState(input: {
  runtime?: RuntimeState
  error?: unknown
}): InstallationState {
  if (input.error) return 'unreachable'
  if (!input.runtime) return 'unknown'
  // One predicate today, and it is the one the reader can do something about:
  // the scheduler is the thing that fetches quotes and rebuilds history, so a
  // stopped scheduler is why every figure on every page stops moving.
  return input.runtime.scheduler_running ? 'ok' : 'attention'
}

/**
 * Where a band's own gesture leads. **A link, never an acknowledgement**
 * (ADR-0021, #726): the banner shows conditions the reader can make *stop*, and
 * what makes them stop is a field, not a button that says *seen*.
 */
export interface BannerGesture {
  to: string
  hash?: string
  label: MessageKey
}

/** One live condition of the content column. */
export interface BannerCondition {
  /** What the reader is told. Its own key, so nothing renders `detail`. */
  message: MessageKey
  /** What the sentence names — a lagging account, and nothing from a payload. */
  values?: MessageValues
  /**
   * How far a condition that **advances** has got, `0`…`1`. Exactly one has
   * one, and it is a bar rather than a date: the reconstruction's target is
   * *the first event*, which the reader recognises, and a target *time* is a
   * promise the app cannot keep (a mute symbol backs off to 24 h).
   */
  progress?: number
  /** What the reader does about it, when there is something to do. */
  gesture?: BannerGesture
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
 * ledger's first event is today — and the band then says the reconstruction is
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
 * The one band, or none. Takes the conditions **already in causal order** and
 * keeps the first: a page that renders two bands has made the first run a wall.
 */
export function oneBand(conditions: readonly BannerCondition[]): BannerCondition | null {
  return conditions[0] ?? null
}

/**
 * The conditions the shell can observe, **in causal order**. The app not
 * answering is the first cause of an empty screen, so it opens the list and
 * everything later queues behind it — including the reconstruction, which has
 * no figures to excuse while nothing is answering at all.
 *
 * The reconstruction is the banner's, and **only** the banner's: it is one of
 * #709's five keys, and #724 keeps it out of the installation tab's badge for
 * that reason — dropped from the badge alone it would still be in the block and
 * make the badge under-count what is on screen, left in both it would put two
 * announcers on one fact.
 */
export function shellConditions(input: {
  error?: unknown
  /**
   * Whether the reporting currency is unanswered, `undefined` while nothing
   * has been observed about it. A band raised on a silence is a claim about the
   * reader's installation made before anybody looked (ADR-0026), so only a
   * positive observation puts this one in the list.
   */
  currencyUnanswered?: boolean
  runtime?: RuntimeState
  /** The oldest day the ledger names — the bar's denominator, and only that. */
  firstEvent?: string | null
  /** How the lagging account is named. The **declaration's** name (#729). */
  nameAccount?: (account: string) => string
  now?: Date
}): BannerCondition[] {
  if (input.error) return [{ message: problemMessageKey(input.error) }]

  // Second, and above the reconstruction on the ticket's own argument: with no
  // reporting currency nothing is converted and the perf job writes nothing at
  // all (#702), so a rebuild running underneath has no figure to excuse yet.
  // It is an **encart with a gesture**, never an acknowledgeable notice —
  // acknowledging *I have no currency* means nothing, which is why it is not
  // one of the acknowledgement table's five keys (ADR-0021).
  if (input.currencyUnanswered === true) {
    return [
      {
        message: 'banner.currency',
        gesture: { to: '/donnees', hash: 'installation', label: 'banner.currency.gesture' },
      },
    ]
  }

  if (input.runtime?.rebuilding !== true) return []

  const { account, ratio } = rebuildProgress(
    input.runtime.accounts ?? [],
    input.firstEvent ?? null,
    input.now ?? new Date(),
  )
  // Named or not, the sentence is not the same one: *which* account is late is
  // the whole of what makes the rule visible, and inventing a name for an
  // account nothing reported would be worse than the shorter sentence.
  return [
    {
      message: account === null ? 'banner.rebuilding' : 'banner.rebuilding.account',
      values: account === null ? undefined : { account: input.nameAccount?.(account) ?? account },
      ...(ratio === null ? {} : { progress: ratio }),
    },
  ]
}

/**
 * The conditions a **page's own reads** can observe — the same ordered list one
 * step down, and the reason it exists is that the shell's list cannot reach
 * them.
 *
 * `/api/runtime` answers from the scheduler's process memory and touches no
 * store at all (#668), which is the property that makes the status dot survive
 * a database outage — and the exact property that leaves the banner **silent**
 * when the store is the thing that has failed. A page whose figures came back
 * `503` therefore has no announcer above it, and a block that renders nothing
 * turns *"the store is unreadable"* and *"you own nothing yet"* into the same
 * screen: an empty one, which is the worse half of the defect the product names
 * elsewhere.
 *
 * `shellError` is taken so the causal order still holds across the two
 * surfaces: while the app is not answering it is the cause of every failed read
 * below it, the band at the top of the column already says so, and repeating it
 * here would put **two announcers on one fact**. One band on screen, never two,
 * stays true by construction rather than by inspection.
 *
 * **The reconstruction is deliberately not in that clause** (#727). It is a
 * shell condition and it is *not* a cause of a failed read: a store that will
 * not answer is a stronger, more specific and more actionable fact than a
 * rebuild running behind it, so a page keeps its own sentence rather than
 * standing under a band explaining something else. Which of the two holds the
 * slot when both are true is the banner's own ordering question, and it is
 * #726's — *the banner never renders two bands, and its order is causal* is that
 * ticket's criterion, tested there with two conditions true at once.
 */
export function readConditions(input: {
  shellError?: unknown
  errors: readonly unknown[]
}): BannerCondition[] {
  if (input.shellError) return []
  return input.errors
    .filter((error) => Boolean(error))
    .map((error) => ({ message: problemMessageKey(error) }))
}
