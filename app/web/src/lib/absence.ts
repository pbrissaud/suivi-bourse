/**
 * The four renderings of absence, under one rule (ADR-0016):
 *
 *   **The em dash means *there is nothing to compute*. Anything that is merely
 *   missing is named instead.**
 *
 * It is a pure function and not a component because the same classification
 * serves three columns of the shares table, the position sheet and the head's
 * own terms, and a rule copied per surface is a rule that drifts per surface.
 *
 *   | What is going on                     | Price    | Value       | Latent      |
 *   |--------------------------------------|----------|-------------|-------------|
 *   | No price observed, carried at cost   | `—`      | its cost    | `0,00`      |
 *   | Price known, rate missing            | native   | *waiting*   | *waiting*   |
 *   | Nothing to compute — position sold   | `—`      | `0,00`      | `—`         |
 *   | Asked N times, never answered        | *no price* × 3         |             |
 *
 * The last two look alike and are not, and that is the whole point of splitting
 * them: a sold position has **no question to ask**, while a line entered under a
 * ticker the market does not know has a question that is legitimate and usually
 * repairable — a typo. Treating the second as *nothing to compute* condemns it
 * to silence for ever.
 *
 * And the fourth case reports **its count, never a verdict**. The app knows that
 * N consecutive readings returned nothing; it does not know that nothing will
 * ever come. *« 3 relevés consécutifs, aucun cours »* is a fact the reader can
 * act on — *« jamais »* would be a guess, and it is not computable.
 */
import type { Converted, Quote } from '@/lib/api'
import type { MessageKey, MessageValues } from '@/lib/i18n'

export interface PositionAbsenceInput {
  /** Zero is a **sold** position, which stays in the table (ADR-0017). */
  quantity: number
  price: Quote | null
  converted: Converted | null
  /**
   * Consecutive fruitless readings for this symbol, from `/api/runtime` — the
   * one number that separates *not asked yet* from *asked and got nothing*.
   */
  consecutiveFailures: number
}

/**
 * The four absences, plus the state that is not one. `quoted` is here so a
 * caller switches over a closed set rather than falling through a default.
 */
export type AbsenceCase =
  | 'carriedAtCost'
  | 'awaitingRate'
  | 'nothingToCompute'
  | 'noQuote'
  | 'quoted'

export function absenceCase(input: PositionAbsenceInput): AbsenceCase {
  // A sold position first, and unconditionally: it has no question to ask, so
  // a failure counter left over from the days it was held says nothing about
  // it. Ordering this test last is how *sold* and *broken ticker* collapse.
  if (input.quantity === 0) return 'nothingToCompute'
  if (input.price !== null) return input.converted === null ? 'awaitingRate' : 'quoted'
  return input.consecutiveFailures > 0 ? 'noQuote' : 'carriedAtCost'
}

/**
 * How one cell reads. `figure` is *there is a number here* — the caller writes
 * it, because only the caller knows which number; this module decides whether
 * there is one at all.
 */
export type Rendering =
  | { kind: 'figure' }
  | { kind: 'dash' }
  | { kind: 'named'; message: MessageKey; values?: MessageValues }

export interface PositionRenderings {
  price: Rendering
  valuation: Rendering
  unrealised: Rendering
}

/**
 * The three renderings are **exported**, because a *total* wears the same one as
 * a *cell*. `Gain total` is unknown for exactly one reason — a held position
 * whose rate has not resolved — and that reason has a sentence here already; a
 * consumer holding only `number | null` cannot reach it, so it writes a bare
 * dash and says *there is nothing to compute* about something perfectly
 * nameable. Exporting the constant is what keeps the message key in one file
 * while the surfaces that need it multiply.
 */
export const FIGURE: Rendering = { kind: 'figure' }
export const DASH: Rendering = { kind: 'dash' }
export const AWAITING_RATE: Rendering = { kind: 'named', message: 'absence.awaitingRate' }

export function positionRenderings(input: PositionAbsenceInput): PositionRenderings {
  switch (absenceCase(input)) {
    case 'carriedAtCost':
      // The dash in the price column **is** the signal, and a rebuild makes the
      // case common enough that a badge of its own would be noise across the
      // whole page (ADR-0004 held). The latent gain is exactly zero, not a
      // loss: valuing at cost makes the purchase day come out neutral.
      return { price: DASH, valuation: FIGURE, unrealised: FIGURE }
    case 'awaitingRate':
      // The native price is known and worth showing — it is the quote the
      // reader's broker shows them. What is missing is the rate, and it is
      // named rather than dashed, because it is repairable.
      return { price: FIGURE, valuation: AWAITING_RATE, unrealised: AWAITING_RATE }
    case 'nothingToCompute':
      return { price: DASH, valuation: FIGURE, unrealised: DASH }
    case 'noQuote': {
      const named: Rendering = {
        kind: 'named',
        message: 'absence.noQuote',
        values: { count: input.consecutiveFailures },
      }
      return { price: named, valuation: named, unrealised: named }
    }
    case 'quoted':
      return { price: FIGURE, valuation: FIGURE, unrealised: FIGURE }
  }
}
