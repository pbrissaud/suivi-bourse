/**
 * What the *installation* tab decides before anything is rendered (#724,
 * ADR-0014, ADR-0015). Pure: payloads in, verdicts out.
 *
 * Two of the three are quantifications, and both exist for the same reason: a
 * portfolio-wide gesture that reaches part of the portfolio has to say so, or
 * the reader concludes the rest is broken.
 */
import type { RuntimeState, SettingDescription } from '@/lib/api'

// ------------------------------------------------------------------------- //
// The cadence's reach
// ------------------------------------------------------------------------- //

/** How many symbols a new `regular_interval` reaches now, and how many later. */
export interface CadenceReach {
  /** Polling right now: re-armed the moment the dial is saved. */
  now: number
  /** Asleep: not mis-set, off-topic. They read the dial when their market opens. */
  atMarketOpen: number
}

/**
 * Split the held symbols the way the write path will actually reach them.
 *
 * **The instrument is `closed`, not `next_run`**, and that is the one place
 * this module departs from the letter of its ticket. #701 settled it on the
 * server with three counter-examples, and re-deriving the split from the armed
 * time here would reproduce all three: it misreads a symbol asleep until an
 * open that falls *inside* a long outgoing interval, it cannot tell a
 * dead-ticker back-off (armed at `interval × 2^n`) from a market close, and it
 * inverts the moment the dial it is compared against is the very thing being
 * changed. `closed` is what the scheduler *acted on* for that symbol on its
 * last pass, it is published per symbol on the same resource, and using it is
 * what makes this sentence agree with the receipt the save answers with —
 * whereas two instruments would give the reader two counts of one gesture.
 *
 * A symbol that has never completed a pass (`closed: null`) counts as reached:
 * it is armed to fire immediately, so it reads the new value on a pass that has
 * already begun. The two figures **add up to the held portfolio**, which is the
 * property that lets a reader tell *asleep* from *misconfigured*.
 */
export function cadenceReach(runtime: RuntimeState | undefined): CadenceReach | null {
  if (!runtime) return null
  const held = runtime.symbols.filter((symbol) => symbol.held !== false)
  const atMarketOpen = held.filter((symbol) => symbol.closed === true).length
  return { now: held.length - atMarketOpen, atMarketOpen }
}

// ------------------------------------------------------------------------- //
// The dials, as the registry hands them over
// ------------------------------------------------------------------------- //

/**
 * The dial whose change is retroactive, and the reason the form says so out
 * loud: the dead-ticker back-off waits `regular_interval × 2^(n−3)` and stores
 * no absolute delay anywhere, so lowering the number in the form shortens —
 * *retroactively* — the wait of a symbol that has been failing since this
 * morning. No interface can hide it: the number in the form is the number in
 * the formula.
 */
export const RETROACTIVE_DIAL = 'regular_interval'

/**
 * The one dial that is a **question** rather than a setting (ADR-0002,
 * ADR-0021): no default, and fixed from the first recorded event. It is the
 * target of the *reporting currency* gesture, which is why the field carries an
 * id at all.
 */
export const CURRENCY_DIAL = 'base_currency'

/** The form's field id for a dial. One spelling, so a label and a link agree. */
export function settingFieldId(key: string): string {
  return `setting-${key}`
}

/**
 * What the form should send: every dial whose field differs from the store's
 * effective value, and nothing else.
 *
 * `PUT /api/settings` re-arms exactly what it reports as changed, and
 * `reschedule_job` recomputes `next_run_time` from *now* — so a save button
 * that posted every field would put every timer back to zero on every click,
 * invisibly. Sending only what moved is not an optimisation, it is the
 * difference between a save that does nothing and a save that silently
 * restarts the scheduler's whole clock.
 */
export function changedValues(
  settings: readonly SettingDescription[],
  draft: Readonly<Record<string, string>>,
): Record<string, string> {
  const changed: Record<string, string> = {}
  for (const setting of settings) {
    const typed = draft[setting.key]
    if (typed === undefined) continue
    const trimmed = typed.trim()
    // A blank field is *not* a request to reset: the write path refuses one, and
    // reading it as "give me the default" would make an accidental clear and a
    // deliberate reset the same gesture.
    if (trimmed === '') continue
    if (trimmed === String(setting.value ?? '')) continue
    changed[setting.key] = trimmed
  }
  return changed
}

/** The draft a form starts from: every dial at its effective value, as text. */
export function draftFrom(settings: readonly SettingDescription[]): Record<string, string> {
  const draft: Record<string, string> = {}
  for (const setting of settings) {
    draft[setting.key] = setting.value === null ? '' : String(setting.value)
  }
  return draft
}
