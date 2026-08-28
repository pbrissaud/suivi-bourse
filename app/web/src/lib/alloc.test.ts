/**
 * The allocation ramp: twelve stops, **generated**, and the rules that make the
 * generation worth having (ADR-0023, recomputed by ADR-0029).
 *
 * The rules are asserted rather than the values: a test pinning
 * `oklch(0.4200 0.1600 262)` would go red on a rounding change and stay green if
 * the two ramps were swapped between the grounds — which is the failure that
 * matters, because it encodes rank backwards in one theme out of two.
 *
 * Two of them need something `alloc.ts` does not have. *Rank 1 is the most
 * contrasted* is a claim about the ramp **against its ground**, and the ground
 * lives in `index.css`; *every stop is a colour that exists* needs sRGB, which
 * the product never converts to. Both come from `src/test/`, and neither value
 * is copied here — a copy would go stale the day the preset is regenerated.
 */
import { describe, expect, it } from 'vitest'

import { ALLOCATION_SLICES, allocationRamp, allocationTokenNames } from '@/lib/alloc'
import { contrast, inSrgb, luminance, maxChroma } from '@/test/oklch'
import { ground } from '@/test/stylesheet'

function components(stop: string): { lightness: number; chroma: number; hue: number } {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(stop)
  if (!match) throw new Error(`not an oklch stop: ${stop}`)
  return { lightness: Number(match[1]), chroma: Number(match[2]), hue: Number(match[3]) }
}

