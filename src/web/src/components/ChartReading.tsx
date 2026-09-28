/**
 * What a chart says at rest — **the shape of the window, in one sentence**
 * (#1003).
 *
 * It is the other half of `ChartTooltip`, and the pair divides the work the way
 * the reader's own gestures do: the tooltip answers *what about this day* as a
 * pointer or an arrow key moves along the series, and this answers *what is the
 * shape of all of it* for a reader who has just arrived. Neither repeats the
 * other, and neither repeats the head above the chart.
 *
 * Four things about it are decisions:
 *
 *  - **It is `sr-only`, and no pixel moves.** #831 took the explanatory caption
 *    off this block and #787 put the magnitude at rest in the head; an
 *    accessibility pass has no business reversing either in passing. The
 *    precedent is `InvestmentRhythm`'s month strip, which has written its
 *    reading this way since #751: one `sr-only` sentence per column, the bars
 *    `aria-hidden`.
 *  - **It is a `<figcaption>`, so the caller is a `<figure>`.** That pair is
 *    what HTML has for a drawing and its description, which is one rung above
 *    wiring an `aria-describedby` by hand.
 *  - **It never states the last value.** The dashboard's head carries its figure
 *    on the live gain's instant rather than on the series' last point (#1051),
 *    so an arrival restated here would be a second, different number for today.
 *    The sentence says the extent, the opening, the dated extremes and the side
 *    of the gap — what nothing else on the page says.
 *  - **The values are written by the chart's own `format`**, exactly as
 *    `ChartTooltip` takes it: the chart owns the unit, the primitive owns the
 *    shape. That is also what keeps one component serving a chart in euros and a
 *    chart in per cent.
 *
 * **The live region is the caller's, not this component's.** A region has to
 * outlive what it reports on, and three of the four charts swap this caption for
 * an `EmptyState` when a range press empties the window — so the `aria-live`
 * belongs on the node that holds *either*, one level up, or a gesture that
 * empties the chart would unmount the announcer instead of changing it.
 */
import { chartShape, type ReadingCurve } from '@/lib/chartReading'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

interface ChartReadingProps {
  /**
   * The rows the plot draws — **the same array**, passed to `data=` and read
   * here by the same keys, which is what makes the sentence unable to drift
   * from the curve (`lib/chartReading.ts`).
   */
  rows: readonly object[]
  /** One entry per `<Line>`, naming it and the `dataKey` it draws. */
  curves: readonly ReadingCurve[]
  /**
   * How a value is written. The chart owns its unit; this owns the shape.
   *
   * **`null` is *the unit is not known yet*, and then nothing is announced at
   * all.** A reporting currency that has not answered makes `formatCurrency`
   * render the plain number, which is right for an axis tick and for a tooltip
   * under a pointer — the reader can see which chart they are on — and wrong
   * here: *1 800,00* spoken to somebody who cannot see the screen is a figure
   * without its unit, and a block says nothing it has not read (#775). A
   * percentage carries its own unit, so the performance reading never passes
   * `null`.
   */
  format: ((value: number) => string) | null
  /**
   * The constant a single curve is read against — `0` on the performance
   * reading, which is the `ReferenceLine` that plot already draws.
   */
  reference?: number
}

export function ChartReading({ rows, curves, format, reference }: ChartReadingProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const shape = chartShape(rows, curves, reference)

  // The unit has not answered: no sentence rather than a bare number.
  if (format === null) return null

  // Rows that draw nothing are a **fact** about the window, and the only
  // truthful sentence over them. *Not answered* never reaches here: the block
  // above returns before this mounts.
  if (shape === null) {
    return <figcaption className="sr-only">{t('chart.reading.nothing')}</figcaption>
  }

  const [first, second] = shape.opening
  // The second name is the other curve's, or the reference's own word: a curve
  // crossing `0,00 %` reads as *crosses zero*, which is what the drawn line is.
  const other = second === undefined ? t('chart.reading.reference') : second.name

  const clauses = [
    t('chart.reading.range', {
      names: f.list(shape.opening.map((one) => one.name)),
      from: f.date(shape.from),
      to: f.date(shape.to),
    }),
    second === undefined
      ? t('chart.reading.opening.one', { name: first.name, value: format(first.value) })
      : t('chart.reading.opening.two', {
          first: first.name,
          firstValue: format(first.value),
          second: second.name,
          secondValue: format(second.value),
        }),
    // The extremes are the **first** curve's, and the sentence leads with its
    // name: *Plus haut Valeur totale 24 300 €* is a noun stack French does not
    // do, and the colon is what makes one wording read in both languages.
    t('chart.reading.extremes', {
      name: first.name,
      high: format(shape.high.value),
      highDay: f.date(shape.high.day),
      low: format(shape.low.value),
      lowDay: f.date(shape.low.day),
    }),
    gapClause(),
  ]

  return <figcaption className="sr-only">{clauses.filter(Boolean).join(' ')}</figcaption>

  function gapClause(): string | null {
    if (shape === null || shape.gap === null) return null
    if ('side' in shape.gap) {
      return t('chart.reading.stays', { first: first.name, second: other, side: shape.gap.side })
    }
    return t('chart.reading.crosses', {
      first: first.name,
      second: other,
      count: shape.gap.crossings,
      day: f.date(shape.gap.last),
    })
  }
}
