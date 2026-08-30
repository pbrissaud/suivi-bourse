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
    // The steady state, so the cases below are read against a finished
    // backfill; the rebuild is a case of its own further down (#845).
    terminal: true,
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

  it('carries a line quoted in no nameable unit, and never leaves it waiting', () => {
    // The shape the payload actually serves: a number came back, and the column
    // that says what it is a number *of* is empty (#774). There is no pair, so
    // no rate is on its way — the absence is permanent, and it joins the first
    // row of the table rather than founding a fifth one.
    const unitless = input({ price: { value: 130, currency: null, at: NOW }, converted: null })
    expect(absenceCase(unitless)).toBe('carriedAtCost')
    expect(positionRenderings(unitless)).toEqual({
      price: { kind: 'dash' },
      valuation: { kind: 'figure' },
      unrealised: { kind: 'figure' },
    })

    // And it is *not* the line whose unit is known and whose rate is missing,
    // which is #706's legitimate wait and must survive this repair intact.
    const waiting = input({ converted: null })
    expect(absenceCase(waiting)).toBe('awaitingRate')
    expect(absenceCase(unitless)).not.toBe(absenceCase(waiting))
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
    // The sentence goes where *no price* is true — the price cell — while the
    // two money cells state the convention the line is valued under (#845).
    expect(rendered.price).toEqual({
      kind: 'named',
      message: 'absence.noQuote',
      values: { count: 3 },
    })
    expect(rendered.valuation).toEqual({ kind: 'figure' })
    expect(rendered.unrealised).toEqual({ kind: 'figure' })
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

  it('says nothing at all about a line whose history is still being rebuilt', () => {
    // The second term of ADR-0004's predicate, and the whole of #845: the
    // backward pass has not reached this symbol's first acquisition, so *no
    // price* means *not yet* and carrying it at its cost would render *not yet*
    // as *never* — which is the sentence `carrying.py` refuses.
    const rebuilding = input({ price: null, converted: null, terminal: false })
    expect(absenceCase(rebuilding)).toBe('rebuilding')
    expect(positionRenderings(rebuilding)).toEqual({
      price: { kind: 'named', message: 'absence.rebuilding' },
      valuation: { kind: 'named', message: 'absence.rebuilding' },
      unrealised: { kind: 'named', message: 'absence.rebuilding' },
    })

    // Two sentences, one arithmetic: the counter is what parts them, and it
    // still says nothing about what the line is worth.
    const asked = input({ price: null, converted: null, terminal: false, consecutiveFailures: 4 })
    expect(absenceCase(asked)).toBe('rebuilding')
    for (const cell of Object.values(positionRenderings(asked))) {
      expect(cell).toEqual({ kind: 'named', message: 'absence.noQuote', values: { count: 4 } })
    }

    // And the catalogues say a rebuild rather than a failure: nothing here is
    // the reader's to repair.
    expect(formatMessage('fr', 'absence.rebuilding')).toMatch(/reconstitution/)
    expect(formatMessage('en', 'absence.rebuilding')).toMatch(/rebuilt/)
  })

  it('lets terminality alone decide the arithmetic, the counter never', () => {
    // The same counter on both, and two different verdicts; the same
    // terminality with two counters, and one verdict. That pair is the
    // substitution #845 removed: the counter separates *asked and got nothing*
    // from *not asked yet*, which are two sentences and one sum.
    const carried = input({ price: null, converted: null, consecutiveFailures: 3 })
    const waiting = input({ price: null, converted: null, consecutiveFailures: 3, terminal: false })
    expect(absenceCase(carried)).toBe('noQuote')
    expect(absenceCase(waiting)).toBe('rebuilding')

    const never = input({ price: null, converted: null, consecutiveFailures: 0 })
    expect(absenceCase(never)).toBe('carriedAtCost')
    // Both terminal, both priceless, and both valued the same way — only the
    // sentence in the price cell differs.
    expect(positionRenderings(never).valuation).toEqual(positionRenderings(carried).valuation)
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
