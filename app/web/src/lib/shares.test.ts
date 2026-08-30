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
import { positionRenderings } from '@/lib/absence'
import {
  accountBreakdown,
  allocation,
  buildShareRows,
  closedRows,
  eventMarkers,
  heldRows,
  isAnomalous,
  isClosed,
  marketValue,
  placedValue,
  shareEvents,
  unitCost,
  unrealised,
  unrealisedRatio,
  valuationTotal,
  weightRendering,
  weightShare,
} from '@/lib/shares'
import {
  aClosedPosition,
  aPosition,
  aPriceSeries,
  anEvent,
  shareLedger,
  sharesPortfolio,
} from '@/test/factories'

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

describe('a position whose history is still being rebuilt', () => {
  it('is worth nothing computable, and is not carried at its cost', () => {
    // ADR-0004's domain is exactly *the symbol's backfill is terminal*, and
    // this line is not: *no price* means *not yet*, so valuing it at its PMP
    // renders *not yet* as *never* — and it did, on every line of every fresh
    // install, while the dashboard's own curve left the same day hollow (#845).
    const rows = rowsOf([
      aPosition({ symbol: 'ZZC', quantity: 6, cost_basis: 600, price: null, terminal: false }),
    ])

    expect(marketValue(rows[0])).toBeNull()
    expect(unrealised(rows[0])).toBeNull()
    // Not the reader's to repair: nothing has failed, the app is still reading.
    expect(isAnomalous(rows[0])).toBe(false)
  })

  it('refuses the total and names the rebuild, never the exchange rate', () => {
    // The mechanical consequence, and the one the ticket's own criteria had to
    // add: a valuation gained a second cause of nullity, so the two totals that
    // read it gained a second reason — and the first was written in. On a fresh
    // install, where no symbol is terminal, the header announced *waiting for
    // the exchange rate* and sent the owner to a dial they had answered.
    const rebuilding = rowsOf([
      aPosition({ symbol: 'ZZC', quantity: 6, cost_basis: 600, price: null, terminal: false }),
    ])
    expect(valuationTotal(rebuilding)).toEqual({ known: false, because: 'rebuilding' })

    // And the rate keeps its own sentence where it is the real reason.
    const waiting = rowsOf([
      aPosition({ symbol: 'ZZB', price: 125, currency: 'USD', rate: null }),
    ])
    expect(valuationTotal(waiting)).toEqual({ known: false, because: 'awaitingRate' })
  })

  it('is left out of the weights, which go on dividing what they can', () => {
    // The asymmetry is deliberate: a **total** is refused because a sum that
    // quietly drops a line is a wrong number, while the divisor of the weights
    // omits — refusing it would put one line's absence on every other row,
    // which is the noise ADR-0016 deletes markers for.
    const rows = rowsOf([
      aPosition({ symbol: 'ZZA', quantity: 10, cost_basis: 1000, price: 130 }),
      aPosition({ symbol: 'ZZC', quantity: 6, cost_basis: 600, price: null, terminal: false }),
    ])

    expect(placedValue(rows)).toBe(1300)
    expect(weightShare(rows[0], placedValue(rows))).toBe(1)
    expect(weightShare(rows[1], placedValue(rows))).toBeNull()
    // Named on its own row rather than counted as nothing.
    expect(weightRendering(rows[1], placedValue(rows))).toEqual({
      kind: 'named',
      message: 'absence.rebuilding',
    })
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

describe('the instrument’s attributes', () => {
  it('are read off the group, never added across its accounts', () => {
    // Owning the same ETF in a PEA and a CTO does not double its market
    // capitalisation — which is the whole reason they are not in `_ADDITIVE`
    // on the other side of the wire either.
    const [row] = rowsOf([
      aPosition({ account: 'alpha', symbol: 'ZZF', quantity: 2, cost_basis: 200 }),
      aPosition({ account: 'beta', symbol: 'ZZF', quantity: 3, cost_basis: 300 }),
    ])
    expect(row.fundamentals?.market_cap).toBe(1.2e9)
  })

  it('are absent on a symbol the fetch has never reached', () => {
    const [row] = rowsOf([aPosition({ symbol: 'ZZC', price: null })])
    expect(row.fundamentals).toBeNull()
  })
})

describe('the per-account breakdown', () => {
  it('does not exist at one account', () => {
    // It would repeat the sheet's own header line for line, quantity for
    // quantity — which is what took it off the sheet in the first place.
    const positions = [aPosition({ account: 'alpha', symbol: 'ZZA' })]
    expect(accountBreakdown(positions, 'ZZA', NO_FAILURES)).toEqual([])
  })

  it('comes back the moment a share is held on two accounts', () => {
    const positions = [
      aPosition({ account: 'alpha', symbol: 'ZZF', quantity: 2, cost_basis: 200, price: 110 }),
      aPosition({ account: 'beta', symbol: 'ZZF', quantity: 3, cost_basis: 300, price: 110 }),
      // Another share entirely: the breakdown is one symbol's.
      aPosition({ account: 'alpha', symbol: 'ZZA' }),
    ]
    const lines = accountBreakdown(positions, 'ZZF', NO_FAILURES)

    expect(lines.map((line) => line.accounts)).toEqual([['alpha'], ['beta']])
    // Every figure of a line is the same function the folded row uses, so the
    // breakdown cannot drift from what it decomposes: 2 × 110 = 220 against
    // 200, and 3 × 110 = 330 against 300.
    expect(lines.map(marketValue)).toEqual([220, 330])
    expect(lines.map(unrealised)).toEqual([20, 30])
    expect(lines.map(unitCost)).toEqual([100, 100])
  })
})

describe('the chart’s event markers', () => {
  const POINTS = aPriceSeries().points

  it('is one marker per day, announcing its count', () => {
    // `×2, ×2, ×3, ×3` over four days on one real symbol: drawn per event those
    // points overlap and three purchases read as one, in silence.
    const markers = eventMarkers(shareLedger(), 'ZZA', POINTS)
    expect(markers.map((marker) => [marker.day, marker.count])).toEqual([
      ['2026-02-28', 1],
      ['2026-03-01', 3],
    ])
  })

  it('drops what falls outside the visible range, and what is another share’s', () => {
    // 2025-01-05 is in the ledger and not on the chart: the window bounds the
    // markers, so changing the range genuinely changes what is announced. And
    // the `ZZC` event of 2026-03-01 never joins `ZZA`'s count of three.
    const days = eventMarkers(shareLedger(), 'ZZA', POINTS).map((marker) => marker.day)
    expect(days).not.toContain('2025-01-05')
    expect(eventMarkers(shareLedger(), 'ZZC', POINTS)).toHaveLength(1)
  })

  it('keeps a day whose events precede the first point of that same day', () => {
    // The series opens on an afternoon close; a purchase made that morning is
    // still a purchase of the visible range, and dropping it would lose the
    // very event that opened the line.
    const markers = eventMarkers(
      [anEvent({ date: '2026-02-28' })],
      'ZZA',
      [
        { t: '2026-02-28T17:30:00.000Z', price: 126 },
        { t: '2026-03-02T12:00:00.000Z', price: 130 },
      ],
    )
    expect(markers.map((marker) => [marker.day, marker.offset])).toEqual([['2026-02-28', 0]])
  })

  it('sits on the rank of its point, never on a fraction of the elapsed span', () => {
    // The chart draws on a **category** axis: N points are N even steps
    // whatever the time between them. A fraction of the span is therefore a
    // second statement of the same abscissa, and the two part company exactly
    // where the reader needs them together — on `1M`, whose rung is the raw
    // series, the live scrape writes a point every 120 s in session while the
    // reconstruction writes one per hour or per day.
    const points = [
      { t: '2026-02-01T17:30:00.000Z', price: 100 },
      { t: '2026-03-01T17:30:00.000Z', price: 110 },
      { t: '2026-03-01T17:32:00.000Z', price: 111 },
    ]
    const markers = eventMarkers([anEvent({ date: '2026-03-01' })], 'ZZA', points)
    // Its point is the second of three, so the marker is at mid-plot. Read as a
    // fraction of the span the same day lands at 0,97 — under the curve of the
    // last two minutes, which is the wrong place on the one liaison this sheet
    // exists to make.
    expect(markers.map((marker) => [marker.day, marker.offset])).toEqual([['2026-03-01', 0.5]])
  })

  it('names the nearest point when the day itself carries none', () => {
    // A Saturday carries no session; the marker of an event dated there belongs
    // on the close that framed it, not on an edge of the plot.
    const points = [
      { t: '2026-03-02T17:30:00.000Z', price: 100 },
      { t: '2026-03-06T17:30:00.000Z', price: 110 },
      { t: '2026-03-20T17:30:00.000Z', price: 120 },
    ]
    const markers = eventMarkers([anEvent({ date: '2026-03-07' })], 'ZZA', points)
    expect(markers.map((marker) => marker.offset)).toEqual([0.5])
  })

  it('places nothing at all on a span of one point', () => {
    // A fraction of nothing is an invented position, which is the one thing a
    // marker must not be.
    expect(eventMarkers(shareLedger(), 'ZZA', POINTS.slice(0, 1))).toEqual([])
  })
})

describe('a share’s own events', () => {
  it('are its own, newest first', () => {
    const events = shareEvents(shareLedger(), 'ZZA')
    expect(events.every((event) => event.symbol === 'ZZA')).toBe(true)
    expect(events[0].date).toBe('2026-03-01')
    expect(events.at(-1)?.date).toBe('2025-01-05')
  })
})

// ------------------------------------------------------------------------- //
// The weight — a figure with no column
//
// `Poids` was a column of the live table at #791 and left again; the figure it
// rendered stayed, deliberately, for a surface that has not been written yet.
// Its only cover used to be that column's rendering tests, so it is held here
// instead — a kept function with no reader and no test is the one that rots.
// ------------------------------------------------------------------------- //

describe('the weight of a line', () => {
  it('divides the value of the lines that can be placed, and not the whole table', () => {
    // The line **awaiting its rate** is out of the whole rather than counted as
    // nothing: counting it would make every other percentage silently wrong. It
    // is `allocation`'s rule one page over, reused rather than re-decided. A
    // line that was never quoted at all is a different case — ADR-0004 carries
    // it at its cost, so it has a value and belongs in the whole.
    const rows = rowsOf([
      aPosition({ symbol: 'ZZA', quantity: 10, cost_basis: 500, price: 130 }),
      aPosition({ symbol: 'ZZB', quantity: 10, cost_basis: 500, price: 70 }),
      aPosition({ symbol: 'ZZC', quantity: 6, cost_basis: 600, price: 125, currency: 'USD', rate: null }),
    ])
    const whole = placedValue(rows)

    expect(whole).toBeCloseTo(2000, 6)
    expect(weightShare(rows[0], whole)).toBeCloseTo(0.65, 6)
    expect(weightShare(rows[1], whole)).toBeCloseTo(0.35, 6)
    // The three shares close on the placed lines alone.
    expect((weightShare(rows[0], whole) ?? 0) + (weightShare(rows[1], whole) ?? 0)).toBeCloseTo(1, 6)
  })

  it('has no share where the line has no value, and none where the whole is nothing', () => {
    const [awaitingRate] = rowsOf([
      aPosition({ symbol: 'ZZC', quantity: 6, cost_basis: 600, price: 125, currency: 'USD', rate: null }),
    ])
    expect(weightShare(awaitingRate, 2000)).toBeNull()

    // A table every line of which is worth zero: there is genuinely nothing to
    // divide, and dividing by it would answer `Infinity` or `NaN`.
    const [worthless] = rowsOf([
      aPosition({ symbol: 'ZZA', quantity: 0, cost_basis: 0, price: 130 }),
    ])
    expect(weightShare(worthless, 0)).toBeNull()
  })

  it('reads as the valuation it divides, and never classifies an absence twice', () => {
    // Whatever empties `Valorisation` empties this for the same reason and has
    // the same sentence already written for it: a second classification of one
    // absence is how four renderings become five.
    const [priced, awaitingRate] = rowsOf([
      aPosition({ symbol: 'ZZA', quantity: 10, cost_basis: 500, price: 130 }),
      aPosition({ symbol: 'ZZC', quantity: 6, cost_basis: 600, price: 125, currency: 'USD', rate: null }),
    ])

    expect(weightRendering(priced, 1300).kind).toBe('figure')
    expect(weightRendering(awaitingRate, 1300)).toEqual(
      positionRenderings(awaitingRate).valuation,
    )
    // The one case of its own: a figure of a valuation, over a whole of nothing.
    expect(weightRendering(priced, 0).kind).toBe('dash')
  })
})


/**
 * The rows the allocation divides, with no failure counter: it is a rendering
 * concern (see the head of `lib/shares.ts`) and the arithmetic has no subject
 * for it.
 */
function allocationRows(positions: readonly Position[]) {
  return buildShareRows(positions, NO_FAILURES)
}

// ------------------------------------------------------------------------- //
// The allocation — the dashboard's figure until #831, this page's since
// ------------------------------------------------------------------------- //

describe('the allocation', () => {
  it('names seven lines and folds the rest into one slice that counts itself', () => {
    // Twelve was the cap until #838, on a measurement: at eight, the tail
    // *Others (4)* was worth 10,1 %, more than four of the named slices put
    // together. The drawing caps at seven arcs all the same, and it answers
    // that by making the fold **say what it holds** — the count is in the slice
    // — and by putting every line it hides in the table under the ring.
    const positions = Array.from({ length: 15 }, (_, index) =>
      aPosition({ symbol: `Z${index}`, name: `Zeta ${index}`, quantity: 1, cost_basis: 1, price: 15 - index }),
    )
    const { slices, total } = allocation(allocationRows(positions))

    expect(slices).toHaveLength(8)
    expect(slices.slice(0, 7).every((slice) => slice.count === 1)).toBe(true)
    expect(slices[7]).toMatchObject({ symbol: null, count: 8 })
    // Nothing is lost in the fold: 15 + 14 + … + 1.
    expect(total).toBe(120)
    expect(slices.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1, 10)
  })

  it('folds only past eight lines, and draws all eight where there are eight', () => {
    // At exactly the cap there is nothing to gain by hiding one line behind a
    // word — the drawing's own rule, and the one place the fold is *not* the
    // simple `> cap - 1` it would be if the eighth slice were always the tail.
    const eight = Array.from({ length: 8 }, (_, index) =>
      aPosition({ symbol: `Z${index}`, name: `Zeta ${index}`, quantity: 1, cost_basis: 1, price: 8 - index }),
    )
    const { slices } = allocation(allocationRows(eight))

    expect(slices).toHaveLength(8)
    expect(slices.every((slice) => slice.symbol !== null)).toBe(true)
  })

  it('excludes what it could not place **and hands it back to be named**', () => {
    // The exclusion was already right and its own comment said why — summing a
    // position with no resolved rate makes every *other* percentage silently
    // wrong — and it was never said on screen.
    const { slices, unplaced } = allocation(
      allocationRows([
        aPosition({ symbol: 'ZZA', quantity: 10, cost_basis: 1000, price: 130 }),
        aPosition({ symbol: 'ZZB', quantity: 4, cost_basis: 400, price: 125, currency: 'USD', rate: null }),
      ]),
    )

    expect(unplaced).toEqual(['ZZB'])
    expect(slices.map((slice) => slice.symbol)).toEqual(['ZZA'])
    expect(slices[0].share).toBe(1)
  })

  it('keeps a line carried at its cost and drops a closed one', () => {
    // A position nothing has ever quoted is worth what it cost (ADR-0004), so
    // it is a slice; a sold one is worth exactly zero, and a legend of zeros is
    // noise — the shares page's folded section is where it lives.
    const { slices } = allocation(
      allocationRows([
        aPosition({ symbol: 'ZZA', quantity: 10, cost_basis: 1000, price: 130 }),
        aPosition({ symbol: 'ZZC', quantity: 6, cost_basis: 600, price: null }),
        aPosition({ symbol: 'ZZD', quantity: 0, cost_basis: 0, price: null, realised: 120 }),
      ]),
    )

    expect(slices.map((slice) => slice.symbol)).toEqual(['ZZA', 'ZZC'])
    expect(slices[1].value).toBe(600)
  })
})
