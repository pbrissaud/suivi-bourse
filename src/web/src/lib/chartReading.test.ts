/**
 * **The shape is read off the plot's own rows** (#1003).
 *
 * The edges here are the ones the product's curves actually have, and every one
 * of them is a way for a sentence to lie to a reader who cannot see the plot:
 * a hole announced as a zero, an extreme taken from the reference curve instead
 * of the measured one, a crossing counted where the series simply stops for a
 * fortnight. The two that matter most are the two the design pass argued about
 * — a hole is never a zero, and touching a reference is not crossing it.
 */
import { describe, expect, it } from 'vitest'

import { chartShape, type ReadingCurve } from '@/lib/chartReading'

const VALUE: ReadingCurve = { name: 'Total value', key: 'value' }
const CONTRIBUTED: ReadingCurve = { name: 'Net contributed', key: 'contributed' }

/** Rows in the shape every chart here hands Recharts: a day and its fields. */
function rows(
  ...days: [string, number | null, (number | null)?][]
): Record<string, unknown>[] {
  return days.map(([t, value, contributed]) => ({ t, value, contributed }))
}

describe('nothing to read', () => {
  it('returns null on no rows at all', () => {
    expect(chartShape([], [VALUE])).toBeNull()
  })

  it('returns null when every value of every curve is a hole', () => {
    const shape = chartShape(
      rows(['2026-01-01', null, null], ['2026-01-02', null, null]),
      [VALUE, CONTRIBUTED],
    )
    // The rows exist and the plot draws nothing: that is a fact about the
    // window, and `ChartReading` says so rather than announcing a figure.
    expect(shape).toBeNull()
  })

  it('returns null when the rows carry no day', () => {
    expect(chartShape([{ value: 12 }, { value: 14 }], [VALUE])).toBeNull()
  })
})

describe('the extent and the opening', () => {
  it('spans the first and last day anything is drawn on', () => {
    const shape = chartShape(
      rows(
        ['2026-01-01', null, null],
        ['2026-01-02', 100, 90],
        ['2026-01-03', 120, 90],
        ['2026-01-04', null, null],
      ),
      [VALUE, CONTRIBUTED],
    )
    expect(shape?.from).toBe('2026-01-02')
    expect(shape?.to).toBe('2026-01-03')
  })

  it('opens on the first drawn value and not on the first row', () => {
    const shape = chartShape(
      rows(['2026-01-01', null, 90], ['2026-01-02', 100, 95]),
      [VALUE, CONTRIBUTED],
    )
    // A hole at the first day is skipped, per curve: the value curve opens on
    // the 2nd at 100, the contributed one on the 1st at 90.
    expect(shape?.opening).toEqual([
      { name: 'Total value', value: 100 },
      { name: 'Net contributed', value: 90 },
    ])
  })

  it('drops a curve that is never drawn', () => {
    const shape = chartShape(
      rows(['2026-01-01', 100, null], ['2026-01-02', 120, null]),
      [VALUE, CONTRIBUTED],
    )
    // An install with no cash event has `net_contributed` at `null` for ever
    // (#708). Naming it would claim a line the reader cannot find.
    expect(shape?.opening).toEqual([{ name: 'Total value', value: 100 }])
    expect(shape?.gap).toBeNull()
  })

  it('reads a single drawn point without inventing a span', () => {
    const shape = chartShape(rows(['2026-01-01', 100]), [VALUE])
    expect(shape?.from).toBe('2026-01-01')
    expect(shape?.to).toBe('2026-01-01')
    expect(shape?.high).toEqual({ value: 100, day: '2026-01-01' })
    expect(shape?.low).toEqual({ value: 100, day: '2026-01-01' })
  })
})

describe('the extremes', () => {
  it('belong to the first drawn curve and never to the reference', () => {
    const shape = chartShape(
      rows(['2026-01-01', 100, 400], ['2026-01-02', 120, 10]),
      [VALUE, CONTRIBUTED],
    )
    // 400 and 10 are the contributed curve's and must not surface: the second
    // curve is what the first is read against, not a second measurement.
    expect(shape?.high).toEqual({ value: 120, day: '2026-01-02' })
    expect(shape?.low).toEqual({ value: 100, day: '2026-01-01' })
  })

  it('keeps the earliest day on a tie', () => {
    const shape = chartShape(
      rows(['2026-01-01', 100], ['2026-01-02', 80], ['2026-01-03', 100]),
      [VALUE],
    )
    expect(shape?.high).toEqual({ value: 100, day: '2026-01-01' })
  })

  it('skips holes rather than reading them as zero', () => {
    const shape = chartShape(
      rows(['2026-01-01', 100], ['2026-01-02', null], ['2026-01-03', 120]),
      [VALUE],
    )
    expect(shape?.low).toEqual({ value: 100, day: '2026-01-01' })
  })
})

