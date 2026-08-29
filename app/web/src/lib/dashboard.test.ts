/**
 * The bottom of the dashboard, at the level where its rules are arithmetic
 * (#727). What is asserted here is what no rendering can show: the coincidence
 * of two announcers, and a line that disappears from two columns by moving by
 * nothing.
 *
 * The allocation's own cases left with the figure (#831): it divides the shares
 * page's table now, so they are in `shares.test.ts` beside the function.
 */
import { describe, expect, it } from 'vitest'

import {
  DASHBOARD_RANGES,
  amountsFromTotals,
  amountsFromValuation,
  amountsValues,
  dashboardState,
  dayMove,
  hasCashLedger,
  moversList,
  performanceRows,
  windowFloor,
  yFloor,
} from '@/lib/dashboard'
import { buildShareRows } from '@/lib/shares'
import {
  aClosedPosition,
  aMover,
  aPerfPoint,
  aPortfolioHistory,
  aPosition,
  aPositionsHistory,
  aPositionsPayload,
  aTotals,
  aTotalsPayload,
  NOW,
} from '@/test/factories'

const now = new Date(NOW)

function rowsOf(positions: Parameters<typeof buildShareRows>[0]) {
  return buildShareRows(positions, new Map())
}

describe('the one range control', () => {
  it('offers four presets, and `3M` is not one of them', () => {
    // From February to December `YTD` covers `3M` or contains it, and five
    // buttons on the page's only range control is one too many.
    expect([...DASHBOARD_RANGES]).toEqual(['1M', 'YTD', '1Y', 'MAX'])
  })

  it('reads a window off the calendar, and `MAX` bounds nothing', () => {
    expect(windowFloor('1M', now)).toBe('2026-02-02')
    expect(windowFloor('YTD', now)).toBe('2026-01-01')
    expect(windowFloor('1Y', now)).toBe('2025-03-02')
    expect(windowFloor('MAX', now)).toBeNull()
  })

  it('filters the series and never buckets it', () => {
    // The series is daily and dense over the calendar, and it is kept whole:
    // the retention ladder is about observed prices, of which five years is
    // tens of thousands of points. So a range changes the span and nothing
    // else — there is no *aggregated by X* caption owed here.
    const points = aPortfolioHistory().points
    const year = amountsFromTotals(points, windowFloor('1Y', now))

    expect(year.map((row) => row.t)).toEqual([
      '2025-03-02',
      '2026-01-01',
      '2026-02-02',
      '2026-03-02',
    ])
    expect(amountsFromTotals(points, null)).toHaveLength(points.length)
  })
})

describe('the value axis', () => {
  it('is floored at zero when nothing drawn is negative', () => {
    // The measured defect: a graduation at `−1 411 €` under a series that has
    // never been negative, which the reader has no way to know is an artefact.
    expect(yFloor(amountsValues(amountsFromTotals(aPortfolioHistory().points, null)))).toBeGreaterThan(
      0,
    )
  })

  it('does not spend the plot on the space between zero and the series', () => {
    // Measured on the real portfolio: a series living between 9 000 € and
    // 17 000 € drawn from zero puts half the plot on nothing and squashes the
    // year into its top third. *Never graduate below zero* and *start at zero*
    // are not the same instruction.
    expect(yFloor([9000, 12000, 17000])).toBe(9000 - 800)
    // And the clamp holds where a tenth of the amplitude reaches under zero.
    expect(yFloor([100, 12000])).toBe(0)
  })

  it('gives the floor back the moment a real negative appears', () => {
    // There the floor is information, and forcing anything would clip the curve
    // out of the plot altogether.
    expect(yFloor([1200, -40, 900])).toBe('auto')
  })

  it('answers a floor for a series with no amplitude, and for one with none at all', () => {
    // A flat series has no amplitude to take a tenth of, and a flat series at
    // zero has no magnitude either.
    expect(yFloor([1000, 1000])).toBe(900)
    expect(yFloor([0, 0])).toBe(0)
    expect(yFloor([null, null])).toBe(0)
  })
})

