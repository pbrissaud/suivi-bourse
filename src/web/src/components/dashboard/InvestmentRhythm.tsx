/**
 * How much the owner buys in a month, and how often (#751).
 *
 * **The amount never appears without its coverage**, and here that is
 * structural rather than a rule somebody remembers: the two are one `Stat` —
 * the figure and the sentence hanging under it — so there is no arrangement of
 * this block that renders `500 €` on its own. It is the whole point of the
 * record: a reader handed the amount alone says `6 000 € a year` with complete
 * confidence when half of that never went in.
 *
 * **The months are drawn, and the dispersion is not quoted.** The record's
 * *is it held steady* used to be answered by a coefficient of variation set as
 * a percentage — `173,30 %` — which no reader can turn back into a habit. The
 * twelve observed months as twelve columns answer it without a figure: the
 * gaps are the coverage, the heights are the spread, and a month with nothing
 * bought is a tick on the baseline rather than an absence. The coefficient
 * stays in the payload for the agent; the screen shows what it
 * reduces.
 *
 * **No label and no verdict.** Not *monthly*, not *regular*, not *irregular*:
 * the word is a judgement, the threshold producing it is a setting nobody asked
 * for, and the reading is the reader's.
 *
 * **Nothing at all while the read is in flight**: `rhythm === null`
 * is *not answered yet*, and an empty state on it would be a claim about the
 * reader's own ledger made on a silence.
 *
 * **The per-account breakdown is in the payload and not on the screen.** The
 * grain the record argues for is the portfolio — an ETF in January and bitcoin
 * in February are one habit — and the split is what the agent reaches over the
 * same route. Its home on a page is the `Projections` one, the day
 * #757 or #758 gives that page a second occupant.
 */
import { EmptyState } from '@/components/EmptyState'
import { Stat } from '@/components/Stat'
import { Unreadable } from '@/components/Unreadable'
import { Section } from '@/components/ui/section'
import type { InvestmentRhythmResponse, RhythmMonth } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'

interface InvestmentRhythmProps {
  rhythm: InvestmentRhythmResponse | null
  failure?: ReadFailure | null
}

export function InvestmentRhythm({ rhythm, failure = null }: InvestmentRhythmProps) {
  const { t } = useI18n()
  const f = useFormatters()

  if (rhythm === null) return failure === null ? null : <Unreadable failure={failure} />

  return <Section title={t('dashboard.rhythm.title')}>{body()}</Section>

  function body() {
    // **Two absences, two sentences.** Nothing observed at all is a ledger with
    // no past; observed and uncovered is an owner who did not buy — and the
    // second is a statement about the rhythm rather than the lack of one.
    if (rhythm === null || rhythm.months_observed === 0) {
      return (
        <EmptyState
          title={t('dashboard.rhythm.unobserved')}
          description={t('dashboard.rhythm.unobserved.body')}
        />
      )
    }
    if (rhythm.monthly_amount === null) {
      return (
        <EmptyState
          title={t('dashboard.rhythm.empty', { observed: rhythm.months_observed })}
          description={t('dashboard.rhythm.empty.body')}
        />
      )
    }

    return (
      // The figure on the left at a fixed width and the twelve months filling
      // the rest (direction 1a): the amount is read first, the months are
      // what the width is for. Stacked under `sm`.
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:gap-8">
        <div className="shrink-0 sm:w-40">
          {/* The pair, and it is **one** group: the coverage is a child of the
            amount, so no reading of this markup detaches them. */}
          <Stat
            label={t('dashboard.rhythm.amount')}
            value={f.currency(rhythm.monthly_amount, rhythm.base_currency)}
          >
            <p className="text-xs text-muted-foreground">
              {t('dashboard.rhythm.coverage', {
                covered: rhythm.months_covered,
                observed: rhythm.months_observed,
              })}
            </p>
          </Stat>
        </div>
        <MonthStrip months={rhythm.months} currency={rhythm.base_currency} />
      </div>
    )
  }
}

/**
 * The observed months as columns, oldest on the left, **right-aligned in
 * twelve slots**: a ledger four months old fills the last four and leaves the
 * rest empty, so the strip says *twelve is the window* on a young ledger too.
 * The **current month** is the one column in the mint (`--primary`), the
 * others a quiet grey: the month still being bought in is the one the reader
 * compares against the eleven before it. An observed month with no purchase is a
 * tick on the baseline, which is a fact about the rhythm and not a gap in the
 * drawing. Each column names its month and its amount, for a pointer and for a
 * screen reader alike.
 */
function MonthStrip({ months, currency }: { months: RhythmMonth[]; currency: string | null }) {
  const { t } = useI18n()
  const f = useFormatters()
  const peak = Math.max(...months.map((one) => one.amount ?? 0))
  // The window ends on the month the measure was taken in (`rhythm.py`
  // anchors it on *now*), so the last column is the current month — read off
  // the payload rather than off the browser's clock.
  const current = months.at(-1)?.month ?? null
  const label = (month: string, year = true) => {
    const [y, m] = month.split('-')
    return year ? `${f.month(y, Number(m))} ${y}` : f.month(y, Number(m))
  }

  return (
    <div className="min-w-0 flex-1">
      <ol aria-label={t('dashboard.rhythm.months')} className="grid grid-cols-12 items-end gap-1.5">
        {months.map((one, index) => {
          const said =
            one.amount === null
              ? t('dashboard.rhythm.month.none', { month: label(one.month) })
              : t('dashboard.rhythm.month', {
                  month: label(one.month),
                  amount: f.currency(one.amount, currency),
                })
          // The year is written on the first column and on every January, so
          // a row of twelve short names still says which year each is in.
          const january = one.month.endsWith('-01')
          return (
            <li
              key={one.month}
              title={said}
              className="flex flex-col items-center gap-1.5"
              style={index === 0 ? { gridColumnStart: 13 - months.length } : undefined}
            >
              <span className="sr-only">{said}</span>
              <span aria-hidden className="flex h-14 w-full max-w-10 items-end">
                <span
                  className={
                    one.amount === null
                      ? 'block h-0.5 w-full bg-muted-foreground/35'
                      : one.month === current
                        ? 'block w-full rounded-t-[3px] bg-primary'
                        : 'block w-full rounded-t-[3px] bg-muted-foreground/40'
                  }
                  style={
                    one.amount === null
                      ? undefined
                      : { height: `${Math.max(6, (one.amount / peak) * 100)}%` }
                  }
                />
              </span>
              <span aria-hidden className="hidden truncate text-2xs text-muted-foreground md:block">
                {label(one.month, index === 0 || january)}
              </span>
            </li>
          )
        })}
      </ol>
      {/* Under `md` the twelve names do not fit, and the two ends say the extent. */}
      {months.length < 2 ? null : (
        <p
          aria-hidden
          className="mt-1.5 flex justify-between text-2xs text-muted-foreground md:hidden"
        >
          <span>{label(months[0].month)}</span>
          <span>{label(months.at(-1)!.month)}</span>
        </p>
      )}
    </div>
  )
}
