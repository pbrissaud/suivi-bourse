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
  AXIS_TICKS,
  DASHBOARD_RANGES,
  amountsFromTotals,
  amountsFromValuation,
  amountsValues,
  dashboardState,
  heroReading,
  hasCashLedger,
  unpricedLines,
  performanceRows,
  tickDigits,
  timeTicks,
  valueAxis,
  signSplitOffset,
  windowFloor,
  yFloor,
} from '@/features/dashboard/lib/dashboard'
import { formatCompact } from '@/lib/format'
import {
  aClosedPosition,
  aPerfPoint,
  aPortfolioHistory,
  aPosition,
  aPositionsHistory,
  aPositionsPayload,
  aRuntime,
  aTotals,
  aTotalsPayload,
  NOW,
} from '@/test/factories'

const now = new Date(NOW)

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
    expect(
      yFloor(amountsValues(amountsFromTotals(aPortfolioHistory().points, null))),
    ).toBeGreaterThan(0)
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

describe('the axes (#1265)', () => {
  /** `count` consecutive days from `from`. */
  function daysFrom(from: string, count: number): string[] {
    const start = new Date(`${from}T00:00:00Z`)
    return Array.from({ length: count }, (_, i) =>
      new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10),
    )
  }

  it('valueAxis gives three to five ticks on a 1, 2, 2.5 or 5 step', () => {
    for (let power = -4; power <= 7; power += 1) {
      for (const [low, high] of [
        [1, 1.3],
        [1, 2],
        [1, 7],
        [3, 4.2],
        [-5, -1],
        [-3, 4],
        [-1, 1],
      ]) {
        const { ticks } = valueAxis([low * 10 ** power, high * 10 ** power])
        const label = `${low}..${high} e${power}`
        expect(ticks.length, label).toBeGreaterThanOrEqual(3)
        expect(ticks.length, label).toBeLessThanOrEqual(5)
        const gap = ticks[1] - ticks[0]
        const mantissa = gap / 10 ** Math.floor(Math.log10(gap) + 1e-9)
        expect(
          [1, 2, 2.5, 5].some((m) => Math.abs(m - mantissa) < 1e-6),
          label,
        ).toBe(true)
        for (let i = 2; i < ticks.length; i += 1) {
          expect(ticks[i] - ticks[i - 1], label).toBeCloseTo(gap, 10)
        }
      }
    }
  })

  it('valueAxis keeps every drawn value and every tick inside its domain', () => {
    const { domain, ticks } = valueAxis([null, 9000, 12000, 17000, null])
    expect(domain[0]).toBeGreaterThanOrEqual(0)
    for (const value of [9000, 12000, 17000, ...ticks]) {
      expect(value).toBeGreaterThanOrEqual(domain[0])
      expect(value).toBeLessThanOrEqual(domain[1])
    }
    expect(valueAxis([-40, 900]).domain[0]).toBeLessThan(-40)
    expect(valueAxis([null, null])).toEqual({ domain: [0, 1], ticks: [] })
  })

  it('valueAxis always graduates 0 % on the performance reading', () => {
    for (const range of DASHBOARD_RANGES) {
      const rows = performanceRows(aPortfolioHistory().points, windowFloor(range, now))
      expect(valueAxis(rows.map((row) => row.performance)).ticks, range).toContain(0)
    }
  })

  it('timeTicks marks weeks on 1M, months on 1Y and years on MAX', () => {
    const month = timeTicks(daysFrom('2026-09-18', 31), AXIS_TICKS.time.wide)
    expect(month.unit).toBe('day')
    for (const tick of month.ticks) expect(new Date(`${tick}T00:00:00Z`).getUTCDay()).toBe(1)

    const year = timeTicks(daysFrom('2025-10-18', 366), AXIS_TICKS.time.wide)
    expect(year.unit).toBe('month')
    expect(year.ticks).toHaveLength(12)

    const max = timeTicks(daysFrom('2019-10-30', 7 * 365), AXIS_TICKS.time.wide)
    expect(max.unit).toBe('year')
    expect(max.ticks).toHaveLength(7)
  })

  it('timeTicks never draws more than the budget, on a phone or not', () => {
    const series = [
      daysFrom('2026-10-13', 5),
      daysFrom('2026-09-18', 31),
      daysFrom('2026-01-01', 40),
      daysFrom('2026-01-01', 291),
      daysFrom('2025-10-18', 366),
      daysFrom('2019-10-30', 7 * 365),
      daysFrom('2009-10-30', 17 * 365),
    ]
    for (const days of series) {
      for (const max of [AXIS_TICKS.time.phone, AXIS_TICKS.time.wide]) {
        const { ticks } = timeTicks(days, max)
        expect(ticks.length, `${days[0]} +${days.length} at ${max}`).toBeLessThanOrEqual(max)
        expect(ticks.length, `${days[0]} +${days.length} at ${max}`).toBeGreaterThanOrEqual(1)
        for (const tick of ticks) expect(days).toContain(tick)
      }
    }
  })

  it('timeTicks never marks the period a series starts in', () => {
    // 18 Oct 2026 to 20 Dec: October is the starting month, so the first month tick is November.
    const { unit, ticks } = timeTicks(daysFrom('2026-10-18', 64), AXIS_TICKS.time.phone)
    expect(unit).toBe('month')
    expect(ticks[0]).toBe('2026-11-01')
    expect(ticks.some((tick) => tick.startsWith('2026-10'))).toBe(false)
  })

  it('tickDigits adds digits until neighbouring ticks read differently', () => {
    const compact = (value: number, digits: number) => formatCompact('fr-FR', value, 'EUR', digits)
    // Tight around 1 M€: two digits write every one of these `1 M€`.
    const tight = [1_000_000, 1_001_000, 1_002_000, 1_003_000]
    expect(new Set(tight.map((tick) => compact(tick, 2))).size).toBe(1)
    const digits = tickDigits(tight, compact)
    expect(digits).toBeGreaterThan(2)
    expect(new Set(tight.map((tick) => compact(tick, digits))).size).toBe(tight.length)
    // And a roomy axis keeps the formatter's own two.
    expect(tickDigits([0, 5000, 10_000], compact)).toBe(2)
  })

  it('timeTicks on fewer than two days is empty', () => {
    expect(timeTicks([], 12)).toEqual({ unit: 'day', ticks: [] })
    expect(timeTicks(['2026-10-18'], 12)).toEqual({ unit: 'day', ticks: [] })
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

  it('ends, at MAX, on the figure the IRR’s bubble states', () => {
    // The bubble writes `twr_index / 100 − 1` from `twr_since`; the MAX curve
    // starts on that same day. They cannot disagree.
    const points = [100, 104.5, 91.25, 137.5].map((index, i) =>
      aPerfPoint(`2026-0${i + 1}-01`, index),
    )
    const rows = performanceRows(points, windowFloor('MAX', now))

    expect(rows[0].performance).toBe(0)
    expect(Math.abs(rows[rows.length - 1].performance! - (137.5 / 100 - 1))).toBeLessThan(1e-12)
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
      {
        t: '2026-01-01',
        cash_balance: null,
        holdings_value: 600,
        total_value: null,
        net_contributed: null,
        twr_index: null,
      },
      {
        t: '2026-02-02',
        cash_balance: 500,
        holdings_value: 1300,
        total_value: 1800,
        net_contributed: 1380,
        twr_index: 120,
      },
      {
        t: '2026-03-02',
        cash_balance: 500,
        holdings_value: 1300,
        total_value: 1800,
        net_contributed: 1380,
        twr_index: 132,
      },
    ]).points

    const rows = performanceRows(points, null)
    expect(rows.map((row) => row.t)).toEqual(['2026-02-02', '2026-03-02'])
    expect(rows[0].performance).toBe(0)
    expect(rows[1].performance).toBeCloseTo(0.1, 10)
  })
})