describe('the performance reading', () => {
  it('starts at 0 % and, at MAX, ends exactly on the head’s own figure', () => {
    // The check the ticket asks for: two announcers of one figure agreeing
    // instead of contradicting each other. At `MAX` the window's first day *is*
    // the series' origin, where the stored index is 100.
    const rows = performanceRows(aPortfolioHistory().points, null)

    expect(rows[0].performance).toBe(0)
    const head = (aTotals().twr_index! - 100) / 100
    expect(rows[rows.length - 1].performance).toBeCloseTo(head, 10)
  })

  it('is invariant to the horizon receding, which is why it carries no base date', () => {
    // The head's scalar moves while the reconstruction reaches further back —
    // that is what `twr_since` says on it. A curve rebased on the first day of
    // the *visible* window does not: history appearing before that day changes
    // nothing inside it, so there is no date to write under the plot.
    const floor = windowFloor('1Y', now)
    const whole = performanceRows(aPortfolioHistory().points, floor)
    const shorter = performanceRows(aPortfolioHistory().points.slice(1), floor)

    expect(shorter).toEqual(whole)
    expect(whole[0].performance).toBe(0)
  })

  it('never divides by an index that is not one', () => {
    // A series may open with days carrying no index at all (#708: `twr_index`
    // follows `total_value`), and dividing by one of those answers infinity.
    const points = aPortfolioHistory([
      { t: '2026-01-01', cash_balance: null, holdings_value: 600, total_value: null, net_contributed: null, twr_index: null },
      { t: '2026-02-02', cash_balance: 500, holdings_value: 1300, total_value: 1800, net_contributed: 1380, twr_index: 120 },
      { t: '2026-03-02', cash_balance: 500, holdings_value: 1300, total_value: 1800, net_contributed: 1380, twr_index: 132 },
    ]).points

    const rows = performanceRows(points, null)
    expect(rows.map((row) => row.t)).toEqual(['2026-02-02', '2026-03-02'])
    expect(rows[0].performance).toBe(0)
    expect(rows[1].performance).toBeCloseTo(0.1, 10)
  })
})

describe('the two readings', () => {
  it('falls back to valuation against cost where there is no cash ledger', () => {
    // #708's per-field rule: without a `DEPOSIT` anywhere, `total_value`,
    // `net_contributed` and `twr_index` are all `NULL` — so *value against net
    // contributed* is two empty curves, and the area of the fallback is the
    // **latent** gain rather than the gain.
    expect(hasCashLedger(aTotals())).toBe(true)
    expect(hasCashLedger(aTotals({ total_value: null, net_contributed: null }))).toBe(false)
    expect(hasCashLedger(null)).toBe(false)

    const rows = amountsFromValuation(aPositionsHistory().points, null)
    expect(rows[rows.length - 1]).toEqual({ t: '2026-03-02', value: 2300, contributed: 2000 })
  })
})

describe('the movers', () => {
  /** N held lines, named — the portfolio the sentence's denominator counts. */
  function heldLines(symbols: string[]) {
    return rowsOf(symbols.map((symbol) => aPosition({ symbol })))
  }

  it('counts what it does not show, and a line that moved by nothing with it', () => {
    // Measured: the portfolio's second line, at 16,6 % of it, moved 0,00 % — so
    // it entered no column and vanished from the list.
    const reading = moversList(
      [
        aMover({ symbol: 'A', change_pct: 0.05 }),
        aMover({ symbol: 'B', change_pct: 0 }),
        aMover({ symbol: 'C', change_pct: -0.02 }),
      ],
      heldLines(['A', 'B', 'C', 'D', 'E', 'F']),
    )

    // One list, best first: the riser, then the faller. The line that moved by
    // nothing is in neither, and is counted by the sentence instead.
    expect(reading.rows.map((mover) => mover.symbol)).toEqual(['A', 'C'])
    expect(reading.unchanged).toBe(1)
    // Six held, two shown: the unchanged one, and the three lines the server
    // never served because they have nothing to compare a first day against.
    expect(reading.others).toBe(4)
  })

  it('leaves a closed line out of the sentence it is not part of', () => {
    // `/api/positions` serves a sold line on purpose (ADR-0017), `buildShareRows`
    // folds it with its last frozen quote, and the server compares that quote
    // against a baseline equal to it — so a position closed years ago comes back
    // as `change_pct: 0`. Counted, it swelled `unchanged` while `others` was
    // taken over the held lines alone: the same sentence's two members then
    // described two different sets, and its qualifier could exceed the set it
    // qualifies.
    const rows = rowsOf([
      aPosition({ symbol: 'ZZA' }),
      aPosition({ symbol: 'ZZB' }),
      aClosedPosition({ symbol: 'ZZD', closed_at: '2025-11-04' }),
      aClosedPosition({ symbol: 'ZZE', closed_at: '2025-11-05' }),
    ])
    const reading = moversList(
      [
        aMover({ symbol: 'ZZA', change_pct: 0.05 }),
        aMover({ symbol: 'ZZB', change_pct: 0 }),
        // The measured shape: worth nothing, moving by nothing, still served.
        aMover({ symbol: 'ZZD', change_pct: 0, change: 0, market_value: 0, contribution: 0 }),
        // And one whose frozen quote still differs from its baseline: a closed
        // line has no business in a column of the portfolio's movers either.
        aMover({ symbol: 'ZZE', change_pct: 0.31, market_value: 0, contribution: 0 }),
      ],
      rows,
    )

    expect(reading.unchanged).toBe(1)
    expect(reading.rows.map((mover) => mover.symbol)).toEqual(['ZZA'])
    // Two held, one shown: the one that moved by nothing. The two closed lines
    // are in neither figure, which is what makes the pair one set.
    expect(reading.others).toBe(1)
    expect(reading.unchanged).toBeLessThanOrEqual(reading.others)
  })

  it('takes five, biggest first, whichever way they went', () => {
    const symbols = Array.from({ length: 8 }, (_, index) => `U${index}`)
    // Four up and four down, so the list has to choose across the whole set and
    // not five from one end of it: the day's best and its worst both belong.
    const movers = symbols.map((symbol, index) =>
      aMover({ symbol, change_pct: (index - 3.5) / 100 }),
    )
    const reading = moversList(movers, heldLines(symbols))

    expect(reading.rows.map((mover) => mover.symbol)).toEqual(['U7', 'U6', 'U5', 'U4', 'U3'])
    expect(reading.others).toBe(3)
  })
})

