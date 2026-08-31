/**
 * One rule, and it is the whole file: **zero is not absence** (ADR-0016).
 */
import { describe, expect, it } from 'vitest'

import { signClass, signOf } from '@/lib/sign'

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
