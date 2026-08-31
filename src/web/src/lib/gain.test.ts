/**
 * The identity of ADR-0018, pinned to the cent.
 *
 * The measured counter-example is the reason the fourth term exists: on the
 * real portfolio `gain_absolu` reads 957,48 € while the three position terms
 * sum to 971,43 € — a gap of exactly 13,95 €, six `DEPOSIT` rows carrying a
 * fee. Those numbers are the test.
 */
import { describe, expect, it } from 'vitest'

import { AWAITING_RATE, DASH, FIGURE, REBUILDING } from '@/lib/absence'
import {
  gainTotal,
  portfolioTerms,
  positionTerms,
  securityTerms,
  sumRendering,
  termAmount,
  termCarriesSign,
  termIsRendered,
  termRendering,
  type Sum,
} from '@/lib/gain'
import { aPosition, defaultPositions } from '@/test/factories'

/** A known sum, spelled once so the arithmetic below stays readable. */
const known = (value: number): Sum => ({ known: true, value })

describe('the four terms and their sum', () => {
  it('sums to the gain, the fourth term included', () => {
    //   latent +461,46 · realised −599,01 · dividends +1 108,98  =  971,43
    //   less the 13,95 taken out of six transfers                =  957,48
    const terms = {
      unrealised: known(461.46),
      realised: -599.01,
      dividends: 1108.98,
      transferFees: -13.95,
      holdsPosition: true,
    }
    expect(gainTotal(terms)).toMatchObject({ known: true })
    expect(termAmount({ ...terms }, 'unrealised')).toBeCloseTo(461.46, 2)
    expect((gainTotal(terms) as { value: number }).value).toBeCloseTo(957.48, 2)
  })

  it('refuses to render a four-term total from three (#775)', () => {
    // `transfer_fees: null` is the server saying *there is nothing to bound the
    // fees by* (#722), and counted as zero it produced exactly the 971,43 that
    // disagrees with `gain_absolu` by 13,95 — a total amputated of a term, with
    // nothing on the page able to say so. It is an absence now, and it is the
    // em dash: *there is nothing to compute* (ADR-0016), never a fifth form.
    const terms = {
      unrealised: known(461.46),
      realised: -599.01,
      dividends: 1108.98,
      transferFees: null,
      holdsPosition: true,
    }
    expect(gainTotal(terms)).toEqual({ known: false, because: 'unboundedFees' })
    expect(sumRendering(gainTotal(terms))).toBe(DASH)
    // And the term itself renders, as a dash: a headline that goes out with no
    // visible cause under it is worse than the wrong number it replaces.
    expect(termIsRendered('transferFees', termAmount(terms, 'transferFees'))).toBe(true)
    expect(termRendering(terms, 'transferFees')).toBe(DASH)
  })

  it('sums three terms where the fourth has no subject at all', () => {
    // A security is not a place money is transferred to (ADR-0017), so the
    // shares page's header can never carry that term — which is `0` and not
    // `null`: the sum of three **is** the gain it announces, and the term is
    // dropped rather than printed as `0,00 €`.
    const terms = securityTerms(defaultPositions())
    expect(termIsRendered('transferFees', termAmount(terms, 'transferFees'))).toBe(false)
    expect((gainTotal(terms) as { value: number }).value).toBeCloseTo(375, 2)
  })

  it('reads the three position terms off the positions', () => {
    //   ZZA  10 × 130,00 − 1 000,00 = +300,00, dividends 25,00
    //   ZZB   4 × 100,00 −   400,00 =    0,00, realised  50,00
    //   ZZC  carried at cost        =    0,00
    expect(positionTerms(defaultPositions())).toEqual({
      unrealised: known(300),
      realised: 50,
      dividends: 25,
      holdsPosition: true,
    })
    const total = gainTotal(portfolioTerms(defaultPositions(), -5)) as { value: number }
    expect(total.value).toBeCloseTo(370, 2)
  })

  it('gives a position carried at its cost a latent gain of exactly zero', () => {
    // Composing this out of null-tolerant helpers is what made a share whose
    // price was never observed report a total loss.
    const carried = aPosition({ quantity: 6, cost_basis: 600, price: null })
    expect(positionTerms([carried]).unrealised).toEqual(known(0))
  })

  it('leaves the latent term unknown when a rate is missing, and never zero', () => {
    // Quoted, and the rate did not resolve: this position has no market value
    // in the reporting currency, so neither has the sum. A `?? 0` here is how a
    // portfolio silently reports the gain of the part of itself it converted.
    const waiting = aPosition({ price: 125, currency: 'USD', rate: null })
    expect(positionTerms([waiting]).unrealised).toEqual({
      known: false,
      because: 'awaitingRate',
    })
    expect(gainTotal(portfolioTerms([waiting], -5)).known).toBe(false)
  })

  it('refuses the total on a fresh install, and says a rebuild rather than a rate', () => {
    // The install where **no** symbol is terminal, which is every install for
    // the length of its first reconstruction. The latent term has no figure —
    // a line whose history is still being read is worth nothing statable — and
    // the reason it carries is the one the reader can act on, which here is
    // *none*: the app is working, and there is nothing to answer.
    const rebuilding = aPosition({
      symbol: 'ZZC',
      quantity: 6,
      cost_basis: 600,
      price: null,
      terminal: false,
    })

    expect(positionTerms([rebuilding]).unrealised).toEqual({
      known: false,
      because: 'rebuilding',
    })
    const total = gainTotal(portfolioTerms([rebuilding], -5))
    expect(total).toEqual({ known: false, because: 'rebuilding' })
    // **Named on screen**, and that is half the repair: this function falls
    // back on the em dash for a reason it does not know, so a third one added
    // in silence would have gone out as *there is nothing to compute* about a
    // portfolio that is simply not finished being read (ADR-0016).
    expect(sumRendering(total)).toBe(REBUILDING)
    expect(sumRendering(total)).not.toBe(DASH)
    expect(sumRendering(total)).not.toBe(AWAITING_RATE)
  })

  it('carries a terminal line at its cost, which is what the counter never decided', () => {
    // The other half of the pair: the backward pass has finished, so *no price*
    // is permanent and the line contributes exactly zero to the latent gain
    // rather than emptying it. The failure counter is not in this loop at all
    // and never was — it separates two sentences, and #845 is what stopped it
    // separating two sums everywhere else.
    const carried = aPosition({ symbol: 'ZZC', quantity: 6, cost_basis: 600, price: null })
    expect(carried.terminal).toBe(true)
    expect(positionTerms([carried]).unrealised).toEqual(known(0))
    expect(gainTotal(portfolioTerms([carried], -5))).toEqual(known(-5))
  })

  it('does not let a **held** line with no nameable unit blank the headline', () => {
    // The same defect a second time, and the reason it is the same: this loop
    // asks `absenceCase` rather than holding a copy, so #774's repair — *a quote
    // is a number and a unit* — reaches the headline through the one call.
    // Before it, one line quoted in a unit nothing names turned the gain of the
    // **whole portfolio** into *waiting for a rate*, for a rate that was never
    // coming: there is no pair to fetch one for.
    const unitless = aPosition({ symbol: 'ZZG', quantity: 6, cost_basis: 600, price: 130, currency: null })
    expect(positionTerms([unitless]).unrealised).toEqual(known(0))

    const withOpenLines = positionTerms([...defaultPositions(), unitless])
    expect(withOpenLines.unrealised).toEqual(known(300))
    expect(gainTotal(portfolioTerms([...defaultPositions(), unitless], -5)).known).toBe(true)
  })

  it('does not let a **sold** position with no rate blank the headline', () => {
    // `absenceCase` tests `quantity === 0` first and unconditionally, and says
    // why: ordering it last is how *sold* and *broken ticker* collapse. This
    // function held its own copy of the classification, minus that first test,
    // so a line the owner closed years ago — whose `symbol_quote` still carries
    // a last price and whose rate does not resolve while the base currency is
    // unanswered — turned the gain of the **whole portfolio** into an absence.
    // A sold position contributes exactly zero by construction: nil quantity,
    // nil basis.
    const sold = aPosition({
      symbol: 'ZZD',
      quantity: 0,
      cost_basis: 0,
      realised: 120,
      price: 125,
      currency: 'USD',
      rate: null,
    })
    expect(positionTerms([sold]).unrealised).toEqual(known(0))

    const withOpenLines = positionTerms([...defaultPositions(), sold])
    expect(withOpenLines.unrealised).toEqual(known(300))
    expect(withOpenLines.realised).toBe(170)
  })
})

