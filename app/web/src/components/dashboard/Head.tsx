/**
 * The head of the dashboard (ADR-0018, ADR-0016).
 *
 * **One head, no discriminated union.** `MODE_MULTI_CURRENCY` is dead and a
 * `default` account is always seeded, so there is nothing to branch the whole
 * block on. Absence is rendered **per field**, and the statistics **shrink**
 * rather than fill with dashes: four dashes in the densest block of the page
 * would apply the absence rule where it has no subject — a field that does not
 * exist for this installation is not a missing value. A sentence under the head
 * names what a ledger would add.
 *
 * **The gain is computed, never read.** `portfolio_totals.gain_absolu` rides in
 * the payload and is ignored: it is the same number written down elsewhere, and
 * two producers for one figure is what the shares page spent a session
 * dismantling. The arithmetic lives in `lib/gain.ts`.
 *
 * **The gain stays alone at the top** (variant A), decided in front of the
 * board against the grid: *total value and gain side by side* fails **by
 * height** — an eight-line gain block against a three-line value block, a
 * quarter of the strip empty, and the four terms folded 3 + 1, orphaning
 * precisely the term whose subordination is the thing being bought.
 *
 * **Four icons, not nine.** ADR-0016's rule applied to the letter puts nine in
 * this one block; a total and its subordinate terms are *one* figure, so the
 * `Gain total` bubble carries the identity **and** its four terms, and the
 * terms themselves carry none. The other three go on `Versé net`, `TRI` and
 * `TWR`.
 *
 * **The year-to-date is two figures that do not touch**: the euro under the
 * head figure, the percentage filed inside the TWR statistic. Measured on the
 * real portfolio, `+40,69 €` and `−1,25 %` over the same period, of opposite
 * signs and both correct — the portfolio grew by 6 673 € of deposits while its
 * holdings lost 1,25 %. Side by side they read as a contradiction; they are
 * not one.
 *
 * **There is no range control.** The delta is fixed to year-to-date, on the
 * gain and on the time-weighted return, and **never on the money-weighted
 * one**, which is annualised from the origin and has no window to narrow.
 */
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { EmptyState } from '@/components/EmptyState'
import { Explain } from '@/components/Explain'
import { Stat } from '@/components/Stat'
import { api } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import {
  GAIN_TERMS,
  gainTotal,
  portfolioTerms,
  termCarriesSign,
  termIsRendered,
  termValue,
  type GainTermName,
} from '@/lib/gain'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { signClass } from '@/lib/sign'

const TERM_LABELS: Record<GainTermName, MessageKey> = {
  unrealised: 'gain.term.unrealised',
  realised: 'gain.term.realised',
  dividends: 'gain.term.dividends',
  transferFees: 'gain.term.transferFees',
}

