/**
 * What colour a money figure takes — and the one bug this module exists to
 * remove: **zero is not absence** (ADR-0016).
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
 * do carry it.
 */
export type Sign = 'gain' | 'loss' | 'zero' | 'absent'

export function signOf(value: number | null | undefined): Sign {
  if (value === null || value === undefined || Number.isNaN(value)) return 'absent'
  if (value > 0) return 'gain'
  if (value < 0) return 'loss'
  return 'zero'
}

const CLASSES: Record<Sign, string> = {
  gain: 'text-gain',
  loss: 'text-loss',
  // Neutral in colour, but in the **colour of text** — never in the grey of
  // absence. This line is the whole ticket.
  zero: 'text-foreground',
  absent: 'text-muted-foreground',
}

export function signClass(value: number | null | undefined): string {
  return CLASSES[signOf(value)]
}
