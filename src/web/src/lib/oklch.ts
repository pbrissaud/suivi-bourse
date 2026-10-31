/**
 * A theme's colours as the form draws them: a CSS colour in, the `#rrggbb` a
 * native colour input holds out, and back. The module the lint lets name a
 * colour (`no-colour-literal`), since converting one is its whole job.
 *
 * The maths is `culori`'s. Only what the reader touches is converted: a value
 * nobody edited is never rewritten, so a round trip's rounding stays on the
 * colours the reader chose.
 */
import { clampChroma, converter, formatHex, parse } from 'culori'

const toOklch = converter('oklch')

/** The sRGB hex nearest a CSS colour (chroma reduced into the gamut); black if unreadable. */
export function toHex(css: string): string {
  const colour = parse(css)
  return (colour && formatHex(clampChroma(colour, 'oklch'))) || '#000000'
}

const round = (value: number) => +value.toFixed(4)

/** `#rrggbb` as the `oklch()` a theme stores, rounded to four decimals. */
export function fromHex(hex: string): string {
  const colour = toOklch(hex)
  return `oklch(${round(colour?.l ?? 0)} ${round(colour?.c ?? 0)} ${round(colour?.h ?? 0)})`
}