export function DashboardHead() {
  const { t } = useI18n()
  const f = useFormatters()
  const positions = useQuery({ queryKey: ['positions'], queryFn: api.positions })
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: api.portfolioTotals })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })

  // A failed read is the banner's sentence, not a second one here. Two
  // announcers for one fact is the defect that appeared separately on four
  // pages of the board.
  if (!positions.data) return null

  const rows = positions.data.positions
  const totalsRow = totals.data?.totals ?? null
  const currency = positions.data.base_currency ?? totals.data?.base_currency ?? null

  // The two empties are not the same (spec #712 §6). *No events at all* is a
  // sentence and a way to the Data page — this page reads, it is not where one
  // enters. *Events, nothing held* is a **normal** page: a gain, dividends, a
  // latent gain in a dash.
  if (rows.length === 0 && totalsRow === null) {
    return (
      <EmptyState
        title={t('dashboard.empty.title')}
        description={t('dashboard.empty.body')}
        action={
          <Link to="/donnees" className="font-medium underline underline-offset-4">
            {t('dashboard.empty.link')}
          </Link>
        }
      />
    )
  }

  const terms = portfolioTerms(rows, totalsRow?.transfer_fees ?? null)
  const total = gainTotal(terms)

  const ytdGain = totalsRow?.ytd?.gain ?? null
  const ytdTwr = totalsRow?.ytd?.twr ?? null
  // Base 100 leaves this page (there is nothing to compare here): the reader is
  // shown the move itself, `+102,89 %`, and the index stays the store's unit.
  const twrMove = totalsRow?.twr_index === null || totalsRow?.twr_index === undefined
    ? null
    : (totalsRow.twr_index - 100) / 100

  const accountCount = accounts.data?.accounts.length ?? 0

  return (
    <div className="space-y-6">
      {/* The head, and the gain alone in it. */}
      <Stat
        size="head"
        label={t('dashboard.gainTotal')}
        value={total === null ? ABSENT : f.currency(total, currency)}
        valueClassName={signClass(total)}
        explain={
          <Explain
            figure={t('dashboard.gainTotal')}
            body="dashboard.gainTotal.explain"
            anchor="total-gain"
          />
        }
      >
        {totalsRow === null ? null : (
          <p className="text-sm text-muted-foreground">
            {ytdGain === null
              ? // The one figure the rebuild degrades, and it says which figure
                // and why — the head above it is exact from the first cycle.
                `${ABSENT} — ${t('dashboard.ytd.pending')}`
              : t('dashboard.ytd.gain', { amount: f.signedCurrency(ytdGain, currency) })}
          </p>
        )}
      </Stat>

      {/* The four terms, on their own row and never on the head's. */}
      <div className="flex flex-wrap gap-x-10 gap-y-4 border-t pt-4">
        {GAIN_TERMS.map((term) => {
          const value = termValue(terms, term)
          if (!termIsRendered(term, value)) return null
          return (
            <Stat
              key={term}
              size="term"
              label={t(TERM_LABELS[term])}
              value={value === null ? ABSENT : f.currency(value, currency)}
              // Colour only where the sign can turn. A dividend received is
              // never negative and a transfer fee never positive; painting them
              // steals the signal from the red of a realised loss. An absent
              // value keeps the grey of absence whatever the term.
              valueClassName={
                value === null
                  ? signClass(null)
                  : termCarriesSign(term)
                    ? signClass(value)
                    : signClass(0)
              }
            />
          )
        })}
      </div>

      {/* The statistics, on a third row — and only the ones that exist. */}
      <div className="flex flex-wrap gap-x-10 gap-y-4 border-t pt-4">
        {totalsRow?.total_value == null ? null : (
          <Stat
            label={t('dashboard.totalValue')}
            value={f.currency(totalsRow.total_value, currency)}
          />
        )}
        {totalsRow?.net_contributed == null ? null : (
          <Stat
            label={t('dashboard.netContributed')}
            value={f.currency(totalsRow.net_contributed, currency)}
            explain={
              <Explain
                figure={t('dashboard.netContributed')}
                body="dashboard.netContributed.explain"
                anchor="deposit-fees"
              />
            }
          />
        )}
        {totalsRow?.xirr == null ? null : (
          <Stat
            label={t('dashboard.xirr')}
            value={t('dashboard.xirr.value', { percent: f.percent(totalsRow.xirr) })}
            explain={
              <Explain figure={t('dashboard.xirr')} body="dashboard.xirr.explain" anchor="xirr" />
            }
          />
        )}
        {twrMove === null ? null : (
          <Stat
            label={t('dashboard.twr')}
            value={f.percent(twrMove)}
            explain={
              <Explain figure={t('dashboard.twr')} body="dashboard.twr.explain" anchor="twr" />
            }
          >
            {/* The base date rides the origin scalar **only while it moves**.
                Once the reconstruction is done the base stops moving, and a
                date that never changes again is not news. */}
            {runtime.data?.rebuilding && totalsRow?.twr_since ? (
              <p className="text-xs text-muted-foreground">
                {t('dashboard.twr.since', { date: f.date(totalsRow.twr_since) })}
              </p>
            ) : null}
            {/* The other half of the year-to-date pair. The sentence that
                explains its absence is written once, under the head. */}
            <p className="text-sm text-muted-foreground">
              {ytdTwr === null ? ABSENT : t('dashboard.twr.ytd', { percent: f.percent(ytdTwr) })}
            </p>
          </Stat>
        )}
      </div>

      {/* The consolidated figures name their perimeter — and at N = 1 the link
          disappears of itself, the accounts page having left the navigation. */}
      <p className="text-sm text-muted-foreground">
        {accountCount > 1 ? (
          <Link to="/comptes" className="underline underline-offset-4">
            {t('dashboard.scope', { count: accountCount })}
          </Link>
        ) : (
          t('dashboard.scope', { count: accountCount })
        )}
      </p>

      {totalsRow === null ? (
        <p className="max-w-prose text-sm text-muted-foreground">{t('dashboard.withoutLedger')}</p>
      ) : null}
    </div>
  )
}
