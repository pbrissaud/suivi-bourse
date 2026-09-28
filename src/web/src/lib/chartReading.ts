/**
 * The shape of a drawing, in figures — **read off the array the plot draws**
 * (#1003).
 *
 * Every chart in this product is a focusable widget and not a picture: Recharts
 * turns its own `accessibilityLayer` on by default, so the `<svg>` carries
 * `tabIndex={0}` and `role="application"` and the arrow keys already walk the
 * series. What was missing was never the navigation, it was the words. Two
 * things say them now, and they say different things:
 *
 *  - **`ChartTooltip` answers *what about this day*.** It is a polite live
 *    region, so arrowing along the series announces one point at a time, with
 *    the day and the curves' values already formatted by the chart's own unit.
 *  - **This module answers *what is the shape of the whole window*.** The
 *    extent, where each curve started, the dated extremes, and which side of
 *    the other a curve stayed on. `ChartReading` composes it into one sentence.
 *
 * Four things about it are decisions:
 *
 *  - **It is handed the plot's own rows, by the plot's own keys.** Not a copy:
 *    the same array passed to `data=`, read through the string `dataKey` each
 *    `<Line>` names. That is the whole reason a generated sentence is safe here
 *    — there is no second projection of the series to keep in step, so the
 *    sentence cannot drift from the curve — and `chartReadingContract.test.ts`
 *    holds it by comparing the keys given here with the `dataKey`s in the file.
 *  - **It never states the last value.** The dashboard's head carries its figure
 *    on the live gain's instant and not on the series' last point (#1051), so a
 *    sentence restating the arrival would announce a second, different number
 *    for today, two nodes away in the reading order. One announcer per fact:
 *    today is the head's, the shape is this module's.
 *  - **The extremes belong to the first drawn curve.** The second is a reference
 *    the first is read against — dashed, in the colour of text — and not a
 *    second measurement, which is why the drawing subordinates it and why two
 *    sets of extremes would make the listener choose which to hold.
 *  - **A hole is never a zero, here either.** Every curve draws with
 *    `connectNulls={false}`, so a missing value is skipped for the opening, for
 *    the extremes, and for the crossings: a gap in the data is not a day the
 *    other side won.
 *
 * The single-curve chart with a reference line has a pair anyway: the
 * performance reading draws `<ReferenceLine y={0}>`, so it passes `0` and its
 * gap clause is read against that constant. Nothing else passes one.
 */

/** The category key every chart in this product names its days with. */
const DAY = 't'

export interface ReadingCurve {
  /** The curve's name, already translated — the legend's own string. */
  name: string
  /** The row field the `<Line>` draws, by the key it names it with. */
  key: string
}

/** A value and the day it fell on. */
export interface Extreme {
  value: number
  day: string
}

/** A curve's first drawn value, with the name to announce it under. */
export interface Opening {
  name: string
  value: number
}

/**
 * Where the first curve sits relative to the second, or to the reference.
 *
 * `side` is *it never left this side*, which is the whole window in one word.
 * `crossings` is the other news, and it carries the last day it changed side
 * because that is the one date a listener can act on. A day the two are **equal**
 * is neither: see `gapOf`.
 */
export type Gap = { side: 'above' | 'below' } | { crossings: number; last: string }

export interface Shape {
  /** The first and last day anything is drawn on. */
  from: string
  to: string
  /** Each drawn curve's first value, in the curves' own order. */
  opening: readonly Opening[]
  /** The first drawn curve's extremes. */
  high: Extreme
  low: Extreme
  /** `null` when there is nothing to compare: one curve and no reference. */
  gap: Gap | null
}

/**
 * A row, as this module is allowed to see one.
 *
 * `readonly object[]` and not `Record<string, unknown>[]` at the boundary: every
 * caller hands a real interface — `AmountsRow`, `BenchmarkPoint`, `ValuePoint` —
 * and an interface has no index signature, so demanding one would push a cast
 * onto all four call sites. One cast lives here instead, at the only place that
 * reads a key it does not own.
 */
type Row = Record<string, unknown>

const of = (row: object): Row => row as Row

/** The day, or `null` — a row without a string day is not a day. */
function day(row: object): string | null {
  const value = of(row)[DAY]
  return typeof value === 'string' ? value : null
}

/**
 * The drawn value, or `null`.
 *
 * A key that names nothing yields `undefined`, which is not a number and is
 * therefore a hole — the same treatment a genuine `null` gets. That is what
 * keeps a renamed row field from announcing `0` across a whole window; the
 * contract test is what keeps it from happening at all.
 */
