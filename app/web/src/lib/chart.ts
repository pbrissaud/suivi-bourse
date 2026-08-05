/**
 * The app's axis policy, in one place.
 *
 * #660 settled it on the dashboard's main chart and gave the reason: a
 * data-derived domain makes Recharts put the series' own extreme on the axis, so
 * a top gradation reading `19 733 €` looks like a defect rather than a scale.
 * Rounding outward to a round number costs a little tightness and buys an axis a
 * reader can estimate against.
 *
 * It lives here because #661 added a second chart with a computed domain, and
 * two charts in one app disagreeing about their axis policy is worse than either
 * policy — the same argument that dropped the zero baseline in the first place.
 */

/** The nearest round number at or below `value`: 1, 2, 5 × a power of ten. */
export function niceStep(value: number): number {
  if (!(value > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalised = value / magnitude
  const factor = normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1
  return factor * magnitude
}

/** Round a `[min, max]` outward to the gradations `niceStep` would draw. */
export function roundOutward(min: number, max: number, divisions = 4): [number, number] {
  const step = niceStep((max - min) / divisions)
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step]
}
