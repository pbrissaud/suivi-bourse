/**
 * The gain has four terms, and their sum **is** its definition (ADR-0018).
 *
 * The head therefore **computes** `Gain total` here and never reads
 * `portfolio_totals.gain_absolu`, which is the same number written down
 * elsewhere. Two producers for one figure is what the shares page spent a
 * session dismantling — and the direct benefit is structural rather than
 * aesthetic: **a field absent for one account can no longer blank the
 * headline.** A global row is written only where it is writable for *every*
 * account; three of the four terms are read off the positions, which are not
 * under that constraint, so the page keeps its subject when `portfolio_totals`
 * cannot.
 *
 * The fourth term is why any of this exists. Six `DEPOSIT` rows in the real
 * files carry a `fee` — *Apple Pay Top up* — which leaves the cash while
 * `net_contributed` records the gross, so it lands inside `gain_absolu` and
 * inside **none** of the three position terms:
 *
 *     gain_absolu 957,48 €   ·   Σ of three terms 971,43 €   ·   gap 13,95 €
 *
 * No position can carry it: it is not an acquisition cost, not a disposal cost,
 * not a dividend, and it belongs to no security — so the shares page, whose
 * header sums its rows, can never show it. With it the sum telescopes exactly.
 */
import { AWAITING_RATE, DASH, FIGURE, REBUILDING, absenceCase, type Rendering } from '@/lib/absence'
import type { Position } from '@/lib/api'

export const GAIN_TERMS = ['unrealised', 'realised', 'dividends', 'transferFees'] as const

export type GainTermName = (typeof GAIN_TERMS)[number]

/**
 * A sum, or the **reason** there is not one.
 *
 * `number | null` was the shape, and it is one bit short: the nullity survived
 * the return and the *case* did not, so every caller could do nothing but write
 * an em dash — which by this product's own rule (ADR-0016) says *there is
 * nothing to compute* about a rate that simply has not resolved yet. Carrying
 * the reason is what lets the head name it, and it costs one discriminant.
 *
 * It was called `Unrealised` while there was one reason (#718); there are two
 * since #775, and neither of them is about the latent term alone. The two are
 * rendered differently and that is the whole of why they are two: a rate on its
 * way is **named**, and a fourth term nothing can bound wears the em dash —
 * *there is nothing to compute* — which is one of ADR-0016's four and not a
 * fifth (ADR-0021).
 *
 * `rebuilding` is the third, and it is a **mechanical** consequence of #845
 * rather than a new idea: a position's valuation gained a second cause of
 * nullity, so every sum that reads one gained a second reason to have no
 * figure. Left unnamed it would have fallen onto `awaitingRate`'s sentence,
 * which is what the discriminant exists to prevent — and it would have said it
 * on a **fresh install**, where no symbol is terminal, about a currency the
 * owner has already answered for.
 */
export type Sum =
  | { known: true; value: number }
  | { known: false; because: 'awaitingRate' | 'unboundedFees' | 'rebuilding' }

export interface GainTerms {
  /**
   * Does the portfolio hold **anything at all**? (#727)
   *
   * It decides one thing and only one: how the latent term *reads* when every
   * line has been sold. The sum over closed positions is exactly `0`, which is
   * arithmetically right and reads as a statement — *your holdings have gained
   * nothing* — about holdings that do not exist. By ADR-0016 that is precisely
   * what the em dash is for: **there is nothing to compute**. The gain total is
   * untouched, because zero is what a term with no subject contributes to a
   * sum: an owner who has sold everything still has a realised gain, dividends
   * and transfer fees, and that sum is their gain.
   */
  holdsPosition: boolean
  /**
   * Unknown, not zero, when at least one held position is quoted in a currency
   * whose rate has not resolved: its market value in the reporting currency has
   * no value at all. A `?? 0` here is how a portfolio silently reports the gain
   * of the part of itself it could convert.
   */
  unrealised: Sum
  realised: number
  dividends: number
  /**
   * **Signed as it enters the sum** — negative, the money having left. Naming
   * it as a cost and subtracting it at the call site is one sign flip too many
   * for a figure whose entire point is that the four terms add up.
   *
   * `0` is a **figure**: the broker moved the money for free, and the term is
   * then not rendered at all rather than printed as `0,00 €`.
   *
   * `null` is *there is no day to bound the fees by* — the server's own
   * sentence, `transfer_fees` being bounded by the row's own day so that
   * ADR-0018's identity holds between figures measured at the same instant
   * (#722). It counted as zero here until #775, which made a **four-term total
   * render from three**, amputated of a term, with nothing on screen saying so.
   * The two meanings were one value; they are two states now, and only the
   * first is worth zero.
   */
  transferFees: number | null
}

