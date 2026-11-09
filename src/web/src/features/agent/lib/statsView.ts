/**
 * What the statistics page draws, worked out of `GET /api/agent/stats` and
 * nothing else: the shares of the bar, the weekly chart's scale and the months
 * under it. Pure, so the arithmetic is proved without a page.
 */
import type { AgentStats } from '@/features/agent/lib/api'

export interface Shares {
  cache: number
  fresh: number
  output: number
}

/** The bar's three parts as shares of every token exchanged (0 to 1); zeros while none was. */
export function sharesOf(totals: AgentStats['totals']): Shares {
  const whole = totals.cache_read + totals.fresh + totals.output
  if (whole === 0) return { cache: 0, fresh: 0, output: 0 }
  return {
    cache: totals.cache_read / whole,
    fresh: totals.fresh / whole,
    output: totals.output / whole,
  }
}

/**
 * The chart's top value: the weekly maximum rounded up to 1, 2 or 5 times a
 * power of ten divided in three, so the ticks (0, a third, two thirds, top) are
 * round numbers. Never zero.
 */
export function chartTop(max: number): number {
  if (max <= 0) return 3
  const step = max / 3
  const power = 10 ** Math.floor(Math.log10(step))
  const unit = [1, 2, 5, 10].find((n) => n * power >= step) as number
  return 3 * unit * power
}

/** The weeks that open a month, as `{ index, week }`, thinned to at most `limit` labels. */
export function monthTicks(
  weeks: readonly { week: string }[],
  limit = 7,
): { index: number; week: string }[] {
  const firsts: { index: number; week: string }[] = []
  let seen = ''
  weeks.forEach(({ week }, index) => {
    const month = week.slice(0, 7)
    if (month !== seen) firsts.push({ index, week })
    seen = month
  })
  const every = Math.ceil(firsts.length / limit)
  return firsts.filter((_, i) => i % every === 0)
}
