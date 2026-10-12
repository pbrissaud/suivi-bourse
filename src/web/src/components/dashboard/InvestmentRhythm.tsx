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
import type { RenderState } from '@/lib/dashboardLayout'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'

interface InvestmentRhythmProps {
  rhythm: InvestmentRhythmResponse | null
  failure?: ReadFailure | null
}

/** What this block renders: the block's own `null` and the grid's, one rule. */
export function investmentRhythmRenderState({
  rhythm,
  failure = null,
}: InvestmentRhythmProps): RenderState {
  return rhythm === null && failure === null ? 'pending' : 'renders'
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
      // The figure above the twelve months, at every width: the card is
      // half-width only (dashboard grid, 11/10/2026 — across the full width
      // the twelve columns spread too far apart to read), and on half a width
      // a figure beside them would take a third of the room they need. The
      // amount is still read first.
      <div className="flex flex-1 flex-col gap-5">
        <div className="shrink-0">
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
        <MonthStrip
          months={rhythm.months}
          median={rhythm.monthly_amount}
          currency={rhythm.base_currency}
        />
      </div>
    )
  }
}

const CAP_MULTIPLE = 3
const FLOOR_PERCENT = 15

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
 *
 * **One month does not set the scale for the other eleven** (#1152). Scaled to
 * the largest month, a single large purchase pressed every other bar onto the
 * floor, where a month bought in read as a month with nothing — the one thing
 * the strip exists to tell apart. The scale stops at three times the median
 * month, a month above it is drawn full height with a notch cut near its top,
 * and its exact amount is still in its title and its screen-reader text. A
 * month bought in never drops below 15 % of the column, four times the empty
 * tick.
 */
function MonthStrip({
  months,
  median,
  currency,
}: {
  months: RhythmMonth[]
  median: number
  currency: string | null
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const peak = Math.max(...months.map((one) => one.amount ?? 0))
  // A median of `0` (free shares count as a `0` buy) would cap every month
  // bought in, so the scale falls back on the peak.
  const scaleTop = median > 0 ? Math.min(peak, CAP_MULTIPLE * median) : peak
  // The window ends on the month the measure was taken in (`rhythm.py`
  // anchors it on *now*), so the last column is the current month — read off
  // the payload rather than off the browser's clock.
  const current = months.at(-1)?.month ?? null
  const label = (month: string, year = true) => {
    const [y, m] = month.split('-')
    return year ? `${f.month(y, Number(m))} ${y}` : f.month(y, Number(m))
  }

  return (
    <div className="mt-auto min-w-0">
      <ol aria-label={t('dashboard.rhythm.months')} className="grid grid-cols-12 items-end gap-1.5">
        {months.map((one, index) => {
          const said =
            one.amount === null
              ? t('dashboard.rhythm.month.none', { month: label(one.month) })
              : t('dashboard.rhythm.month', {
                  month: label(one.month),
                  amount: f.currency(one.amount, currency),
                })
          // **One month in three is named** (design review 16B): at half a
          // width a column is some forty pixels, and twelve names would
          // collide. Counted on the twelve slots, so the named months do not
          // shift as a young ledger fills; the full name is in each column's
          // title and its screen-reader text.
          const slot = index + 12 - months.length
          return (
            <li
              key={one.month}
              title={said}
              className="flex flex-col items-center gap-1.5"
              style={index === 0 ? { gridColumnStart: 13 - months.length } : undefined}
            >
              <span className="sr-only">{said}</span>
              <span aria-hidden className="flex h-14 w-full max-w-10 items-end">
                {one.amount === null ? (
                  <span className="block h-0.5 w-full bg-muted-foreground/35" />
                ) : (
                  <Bar amount={one.amount} scaleTop={scaleTop} current={one.month === current} />
                )}
              </span>
              <span aria-hidden className="h-4 whitespace-nowrap text-2xs text-muted-foreground">
                {slot % 3 === 0 ? label(one.month, false) : null}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** A month bought in; above the scale's top it is full height and notched. */
function Bar({
  amount,
  scaleTop,
  current,
}: {
  amount: number
  scaleTop: number
  current: boolean
}) {
  const capped = amount > scaleTop
  return (
    <span
      data-capped={capped ? '' : undefined}
      className={`block w-full rounded-t-[3px] ${capped ? 'relative ' : ''}${
        current ? 'bg-primary' : 'bg-muted-foreground/40'
      }`}
      style={{
        height: capped ? '100%' : `${Math.max(FLOOR_PERCENT, (amount / scaleTop) * 100 || 0)}%`,
      }}
    >
      {/* The cut is the `Section`'s own background, so it reads in both themes. */}
      {capped ? <span className="absolute inset-x-0 top-1.5 h-0.5 bg-muted" /> : null}
    </span>
  )
}
