/**
 * What the *installation* tab decides before anything is rendered (#724). Pure: payloads in, verdicts out.
 *
 */
import type { SettingDescription } from '@/features/settings/lib/api'

// ------------------------------------------------------------------------- //
// The dials, as the registry hands them over
// ------------------------------------------------------------------------- //

/** A dial's field id. One spelling, so a label and a link agree. */
export function settingFieldId(key: string): string {
  return `setting-${key}`
}

/**
 * What a row should send: the dial whose field differs from the store's
 * effective value, and nothing else.
 *
 * `PUT /api/settings` re-arms exactly what it reports as changed, and
 * `reschedule_job` recomputes `next_run_time` from *now* — so a save that
 * posted every dial would put every timer back to zero on every blur,
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
    // A blank field is *not* a request to reset a dial that has something to
    // fall back to: the write path refuses one there, and reading it as "give me
    // the default" would make an accidental clear and a deliberate reset the same
    // gesture. A dial with neither a default nor an obligation is the exception —
    // blank is the only way to say *unset*, so it has to reach the API (#982).
    if (trimmed === '' && (setting.default !== null || setting.required)) continue
    if (trimmed === String(setting.value ?? '')) continue
    changed[setting.key] = trimmed
  }
  return changed
}

/** The draft a row starts from: every dial at its effective value, as text. */
export function draftFrom(settings: readonly SettingDescription[]): Record<string, string> {
  const draft: Record<string, string> = {}
  for (const setting of settings) {
    draft[setting.key] = setting.value === null ? '' : String(setting.value)
  }
  return draft
}
