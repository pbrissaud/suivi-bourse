/**
 * A share of a total, drawn — **one component, where the product had three**
 * (#800).
 *
 * Everywhere the product lists a share of a total it writes the percentage and
 * draws nothing. The figure is there; the comparison between two lines is not:
 * `15,99 %` against `11,39 %` is a *reading*, and two bars are a glance. Three
 * surfaces carry the same figure — the allocation's legend, the accounts rail
 * and the account's own held lines (#833; the shares table's `Poids` column,
 * which this file was written for at #791, has left it for good with #831, the
 * weight of a line being drawn there by the allocation above the table now) —
 * and that is the reason this is a primitive rather
 * than a fix: `Stat`, `EmptyState`, `Refusal` and `EntryPair` all exist because the
 * prototype held four copies of one thing, and a share bar written three times
 * diverges three times. It had already begun: the account's composition bar was
 * a second copy, hand-written under `AccountDetail`, and it now mounts this one.
 *
 * Four things about it are decisions:
 *
 *  - **It chooses neither the colour nor the order** (ADR-0023, amended by
 *    ADR-0029). The allocation's ramp encodes **rank**, redundantly with the
 *    angle, and it is allowed to *only because* that list is sorted and
 *    legended; the rail's wheel encodes **identity**, in declaration order.
 *    Two rules, and neither of them is this file's — it takes the rank already
 *    spelled as the colour its own surface gives it. A default fill here would
 *    be a third ramp, invented by the one module that cannot know what it is
 *    drawing.
 *  - **The bar is `aria-hidden`.** The percentage is written beside it on every
 *    surface that mounts it, and announcing the drawing as well is two
 *    announcers for one figure.
 *  - **No share draws no bar; a zero share draws an empty track.** They are not
 *    the same claim. An account nothing has been written about has no share to
 *    state, and the em dash beside it says that already (`lib/absence.ts`) — a
 *    bar at zero would say *this is worth nothing*, which is a figure and not an
 *    absence. A line genuinely worth nothing out of a total that exists is that
 *    figure, and zero is not absence (`lib/sign.ts`): an empty track is what
 *    zero per cent looks like.
 *  - **The track is chrome and the fill is the domain's.** `bg-muted` is the
 *    preset's, which is ADR-0029's cut read the only way it can be here, and it
 *    is what leaves the fill as the one colour a caller has to think about.
 */
import { cn } from '@/lib/utils'

/**
 * Two heights, because they are the same object at two distances — `Stat`'s
 * three sizes, one order of magnitude down. `line` sits under a legend row or
 * inside a table cell, where the bar is subordinate to the text above it;
 * `block` sits under a figure of its own, where it is the drawing. A prop
 * rather than a second copy of this component: the whole reason the primitive
 * exists is that the product had three.
 */
const HEIGHTS: Record<'line' | 'block', string> = {
  line: 'h-[3px]',
  block: 'h-2',
}

export interface ShareBarProps {
  /**
   * The share, as a fraction of the whole — `0.1599`, never `15.99`. `null` is
   * *there is no share to state*, and it draws nothing at all.
   */
  share: number | null
  /**
   * The fill, as a CSS colour. Decided by the surface — the allocation's rank
   * ramp, the rail's identity wheel — and never here.
   */
  fill: string
  size?: 'line' | 'block'
  /**
   * The share the bar is drawn **full** at — the largest one on the surface,
   * where a list is compared down its own column (#838). `1` is the default and
   * means *full at the whole*, which is what a single bar under one figure says.
   *
   * The drawing uses it on the allocation's legend: the biggest line fills its
   * track and the rest are read against it, which is what makes a column of
   * 26, 18 and 11 per cent legible at all. It changes nothing about what is
   * **written** — the exact percentage stands beside the bar either way — and
   * that is why the bar can be scaled without lying: `aria-hidden`, it claims
   * nothing on its own.
   */
  scale?: number
  /** Where the bar sits, and nothing else: a margin, a flex basis. */
  className?: string
}

export function ShareBar({ share, fill, size = 'line', scale = 1, className }: ShareBarProps) {
  if (share === null) return null
  // Floored and capped **here**, so that no call site has to know why: a
  // browser drops `width: -12.5%` without a word, and the bars beside it then
  // read as a whole they no longer divide (`lib/accounts.ts` met the same edge
  // on the stacked bar and answers it by refusing the share outright).
  const percent = Math.min(Math.max((share / (scale || 1)) * 100, 0), 100)
  return (
    <span
      aria-hidden
      // The one handle a rendering test has on it: the bar is `aria-hidden` and
      // carries no word, so a suite that reads what is announced walks past it
      // exactly as `EmptyState` needed `data-empty` to be seen at all
      // (ADR-0026). `accounts.test.tsx` reads the drawn share through it.
      data-share-bar
      className={cn('block w-full overflow-hidden rounded-full bg-muted', HEIGHTS[size], className)}
    >
      {/* The fill is not rounded and does not need to be: the track rounds the
          left edge and clips the right, which is what a share drawn short of
          its whole looked like before this component existed. Rounding it here
          would round the right edge too, and the composition bar this replaced
          would have changed shape on a refactor that promised not to. */}
      <span className="block h-full" style={{ width: `${percent}%`, backgroundColor: fill }} />
    </span>
  )
}