function value(row: object, key: string): number | null {
  const raw = of(row)[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

export function chartShape(
  rows: readonly object[],
  curves: readonly ReadingCurve[],
  /**
   * The constant the single curve is read against, when the plot draws one.
   * `PortfolioChart`'s performance reading passes `0`, which is the
   * `ReferenceLine` it already draws.
   */
  reference?: number,
): Shape | null {
  // The curves that are actually drawn, with their values aligned to `rows`.
  // A curve with no value at all is not in the sentence: it is not on the plot
  // either, and naming it would claim a line the reader cannot find.
  const drawn = curves
    .map((curve) => ({ curve, values: rows.map((row) => value(row, curve.key)) }))
    .filter((entry) => entry.values.some((one) => one !== null))

  if (drawn.length === 0) return null

  const days = rows.map(day)
  // The extent is the drawing's: the first and last day *anything* is drawn on,
  // which is what the plot's own category axis spans.
  const anywhere = days.filter(
    (one, index): one is string =>
      one !== null && drawn.some((entry) => entry.values[index] !== null),
  )
  if (anywhere.length === 0) return null

  const primary = drawn[0]
  let high: Extreme | null = null
  let low: Extreme | null = null
  primary.values.forEach((one, index) => {
    const on = days[index]
    if (one === null || on === null) return
    // Strictly greater, so a tie keeps the **first** day it happened on: the
    // earliest date is the one a reader can place against their own history.
    if (high === null || one > high.value) high = { value: one, day: on }
    if (low === null || one < low.value) low = { value: one, day: on }
  })
  if (high === null || low === null) return null

  return {
    from: anywhere[0],
    to: anywhere[anywhere.length - 1],
    opening: drawn.map((entry) => ({
      name: entry.curve.name,
      // Non-null by construction: the filter above kept only curves that have
      // at least one drawn value.
      value: entry.values.find((one) => one !== null) as number,
    })),
    high,
    low,
    gap: gapOf(
      primary.values,
      drawn.length > 1 ? drawn[1].values : reference,
      days,
    ),
  }
}

/**
 * The gap, against a second curve or against a constant.
 *
 * Only days where **both** sides have a value are compared, and the comparison
 * walks those comparable days in order. What a hole does depends on what is on
 * either side of it, and the distinction is the whole subtlety here:
 *
 *  - Two days on the **same** side with a hole between them are not a crossing.
 *    The drawing says nothing about the missing day and nothing changed around
 *    it, so counting one would invent an event.
 *  - Two days on **opposite** sides with a hole between them **are** one, dated
 *    on the day the new side is first drawn. Refusing it — counting a change
 *    only between adjacent rows — would announce *stays above over the whole
 *    range* about a curve whose last drawn day is below it, which is false to
 *    the one reader who cannot check it against the plot. The crossing happened;
 *    the only honest date for it is the first day it is observable.
 *
 * **A day the two are equal is treated the same way as a hole**, and for the
 * reason a touch is not an event: it is on the line, not on a side of it. Where
 * every comparable day is equal there is no side and no crossing, so no clause
 * is spoken — a curve that never left its reference says less rather than
 * something untrue.
 */
function gapOf(
  values: readonly (number | null)[],
  against: readonly (number | null)[] | number | undefined,
  days: readonly (string | null)[],
): Gap | null {
  if (against === undefined) return null

  const sides: { above: boolean; day: string }[] = []
  values.forEach((one, index) => {
    const on = days[index]
    if (one === null || on === null) return
    const other = typeof against === 'number' ? against : against[index]
    if (other === null || other === undefined) return
    // **A day the two are equal is not a side.** Counted as *above* — which is
    // what `>=` did — a curve sitting below its reference, touching it and
    // staying below was announced as *crossing twice*, having never once been
    // above it. And a time-weighted return is rebased to exactly `0` on its first
    // drawn day by construction, so every performance reading that dipped and
    // recovered carried one crossing too many. Skipped, the touch joins the days
    // the drawing says nothing about, and a genuine crossing over it still counts
    // once, on the day the new side is drawn.
    if (one === other) return
    sides.push({ above: one > other, day: on })
  })
  if (sides.length === 0) return null

  let crossings = 0
  let last = ''
  for (let at = 1; at < sides.length; at += 1) {
    if (sides[at].above !== sides[at - 1].above) {
      crossings += 1
      last = sides[at].day
    }
  }
  return crossings === 0 ? { side: sides[0].above ? 'above' : 'below' } : { crossings, last }
}
