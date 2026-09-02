/**
 * How much the owner buys in a month, and how often (#751, ADR-0041).
 *
 * **The amount never appears without its coverage**, and here that is
 * structural rather than a rule somebody remembers: the two are one `Stat` —
 * the figure and the sentence hanging under it — so there is no arrangement of
 * this block that renders `500 €` on its own. It is the whole point of the
 * record: a reader handed the amount alone says `6 000 € a year` with complete
 * confidence when half of that never went in.
 *
 * **No label and no verdict.** Not *monthly*, not *regular*, not *irregular*:
 * the word is a judgement, the threshold producing it is a setting nobody asked
 * for (ADR-0036), and the reading is the reader's. The block states the
 * numbers, and the dispersion beside them is what answers *is it held steady*
 * without the block answering it for anyone.
 *
 * **Nothing at all while the read is in flight** (ADR-0026): `rhythm === null`
 * is *not answered yet*, and an empty state on it would be a claim about the
 * reader's own ledger made on a silence.
 *
 * **The per-account breakdown is in the payload and not on the screen.** The
 * grain the record argues for is the portfolio — an ETF in January and bitcoin
 * in February are one habit — and the split is what the agent reaches over the
 * same route (ADR-0040). Its home on a page is the `Projections` one, the day
 * #757 or #758 gives that page a second occupant.
 */
import { EmptyState } from '@/components/EmptyState'
import { Stat } from '@/components/Stat'
import { Unreadable } from '@/components/Unreadable'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import type { InvestmentRhythmResponse } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'

export interface InvestmentRhythmProps {
  rhythm: InvestmentRhythmResponse | null
  failure?: ReadFailure | null
}

export function InvestmentRhythm({ rhythm, failure = null }: InvestmentRhythmProps) {
  const { t } = useI18n()
  const f = useFormatters()

  if (rhythm === null) return failure === null ? null : <Unreadable failure={failure} />

  return (
    <Card>
      <CardHeader>
        <h2 className="eyebrow">{t('dashboard.rhythm.title')}</h2>
      </CardHeader>
      <CardContent>{body()}</CardContent>
    </Card>
  )

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
      <div className="flex flex-wrap items-start gap-x-12 gap-y-6">
        {/* The pair, and it is **one** group: the coverage is a child of the
            amount, so no reading of this markup detaches them. */}
        <Stat
          size="head"
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

        {/* Subordinate, and withheld on **one covered month**. The server's
            figure is defined there — the population deviation of a single value
            is `0` — and rendering it would say *held perfectly steady* on the
            strength of one purchase, which is the first-run screen. That is the
            confident-and-wrong reading the amount/coverage pair exists to
            prevent, met one figure over; a spread needs two months to be a
            spread. `null` is the server's own absence, on months averaging
            nothing. */}
        {rhythm.dispersion === null || rhythm.months_covered < 2 ? null : (
          <Stat
            size="term"
            label={t('dashboard.rhythm.dispersion')}
            // A coefficient of variation is a ratio, and it is read as a
            // percentage of the months' own average — unsigned, a spread having
            // no direction.
            value={f.percentPoints(rhythm.dispersion * 100)}
          />
        )}
      </div>
    )
  }
}
