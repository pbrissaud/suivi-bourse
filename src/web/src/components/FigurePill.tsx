import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

import { MONEY_DECIMALS, signClass, signOf } from '@/lib/sign'
import { cn } from '@/lib/utils'

export const PILL =
  'tabular inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-sm font-medium'

/**
 * The arrow of the sign and the text, both in the sign's colour. **Its figure
 * carries the sign, not its ground** (#1149, reversing the tint of #831):
 * DESIGN.md does not colour a pill or a row with `gain` or `loss`, it colours
 * the figure. The arrow is the redundant encoding that makes the direction
 * legible without the hue. A **zero** takes no arrow and the colour of text: it
 * is a figure, not a direction, and `lib/sign.ts` is what says so.
 *
 * The accounts page sets it in a `PILL`; the dashboard's head sets it bare, on
 * the ground (#1280).
 *
 * `decimals` is the precision `text` is written at (#1286): a figure that rounds
 * to zero is a zero, whatever its raw sign.
 */
export function SignedFigure({
  amount,
  text,
  className,
  arrowClassName = 'size-3',
  decimals = MONEY_DECIMALS,
}: {
  amount: number | null
  text: string
  className?: string
  arrowClassName?: string
  decimals?: number
}) {
  const sign = signOf(amount, decimals)
  const Arrow = sign === 'gain' ? ArrowUpRight : sign === 'loss' ? ArrowDownRight : null
  return (
    <span
      className={cn('inline-flex items-center gap-1.5', signClass(amount, decimals), className)}
    >
      {Arrow === null ? null : <Arrow className={arrowClassName} aria-hidden />}
      {text}
    </span>
  )
}
