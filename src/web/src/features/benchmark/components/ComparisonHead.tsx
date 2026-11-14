/**
 * The head of the comparison — **a sentence, not a figure** (« Relevé »,
 * DESIGN.md › Typography › Statement).
 *
 * « 837,20 € de moins qu'en plaçant le même argent dans le MSCI World. » is the
 * answer, and the sentence is the hero: a bare « −837,20 € » at 56 px read as
 * money lost, and it is money not made. Decisions kept from the screen it
 * replaces:
 *
 *  - **The reference is chosen in the line above the sentence** (#1282): the
 *    whole page depends on that one choice, and the header bar is closed to
 *    controls.
 *  - **A gap takes no sign colour**; each side's own return keeps its own, as
 *    a gain or a loss. The two bars under the sentence are on one scale and
 *    take the chart hues, never a sign colour.
 *  - **The percentage is the verdict's, not the sentence's**: « soit 2,0 % des
 *    41 063,00 € versés aux mêmes dates » says how big the gap is next to the
 *    money it is a gap of. The euro leads because the head answers *how much
 *    is left*; the returns sit in the marks on the right, apart.
 *  - **The head is the result of a gesture**, so it is a polite live region:
 *    choosing another fund reads the sentence back.
 *  - **Truncation is a caption, not an absence**: with a 2024 fund the screen
 *    has a complete, correct answer over a shorter window, said under the
 *    verdict.
 */
import type { ReactNode } from 'react'

import { ProvisionalNote } from '@/components/ProvisionalNote'
import { ShareBar } from '@/components/ShareBar'
import type { BenchmarkResponse } from '@/features/benchmark/lib/api'
import { figured } from '@/features/benchmark/lib/comparison'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { signClass, signOf } from '@/lib/sign'

/** A return is read at one decimal: the marks are a shape, not a statement. */
const POINTS_DECIMALS = 3

interface ComparisonHeadProps {
  data: BenchmarkResponse
  currency: string | null
  /** The fund picker, which the sentence above the statement carries. */
  picker: ReactNode
}

export function ComparisonHead({ data, currency, picker }: ComparisonHeadProps) {
  const { t } = useI18n()
  const f = useFormatters()

  const gap = data.gap_gross ?? null
  const index = data.index ?? data.reference ?? ''
  const contributed = data.contributed ?? null
  const yours = data.portfolio_value ?? null
  const theirs = data.reference_value ?? null
  const scale = Math.max(yours ?? 0, theirs ?? 0)

  const amount = gap === null ? '' : f.currency(Math.abs(gap), currency)
  const statement =
    gap === null
      ? null
      : signOf(gap) === 'zero'
        ? t('benchmark.statement.equal', { index })
        : t(signOf(gap) === 'gain' ? 'benchmark.statement.ahead' : 'benchmark.statement.behind', {
            gap: amount,
            index,
          })

  // « soit 2,0 % des 41 063,00 € versés » — only where there is a gap and a
  // positive amount to measure it against.
  const share =
    gap !== null && signOf(gap) !== 'zero' && contributed !== null && contributed > 0
      ? f.percentPoints((Math.abs(gap) / contributed) * 100, 1)
      : null
  const paid = contributed === null ? '' : f.currency(contributed, currency)

  const marks: [string, string, string?][] = [
    [t('benchmark.marks.invested'), contributed === null ? '—' : paid],
    [
      t('benchmark.marks.yours'),
      f.percent(data.portfolio_return, 1, 1),
      signClass(data.portfolio_return ?? null, POINTS_DECIMALS),
    ],
    [
      t('benchmark.marks.theirs', { index }),
      f.percent(data.reference_return, 1, 1),
      signClass(data.reference_return ?? null, POINTS_DECIMALS),
    ],
  ]

  return (
    <div aria-live="polite">
      <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-x-1 text-md text-muted-foreground">
            {t('benchmark.lead')} {picker}
          </div>
          {statement === null ? null : (
            <p className="max-w-[30ch] statement">{figured(statement, [amount])}</p>
          )}
          {share === null ? null : (
            <p className="mt-0.5 text-muted-foreground">
              {figured(t('benchmark.verdict.share', { share, contributed: paid }), [share, paid])}
            </p>
          )}
          {contributed === null ? null : (
            // « Même argent investi », retraceable: what it sums, and that both
            // percentages below are measured against it.
            <p className="max-w-prose text-sm text-muted-foreground">{t('benchmark.explain')}</p>
          )}
          <ProvisionalNote />
          <Caveats data={data} />
        </div>
        <dl
          aria-label={t('benchmark.marks.label')}
          className="m-0 grid grid-cols-[auto_auto] items-baseline gap-x-6 gap-y-1.5 pb-1.5"
        >
          {marks.map(([name, value, tone]) => (
            <div key={name} className="contents">
              <dt className="text-right text-sm text-muted-foreground">{name}</dt>
              <dd className={`fig m-0 text-right text-md ${tone ?? ''}`}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Two bars on one scale: the same money, two results. */}
      <div className="mt-6 flex flex-col gap-2">
        {(
          [
            [t('benchmark.bar.yours'), yours, 'var(--alloc-1)'],
            [t('benchmark.bar.theirs', { index }), theirs, 'var(--alloc-5)'],
          ] as const
        ).map(([name, value, fill]) => (
          <div
            key={name}
            className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_7.5rem] items-center gap-4"
          >
            <span className="text-muted-foreground">{name}</span>
            <ShareBar share={value} scale={scale} fill={fill} size="block" />
            <span className="fig text-right">
              {value === null ? '—' : f.currency(value, currency)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * What shortened the period, under the verdict — the period itself is the
 * header's subtitle. It reads the **computed** period and never the fund's
 * inception alone: the seed lands at the later of the fund's first close and
 * the account's first written day, and an exhausted reference or a missing rate
 * can end it early. A caption naming a period the arithmetic did not honour is
 * worse than none.
 */
function Caveats({ data }: { data: BenchmarkResponse }) {
  const { t } = useI18n()
  const f = useFormatters()

  if (!data.covered_from || !data.covered_to) return null

  // **The fund is named as the cause only when it is one**: the server is the
  // only side that knows both dates. Whole years **elapsed**, never a difference
  // of year parts, so the figure is the one the owner would count themselves.
  const lost =
    data.truncated_by_fund === true && data.portfolio_from
      ? elapsedYears(data.portfolio_from, data.covered_from)
      : 0

  const sentences = [
    lost > 0
      ? t('benchmark.period.truncated', { from: f.date(data.covered_from), years: lost })
      : null,
    data.ended === 'exhausted'
      ? t('benchmark.period.exhausted', { to: f.date(data.covered_to) })
      : data.ended === 'awaiting_rate'
        ? t('benchmark.period.awaitingRate', { to: f.date(data.covered_to) })
        : null,
  ].filter((sentence) => sentence !== null)
  if (sentences.length === 0) return null

  return <p className="max-w-prose text-sm text-muted-foreground">{sentences.join(' ')}</p>
}

/**
 * Whole years between two `YYYY-MM-DD` days. Under a year the caption stays
 * silent: it exists for the case where truncation actually bites, and the
 * subtitle already names both ends.
 */
function elapsedYears(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const whole = ty - fy
  return tm > fm || (tm === fm && td >= fd) ? whole : whole - 1
}
