/**
 * Everything a first launch could once have asked has been deleted or answered
 * elsewhere: the mode is dead (#711), the accounts seed themselves, the store's
 * location is *observed* rather than demanded (#741), the drop folder may
 * legitimately not exist, and the display format follows the reader's language.
 * What is left is **the reporting currency**, the one dial with no default and
 * therefore the only one whose absence means *nobody has ever answered here*.
 *
 * **The predicate is a class and not a name**. It reads *a required setting is
 * unanswered*, off the `required` mark the registry publishes with every other
 * property of a dial — not off `base_currency` spelled out here. The currency
 * is what wears the mark today, and nothing on screen moves for it; what the
 * seam buys is that the second required dial is a line in
 * `settings_registry.py` rather than this file reopened.
 *
 * There is **no `onboarding_done` row**: recording server-side what can be
 * derived is precisely what the predicate was written against, and it is that
 * severed link — not the number of passages — that answers #726's refusal on
 * its merits. A ledger emptied after six months reopens nothing, because
 * nothing about this screen is derived from the data it is about to collect.
 *
 * The walk has **one other way in**, and it is a gesture and not a predicate:
 * `/?open=first-run`, which the empty dashboard links to (#1262). It reads
 * nothing and stores nothing.
 */
import type { SettingDescription } from '@/features/settings/lib/api'

/**
 * The four steps, **in order** (« Relevé »): the currency, the tax models of a
 * country, the first account, then where the first events come from.
 *
 * Only the first is owed: the app serves the walk until a currency is stored,
 * and every other step is traversed rather than answered — a blank account
 * writes nothing, no model ticked imports nothing, and the last step offers
 * three doors, one of them « Plus tard ».
 */
export const PASSAGES = ['currency', 'models', 'account', 'events'] as const

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
 * first run's one predicate, derived from the mark (#726).
 *
 * *Unanswered* is `stored` being false and not `value === null`: `stored` is
 * what the store actually holds, so the reading stays true of the whole class
 * rather than of the one member that happens to have no default. The two agree
 * on `base_currency` today, which is the point — nothing on screen moves.
 *
 * `undefined` is *not observed from here*: the read has not landed, or the
 * registry carries no required dial at all. A read in flight is not a fact,
 *and the modal is a claim about the reader's own installation — so
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
 * pinned card that says *answer the currency*, the empty state each of the
 * three valued pages renders in its place (#829), and the sentence that says
 * the answer cannot be taken back — all of which are about this dial and no
 * other. The modal's predicate is `requiredUnanswered`, and the two coincide
 * only because the currency is the one dial marked required today.
 *
 * `undefined` is *not observed from here*: the read has not landed, or the
 * registry does not carry the dial. A read in flight is not a fact, and each of
 * those surfaces is a claim about the reader's own installation — so it waits
 * for a positive observation rather than appearing on a silence.
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
 * The code the dial holds, or `null` — the unit every amount on screen is in.
 *
 * The same read as `currencyUnanswered`, answered the other way round: that one
 * asks whether the dial is empty, this one hands over what is in it. It is the
 * read a field asking for **money** needs (#953): a bracket ceiling is a bare
 * number, and the currency it will be compared against lives here and nowhere
 * near the model.
 *
 * `null` covers both silences — a read still in flight and a dial nobody has
 * answered — and every caller renders nothing for it rather than guessing a
 * unit, which is the same caution the two predicates above keep.
 */
export function baseCurrency(settings: readonly SettingDescription[] | undefined): string | null {
  const dial = settings?.find((setting) => setting.key === CURRENCY_KEY)
  return typeof dial?.value === 'string' ? dial.value : null
}

/**
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
 * It is a rename of the predicate and not a second reading of it: *answered* is
 * what the dial publishes (`currencyUnanswered`), and this is its name on
 * screen.
 *
 * `undefined` is *not observed from here*: with the settings read not landed,
 * neither *it is fixed the moment you answer* nor *it is fixed* is a sentence
 * this screen has the standing to write.
 */
export function currencyFixed(settings: readonly SettingDescription[] | undefined) {
  const unanswered = currencyUnanswered(settings)
  return unanswered === undefined ? undefined : !unanswered
}

/**
 * Where a **reopened** walk starts (#1262): on the tax models once every required
 * dial is answered, on the question otherwise. « Retour » still leads back to the
 * first step.
 */
export function reopenedPassage(settings: readonly SettingDescription[] | undefined): Passage {
  return requiredUnanswered(settings) === false ? 'models' : 'currency'
}

/**
 * The value the mark is written with. It is `dismissed` and not `walked`, and
 * the wording is deliberately left where it was: every browser that has already
 * closed the modal holds this exact string, and a new spelling would re-open the
 * onboarding — the explanation of the product included — on every reader who has
 * been through. What the mark means widened; what it is written as did not.
 */
/**
 * Does the first run stand? The registry's `required` mark and nothing else:
 * the app serves it until a currency is stored, wherever the reader landed, and
 * no browser memory lets it be put off.
 *
 * `false` while the settings read has not landed, which is the same rule every
 * other surface follows: one that appears on a silence and disappears when the
 * answer arrives is worse than one that arrives late.
 */
export function firstRunStands(settings: readonly SettingDescription[] | undefined): boolean {
  return requiredUnanswered(settings) === true
}
