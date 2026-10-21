/**
 * One rule, and it is the whole file: **zero is not absence**.
 */
import { describe, expect, it } from 'vitest'

import { figureClass, RATIO_DECIMALS, signClass, signOf } from '@/lib/sign'

describe('the colour of a money figure', () => {
  it('separates a zero from an absence, which the prototype did not', () => {
    // `signClass` greyed `0` exactly as it greyed `null`, and a sold-out
    // position carries both side by side — `Valorisation 0,00 €` beside
    // `Latente —`. In one grey the reader cannot tell *worth nothing* from
    // *nothing to tell you*.
    expect(signOf(0)).toBe('zero')
    expect(signOf(null)).toBe('absent')
    expect(signClass(0)).not.toBe(signClass(null))
  })

  it('gives zero the colour of text, never the grey of absence', () => {
    expect(signClass(0)).toBe('text-foreground')
    expect(signClass(null)).toBe('text-muted-foreground')
    expect(signClass(undefined)).toBe('text-muted-foreground')
  })

  it('reads a negative zero as a zero', () => {
    // It comes out of a subtraction often enough that reading it as a loss
    // would paint red on a position that has not moved.
    expect(signOf(-0)).toBe('zero')
  })

  it('answers gain and loss on either side', () => {
    expect(signClass(0.01)).toBe('text-gain')
    expect(signClass(-0.01)).toBe('text-loss')
  })
})

describe('a figure that is neither money made nor money lost (#1282)', () => {
  it('figureClass: the colour of text for a figure of either sign, muted for an absence', () => {
    expect(figureClass(4212.8)).toBe('text-foreground')
    expect(figureClass(-1200)).toBe('text-foreground')
    expect(figureClass(0)).toBe('text-foreground')
    expect(figureClass(null)).toBe('text-muted-foreground')
    expect(figureClass(undefined)).toBe('text-muted-foreground')
    expect(figureClass(Number.NaN)).toBe('text-muted-foreground')
  })
})

describe('the sign of the figure shown, not of the raw value (#1286)', () => {
  it('reads a ratio that rounds to 0,00 % as a zero, on either side', () => {
    // An IRR of +0,00003 % reads `0,00 %`: a green arrow beside it claims a
    // gain the digits do not show.
    expect(signOf(0.0000003, RATIO_DECIMALS)).toBe('zero')
    expect(signOf(-0.0000003, RATIO_DECIMALS)).toBe('zero')
    expect(signClass(0.0000003, RATIO_DECIMALS)).toBe('text-foreground')
  })

  it('rounds half away from zero, as the formatter does', () => {
    // +0,005 % is `+0,01 %` once formatted, and coloured as the gain it shows.
    expect(signOf(0.00005, RATIO_DECIMALS)).toBe('gain')
    expect(signOf(-0.00005, RATIO_DECIMALS)).toBe('loss')
    expect(signOf(0.0000499, RATIO_DECIMALS)).toBe('zero')
  })

  it('reads money to the cent by default', () => {
    expect(signOf(0.004)).toBe('zero')
    expect(signOf(-0.004)).toBe('zero')
    expect(signOf(0.005)).toBe('gain')
    // `1.005 * 100` is 100.4999… in binary: the cent is the decimal's.
    expect(signOf(-1.005)).toBe('loss')
  })

  it('keeps a real ratio a gain: 0,4 % is not money', () => {
    expect(signOf(0.004, RATIO_DECIMALS)).toBe('gain')
  })
})
