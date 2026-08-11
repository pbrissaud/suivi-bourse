/**
 * The two derivations the shell needs, pure and side by side because they are
 * the same fact seen by two surfaces with two different jobs (ADR-0021):
 *
 *  - the **status dot** says what is true of the *installation*, indicates
 *    without demanding, and leads to the tab that explains it;
 *  - the **banner** says why *what you are looking at* is wrong or empty, and
 *    shows **one** band or none — never two.
 *
 * Both are deliberately thin here. The banner's real condition list — the
 * missing base currency, the rebuild in progress — arrives with the first-run
 * ticket, and it arrives as *more entries in an ordered list*, not as a second
 * mechanism. The order is **causal, not a ranking**: as long as the app is not
 * answering, nothing downstream has a figure to excuse.
 */
import type { RuntimeState } from '@/lib/api'
import type { MessageKey } from '@/lib/i18n'
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

/** One live condition of the content column. */
export interface BannerCondition {
  /** What the reader is told. Its own key, so nothing renders `detail`. */
  message: MessageKey
}

/**
 * The one band, or none. Takes the conditions **already in causal order** and
 * keeps the first: a page that renders two bands has made the first run a wall.
 */
export function oneBand(conditions: readonly BannerCondition[]): BannerCondition | null {
  return conditions[0] ?? null
}

/**
 * The conditions the shell can observe today. The app not answering is the
 * first cause of an empty screen, so it opens the list and everything later
 * queues behind it.
 */
export function shellConditions(input: { error?: unknown }): BannerCondition[] {
  if (!input.error) return []
  return [{ message: problemMessageKey(input.error) }]
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