/**
 * Colour goes only to the terms that can **change sign** (ADR-0018). A dividend
 * received is never negative and a transfer fee never positive, so colouring
 * them is decoration that steals the signal from the red of a realised loss.
 */
export function termCarriesSign(term: GainTermName): boolean {
  return term === 'unrealised' || term === 'realised'
}

/**
 * The fourth term renders **only when it is not zero** — and never as `0,00 €`.
 *
 * `null` **does** render, as an em dash (#775): the total above it is a dash
 * for exactly this reason, and a dashed total whose cause is not on the screen
 * under it is a figure that has gone out with no explanation. The masking at
 * zero is untouched — that one is the other meaning, and it is real.
 */
export function termIsRendered(term: GainTermName, value: number | null): boolean {
  if (term !== 'transferFees') return true
  return value !== 0
}

/**
 * The three terms the positions carry, summed over the whole portfolio.
 *
 * **The classification is `lib/absence.ts`'s, and never a second spelling of it
 * here.** This function held one: *quoted with no rate* and *no quote at all*
 * written out inline, which is `absenceCase`'s second and third branches — minus
 * its first, `quantity === 0`, which that module tests **first and
 * unconditionally** and says why: ordering it last is how *sold* and *broken
 * ticker* collapse. Missing it, a sold position whose last quote carries no rate
 * blanked the headline of the whole portfolio, which is the exact failure the
 * four-term computation exists to prevent.
 *
 * **And it is why #774 changed nothing here.** A held line quoted in a unit
 * nothing names was flipping the whole portfolio's `Gain total` to *waiting for
 * a rate* — the same failure a second time, on a rate that was never coming —
 * and the repair is one term of `absenceCase`, read by this loop through the
 * one call it already makes. Written out again here it would have been the copy
 * losing a branch, which is the defect this delegation was created by.
 *
 * A position carried at its cost contributes **exactly zero** to the latent gain
 * rather than a loss — that is the absence rule's first row, and composing this
 * out of null-tolerant helpers is what made a share whose price was never
 * observed report a total loss.
 */
export function positionTerms(positions: readonly Position[]): Omit<GainTerms, 'transferFees'> {
  let unrealised: Sum = { known: true, value: 0 }
  let realised = 0
  let dividends = 0
  let holdsPosition = false

  for (const position of positions) {
    realised += position.realised
    dividends += position.dividends
    holdsPosition = holdsPosition || position.quantity !== 0
    if (!unrealised.known) continue

    // The sum is computed from the positions alone, deliberately (the whole
    // point of the four terms), so there is no per-symbol failure counter to
    // hand over. That splits *asked and got nothing* from *not asked yet* in a
    // **cell**, and the two are one arithmetic here: both are carried at cost.
    // `terminal` is *not* in that class and comes off the payload: it decides an
    // arithmetic (#845), which is exactly why it had to cross the wire.
    const which = absenceCase({
      quantity: position.quantity,
      price: position.price,
      converted: position.converted,
      terminal: position.terminal,
      consecutiveFailures: 0,
    })

    if (which === 'awaitingRate' || which === 'rebuilding') {
      // No market value in the reporting currency, so no sum either — and the
      // two reasons are kept apart all the way up, because they send the reader
      // to two different places: a currency to answer, and a wait.
      unrealised = { known: false, because: which }
      continue
    }
    // Sold, carried at cost, or never quoted: a contribution of exactly zero,
    // by construction — a sold position has a nil basis and a carried one is
    // worth what it cost.
    if (which !== 'quoted') continue

    const marketValue = (position.converted?.value ?? 0) * position.quantity
    unrealised = { known: true, value: unrealised.value + marketValue - position.cost_basis }
  }

  return { unrealised, realised, dividends, holdsPosition }
}

