/**
 * The first run — **a predicate, never a moment** (#726, ADR-0021, ADR-0005).
 *
 * Everything a first launch could once have asked has been deleted or answered
 * elsewhere: the mode is dead (#711), the accounts seed themselves (ADR-0013),
 * the store's location is *observed* rather than demanded (#741), the drop
 * folder may legitimately not exist (ADR-0015), and the display format follows
 * the reader's language (ADR-0024). What is left is **the reporting currency**,
 * the one dial with no default and therefore the only one whose absence means
 * *nobody has ever answered here*.
 *
 * That is why there is one predicate and not three independent steps on three
 * predicates: three steps would reopen the onboarding screen — the explanation
 * of the product included — for somebody who has used the app for six months
 * and has just revoked their imports.
 *
 * **The memory of the closing is browser-side only.** The predicate stays
 * entirely derived from the server, so a wiped volume re-arms it and a second
 * browser sees it again; what `localStorage` holds is *this reader has waved it
 * away in this browser*, which is a property of the reader exactly as the theme
 * and the language are (ADR-0024, same mechanism, absence meaning *not yet*).
 * Storing it in the store would be a second dial answering a question the app
 * has just decided it asks once.
 */
import type { SettingDescription } from '@/lib/api'
import { browserStorage, rememberPreference } from '@/lib/storage'

/** Same shape as the theme and language keys, deliberately (ADR-0024). */
export const FIRST_RUN_STORAGE_KEY = 'sb.firstRun'

/** The dial the whole thing turns on. */
export const CURRENCY_KEY = 'base_currency'

/**
 * Whether the reporting currency is unanswered — the one predicate, read off
 * the settings the API already publishes (**no new API state**, #726).
 *
 * `undefined` is *not observed from here*: the read has not landed, or the
 * registry does not carry the dial. A read in flight is not a fact (ADR-0026),
 * and the modal is a claim about the reader's own installation — so it waits
 * for a positive observation rather than opening on a silence.
 *
 * The absence it takes is `undefined` and **not `null`**, which is what every
 * caller produces (`config.data?.settings`) and what keeps this parameter out
 * of ADR-0026's `readonly X[] | null` family: one of its two callers has the
 * read in hand by construction — `Installation` mounts the settings block only
 * once the config has landed — and a slot declaring *this may be in flight*
 * handed a value that cannot be is exactly what `inFlightShape.test.ts` is for.
 */
export function currencyUnanswered(
  settings: readonly SettingDescription[] | undefined,
): boolean | undefined {
  if (!settings) return undefined
  const dial = settings.find((setting) => setting.key === CURRENCY_KEY)
  if (!dial) return undefined
  // The effective value, which for this dial *is* the stored row: it is the one
  // dial with no default, so `null` here can only mean nobody has answered.
  return dial.value === null
}

/**
 * Whether the base currency is **fixed** — answered, and therefore no longer
 * something this app draws a field for (#794, ADR-0002, `CONTEXT.md`).
 *
 * *Immutable once set: the answer can be given late, it just cannot be taken
 * back.* The screen said something else and it said it twice: *you can still
 * change this: your ledger is empty*, over a dial whose second answer does not
 * convert three years of euros but silently re-reads them as dollars. The
 * server is looser than that — `_refuse_a_reinterpretation` returns early on an
 * empty ledger, which is what lets an install answer late — and the front is
 * deliberately **not**: what the loose clause buys is a window in which a
 * reader can adopt a second unit and discover on their first import that the
 * first one was never converted. The one thing the app owes here is the
 * sentence, said before the answer rather than on the refusal.
 *
 * It is a rename of the predicate and not a second reading of it: *answered*
 * is what the dial publishes (`currencyUnanswered`), and this is its name on
 * screen.
 *
 * `undefined` is *not observed from here*: with the settings read not landed,
 * neither *it is fixed the moment you answer* nor *it is fixed* is a sentence
 * this screen has the standing to write (ADR-0026).
 */
export function currencyFixed(settings: readonly SettingDescription[] | undefined) {
  const unanswered = currencyUnanswered(settings)
  return unanswered === undefined ? undefined : !unanswered
}

/** Whether this browser has already waved the modal away. */
export function firstRunDismissed(): boolean {
  try {
    return browserStorage()?.getItem(FIRST_RUN_STORAGE_KEY) === 'dismissed'
  } catch {
    return false
  }
}

/**
 * Remember the closing. A browser that refuses storage simply shows the modal
 * again next time — the reader still closes it, it just is not remembered,
 * which is `lib/storage.ts`'s rule for the two preferences and the right
 * degradation here too: nothing is lost but a second dismissal.
 */
export function rememberFirstRunDismissed() {
  rememberPreference(FIRST_RUN_STORAGE_KEY, 'dismissed')
}

/**
 * Does the modal stand? The predicate and the browser's memory, composed.
 *
 * `false` while the settings read has not landed, which is the same rule the
 * bands follow: a surface that appears on a silence and disappears when the
 * answer arrives is worse than one that arrives late.
 */
export function firstRunStands(input: {
  settings: readonly SettingDescription[] | undefined
  dismissed: boolean
}): boolean {
  return currencyUnanswered(input.settings) === true && !input.dismissed
}
