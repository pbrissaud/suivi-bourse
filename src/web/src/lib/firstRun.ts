/**
 * The first run — **a predicate, never a moment** (#726, ADR-0021, ADR-0005),
 * and **three passages** since ADR-0035 (#823).
 *
 * Everything a first launch could once have asked has been deleted or answered
 * elsewhere: the mode is dead (#711), the accounts seed themselves (ADR-0013),
 * the store's location is *observed* rather than demanded (#741), the drop
 * folder may legitimately not exist (ADR-0015), and the display format follows
 * the reader's language (ADR-0024). What is left is **the reporting currency**,
 * the one dial with no default and therefore the only one whose absence means
 * *nobody has ever answered here*.
 *
 * **The predicate is a class and not a name** (ADR-0035). It reads *a required
 * setting is unanswered*, off the `required` mark the registry publishes with
 * every other property of a dial — not off `base_currency` spelled out here.
 * The currency is what wears the mark today, and nothing on screen moves for
 * it; what the seam buys is that the second required dial is a line in
 * `settings_registry.py` rather than this file reopened.
 *
 * **The memory of the traversal is browser-side only.** The predicate stays
 * entirely derived from the server, so a wiped volume re-arms it and a second
 * browser sees it again; what `localStorage` holds is *this reader has been
 * through, in this browser*, which is a property of the reader exactly as the
 * theme and the language are (ADR-0024, same mechanism, absence meaning *not
 * yet*). There is **no `onboarding_done` row**: recording server-side what can
 * be derived is precisely what the predicate was written against, and it is
 * that severed link — not the number of passages — that answers #726's refusal
 * on its merits. A ledger emptied after six months reopens nothing, because
 * nothing about this screen is derived from the data it is about to collect.
 */
import type { SettingDescription } from '@/lib/api'
import { browserStorage, rememberPreference } from '@/lib/storage'

/** Same shape as the theme and language keys, deliberately (ADR-0024). */
export const FIRST_RUN_STORAGE_KEY = 'sb.firstRun'

/**
 * The three passages, **in order** (ADR-0035): the required settings, the
 * accounts, the first events.
 *
 * They are a list rather than three booleans because that is the whole of what
 * changed: the modal already stood on one predicate, and what the reader walks
 * is a sequence inside it. Three *independent* steps on three predicates is the
 * shape #726 refused, and it is refused here too — nothing below reads the
 * accounts or the ledger to decide whether a passage is owed.
 *
 * **Mandatory means traversed, never answered.** Each of the three is walked
 * and none of them extracts anything: the settings passage carries the one
 * question and releases a reader who does not answer it, the accounts passage
 * is satisfied by the seeded row every install owns, and the events passage
 * offers two doors and no obligation to take either.
 */
export const PASSAGES = ['settings', 'accounts', 'events'] as const

export type Passage = (typeof PASSAGES)[number]

/** Where in the walk this passage is, counted from one for a reader. */
export function passageNumber(passage: Passage): number {
  return PASSAGES.indexOf(passage) + 1
}

/**
 * The passage after this one, or `null` where the walk ends.
 *
 * `null` is what the last passage's control reads: there is nothing after the
 * events, so the gesture there **leaves**, and leaving is what writes the mark.
 */
export function nextPassage(passage: Passage): Passage | null {
  return PASSAGES[PASSAGES.indexOf(passage) + 1] ?? null
}

/** The passage before this one, or `null` on the first — which has no way back. */
export function previousPassage(passage: Passage): Passage | null {
  const index = PASSAGES.indexOf(passage)
  return index <= 0 ? null : PASSAGES[index - 1]
}

/**
 * The reporting currency's own key. It is **not** the predicate's — that reads
 * the registry's mark (`requiredUnanswered`) — but the currency field, its
 * receipt and its immutability rule are about *this* dial and name it as such,
 * exactly as the six event types are named by the catalogue.
 */
export const CURRENCY_KEY = 'base_currency'

/**
 * Whether a dial the registry marks **required** is still unanswered — the
 * first run's one predicate, derived from the mark (ADR-0035, #726).
 *
 * *Unanswered* is `stored` being false and not `value === null`: `stored` is
 * what the store actually holds, so the reading stays true of the whole class
 * rather than of the one member that happens to have no default. The two agree
 * on `base_currency` today, which is the point — nothing on screen moves.
 *
 * `undefined` is *not observed from here*: the read has not landed, or the
 * registry carries no required dial at all. A read in flight is not a fact
 * (ADR-0026), and the modal is a claim about the reader's own installation — so
 * it waits for a positive observation rather than opening on a silence. The
 * second case is the same caution one step further: a payload with no mark
 * anywhere is a server this front has not understood, and reading that as *every
 * required dial is answered* would silently retire the question.
 */
