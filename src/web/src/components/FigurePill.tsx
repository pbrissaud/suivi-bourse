import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

import { signClass, signOf } from '@/lib/sign'
import { cn } from '@/lib/utils'

export const PILL =
  'tabular inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-sm font-medium'

/**
 * One pill of a total — the total itself, the year, or today. The dashboard's
 * head and the accounts page's detail draw the same pill.
 *
 * A pill and not a statistic, deliberately: a `Stat` is a figure of its own,
 * and these are the head's figure seen through another window.
 *
 * **Its ground is neutral and its figure carries the sign** (#1149, reversing
 * the tint of #831): DESIGN.md does not colour a pill with `gain` or `loss`,
 * it colours the figure. The arrow stays the redundant encoding that makes the
 * direction legible without the hue. A **zero** takes no arrow and the colour
 * of text: it is a figure, not a direction, and `lib/sign.ts` is what says so.
 */
export function Period({ amount, text }: { amount: number; text: string }) {
  return (
    <span className={PILL}>
      <SignedFigure amount={amount} text={text} />
    </span>
  )
}

/** The arrow of the sign and the text, both in the sign's colour. */
export function SignedFigure({ amount, text }: { amount: number | null; text: string }) {
  const sign = signOf(amount)
  const Arrow = sign === 'gain' ? ArrowUpRight : sign === 'loss' ? ArrowDownRight : null
  return (
    <span className={cn('inline-flex items-center gap-1.5', signClass(amount))}>
      {Arrow === null ? null : <Arrow className="size-3" aria-hidden />}
      {text}
    </span>
  )
}
