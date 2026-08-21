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
 * Recomputed on the midnight ground (ADR-0029), and two things moved with it.
 *
 * **The hue, 262, is chosen and not derived.** ADR-0023 took the preset's
 * `--chart-2` because the preset was near monochrome and that slot was the only
 * blue in it. The midnight preset states a ground *and* an accent, so the choice
 * needs its own argument: mint, purple and teal are spoken for by a state or a
 * mark, and a share of a total is neither, so the ramp sits in the blue nobody
 * claimed. It is deliberately **near** both grounds — `266.4` dark, `258.3`
 * light — without being either: a single ramp cannot be two hues, and reading
 * one ground's hue would make the light ramp answer to the dark one. Twelve
 * lightnesses of that blue read as shades of the surface, never as a meaning.
 *
 * **The chroma ends are bounded by rank 1, and rank 1 alone.** Blue keeps almost
 * no chroma at high lightness: at `L 0.86` the screen can show `0.069`, and
 * `0.16` — what both ramps used to ask for — was outside sRGB. The browser
 * clamped those first stops, rendering several ranks as one colour, which is the
 * ramp failing at exactly the job it exists for. Since chroma must then *fall*
 * from rank 1, that one ceiling sets the whole dark ramp: the later stops have
 * three to six times the headroom they use, and could not use it without
 * breaking the rule.
 *
 * The honest consequence is that **on the dark ground the chroma cue is nearly
 * mute** — `0.055` to `0.018` is a travel a reader will not see — and lightness
 * carries the rank alone. That is acceptable only because lightness was always
 * the primary cue and the legend carries name and percentage besides. The light
 * ramp, drawn where blue has room, keeps both cues.
 */
export const ALLOCATION_RAMP: Record<Ground, RampEnds> = {
  light: { lightness: [0.42, 0.8], chroma: [0.16, 0.05], hue: 262 },
  dark: { lightness: [0.86, 0.42], chroma: [0.055, 0.018], hue: 262 },
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