export function requiredUnanswered(
  settings: readonly SettingDescription[] | undefined,
): boolean | undefined {
  if (!settings) return undefined
  const required = settings.filter((setting) => setting.required)
  if (required.length === 0) return undefined
  return required.some((setting) => !setting.stored)
}

/**
 * Whether the reporting currency is unanswered — read off the settings the API
 * already publishes (**no new API state**, #726).
 *
 * This one *is* about the currency, and legitimately names it: it feeds the
 * pinned card that says *answer the currency*, the empty state each of the three
 * valued pages renders in its place (#829, ADR-0037), and the sentence that says
 * the answer cannot be taken back — all of which are about this dial and no
 * other. The modal's predicate is `requiredUnanswered`, and the two coincide
 * only because the currency is the one dial marked required today.
 *
 * `undefined` is *not observed from here*: the read has not landed, or the
 * registry does not carry the dial. A read in flight is not a fact (ADR-0026),
 * and each of those surfaces is a claim about the reader's own installation — so
 * it waits for a positive observation rather than appearing on a silence.
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

/**
 * The value the mark is written with. It is `dismissed` and not `walked`, and
 * the wording is deliberately left where it was: every browser that has already
 * closed the modal holds this exact string, and a new spelling would re-open the
 * onboarding — the explanation of the product included — on every reader who has
 * been through. What the mark means widened; what it is written as did not.
 */
const STILL_UNANSWERED = 'dismissed'
const ANSWERED = 'answered'

/**
 * What the browser remembers of the walk: **that the reader has been through,
 * and what was still unanswered when they left.**
 *
 * The second half is what makes *a wiped store asks again* true (ADR-0035)
 * rather than merely true of a second browser. A mark saying only *been through*
 * would suppress the question for ever in the browser that answered it — and the
 * reader who loses their volume, which is the trial install ADR-0015 designs
 * for, would land on an app whose currency is gone with nothing asking for it
 * again. So the mark is compared against what the server says **now**: a reader
 * who left with the question still open is left alone, and a reader who left
 * having answered is asked again the day the store no longer holds the answer,
 * because that is a different installation wearing the same address.
 *
 * `'unanswered'` is written as `dismissed`, the string every browser that has
 * already closed this modal holds. That is deliberate: the old modal only ever
 * stood on an unanswered dial, so the legacy value already *means* this, and a
 * new spelling would walk every one of those readers through the product's
 * explanation a second time.
 */
export type FirstRunMark = 'unanswered' | 'answered'

/** What this browser holds, or `null` — nobody has been through here. */
export function readFirstRunMark(): FirstRunMark | null {
  try {
    const stored = browserStorage()?.getItem(FIRST_RUN_STORAGE_KEY)
    if (stored === STILL_UNANSWERED) return 'unanswered'
    if (stored === ANSWERED) return 'answered'
    return null
  } catch {
    // A browser that refuses storage has no memory: it walks again, which is
    // the degradation `lib/storage.ts` chose for the three preferences too.
    return null
  }
}

/**
 * Remember the traversal — **however the reader left**, the cross, a door and
 * the last passage writing the same kind of mark: what is recorded is *this
 * reader has been through*, and the way out never had the weight of the answer
 * (ADR-0021).
 *
 * A browser that refuses storage simply shows the modal again next time — the
 * reader still leaves it, it just is not remembered, which is `lib/storage.ts`'s
 * rule for the three preferences and the right degradation here too: nothing is
 * lost but a second walk.
 */
export function rememberFirstRunWalked(mark: FirstRunMark) {
  rememberPreference(FIRST_RUN_STORAGE_KEY, mark === 'answered' ? ANSWERED : STILL_UNANSWERED)
}

/**
 * Does the modal stand? The predicate and the browser's memory, composed.
 *
 * The predicate is the registry's mark and not a key (ADR-0035), so the day a
 * second dial is marked required the modal opens for it with nothing changed
 * here. **The browser's memory is the other half and it is the only other
 * half**: no read of the accounts and no read of the ledger reaches this
 * function, which is what keeps an emptied ledger from reopening the walk.
 *
 * The two are composed rather than and-ed: a browser that walked away from an
 * **open** question is left alone, and one that walked away having answered is
 * walked again the day a required dial is unanswered — which can only mean the
 * store that held the answer is gone.
 *
 * `false` while the settings read has not landed, which is the same rule every
 * other surface follows: one that appears on a silence and disappears when the
 * answer arrives is worse than one that arrives late.
 */
export function firstRunStands(input: {
  settings: readonly SettingDescription[] | undefined
  mark: FirstRunMark | null
}): boolean {
  return requiredUnanswered(input.settings) === true && input.mark !== 'unanswered'
}
