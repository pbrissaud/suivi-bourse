/**
 * OKLCH → sRGB, for the one question the app never has to ask and its tests do:
 * **how much light does this colour put on the screen?**
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

/**
 * The colour **with its hue taken away**: WCAG relative luminance, which is the
 * one reading of a colour that survives every form of colour blindness.
 *
 * OKLCH lightness is not what a screen emits: chroma carries light of its own,
 * so a contrast has to be read off the rendered colour, not the declared one.
 */
export function luminance(lightness: number, chroma: number, hue: number): number {
  const [red, green, blue] = linearSrgb(lightness, chroma, hue).map((channel) =>
    Math.min(1, Math.max(0, channel)),
  )
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/** The WCAG contrast of two luminances — the same formula for text and marks. */
export function contrast(one: number, other: number): number {
  const [lighter, darker] = one >= other ? [one, other] : [other, one]
  return (lighter + 0.05) / (darker + 0.05)
}
