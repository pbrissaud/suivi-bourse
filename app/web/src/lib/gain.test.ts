/**
 * The identity of ADR-0018, pinned to the cent.
 *
 * The measured counter-example is the reason the fourth term exists: on the
 * real portfolio `gain_absolu` reads 957,48 € while the three position terms
 * sum to 971,43 € — a gap of exactly 13,95 €, six `DEPOSIT` rows carrying a
 * fee. Those numbers are the test.
 */
import { describe, expect, it } from 'vitest'

import {
  gainTotal,
  portfolioTerms,
  positionTerms,
  termCarriesSign,
  termIsRendered,
} from '@/lib/gain'
import { aPosition, defaultPositions } from '@/test/factories'

describe('the four terms and their sum', () => {
  it('sums to the gain, the fourth term included', () => {
    //   latent +461,46 · realised −599,01 · dividends +1 108,98  =  971,43
    //   less the 13,95 taken out of six transfers                =  957,48
    const terms = {
      unrealised: 461.46,
      realised: -599.01,
      dividends: 1108.98,
      transferFees: -13.95,
    }
    expect(gainTotal(terms)).toBeCloseTo(957.48, 2)
    // And without the fourth term the sum is the 971,43 that used to disagree
    // with `gain_absolu` by 13,95, with nothing on the page able to say why.
    expect(gainTotal({ ...terms, transferFees: null })).toBeCloseTo(971.43, 2)
  })

  it('reads the three position terms off the positions', () => {
    //   ZZA  10 × 130,00 − 1 000,00 = +300,00, dividends 25,00
    //   ZZB   4 × 100,00 −   400,00 =    0,00, realised  50,00
    //   ZZC  carried at cost        =    0,00
    expect(positionTerms(defaultPositions())).toEqual({
      unrealised: 300,
      realised: 50,
      dividends: 25,
    })
    expect(gainTotal(portfolioTerms(defaultPositions(), -5))).toBeCloseTo(370, 2)
  })

  it('gives a position carried at its cost a latent gain of exactly zero', () => {
    // Composing this out of null-tolerant helpers is what made a share whose
    // price was never observed report a total loss.
    const carried = aPosition({ quantity: 6, cost_basis: 600, price: null })
    expect(positionTerms([carried]).unrealised).toBe(0)
  })

  it('leaves the latent term unknown when a rate is missing, and never zero', () => {
    // Quoted, and the rate did not resolve: this position has no market value
    // in the reporting currency, so neither has the sum. A `?? 0` here is how a
    // portfolio silently reports the gain of the part of itself it converted.
    const waiting = aPosition({ price: 125, currency: 'USD', rate: null })
    expect(positionTerms([waiting]).unrealised).toBeNull()
    expect(gainTotal(portfolioTerms([waiting], -5))).toBeNull()
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
})
