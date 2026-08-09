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
 * Two consequences are load-bearing and both live in the table below:
 *
 *  - **Rank 1 is the most contrasted in *both* themes**, which forces two
 *    opposite lightness ramps: dark stands out on white, light stands out on
 *    black. A single ramp would encode rank backwards in one theme out of two.
 *  - **Chroma falls with rank in both**, so rank 1 is also the most saturated.
 *    Read against lightness that reads as "decreasing with lightness" in light
 *    and "increasing with lightness" in dark — the same rule, seen from the two
 *    grounds.
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
  /** One hue, the preset's own `--chart-2`, in twelve steps. */
  hue: number
}

export const ALLOCATION_RAMP: Record<Ground, RampEnds> = {
  light: { lightness: [0.45, 0.78], chroma: [0.16, 0.06], hue: 264 },
  dark: { lightness: [0.85, 0.52], chroma: [0.16, 0.06], hue: 264 },
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
