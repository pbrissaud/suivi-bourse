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