describe('the allocation ramp', () => {
  it('has one stop per slice, and one token name per stop', () => {
    expect(allocationRamp('light')).toHaveLength(ALLOCATION_SLICES)
    expect(allocationRamp('dark')).toHaveLength(ALLOCATION_SLICES)
    expect(allocationTokenNames()).toEqual(
      Array.from({ length: ALLOCATION_SLICES }, (_, index) => `--alloc-${index + 1}`),
    )
  })

  it('is one hue in twelve lightnesses, not twelve hues, on both grounds', () => {
    // Twelve hues at constant lightness sit at the edge of discriminability,
    // and below it for a colour-blind reader. Colour here encodes rank, which
    // the legend and the angle already carry — so it may be redundant, and must
    // be readable.
    //
    // Asked of **both** grounds since #837, which is the ticket that has to
    // mean it: the light ramp is derived rather than drawn, and a derivation
    // that reached for a second hue to buy back the chroma green loses on white
    // would satisfy every other assertion in this file.
    for (const theme of ['light', 'dark'] as const) {
      const hues = new Set(allocationRamp(theme).map((stop) => components(stop).hue))
      expect(hues.size, `the ${theme} ramp must be one hue`).toBe(1)
    }
  })

  it('orders the twelve ranks with the hue taken away, on both grounds', () => {
    // **The criterion a colour-blind reader is actually held to** (#837): the
    // rank has to survive the loss of the hue, in *both* themes. One hue in
    // twelve lightnesses is the design that buys that, and this is the
    // measurement of it — relative luminance, which is what is left of a colour
    // once no hue can be told from any other.
    //
    // It is not the same claim as *lightness falls with rank*, which the test
    // below makes on the declared values. Chroma falls with rank too, and
    // chroma emits light: a ramp whose lightness stepped by less than its
    // chroma gave back would read as monotone in OKLCH and **not** monotone on
    // a screen, which is the failure this catches and that one cannot.
    for (const theme of ['light', 'dark'] as const) {
      const painted = allocationRamp(theme)
        .map(components)
        .map((stop) => luminance(stop.lightness, stop.chroma, stop.hue))

      // Every step goes the same way and none of them is nothing: two ranks
      // that render as one value are two ranks the reader cannot tell apart,
      // and one step back the other way is a rank read backwards.
      for (let index = 1; index < ALLOCATION_SLICES; index += 1) {
        const [lower, higher] = theme === 'light' ? [index - 1, index] : [index, index - 1]
        expect(
          painted[higher],
          `${theme} ranks ${index} and ${index + 1} do not separate once the hue is gone`,
        ).toBeGreaterThan(painted[lower])
      }

      // Monotone is *not enough on its own*: twelve values inside one hair of
      // each other are monotone and unreadable. The span is what makes the
      // twelve a scale — measured at 3,86 on white and 5,75 on the midnight
      // ground, so the floor sits under both without pinning either.
      expect(
        contrast(painted[0], painted[ALLOCATION_SLICES - 1]),
        `the ${theme} ramp must span a range a grey reading can resolve`,
      ).toBeGreaterThanOrEqual(3)

      // And it runs the right way: rank 1 is the one furthest from the ground,
      // which on a grey reading means darkest on white and lightest on black.
      const ascending = painted[0] < painted[ALLOCATION_SLICES - 1]
      expect(ascending, `the ${theme} ramp runs the wrong way once the hue is gone`).toBe(
        theme === 'light',
      )
    }
  })

  it('makes rank 1 the most contrasted on both grounds, which flips the ramp', () => {
    const light = allocationRamp('light').map(components)
    const dark = allocationRamp('dark').map(components)

    // On white, rank 1 is the darkest and the ramp lightens.
    expect(light[0].lightness).toBeLessThan(light[ALLOCATION_SLICES - 1].lightness)
    // On black, rank 1 is the lightest and the ramp darkens. A single ramp
    // would encode rank backwards in one theme out of two.
    expect(dark[0].lightness).toBeGreaterThan(dark[ALLOCATION_SLICES - 1].lightness)

    for (let index = 1; index < ALLOCATION_SLICES; index += 1) {
      expect(light[index].lightness).toBeGreaterThan(light[index - 1].lightness)
      expect(dark[index].lightness).toBeLessThan(dark[index - 1].lightness)
    }
  })

  it('drops chroma with rank on both grounds', () => {
    for (const theme of ['light', 'dark'] as const) {
      const ramp = allocationRamp(theme).map(components)
      for (let index = 1; index < ALLOCATION_SLICES; index += 1) {
        expect(ramp[index].chroma).toBeLessThan(ramp[index - 1].chroma)
      }
    }
  })

  it('makes rank 1 the most contrasted against the ground it is drawn on', () => {
    // The two tests above compare the ramp with *itself*, which is one claim
    // short of the decision: rank 1 is not the most contrasted because it sits
    // at an end, but because it is furthest from the ground. On black and white
    // those two readings coincide; on a midnight ground at `oklch(0.155 …)`
    // they stop coinciding, and ADR-0029 changes exactly that value. So the
    // ground is read from `index.css` — the file that owns it — rather than
    // copied here, where a copy would go stale the day the preset is regenerated.
    for (const theme of ['light', 'dark'] as const) {
      const surface = ground(theme)
      const distances = allocationRamp(theme)
        .map(components)
        .map((stop) => Math.abs(stop.lightness - surface.lightness))
      expect(
        distances[0],
        `rank 1 must be the furthest from the ${theme} ground`,
      ).toBe(Math.max(...distances))
    }
  })

  it('states twelve stops the screen can actually show', () => {
    // A browser handed a colour outside sRGB does not refuse it — it clamps it
    // and paints something else. Two stops written as distinct then render as
    // the same, and the ramp goes on claiming a rank it no longer encodes.
    // Nothing about the declared values notices, which is why this is asserted
    // rather than assumed: blue has almost no chroma left at high lightness.
    for (const theme of ['light', 'dark'] as const) {
      for (const [rank, stop] of allocationRamp(theme).map(components).entries()) {
        expect(
          inSrgb(stop.lightness, stop.chroma, stop.hue),
          `${theme} rank ${rank + 1} is outside sRGB: chroma ${stop.chroma} exceeds ` +
            `${maxChroma(stop.lightness, stop.hue).toFixed(4)} at lightness ${stop.lightness}`,
        ).toBe(true)
      }
    }
  })

  it('generates rather than enumerates: ask for four stops and get four', () => {
    // The proof that nothing is hand-picked — the ends are the source, the
    // count is an argument, and the twelve are what the product asks for.
    const four = allocationRamp('light', 4).map(components)
    const twelve = allocationRamp('light').map(components)
    expect(four).toHaveLength(4)
    expect(four[0].lightness).toBe(twelve[0].lightness)
    expect(four[3].lightness).toBe(twelve[ALLOCATION_SLICES - 1].lightness)
  })
})