describe('the gap between two curves', () => {
  it('states the side when the first never leaves it', () => {
    const shape = chartShape(
      rows(['2026-01-01', 100, 90], ['2026-01-02', 120, 95]),
      [VALUE, CONTRIBUTED],
    )
    expect(shape?.gap).toEqual({ side: 'above' })
  })

  it('states the other side too', () => {
    const shape = chartShape(
      rows(['2026-01-01', 80, 90], ['2026-01-02', 85, 95]),
      [VALUE, CONTRIBUTED],
    )
    expect(shape?.gap).toEqual({ side: 'below' })
  })

  it('counts the crossings and names the last one', () => {
    const shape = chartShape(
      rows(
        ['2026-01-01', 100, 90], // above
        ['2026-01-02', 80, 90], // below  → crossing 1
        ['2026-01-03', 120, 90], // above  → crossing 2
      ),
      [VALUE, CONTRIBUTED],
    )
    expect(shape?.gap).toEqual({ crossings: 2, last: '2026-01-03' })
  })

  it('does not count a hole as a crossing', () => {
    const shape = chartShape(
      rows(
        ['2026-01-01', 100, 90], // above
        ['2026-01-02', null, 90], // the series says nothing
        ['2026-01-03', 120, 90], // still above
      ),
      [VALUE, CONTRIBUTED],
    )
    // Compared day by comparable day, the curve never changed side. A
    // fortnight's silence in the middle of a window is not a crossing.
    expect(shape?.gap).toEqual({ side: 'above' })
  })

  it('does count a crossing when the hole separates two opposite sides', () => {
    const shape = chartShape(
      rows(
        ['2026-01-01', 100, 90], // above
        ['2026-01-02', null, 90], // the series says nothing
        ['2026-01-03', 80, 90], // below
      ),
      [VALUE, CONTRIBUTED],
    )
    // The pair **did** change sides, and the only honest date for it is the day
    // the new side is first drawn. The alternative — counting a change only
    // between adjacent rows — would say *stays above over the whole range* about
    // a curve whose last drawn day is below it.
    expect(shape?.gap).toEqual({ crossings: 1, last: '2026-01-03' })
  })

  it('does not cross where the second curve is the hole', () => {
    const shape = chartShape(
      rows(['2026-01-01', 100, 90], ['2026-01-02', 80, null], ['2026-01-03', 120, 90]),
      [VALUE, CONTRIBUTED],
    )
    expect(shape?.gap).toEqual({ side: 'above' })
  })

  it('a touch is on the line and not on a side of it', () => {
    const shape = chartShape(
      rows(['2026-01-01', 100, 90], ['2026-01-02', 90, 90], ['2026-01-03', 110, 90]),
      [VALUE, CONTRIBUTED],
    )
    expect(shape?.gap).toEqual({ side: 'above' })
  })

  it('a touch from below is not two crossings', () => {
    const shape = chartShape(
      rows(['2026-01-01', 80, 90], ['2026-01-02', 90, 90], ['2026-01-03', 85, 90]),
      [VALUE, CONTRIBUTED],
    )
    // Counted as *above*, the touch made this *crosses twice* about a curve that
    // was never once above what was paid in.
    expect(shape?.gap).toEqual({ side: 'below' })
  })

  it('says nothing about a gap between two curves that never part', () => {
    const shape = chartShape(
      rows(['2026-01-01', 90, 90], ['2026-01-02', 95, 95]),
      [VALUE, CONTRIBUTED],
    )
    // No side was ever taken, so there is no side to state and no crossing to
    // count. The sentence says less rather than something untrue.
    expect(shape?.gap).toBeNull()
  })
})

describe('the gap against a constant reference', () => {
  const PERFORMANCE: ReadingCurve = { name: 'Time-weighted return', key: 'performance' }
  const perf = (...days: [string, number | null][]) =>
    days.map(([t, performance]) => ({ t, performance }))

  it('counts crossings of zero, which is the line the plot draws', () => {
    const shape = chartShape(
      perf(['2026-01-01', 0], ['2026-01-02', -3], ['2026-01-03', 4]),
      [PERFORMANCE],
      0,
    )
    // **One crossing, not two.** A time-weighted return is rebased to exactly `0`
    // on its first drawn day, so counting that day as *above zero* gave every
    // curve that dipped and recovered one crossing it never made. Leaving zero
    // downward is not a crossing; coming back up through it is.
    expect(shape?.gap).toEqual({ crossings: 1, last: '2026-01-03' })
  })

  it('states the side when the return never goes under water', () => {
    const shape = chartShape(perf(['2026-01-01', 0], ['2026-01-02', 4]), [PERFORMANCE], 0)
    expect(shape?.gap).toEqual({ side: 'above' })
  })

  it('touching zero is not crossing it', () => {
    const shape = chartShape(
      perf(['2026-01-01', 2], ['2026-01-02', 0], ['2026-01-03', 5]),
      [PERFORMANCE],
      0,
    )
    expect(shape?.gap).toEqual({ side: 'above' })
  })

  it('says nothing about a gap with one curve and no reference', () => {
    const shape = chartShape(perf(['2026-01-01', 2], ['2026-01-02', 5]), [PERFORMANCE])
    expect(shape?.gap).toBeNull()
  })

  it('prefers the second curve to the reference when both are given', () => {
    const shape = chartShape(
      rows(['2026-01-01', 100, 90], ['2026-01-02', 120, 95]),
      [VALUE, CONTRIBUTED],
      0,
    )
    // A pair of curves is the pair; the constant is for the chart that has one.
    expect(shape?.gap).toEqual({ side: 'above' })
  })
})
