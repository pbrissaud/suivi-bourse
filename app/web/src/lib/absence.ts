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
 * There are **four**, and #774 added no fifth: a line quoted in a unit nothing
 * names joins the first row rather than getting one of its own (see `isQuoted`).
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

/**
 * **A quote is a number *and* a unit** (#774) — the front's spelling of the
 * server's `carrying.is_quoted`, and it is spelled twice for the reason that
 * module gives: each caller supplies the term from what it has.
 *
 * `price !== null` alone was the term here, and it says a number was observed
 * and nothing about the unit it is in. A symbol Yahoo answers closes for while
 * naming no currency therefore read as *quoted, waiting for a rate* — for ever,
 * there being no pair to fetch a rate for and so nothing on its way. The server
 * already carries that line at its cost (#773), so the page was the **only**
 * place left saying otherwise, and it said it about the same position on the
 * same screen: *waiting* in the table while the curves valued it at its PMP.
 *
 * The absence is **permanent**, which is what lets it join `carriedAtCost`
 * rather than found a fifth rendering (ADR-0021): #706 refuses to carry *quoted
 * with no rate* because that absence is transitory and repairs itself (#704),
 * and here there is nothing to repair. The cost is already in the right unit,
 * event amounts being the debit in the reporting currency (ADR-0002).
 */
export function isQuoted(price: Quote | null): boolean {
  return price !== null && Boolean(price.currency)
}

export function absenceCase(input: PositionAbsenceInput): AbsenceCase {
  // A sold position first, and unconditionally: it has no question to ask, so
  // a failure counter left over from the days it was held says nothing about
  // it. Ordering this test last is how *sold* and *broken ticker* collapse.
  if (input.quantity === 0) return 'nothingToCompute'
  if (isQuoted(input.price)) return input.converted === null ? 'awaitingRate' : 'quoted'
  // Not quoted — no number at all, or a number in no nameable unit. The two are
  // one arithmetic (the cost) and the counter decides how they *read*: a ticker
  // the app has asked N times reports its count, and a line nothing was ever
  // asked about is simply carried.
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
      //
      // The dash covers the line quoted in no nameable unit too (#774), and
      // there it is a statement rather than an absence of data: the number
      // exists and the app cannot say what it is a number *of*. Printing it
      // under the reporting currency's symbol would assert exactly the unit
      // nothing named — which is the v4 view's own reading, `price` keeping the
      // converted value, `None` and all (`portfolio_view._build_share`).
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
