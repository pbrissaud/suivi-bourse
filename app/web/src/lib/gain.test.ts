/**
 * The identity of ADR-0018, pinned to the cent.
 *
 * The measured counter-example is the reason the fourth term exists: on the
 * real portfolio `gain_absolu` reads 957,48 € while the three position terms
 * sum to 971,43 € — a gap of exactly 13,95 €, six `DEPOSIT` rows carrying a
 * fee. Those numbers are the test.
 */
import { describe, expect, it } from 'vitest'

import { AWAITING_RATE, FIGURE } from '@/lib/absence'
import {
  gainTotal,
  portfolioTerms,
  positionTerms,
  termAmount,
  termCarriesSign,
  termIsRendered,
  termRendering,
  type Unrealised,
} from '@/lib/gain'
import { aPosition, defaultPositions } from '@/test/factories'

/** A known sum, spelled once so the arithmetic below stays readable. */
const known = (value: number): Unrealised => ({ known: true, value })

describe('the four terms and their sum', () => {
  it('sums to the gain, the fourth term included', () => {
    //   latent +461,46 · realised −599,01 · dividends +1 108,98  =  971,43
    //   less the 13,95 taken out of six transfers                =  957,48
    const terms = {
      unrealised: known(461.46),
      realised: -599.01,
      dividends: 1108.98,
      transferFees: -13.95,
    }
    expect(gainTotal(terms)).toMatchObject({ known: true })
    expect(termAmount({ ...terms }, 'unrealised')).toBeCloseTo(461.46, 2)
    expect((gainTotal(terms) as { value: number }).value).toBeCloseTo(957.48, 2)
    // And without the fourth term the sum is the 971,43 that used to disagree
    // with `gain_absolu` by 13,95, with nothing on the page able to say why.
    const three = gainTotal({ ...terms, transferFees: null }) as { value: number }
    expect(three.value).toBeCloseTo(971.43, 2)
  })

  it('reads the three position terms off the positions', () => {
    //   ZZA  10 × 130,00 − 1 000,00 = +300,00, dividends 25,00
    //   ZZB   4 × 100,00 −   400,00 =    0,00, realised  50,00
    //   ZZC  carried at cost        =    0,00
    expect(positionTerms(defaultPositions())).toEqual({
      unrealised: known(300),
      realised: 50,
      dividends: 25,
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
    // the fourth exists.
    expect(termIsRendered('transferFees', 0)).toBe(false)
    expect(termIsRendered('transferFees', null)).toBe(false)
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

    const ordinary = portfolioTerms(defaultPositions(), -5)
    expect(termRendering(ordinary, 'unrealised')).toBe(FIGURE)
    expect(termRendering(ordinary, 'realised')).toBe(FIGURE)
  })
})