export function portfolioTerms(
  positions: readonly Position[],
  transferFees: number | null,
): GainTerms {
  return { ...positionTerms(positions), transferFees }
}

/**
 * The three terms a **security** carries, and nothing else (ADR-0017).
 *
 * The fourth is `0` here and never `null`, and the distinction is the point:
 * on this surface the term has **no subject** — the fee a broker takes out of a
 * transfer belongs to no security, so a header summing its rows can never show
 * it — where `null` says *there is no day to bound fees that do exist by*. The
 * two were one value until #775, and the shares page's own headline went dark
 * the moment `gainTotal` started reading `null` as the second.
 *
 * Zero is therefore exact rather than convenient: the sum of three terms **is**
 * the gain this page announces, and `termIsRendered` drops the term itself, so
 * nothing on screen claims a broker moved money for free.
 */
export function securityTerms(positions: readonly Position[]): GainTerms {
  return { ...positionTerms(positions), transferFees: 0 }
}

/**
 * The definition, and the only place the head's headline comes from.
 *
 * **Neither absence is counted as zero.** `unrealised` unknown is a held
 * position whose rate has not resolved, and the sum inherits its reason so the
 * headline names what is missing. `transferFees` `null` is *nothing to bound
 * the fees by*, and until #775 it was read as a broker moving money for free —
 * so a **four-term total was rendered from three**, amputated of a term, with
 * nothing on screen saying so. A total missing a term is not that total
 * (ADR-0018), so it is an absence, and it is the em dash: *there is nothing to
 * compute*, which is one of ADR-0016's four and not a fifth.
 */
export function gainTotal(terms: GainTerms): Sum {
  if (!terms.unrealised.known) return terms.unrealised
  if (terms.transferFees === null) return { known: false, because: 'unboundedFees' }
  return {
    known: true,
    value: terms.unrealised.value + terms.realised + terms.dividends + terms.transferFees,
  }
}

/**
 * How a sum reads — `absence.ts`'s own constants, so the key lives in one file.
 *
 * Three reasons, two renderings, and **no fifth form of absence**: what the app
 * repairs by itself is *named* — a rate on its way (#704), a history still being
 * rebuilt (#845) — while a term nothing can bound takes the em dash of *there is
 * nothing to compute*.
 */
export function sumRendering(sum: Sum): Rendering {
  if (sum.known) return FIGURE
  if (sum.because === 'awaitingRate') return AWAITING_RATE
  // Named too, and adding the case here is half of #845's repair rather than a
  // detail of it: this function falls back on the em dash for anything it does
  // not recognise, so a third reason added in silence would have been rendered
  // *there is nothing to compute* about a portfolio that is simply not finished
  // being read — invisible, and against ADR-0016.
  if (sum.because === 'rebuilding') return REBUILDING
  return DASH
}

/**
 * How one term reads, and the number to format when it reads as a figure. The
 * pair travels together because splitting them is what let a caller format a
 * `null` — the defect this shape removes.
 */
export function termRendering(terms: GainTerms, term: GainTermName): Rendering {
  // Nothing held: the latent term has no subject, and `0,00 €` would state that
  // holdings which do not exist have gained nothing (#727). The dash says *there
  // is nothing to compute*, which is the truth — and the total above it stays a
  // figure, since the other three terms are exactly what a portfolio sold out of
  // still has.
  if (term === 'unrealised' && !terms.holdsPosition && terms.unrealised.known) return DASH
  if (term === 'unrealised') return sumRendering(terms.unrealised)
  // The fourth term is *absent*, never zero, on an install whose broker moves
  // money for free — and `termIsRendered` has already dropped it by then. A
  // dash is right for anything else that reaches here with no figure.
  return termAmount(terms, term) === null ? DASH : FIGURE
}

export function termAmount(terms: GainTerms, term: GainTermName): number | null {
  if (term !== 'unrealised') return terms[term]
  return terms.unrealised.known ? terms.unrealised.value : null
}