describe('what the terms are allowed to do on screen', () => {
  it('gives colour only to the two that can change sign', () => {
    expect(termCarriesSign('unrealised')).toBe(true)
    expect(termCarriesSign('realised')).toBe(true)
    // A dividend received is never negative and a transfer fee never positive;
    // colouring them steals the signal from the red of a realised loss.
    expect(termCarriesSign('dividends')).toBe(false)
    expect(termCarriesSign('transferFees')).toBe(false)
  })

  it('renders the fourth term only when it is not zero', () => {
    // An install whose transfers are free reads three terms and never learns
    // the fourth exists. **`null` is the other meaning and it does render**
    // (#775): the total above it is a dash for that very reason.
    expect(termIsRendered('transferFees', 0)).toBe(false)
    expect(termIsRendered('transferFees', null)).toBe(true)
    expect(termIsRendered('transferFees', -13.95)).toBe(true)
    // The other three are figures even at zero — a zero is a figure.
    expect(termIsRendered('dividends', 0)).toBe(true)
    expect(termIsRendered('realised', 0)).toBe(true)
  })

  it('names the latent term instead of dashing it when a rate is missing', () => {
    // The rendering comes from `lib/absence.ts` and the key lives there alone.
    // A caller holding `number | null` could only write a dash, which by
    // ADR-0016 says *there is nothing to compute* — the opposite of a rate the
    // app is about to fetch.
    const waiting = portfolioTerms([aPosition({ price: 125, currency: 'USD', rate: null })], -5)
    expect(termRendering(waiting, 'unrealised')).toBe(AWAITING_RATE)
    expect(termAmount(waiting, 'unrealised')).toBeNull()
    // The two reasons a sum can be unknown read apart: this one is repaired by
    // the app itself (#704), so it is named where the other wears the dash.
    expect(sumRendering(gainTotal(waiting))).toBe(AWAITING_RATE)

    const ordinary = portfolioTerms(defaultPositions(), -5)
    expect(termRendering(ordinary, 'unrealised')).toBe(FIGURE)
    expect(termRendering(ordinary, 'realised')).toBe(FIGURE)
  })

  it('dashes the latent term when nothing is held, and keeps the total a figure', () => {
    // A portfolio sold out of: the sum over closed lines is exactly `0`, which
    // is arithmetically right and reads as *your holdings have gained nothing*
    // about holdings that do not exist (#727). The other three terms are what
    // that owner still has, so the total stays a figure.
    const sold = portfolioTerms(
      [
        aPosition({ symbol: 'ZZD', quantity: 0, cost_basis: 0, realised: 120, dividends: 10, price: null }),
        aPosition({ symbol: 'ZZE', quantity: 0, cost_basis: 0, realised: -45, price: null }),
      ],
      -5,
    )

    expect(sold.holdsPosition).toBe(false)
    expect(termRendering(sold, 'unrealised')).toBe(DASH)
    expect(termRendering(sold, 'realised')).toBe(FIGURE)
    expect((gainTotal(sold) as { value: number }).value).toBeCloseTo(80, 2)
  })
})
