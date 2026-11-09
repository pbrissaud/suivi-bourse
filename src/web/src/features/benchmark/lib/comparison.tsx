/**
 * Small pure helpers of the comparison page: figures inside a sentence, and the
 * chart's period.
 */
import { Fragment, type ReactNode } from 'react'

import type { BenchmarkPoint } from '@/features/benchmark/lib/api'

/**
 * A sentence with its figures set in `fig` (« Relevé »: a figure inside a
 * sentence is mono at the sentence's size). The message is formatted first, so
 * the translators own the word order; the figures are found in the result by
 * their written form.
 */
export function figured(text: string, figures: readonly string[]): ReactNode {
  const written = figures.filter((figure) => figure !== '')
  if (written.length === 0) return text
  const pattern = new RegExp(
    `(${written.map((figure) => figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
  )
  return text.split(pattern).map((part, at) =>
    // `split` with one capture group puts the matches at the odd positions.
    at % 2 === 1 ? (
      <span key={at} className="fig">
        {part}
      </span>
    ) : (
      <Fragment key={at}>{part}</Fragment>
    ),
  )
}

/** The chart's periods, in words. The comparison itself always runs from the start. */
export const RANGES = ['1M', 'YTD', '1Y', 'MAX'] as const
export type Range = (typeof RANGES)[number]

/**
 * The days a period keeps, counted back from the series' **last** day: the
 * comparison ends on the fund's last close, which can trail the clock by days,
 * and "1 mois" is a month of the curve the reader is looking at.
 */
export function inRange<T extends Pick<BenchmarkPoint, 't'>>(
  points: readonly T[],
  range: Range,
): T[] {
  if (range === 'MAX' || points.length === 0) return [...points]
  const [year, month, day] = points[points.length - 1].t.split('-').map(Number)
  const floor =
    range === 'YTD'
      ? `${year}-01-01`
      : new Date(
          Date.UTC(range === '1M' ? year : year - 1, range === '1M' ? month - 2 : month - 1, day),
        )
          .toISOString()
          .slice(0, 10)
  return points.filter((point) => point.t >= floor)
}
