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
import type { Position } from '@/lib/api'

export const GAIN_TERMS = ['unrealised', 'realised', 'dividends', 'transferFees'] as const

export type GainTermName = (typeof GAIN_TERMS)[number]

export interface GainTerms {
  /**
   * `null` — **unknown**, not zero: at least one held position is quoted in a
   * currency whose rate has not resolved, so its market value in the reporting
   * currency has no value at all. A `?? 0` here is how a portfolio silently
   * reports the gain of the part of itself it could convert.
   */
  unrealised: number | null
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
 * A position carried at its cost contributes **exactly zero** to the latent
 * gain rather than a loss — that is the absence rule's first row, and composing
 * this out of null-tolerant helpers is what made a share whose price was never
 * observed report a total loss.
 */
export function positionTerms(positions: readonly Position[]): Omit<GainTerms, 'transferFees'> {
  let unrealised: number | null = 0
  let realised = 0
  let dividends = 0

  for (const position of positions) {
    realised += position.realised
    dividends += position.dividends
    if (unrealised === null) continue
    if (position.price !== null && position.converted === null) {
      // Quoted, and the rate is missing: this position's market value has no
      // figure in the reporting currency, so neither has the sum.
      unrealised = null
      continue
    }
    const marketValue =
      position.converted === null ? position.cost_basis : position.converted.value * position.quantity
    unrealised += marketValue - position.cost_basis
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
 * not: the sum is then genuinely unknown, and saying so is the honest answer.
 */
export function gainTotal(terms: GainTerms): number | null {
  if (terms.unrealised === null) return null
  return terms.unrealised + terms.realised + terms.dividends + (terms.transferFees ?? 0)
}

export function termValue(terms: GainTerms, term: GainTermName): number | null {
  return terms[term]
}