describe('where the performance curve changes colour', () => {
  it('is all gain above zero and all loss below it', () => {
    expect(signSplitOffset([0, 0.02, 0.1])).toBe(1)
    expect(signSplitOffset([-0.1, -0.02, 0])).toBe(0)
  })

  it('splits a crossing curve at zero, from the top of its own height', () => {
    expect(signSplitOffset([-0.1, 0.3, 0.05])).toBeCloseTo(0.3 / 0.4, 12)
  })

  it('has no split for a flat or an empty series', () => {
    expect(signSplitOffset([0.2, 0.2])).toBeNull()
    expect(signSplitOffset([])).toBeNull()
    expect(signSplitOffset([null, null])).toBeNull()
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

describe('the four states of the page', () => {
  it('tells *no events* from *events and nothing held*', () => {
    // The first is one sentence and a link; the second is an ordinary page
    // whose blocks each say why they are empty.
    expect(
      dashboardState({
        failed: false,
        positions: aPositionsPayload([], null),
        totals: aTotalsPayload(null, null),
      }),
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

describe('heroReading (#1260)', () => {
  const past = aTotals({ day: '2026-03-01' })

  it('is valued when the newest row is today’s', () => {
    expect(heroReading(aTotals({ day: '2026-03-02' }), undefined, now)).toBe('valued')
    expect(heroReading(aTotals({ day: '2026-03-02' }), aRuntime({ rebuilding: true }), now)).toBe(
      'valued',
    )
  })

  it('is pending over a past-day row while the runtime has not answered', () => {
    expect(heroReading(past, undefined, now)).toBe('pending')
  })

  it('is partial over a past-day row while the history is rebuilding', () => {
    expect(heroReading(past, aRuntime({ rebuilding: true }), now)).toBe('partial')
  })

  it('stays valued over a past-day row when nothing is rebuilding', () => {
    expect(heroReading(past, aRuntime({ rebuilding: false }), now)).toBe('valued')
  })

  it('reads today off the server clock, not the browser’s', () => {
    // The browser is a day ahead of the server: the row is the server's today.
    const browser = new Date('2026-03-03T01:00:00.000Z')
    expect(heroReading(past, aRuntime({ rebuilding: true, now: NOW }), browser)).toBe('partial')
    expect(
      heroReading(
        aTotals({ day: '2026-03-02' }),
        aRuntime({ rebuilding: true, now: NOW }),
        browser,
      ),
    ).toBe('valued')
  })
})

describe('unpricedLines (#1260)', () => {
  it('names held lines with no quote or no rate, once across accounts, by name then symbol', () => {
    const lines = unpricedLines([
      aPosition({
        account: 'alpha',
        symbol: 'ZZB',
        name: 'Zeta Beta',
        price: null,
        terminal: false,
      }),
      aPosition({
        account: 'beta',
        symbol: 'ZZB',
        name: 'Zeta Beta',
        price: null,
        terminal: false,
      }),
      aPosition({ symbol: 'ZZC', name: null, price: 10, currency: 'USD', rate: null }),
      aPosition({ symbol: 'ZZA', name: 'Alpha Zeta', price: null, terminal: false }),
    ])
    expect(lines).toEqual(['Alpha Zeta', 'Zeta Beta', 'ZZC'])
  })

  it('leaves out sold, quoted and terminal lines', () => {
    expect(
      unpricedLines([
        aClosedPosition({ closed_at: '2026-01-05', symbol: 'ZZD' }),
        aPosition({ symbol: 'ZZE' }),
        aPosition({ symbol: 'ZZF', price: null, terminal: true }),
      ]),
    ).toEqual([])
  })
})
