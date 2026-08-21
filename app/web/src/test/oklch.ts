/**
 * OKLCH → sRGB, for the one question the app never has to ask and its tests do:
 * **is this colour a colour the screen can show?**
 *
 * A browser given `oklch(0.85 0.16 262)` does not refuse it — it clamps it into
 * sRGB and paints something else. Two stops of a ramp can therefore be written
 * as distinct and rendered as the same, which is silent: nothing errors, no
 * assertion about a declared value notices, and the ramp goes on claiming to
 * encode a rank it no longer encodes. Blue is where this bites, because sRGB
 * has almost no chroma left at high lightness on that hue.
 *
 * The transform is Björn Ottosson's, and the constants are his. It is here
 * rather than in `lib/` on purpose: the product never converts a colour, and a
 * module nothing imports at runtime does not belong in the bundle.
 */

/** The linear-light sRGB triple, unclamped — negatives and >1 mean *outside*. */
function linearSrgb(lightness: number, chroma: number, hue: number): [number, number, number] {
  const radians = (hue * Math.PI) / 180
  const a = chroma * Math.cos(radians)
  const b = chroma * Math.sin(radians)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const encode = (channel: number): number =>
  channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * Math.pow(Math.max(channel, 0), 1 / 2.4) - 0.055

/**
 * Whether every channel lands inside sRGB — with a hair of tolerance, because
 * the endpoints of a hand-tuned ramp sit deliberately close to the boundary and
 * a rounding at the fourth decimal is not a defect.
 */
export function inSrgb(lightness: number, chroma: number, hue: number): boolean {
  return linearSrgb(lightness, chroma, hue)
    .map(encode)
    .every((channel) => channel >= -0.001 && channel <= 1.001)
}

/** The most chroma this lightness and hue can hold — what a failure should say. */
export function maxChroma(lightness: number, hue: number): number {
  let inside = 0
  let outside = 0.45
  for (let step = 0; step < 40; step += 1) {
    const middle = (inside + outside) / 2
    if (inSrgb(lightness, middle, hue)) inside = middle
    else outside = middle
  }
  return inside
}
