/**
 * **What Atelier's colours must clear, resolved through `index.css`** (#1283).
 *
 * The ring, the account identities and the two signs are aliases in block 2, so
 * each `var()` is followed down to the `oklch()` block 1 gives it. Contrast is
 * WCAG 2 after OKLCH → sRGB with gamut clamping, ΔE_ok the distance in OKLab —
 * both from `test/oklch.ts`. These are guarantees about Atelier only: another
 * theme brings its own chart hues, and the ring's gap and legend carry it there.
 */
import { describe, expect, it } from 'vitest'

import type { Ground } from '@/lib/theme'
import { contrast, distance, luminance } from '@/test/oklch'
import { blocks, declarations, type Oklch, oklch } from '@/test/stylesheet'

const GROUNDS: readonly Ground[] = ['light', 'dark']
/** The ground, the section's tint and the card sitting on it. */
const SURFACES = ['--background', '--muted', '--card'] as const
const RING = ['--alloc-1', '--alloc-2', '--alloc-3', '--alloc-4', '--alloc-5'] as const

/** A token's colour on one ground, following `var()` aliases across blocks. */
function colour(name: string, ground: Ground): Oklch {
  for (const block of blocks()) {
    const value = declarations(block, ground).get(name)
    if (value === undefined) continue
    const alias = /^var\((--[\w-]+)\)$/.exec(value)
    return alias ? colour(alias[1], ground) : oklch(value)
  }
  throw new Error(`no ${name} declared for the ${ground} theme`)
}

function ratio(mark: string, surface: string, ground: Ground): number {
  const [on, under] = [colour(mark, ground), colour(surface, ground)]
  return contrast(
    luminance(on.lightness, on.chroma, on.hue),
    luminance(under.lightness, under.chroma, under.hue),
  )
}

describe('Atelier’s palette', () => {
  it('every allocation stop clears 3:1 on the background, the section and the card, on both grounds', () => {
    for (const ground of GROUNDS)
      for (const stop of RING)
        for (const surface of SURFACES)
          expect(ratio(stop, surface, ground), `${stop} on ${surface}, ${ground}`).toBeGreaterThan(
            3,
          )
  })

  it('neighbouring stops on the closed ring sit at least 0.12 ΔE_ok apart, on both grounds', () => {
    for (const ground of GROUNDS)
      RING.forEach((stop, at) => {
        const next = RING[(at + 1) % RING.length]
        expect(
          distance(colour(stop, ground), colour(next, ground)),
          `${stop} and ${next}, ${ground}`,
        ).toBeGreaterThanOrEqual(0.12)
      })
  })

  it('gain and loss clear 4.5:1 as text on the background, the section and the card, on both grounds', () => {
    for (const ground of GROUNDS)
      for (const sign of ['--gain', '--loss'])
        for (const surface of SURFACES)
          expect(ratio(sign, surface, ground), `${sign} on ${surface}, ${ground}`).toBeGreaterThan(
            4.5,
          )
  })

  it('gain sits at least 0.15 ΔE_ok from the primary, and at least 0.25 from the loss, on both grounds', () => {
    for (const ground of GROUNDS) {
      const gain = colour('--gain', ground)
      expect(distance(gain, colour('--primary', ground)), ground).toBeGreaterThanOrEqual(0.15)
      expect(distance(gain, colour('--loss', ground)), ground).toBeGreaterThanOrEqual(0.25)
    }
  })

  it('the primary foreground clears 4.5:1 on the primary, on both grounds', () => {
    for (const ground of GROUNDS)
      expect(ratio('--primary-foreground', '--primary', ground), ground).toBeGreaterThan(4.5)
  })
})
