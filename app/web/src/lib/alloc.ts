/**
 * The allocation ramp — twelve stops, generated, never enumerated (ADR-0023).
 *
 * The allocation is **sorted descending and legended**, so position already
 * pairs a legend row to its slice and the legend already carries the name and
 * the percentage. Colour therefore never had to *identify*; it only has to
 * encode **rank**, redundantly with the angle — which one hue in twelve
 * lightnesses does better than twelve hues, twelve hues at constant lightness
 * being at the edge of discriminability and below it for a colour-blind reader.
 *
 * Three consequences are load-bearing and all three live in the table below:
 *
 *  - **Rank 1 is the most contrasted in *both* themes**, which forces two
 *    opposite lightness ramps: dark stands out on white, light stands out on
 *    black. A single ramp would encode rank backwards in one theme out of two.
 *  - **Chroma falls with rank in both**, so rank 1 is also the most saturated.
 *    Read against lightness that reads as "decreasing with lightness" in light
 *    and "increasing with lightness" in dark — the same rule, seen from the two
 *    grounds.
 *  - **Every stop is a colour sRGB can hold.** A browser clamps what it cannot
 *    show instead of refusing it, so a ramp written outside the gamut renders
 *    several ranks as one colour while every declared value still looks right.
 *
 * The first two are rules; the third is a constraint the first two have to be
 * satisfied *within*, and it is what sets the chroma ends apart between grounds.
 *
 * The ramp holds *only because* the allocation is sorted and legended. A
 * surface that drew these twelve shares without a legend, or in another order,
 * falls outside ADR-0023 and has to reopen it.
 *
 * Pure, and deliberately not CSS: the twelve tokens are the one place in the
 * product where the *value* depends on the ground rather than merely adapting
 * to it, so they are written onto the root element by `ThemeProvider` at the
 * moment it resolves the ground. `index.css` bridges them, so a call site still
 * writes `bg-alloc-3` and never learns where they came from.
 */

/** How many slices the allocation draws before it stops answering (ADR-0018). */
export const ALLOCATION_SLICES = 12

export type Ground = 'light' | 'dark'

export interface RampEnds {
  /** Lightness at rank 1 → rank 12. Reversed between the two grounds. */
  lightness: [number, number]
  /** Chroma at rank 1 → rank 12. Falls with rank on both grounds. */
  chroma: [number, number]
  /** One hue, chosen near both grounds and claimed by nothing else. */
  hue: number
}

/**
 * **The hue is the product's own** (#787, amending ADR-0029).
 *
 * ADR-0023 took the preset's `--chart-2` because that preset was near monochrome
 * and the slot was the only blue in it. ADR-0029 then *chose* 262 on the
 * argument that mint, purple and teal were spoken for by a state or a mark, and
 * that a share of a total is neither — so the ramp went to the blue nobody
 * claimed. That reasoning protects the marks and forgets the reader: it leaves
 * the one figure drawn largest on the page in a hue the product uses nowhere
 * else, beside a chart stroked in `--price`, which *is* `--primary`. The
 * allocation ended up the only surface that did not look like the application.
 *
 * So the ramp is twelve lightnesses of the **accent's own hue**, `165` — the
 * value `--primary` carries on both grounds. What the mint is spoken for is a
 * *state* (`--gain`) and a *mark* (`--price`), and neither is a slice: a share
 * of a whole is unsigned and always positive, it is legended, and it never sits
 * beside a gain figure it could be mistaken for. The collision ADR-0029 feared
 * is between a **signed** figure and a curve, and this ramp draws neither.
 *
 * **And the gamut stops being the binding constraint**, which is the measured
 * half of the change. Blue keeps almost no chroma where the dark ramp needs it —
 * at `L 0.86` the screen can show `0.069` — so ADR-0029 had to cap the dark
 * ramp's rank 1 there and let chroma fall from it, leaving a travel of `0.055`
 * to `0.018` that it admitted no reader would see. **The mint holds `0.181` at
 * that same lightness.** The chroma cue comes back, and rank stops resting on
 * lightness alone.
 *
 * The two rules that shape the ramps do not move: rank 1 is the most contrasted
 * on **each** ground, which is what forces two opposite lightness ramps, and
 * chroma falls with rank on both. The light ramp is the one the mint constrains
 * — green holds less chroma dark than blue does (`0.101` at `L 0.48` against
 * `0.209`) — so its rank 1 is a touch lighter and a touch less saturated than
 * ADR-0029's. Every stop is asserted in sRGB in `lib/alloc.test.ts`, which is
 * what makes these four pairs measurements rather than tastes.
 */
export const ALLOCATION_RAMP: Record<Ground, RampEnds> = {
  light: { lightness: [0.48, 0.84], chroma: [0.09, 0.028], hue: 165 },
  dark: { lightness: [0.86, 0.42], chroma: [0.14, 0.03], hue: 165 },
}

function interpolate(from: number, to: number, step: number, steps: number): number {
  return from + ((to - from) * step) / (steps - 1)
}

/**
 * The twelve stops for one ground, rank 1 first, as `oklch()` strings.
 *
 * Rounded because these end up in the DOM: an unrounded stop reads as
 * `oklch(0.48000000000000004 …)` in the inspector, which invites someone to
 * "tidy" it by hand and thereby to break the derivation.
 */
export function allocationRamp(ground: Ground, slices: number = ALLOCATION_SLICES): string[] {
  const ends = ALLOCATION_RAMP[ground]
  return Array.from({ length: slices }, (_, index) => {
    const lightness = interpolate(ends.lightness[0], ends.lightness[1], index, slices)
    const chroma = interpolate(ends.chroma[0], ends.chroma[1], index, slices)
    return `oklch(${lightness.toFixed(4)} ${chroma.toFixed(4)} ${ends.hue})`
  })
}

/** `--alloc-1` … `--alloc-12`, in rank order — the names `index.css` bridges. */
export function allocationTokenNames(slices: number = ALLOCATION_SLICES): string[] {
  return Array.from({ length: slices }, (_, index) => `--alloc-${index + 1}`)
}
