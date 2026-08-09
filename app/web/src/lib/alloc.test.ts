/**
 * The allocation ramp: twelve stops, **generated**, and the two rules that make
 * the generation worth having (ADR-0023).
 *
 * The rules are asserted rather than the values: a test pinning
 * `oklch(0.4500 0.1600 264)` would go red on a rounding change and stay green if
 * the two ramps were swapped between the grounds — which is the failure that
 * matters, because it encodes rank backwards in one theme out of two.
 */
import { describe, expect, it } from 'vitest'

import { ALLOCATION_SLICES, allocationRamp, allocationTokenNames } from '@/lib/alloc'

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

  it('is one hue in twelve lightnesses, not twelve hues', () => {
    // Twelve hues at constant lightness sit at the edge of discriminability,
    // and below it for a colour-blind reader. Colour here encodes rank, which
    // the legend and the angle already carry — so it may be redundant, and must
    // be readable.
    const hues = new Set(allocationRamp('light').map((stop) => components(stop).hue))
    expect(hues.size).toBe(1)
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
    for (const ground of ['light', 'dark'] as const) {
      const ramp = allocationRamp(ground).map(components)
      for (let index = 1; index < ALLOCATION_SLICES; index += 1) {
        expect(ramp[index].chroma).toBeLessThan(ramp[index - 1].chroma)
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
