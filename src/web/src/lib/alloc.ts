/**
 * The allocation ramp — eight stops, generated, never enumerated.
 *
 * The allocation is **sorted descending and legended**, so position already
 * pairs a legend row to its slice and the legend already carries the name and
 * the percentage. Colour therefore never had to *identify*; it only has to
 * encode **rank**, redundantly with the angle — which one hue in eight
 * lightnesses does better than eight hues, eight hues at constant lightness
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
 * satisfied *within*, and it is what sets the chroma ends apart between
 * grounds.
 *
 * The ramp holds *only because* the allocation is sorted and legended.
 *
 * Pure, and deliberately not CSS: the eight tokens are the one place in the
 * product where the *value* depends on the ground rather than merely adapting
 * to it, so they are written onto the root element by `ThemeProvider` at the
 * moment it resolves the ground. `index.css` bridges them, so a call site still
 * writes `bg-alloc-3` and never learns where they came from.
 */

/** How many slices the allocation draws before it stops answering. */
/**
 * **Seven ranked slices and the fold, which is eight** (#838). The drawing caps
 * the ring at seven arcs and gives the rest one slice of its own — *Autres · 13
 * lignes* — and it folds only past **eight** lines: at exactly eight there is
 * nothing to gain by hiding one behind a word. It was twelve here, which drew a
 * ring nobody could read as a ranking and a legend two columns of six deep.
 *
 * The fold takes the ramp's **last** stop, the least contrasted of the eight,
 * which is what a fold of the smallest lines should be — the drawing paints it
 * a flat grey and this paints it the ramp's own end, which lands in the same
 * place: 0,42 lightness at 0,03 chroma is a mint nobody reads as a mint.
 */
export const ALLOCATION_SLICES = 8

export type Ground = 'light' | 'dark'

interface RampEnds {
  /** Lightness at rank 1 → rank 12. Reversed between the two grounds. */
  lightness: [number, number]
  /** Chroma at rank 1 → rank 12. Falls with rank on both grounds. */
  chroma: [number, number]
  /** One hue, chosen near both grounds and claimed by nothing else. */
  hue: number
}

/**
 * That reasoning protects the marks and forgets the reader: it leaves the one
 * figure drawn largest on the page in a hue the product uses nowhere else,
 * beside a chart stroked in `--price`, which *is* `--primary`. The allocation
 * ended up the only surface that did not look like the application.
 *
 * So the ramp is eight lightnesses of the **accent's own hue**, `165` — the
 * value `--primary` carries on both grounds. What the mint is spoken for is a
 * *state* (`--gain`) and a *mark* (`--price`), and neither is a slice: a share
 * of a whole is unsigned and always positive, it is legended, and it never sits
 * beside a gain figure it could be mistaken for.
 *
 * **And the gamut stops being the binding constraint**, which is the measured
 * half of the change. **The mint holds `0.181` at that same lightness.** The
 * chroma cue comes back, and rank stops resting on lightness alone.
 *
 * The two rules that shape the ramps do not move: rank 1 is the most contrasted
 * on **each** ground, which is what forces two opposite lightness ramps, and
 * chroma falls with rank on both. Every stop is asserted in sRGB in
 * `lib/alloc.test.ts`, which is what makes these four pairs measurements rather
 * than tastes.
 */
const ALLOCATION_RAMP: Record<Ground, RampEnds> = {
  light: { lightness: [0.48, 0.84], chroma: [0.09, 0.028], hue: 165 },
  dark: { lightness: [0.86, 0.42], chroma: [0.14, 0.03], hue: 165 },
}

function interpolate(from: number, to: number, step: number, steps: number): number {
  return from + ((to - from) * step) / (steps - 1)
}

/**
 * The eight stops for one ground, rank 1 first, as `oklch()` strings.
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
