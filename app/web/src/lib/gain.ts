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
import { AWAITING_RATE, DASH, FIGURE, absenceCase, type Rendering } from '@/lib/absence'
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
 */
export type Unrealised =
  | { known: true; value: number }
  | { known: false; because: 'awaitingRate' }

export interface GainTerms {
  /**
   * Unknown, not zero, when at least one held position is quoted in a currency
   * whose rate has not resolved: its market value in the reporting currency has
   * no value at all. A `?? 0` here is how a portfolio silently reports the gain
   * of the part of itself it could convert.
   */
  unrealised: Unrealised
  realised: number
  dividends: number
  /**
   * **Signed as it enters the sum** — negative, the money having left. Naming
   * it as a cost and subtracting it at the call site is one sign flip too many
   * for a figure whose entire point is that the four terms add up.
   *
   * `null` is *no ledger figures at all*, which for this term is the same
   * screen as zero: an install whose broker moves money for free reads three
   * terms and never learns the fourth exists.
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

/** The fourth term renders **only when it is not zero** — and never as `0,00 €`. */
export function termIsRendered(term: GainTermName, value: number | null): boolean {
  if (term !== 'transferFees') return true
  return value !== null && value !== 0
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
  let unrealised: Unrealised = { known: true, value: 0 }
  let realised = 0
  let dividends = 0

  for (const position of positions) {
    realised += position.realised
    dividends += position.dividends
    if (!unrealised.known) continue

    // The sum is computed from the positions alone, deliberately (the whole
    // point of the four terms), so there is no per-symbol failure counter to
    // hand over. That splits *asked and got nothing* from *not asked yet* in a
    // **cell**, and the two are one arithmetic here: both are carried at cost.
    const which = absenceCase({
      quantity: position.quantity,
      price: position.price,
      converted: position.converted,
      consecutiveFailures: 0,
    })

    if (which === 'awaitingRate') {
      // Quoted, and the rate is missing: this position's market value has no
      // figure in the reporting currency, so neither has the sum.
      unrealised = { known: false, because: 'awaitingRate' }
      continue
    }
    // Sold, carried at cost, or never quoted: a contribution of exactly zero,
    // by construction — a sold position has a nil basis and a carried one is
    // worth what it cost.
    if (which !== 'quoted') continue

    const marketValue = (position.converted?.value ?? 0) * position.quantity
    unrealised = { known: true, value: unrealised.value + marketValue - position.cost_basis }
  }

  return { unrealised, realised, dividends }
}

export function portfolioTerms(
  positions: readonly Position[],
  transferFees: number | null,
): GainTerms {
  return { ...positionTerms(positions), transferFees }
}

/**
 * The definition, and the only place the head's headline comes from.
 *
 * `transferFees` absent counts as zero — an install with free transfers has
 * three terms and its three-term sum *is* the gain. `unrealised` absent does
 * not: the sum is then genuinely unknown, **and it inherits its reason**, so the
 * headline names what is missing instead of wearing the dash that would claim
 * there is nothing to compute.
 */
export function gainTotal(terms: GainTerms): Unrealised {
  if (!terms.unrealised.known) return terms.unrealised
  return {
    known: true,
    value:
      terms.unrealised.value + terms.realised + terms.dividends + (terms.transferFees ?? 0),
  }
}

/** How a sum reads — `absence.ts`'s own constants, so the key lives in one file. */
export function unrealisedRendering(unrealised: Unrealised): Rendering {
  return unrealised.known ? FIGURE : AWAITING_RATE
}

/**
 * How one term reads, and the number to format when it reads as a figure. The
 * pair travels together because splitting them is what let a caller format a
 * `null` — the defect this shape removes.
 */
export function termRendering(terms: GainTerms, term: GainTermName): Rendering {
  if (term === 'unrealised') return unrealisedRendering(terms.unrealised)
  // The fourth term is *absent*, never zero, on an install whose broker moves
  // money for free — and `termIsRendered` has already dropped it by then. A
  // dash is right for anything else that reaches here with no figure.
  return termAmount(terms, term) === null ? DASH : FIGURE
}

export function termAmount(terms: GainTerms, term: GainTermName): number | null {
  if (term !== 'unrealised') return terms[term]
  return terms.unrealised.known ? terms.unrealised.value : null
}
