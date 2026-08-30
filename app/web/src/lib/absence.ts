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
 *   | Asked N times, never answered        | *no price* | its cost  | `0,00`      |
 *   | Still being rebuilt                  | *named* × 3            |             |
 *
 * There are **four**, and neither #774 nor #845 added a fifth: a line quoted in
 * a unit nothing names joins the first row (see `isQuoted`), and a line whose
 * history is still being rebuilt is named in all three cells the way the fourth
 * already was — with one of two sentences, never with a convention of its own.
 *
 * The third and fourth look alike and are not, and that is the whole point of
 * splitting them: a sold position has **no question to ask**, while a line
 * entered under a ticker the market does not know has a question that is
 * legitimate and usually repairable — a typo. Treating the second as *nothing
 * to compute* condemns it to silence for ever.
 *
 * **The arithmetic is decided by terminality, and by nothing else** (#845).
 * `carrying.py` states the predicate as its own acceptance criterion — no quote
 * observed **and** the symbol's backfill is terminal, *«sans quoi "pas encore"
 * est rendu "jamais"»* — and this module used to hold the first term and
 * substitute the failure counter for the second. That counter separates two
 * *sentences* and never two sums: read as the second term it valued at its cost,
 * during every rebuild, a line the dashboard's own curve still refused to value.
 * So `terminal` decides, and the counter reports **its count, never a verdict**:
 * the app knows that N consecutive readings returned nothing, it does not know
 * that nothing will ever come. *« 3 relevés consécutifs, aucun cours »* is a
 * fact the reader can act on — *« jamais »* would be a guess, and it is not
 * computable.
 */
import type { Converted, Quote } from '@/lib/api'
import { ABSENT } from '@/lib/format'
import type { MessageKey, MessageValues } from '@/lib/i18n'

export interface PositionAbsenceInput {
  /** Zero is a **sold** position, which stays in the table (ADR-0017). */
  quantity: number
  price: Quote | null
  converted: Converted | null
  /**
   * Has the backward pass reached this symbol's first acquisition? — the
   * **second** term of ADR-0004's predicate, off `/api/positions` (#845).
   *
   * A *fact*, not a verdict: it says the history is complete, not that the line
   * may be carried. It rides on the positions and not on `/api/runtime`, where
   * the counter below lives, because that read is **optional** (ADR-0026) — a
   * terminality inherited from it would turn every line non-terminal the moment
   * a diagnostic probe fell over, and the table's valuation would change because
   * of a failure that has nothing to do with the portfolio.
   */
  terminal: boolean
  /**
   * Consecutive fruitless readings for this symbol, from `/api/runtime`.
   *
   * It writes a **sentence** and never a sum: *asked N times and never
   * answered* and *not asked yet* read differently and are one arithmetic.
   */
  consecutiveFailures: number
}

/**
 * The four absences, plus the state that is not one. `quoted` is here so a
 * caller switches over a closed set rather than falling through a default.
 *
 * `rebuilding` is the fifth **name** and not a fifth rendering (#845): it is
 * the arithmetic ADR-0004 refuses to state — no quote, and the backfill has not
 * finished — and it wears the cells `noQuote` already wears. A name it had to
 * have, because the sum it produces is `null` where the other two priceless
 * cases produce the cost, and a case a caller cannot switch on is a case a
 * caller re-derives.
 */
export type AbsenceCase =
  | 'carriedAtCost'
  | 'awaitingRate'
  | 'nothingToCompute'
  | 'noQuote'
  | 'rebuilding'
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
  // Not quoted — no number at all, or a number in no nameable unit — and the
  // **second** term decides what that is worth. Not terminal is *not yet*: the
  // backward pass is still walking towards this symbol's first acquisition, so
  // there is no figure to state and none to carry either.
  if (!input.terminal) return 'rebuilding'
  // Terminal: nothing is coming, so the line is carried at its cost (ADR-0004).
  // The counter decides how that *reads* and not what it is worth — a ticker
  // the app has asked N times reports its count in the price cell, a line
  // nothing was ever asked about is simply carried.
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
/**
 * A figure a rebuild is still in the way of (#845) — a cell's, and a **total**'s.
 *
 * Exported for `AWAITING_RATE`'s own reason one line up: the valuation of a line
 * that is not terminal has no figure, so neither has any sum that reads it, and
 * a consumer holding only `number | null` writes an em dash — *there is nothing
 * to compute* — about the most ordinary state of a fresh install.
 */
export const REBUILDING: Rendering = { kind: 'named', message: 'absence.rebuilding' }

/** What a component needs of `useI18n`'s `t` to name an absence. */
export type Translate = (key: MessageKey, values?: MessageValues) => string

/**
 * A figure's text: the number when there is one, the em dash when there is
 * nothing to compute, and the **name** of what is missing otherwise (ADR-0016).
 *
 * A switch over a closed set rather than a `value === null ? ABSENT : …`
 * written at each site: written per site, the dash won every time — including
 * where the rule says something must be named, which is the whole of ADR-0016.
 *
 * It lives here rather than once per file. Five components had it, byte for
 * byte, each with a comment claiming the copy was deliberate — and the
 * repository's own rule is that *a rule is written once*, `lib/gain.ts` calling
 * `absenceCase` rather than holding a second copy because written twice the copy
 * loses a branch (it did). Five copies of a four-branch switch is four branches
 * with five chances of losing one.
 */
export function renderFigure(rendering: Rendering, format: () => string, t: Translate): string {
  switch (rendering.kind) {
    case 'figure':
      return format()
    case 'dash':
      return ABSENT
    case 'named':
      return t(rendering.message, rendering.values)
  }
}

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
    case 'noQuote':
      // Terminal, and asked N times for nothing: the repair sentence goes in
      // the **price** cell, where *no price* is what is true, and the two money
      // cells state the convention — the cost, and a latent gain of exactly
      // zero. Named in all three, the line said *no price* under a heading
      // that reads *Valorisation* while contributing its cost to the total
      // above it, which is the header disagreeing with its own column.
      return {
        price: { kind: 'named', message: 'absence.noQuote', values: { count: input.consecutiveFailures } },
        valuation: FIGURE,
        unrealised: FIGURE,
      }
    case 'rebuilding': {
      // Nothing is known yet, so nothing is stated: the three cells are named,
      // and **which** sentence they carry is the counter's one remaining job.
      // Asked and never answered is a fact worth reading during a rebuild too;
      // asked nothing yet is the rebuild itself, and it says so.
      const named: Rendering =
        input.consecutiveFailures > 0
          ? { kind: 'named', message: 'absence.noQuote', values: { count: input.consecutiveFailures } }
          : REBUILDING
      return { price: named, valuation: named, unrealised: named }
    }
    case 'quoted':
      return { price: FIGURE, valuation: FIGURE, unrealised: FIGURE }
  }
}
