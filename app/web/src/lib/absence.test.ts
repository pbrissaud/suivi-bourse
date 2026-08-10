/**
 * The four renderings of absence, case by case — a pure function under one
 * rule (ADR-0016): *the em dash means there is nothing to compute; anything
 * merely missing is named instead.*
 */
import { describe, expect, it } from 'vitest'

import { absenceCase, positionRenderings, type PositionAbsenceInput } from '@/lib/absence'
import { formatMessage } from '@/lib/i18n'

const NOW = '2026-03-02T12:00:00.000Z'

function input(overrides: Partial<PositionAbsenceInput> = {}): PositionAbsenceInput {
  return {
    quantity: 10,
    price: { value: 130, currency: 'EUR', at: NOW },
    converted: { value: 130, currency: 'EUR', rate: 1, rate_at: NOW },
    consecutiveFailures: 0,
    ...overrides,
  }
}

describe('the four absences', () => {
  it('carries a never-quoted position at its cost: a dash, a value, and a zero', () => {
    const held = input({ price: null, converted: null })
    expect(absenceCase(held)).toBe('carriedAtCost')
    expect(positionRenderings(held)).toEqual({
      price: { kind: 'dash' },
      valuation: { kind: 'figure' },
      unrealised: { kind: 'figure' },
    })
  })

  it('names the missing rate rather than dashing it', () => {
    const waiting = input({ converted: null })
    expect(absenceCase(waiting)).toBe('awaitingRate')
    const rendered = positionRenderings(waiting)
    // The native price stays on screen: it is the quote the reader's broker
    // shows them. What is missing is the rate, and it is repairable.
    expect(rendered.price).toEqual({ kind: 'figure' })
    expect(rendered.valuation).toEqual({ kind: 'named', message: 'absence.awaitingRate' })
    expect(rendered.unrealised).toEqual({ kind: 'named', message: 'absence.awaitingRate' })
  })

  it('has nothing to compute on a sold position', () => {
    const sold = input({ quantity: 0, price: null, converted: null })
    expect(absenceCase(sold)).toBe('nothingToCompute')
    expect(positionRenderings(sold)).toEqual({
      price: { kind: 'dash' },
      valuation: { kind: 'figure' },
      unrealised: { kind: 'dash' },
    })
  })

  it('reports its count on a ticker that never answers, and never says “never”', () => {
    const mute = input({ price: null, converted: null, consecutiveFailures: 3 })
    expect(absenceCase(mute)).toBe('noQuote')
    const rendered = positionRenderings(mute)
    for (const cell of [rendered.price, rendered.valuation, rendered.unrealised]) {
      expect(cell).toEqual({ kind: 'named', message: 'absence.noQuote', values: { count: 3 } })
    }
    // The app knows N readings returned nothing. It does not know nothing will
    // ever come — that would be a guess, and it is not computable.
    expect(formatMessage('fr', 'absence.noQuote', { count: 3 })).not.toMatch(/jamais/)
    expect(formatMessage('en', 'absence.noQuote', { count: 3 })).not.toMatch(/never/i)
    expect(formatMessage('fr', 'absence.noQuote', { count: 3 })).toContain('3')
  })

  it('never collapses the last two, which is what the split is for', () => {
    // A sold position has no question to ask. A line entered under a ticker the
    // market does not know has one, and it is usually a typo.
    const sold = input({ quantity: 0, price: null, converted: null, consecutiveFailures: 7 })
    const mute = input({ price: null, converted: null, consecutiveFailures: 7 })
    expect(absenceCase(sold)).not.toBe(absenceCase(mute))
    expect(positionRenderings(sold).unrealised).not.toEqual(positionRenderings(mute).unrealised)
  })

  it('calls a fully quoted position no absence at all', () => {
    expect(absenceCase(input())).toBe('quoted')
    expect(positionRenderings(input())).toEqual({
      price: { kind: 'figure' },
      valuation: { kind: 'figure' },
      unrealised: { kind: 'figure' },
    })
  })
})
