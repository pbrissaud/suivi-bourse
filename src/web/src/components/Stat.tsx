/**
 * The *figure + label* primitive — **one**, where the prototype had four.
 *
 * `Stat` was copied three times, and the shares page used a fourth component,
 * `Summary`, **with no slot for a hint at all**. That fourth one is precisely
 * what carried `Plus-value latente 335,22 €`: the most wrong figure in the
 * product sat on the only component incapable of explaining itself. So the slot
 * is not optional furniture here — it is the reason the primitive exists.
 *
 * Three weights, one component, because they are the same object seen from
 * three distances: `head` is the one figure a page leads with, `term` is what
 * is subordinate to it, `stat` everything else. Subordination is **vertical**
 * and it is a size — a total and its terms never share a line (ADR-0016), and
 * mounted at equal weight nothing says the terms are *inside* the total.
 *
 * The group is a landmark with the label as its accessible name, which is what
 * lets a reader — and a test — take hold of *one* figure and its subordinates.
 * That is what pins the rule the head exists to keep: the year-to-date euro and
 * the year-to-date percentage are two figures that must never share a line, and
 * asserting they live in two different groups is how that stays true.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface StatProps {
  label: string
  /** Already formatted. This component never sees a number. */
  value: ReactNode
  /**
   * The explanation slot — an `<Explain>`, when the figure rests on a
   * convention. Absent is the ordinary case: the criterion is not the size of
   * the number but *would this be verifiable without knowing a rule?*
   */
  explain?: ReactNode
  /** What hangs under the figure — a delta, a base date, a second scalar. */
  children?: ReactNode
  /** The colour of the value, decided by `lib/sign.ts` and never here. */
  valueClassName?: string
  size?: 'head' | 'stat' | 'term'
  /**
   * Where the pair sits on its own line. `start` everywhere but one: the
   * allocation's total is drawn **inside the ring's hole**, which has a middle
   * and no left edge. It is a prop rather than a fifth copy of this component —
   * the whole reason this primitive exists is that the prototype had four.
   */
  align?: 'start' | 'center'
}

/**
 * The three distances, on the drawing's own ladder (#838): 52 px for the one
 * figure a page leads with, 19 px for a statistic, 16 px for a term inside a
 * total. The head is set a notch heavier than semibold because the drawing sets
 * it there — at that size 600 reads thin against everything around it.
 */
const SIZES: Record<NonNullable<StatProps['size']>, string> = {
  head: 'text-hero font-heavy',
  stat: 'text-xl',
  term: 'text-lg',
}

/**
 * **The head's label is an eyebrow, and the others' is a label.** The drawing
 * distinguishes them: what a page leads with is announced in small caps above
 * the figure, and everything subordinate to it is named in ordinary type. It
 * follows the size because it *is* the size's business — a second prop would
 * let the two disagree.
 */
const LABELS: Record<NonNullable<StatProps['size']>, string> = {
  head: 'text-2xs font-semibold tracking-caps uppercase',
  stat: 'text-xs',
  term: 'text-xs',
}

export function Stat({
  label,
  value,
  explain,
  children,
  valueClassName,
  size = 'stat',
  align = 'start',
}: StatProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('min-w-0 space-y-1', align === 'center' && 'text-center')}
    >
      <div className={cn('flex items-center gap-1.5', align === 'center' && 'justify-center')}>
        <span className={cn(LABELS[size], 'text-muted-foreground')}>{label}</span>
        {explain}
      </div>
      <div className={cn('tabular font-semibold tracking-tight', SIZES[size], valueClassName)}>
        {value}
      </div>
      {children}
    </div>
  )
}