describe('the day’s move', () => {
  const day = (t: string, totalValue: number | null, contributed: number | null) => ({
    ...aPerfPoint(t, 100),
    total_value: totalValue,
    net_contributed: contributed,
  })

  it('counts the movement of the gain, which no deposit moves', () => {
    // `gain_absolu = total_value − net_contributed`, so a 500,00 deposit made
    // today lifts both terms and the day's move stays what the holdings did.
    // It is `_ytd`'s own definition over a one-day window, which is the whole
    // reason the figure is spelled on this series rather than on the movers.
    expect(
      dayMove([day('2026-03-01', 1800, 1380), day('2026-03-02', 2330, 1880)], now),
    ).toBeCloseTo(30, 10)
  })

  it('says nothing about today until the series has reached today', () => {
    // A series stopping short is a reconstruction in progress, and *today* is
    // then a claim nothing on the wire supports.
    expect(dayMove([day('2026-02-28', 1800, 1380), day('2026-03-01', 1830, 1380)], now)).toBeNull()
  })

  it('has no figure while the read is in flight, or with one day to its name', () => {
    // `null` is the read; a single point is a payload with no difference in it.
    expect(dayMove(null, now)).toBeNull()
    expect(dayMove([day('2026-03-02', 1800, 1380)], now)).toBeNull()
  })

  it('goes out on an install with no cash ledger rather than reading a gain of nothing', () => {
    // `total_value` and `net_contributed` are both `NULL` there (#708), where
    // `gain_absolu` is written always — so the year-to-date pill survives this
    // one and an absent pill is not a false one.
    expect(
      dayMove([day('2026-03-01', null, null), day('2026-03-02', null, null)], now),
    ).toBeNull()
  })
})

describe('the four states of the page', () => {
  it('tells *no events* from *events and nothing held*', () => {
    // The first is one sentence and a link; the second is an ordinary page
    // whose blocks each say why they are empty.
    expect(
      dashboardState({ failed: false, positions: aPositionsPayload([], null), totals: aTotalsPayload(null, null) }),
    ).toBe('empty')
    expect(
      dashboardState({ failed: false, positions: aPositionsPayload([]), totals: aTotalsPayload() }),
    ).toBe('portfolio')
  })

  it('claims nothing while a read has not landed, and yields to a failure', () => {
    expect(dashboardState({ failed: false, totals: aTotalsPayload() })).toBe('pending')
    expect(
      dashboardState({ failed: true, positions: aPositionsPayload(), totals: aTotalsPayload() }),
    ).toBe('failed')
  })
})
