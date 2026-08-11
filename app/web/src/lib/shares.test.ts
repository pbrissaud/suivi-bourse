/**
 * The shares page's arithmetic, under this suite's own seam: entries, exits,
 * no rendering (#712 Testing Decisions).
 *
 * Each case names the wrong figure it prevents — a phantom loss on a closed
 * line, a unit price rebuilt from an average of averages, a failing ticker
 * subtracting its whole basis from the portfolio's value.
 */
import { describe, expect, it } from 'vitest'

import type { Position } from '@/lib/api'
import {
  buildShareRows,
  closedRows,
  heldRows,
  isAnomalous,
  isClosed,
  marketValue,
  unitCost,
  unrealised,
  unrealisedRatio,
  valuationTotal,
} from '@/lib/shares'
import { aClosedPosition, aPosition, sharesPortfolio } from '@/test/factories'

const NO_FAILURES = new Map<string, number>()

function rowsOf(positions: Position[], failures = NO_FAILURES) {
  return buildShareRows(positions, failures)
}

describe('a row is a symbol, not a holding', () => {
  it('folds the same share held on two accounts into one line', () => {
    // The model stays multi-account: the same ETF on a PEA and on a CTO is the
    // most ordinary case of the domain, and that none of the nineteen real
    // symbols shows it is contingent.
    const [row] = rowsOf([
      aPosition({ account: 'alpha', symbol: 'ZZF', quantity: 2, cost_basis: 200, price: 110 }),
      aPosition({ account: 'beta', symbol: 'ZZF', quantity: 3, cost_basis: 300, price: 110 }),
    ])

    expect(row.quantity).toBe(5)
    expect(row.cost_basis).toBe(500)
    expect(row.accounts).toEqual(['alpha', 'beta'])
    // 5 × 110,00 = 550,00, and 550,00 − 500,00 = +50,00.
    expect(marketValue(row)).toBe(550)
    expect(unrealised(row)).toBe(50)
    // The unit cost is one division over the amounts, never a mean of means:
    // 500,00 / 5 = 100,00, where averaging 100,00 and 100,00 happens to agree
    // and averaging 90 and 106,67 would not.
    expect(unitCost(row)).toBe(100)
  })

  it('keeps naming the accounts of a line nobody holds any more', () => {
    // The folded section carries a `Compte` column; a closed row that named no
    // account leaves it empty exactly where the reader is asking *on which
    // account did this happen*.
    const [row] = rowsOf([
      aClosedPosition({ account: 'alpha', symbol: 'ZZD', realised: 120, closed_at: '2025-11-04' }),
    ])
    expect(row.accounts).toEqual(['alpha'])
  })

  it('closes on the day the **last** account sold out', () => {
    const [row] = rowsOf([
      aClosedPosition({ account: 'alpha', symbol: 'ZZD', closed_at: '2025-11-04' }),
      aClosedPosition({ account: 'beta', symbol: 'ZZD', closed_at: '2026-01-15' }),
    ])
    expect(row.closedAt).toBe('2026-01-15')
  })
})

describe('a closed position', () => {
  it('is a derivation over quantity and has no unit cost at all', () => {
    // ADR-0003: quantity zero means basis zero, so the division is `0 / 0` and
    // the honest answer is *there is nothing to compute*. This is where the
    // phantom −932 € of a sold line used to come from.
    const [row] = rowsOf([
      aClosedPosition({ symbol: 'ZZD', realised: 120, dividends: 10, closed_at: '2025-11-04' }),
    ])

    expect(isClosed(row)).toBe(true)
    expect(unitCost(row)).toBeNull()
    expect(marketValue(row)).toBe(0)
    expect(unrealised(row)).toBeNull()
    // The two figures it has left, and it keeps them for good.
    expect(row.realised).toBe(120)
    expect(row.dividends).toBe(10)
  })
})

describe('a position with no price is carried at its cost', () => {
  it('is worth what it cost and its latent gain is exactly zero', () => {
    // Not a loss: valuing at cost is what makes the day of a purchase come out
    // neutral instead of digging a crater in the consolidated curve.
    const [row] = rowsOf([aPosition({ symbol: 'ZZC', quantity: 6, cost_basis: 600, price: null })])
    expect(marketValue(row)).toBe(600)
    expect(unrealised(row)).toBe(0)
  })

  it('stays carried at cost when the app has asked and got nothing', () => {
    // The counter is a **rendering** concern. Read as an arithmetic one, a
    // ticker that stopped answering this morning would subtract its whole basis
    // from the portfolio's value tonight.
    const rows = rowsOf(
      [aPosition({ symbol: 'ZZC', quantity: 6, cost_basis: 600, price: null })],
      new Map([['ZZC', 3]]),
    )
    expect(isAnomalous(rows[0])).toBe(true)
    expect(marketValue(rows[0])).toBe(600)
    expect(valuationTotal(rows)).toEqual({ known: true, value: 600 })
  })
})

describe('a quoted position waiting for its rate', () => {
  it('has no value, and the portfolio total inherits the reason', () => {
    // `number | null` is one bit short: the nullity survives the return and the
    // case does not, so a caller writes an em dash and claims there is nothing
    // to compute about a rate the app fetches by itself.
    const rows = rowsOf([aPosition({ symbol: 'ZZB', price: 125, currency: 'USD', rate: null })])
    expect(marketValue(rows[0])).toBeNull()
    expect(valuationTotal(rows)).toEqual({ known: false, because: 'awaitingRate' })
  })
})

describe('the two orderings', () => {
  it('puts the heaviest line first, and a line with no value last', () => {
    const rows = rowsOf([
      ...sharesPortfolio(),
      aPosition({ symbol: 'ZZB2', price: 125, currency: 'USD', rate: null }),
    ])
    // 1 300,00 · 600,00 · 400,00 · then the one that has no value at all.
    expect(heldRows(rows).map((row) => row.symbol)).toEqual(['ZZA', 'ZZC', 'ZZB', 'ZZB2'])
  })

  it('sorts the closed section on the closing date, descending', () => {
    // Market value is zero across the whole section: a column of zeros orders
    // nothing, and this is the only column that discriminates these rows.
    expect(closedRows(rowsOf(sharesPortfolio())).map((row) => row.symbol)).toEqual(['ZZE', 'ZZD'])
  })
})

describe('the percentage under the latent gain', () => {
  it('is the gain over the basis, and is undefined on a nil basis', () => {
    const [held] = rowsOf([aPosition({ symbol: 'ZZA', quantity: 10, cost_basis: 1000, price: 130 })])
    expect(unrealisedRatio(held)).toBeCloseTo(0.3, 10)

    // A pure grant costs nothing: dividing by it would be a percentage of zero.
    const [granted] = rowsOf([aPosition({ symbol: 'ZZG', quantity: 4, cost_basis: 0, price: 10 })])
    expect(unrealisedRatio(granted)).toBeNull()
  })
})
