/**
 * What colour a money figure takes — and the one bug this module exists to
 * remove: **zero is not absence**.
 *
 * The prototype's `signClass` greyed `0` exactly as it greyed `null`, and a
 * sold-out position carries both side by side — `Valorisation 0,00 €` beside
 * `Latente —`. Rendered in the same grey, the reader cannot tell *this is worth
 * nothing* from *we have nothing to tell you*, which are the two halves of the
 * absence rule.
 *
 * So there are **four** answers and not three: gain, loss, a zero that is a
 * figure (the ordinary text colour), and an absence that is not (the muted
 * one). `−0` is a zero: it comes out of subtraction often enough that reading
 * it as a loss would paint a red on a position that has not moved.
 *
 * Colour is also *rationed*, and that decision does not live here: only the
 * terms that can change sign take it (`gain.ts`'s `termCarriesSign`). A
 * dividend received is never negative and a transfer fee never positive, so
 * colouring them is decoration that steals the signal from the two terms that
 * do carry it. DESIGN.md, `## Colors`, is where the rule is written for design.
 */
import type { Rendering } from '@/lib/absence'

export type Sign = 'gain' | 'loss' | 'zero' | 'absent'

/**
 * The decimals a figure is **shown** at, which is what its sign is read at
 * (#1286): money and percent points at two, a ratio at two of percent. An IRR of
 * `+0,00003 %` reads `0,00 %`, and a green arrow beside it claims a gain the
 * digits do not show.
 */
export const MONEY_DECIMALS = 2
export const RATIO_DECIMALS = 4

export function signOf(value: number | null | undefined, decimals = MONEY_DECIMALS): Sign {
  if (value === null || value === undefined || Number.isNaN(value)) return 'absent'
  if (roundedAt(decimals).format(Math.abs(value)) === '0') return 'zero'
  return value > 0 ? 'gain' : 'loss'
}

// `Intl` itself decides, because it is what writes the digits: it rounds the
// number's shortest decimal, so `1.005` is `1,01` and `0.004999999999999999`
// is `0,00`, which no arithmetic on the binary value reproduces at both ends.
const ROUNDERS = new Map<number, Intl.NumberFormat>()
function roundedAt(decimals: number): Intl.NumberFormat {
  let rounder = ROUNDERS.get(decimals)
  if (rounder === undefined) {
    rounder = new Intl.NumberFormat('en', { maximumFractionDigits: decimals, useGrouping: false })
    ROUNDERS.set(decimals, rounder)
  }
  return rounder
}

const CLASSES: Record<Sign, string> = {
  gain: 'text-gain',
  loss: 'text-loss',
  // Neutral in colour, but in the **colour of text** — never in the grey of
  // absence. This line is the whole ticket.
  zero: 'text-foreground',
  absent: 'text-muted-foreground',
}

export function signClass(value: number | null | undefined, decimals = MONEY_DECIMALS): string {
  return CLASSES[signOf(value, decimals)]
}

/**
 * A figure that is neither money made nor money lost — a gap against the
 * benchmark reference (#1282): the colour of text whatever its sign, the grey of
 * absence for no figure.
 */
export function figureClass(value: number | null | undefined): string {
  return CLASSES[signOf(value) === 'absent' ? 'absent' : 'zero']
}

/** The colour of a cell whose content is not a number at all — the one predicate (#860). */
export function toneOf(rendering: Rendering, value: number | null): string {
  return rendering.kind === 'figure' ? signClass(value) : signClass(null)
}
