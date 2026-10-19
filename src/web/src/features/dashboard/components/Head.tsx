/**
 * The head of the dashboard.
 *
 * **One head, no discriminated union.** `MODE_MULTI_CURRENCY` is dead and a
 * `default` account is always seeded, so there is nothing to branch the whole
 * block on. Absence is rendered **per field**, and a field that does not exist
 * for this installation is left out rather than dashed: it is not a missing
 * value. A sentence under the head names what a ledger would add.
 *
 * **A read that fails is named by whoever is empty because of it, not here**
 * (#799, then #829). The head keeps its figures in every one of those cases,
 * which is the property both tickets bought.
 *
 * **The block reads nothing of its own** since the same ticket. The four reads
 * it renders are the page's, handed down as props, and the two shapes that can
 * be *not answered yet* cross the boundary as `readonly X[] | null` — never as
 * `[]`.
 *
 * **The gain is computed, never read.** `portfolio_totals.gain_absolu` rides in
 * the payload and is ignored: it is the same number written down elsewhere, and
 * two producers for one figure is what the shares page spent a session
 * dismantling. The arithmetic lives in `lib/gain.ts`. `Valeur totale` and
 * `Titres` follow it rather than the pass (#1049), so the head reads one instant.
 *
 * **The value is the hero, and the gain is its subtitle** (dashboard redesign,
 * direction 1a). The page answers *how much is my portfolio worth* first: the
 * value is the one figure at hero size, the gain total is a pill under it
 * beside the year's, the day's and the IRR's (#1149, #1174), and the four
 * terms the gain is the
 * sum of left the head for a card of their own (`GainBreakdown.tsx`). That
 * reverses variant A, which kept the gain alone at the top — and it is the same
 * argument read the other way round: the terms were subordinated by size, and
 * they are subordinated by distance now, which a reader cannot sum by accident
 * either.
 *
 * **The chart is under the hero, across its full width** (`HeroChart.tsx`,
 * dashboard grid 17A / D25, 11/10/2026), handed in by the page as `chart`: the
 * block still reads nothing of its own. It was a 64 px sparkline on the
 * right with the real chart in a dialog (#1099, direction 1a); the real chart
 * is now on the page, and the dialog is gone.
 *
 * **The IRR is the last pill** (#1149, DESIGN.md › The hero): the one
 * performance figure (#1112) sits beside the value, not a screen below it on a
 * phone.
 *
 * **The year-to-date is two figures that do not touch**: the euro is the
 * second pill (#1174), the percentage inside the IRR's bubble, with the TWR it
 * belongs to — two groups apart.
 * Measured on the real portfolio, `+40,69 €` and `−1,25 %` over the same
 * period, of opposite signs and both correct — the portfolio grew by 6 673 € of
 * deposits while its holdings lost 1,25 %. Side by side they read as a
 * contradiction; they are not one.
 *
 * **There is no range control.** The delta is fixed to year-to-date, on the
 * gain and on the time-weighted return, and **never on the money-weighted
 * one**, which is annualised from the origin and has no window to narrow.
 *
 * That *the same figure* is load-bearing rather than decorative: the day's move
 * is the movement of `gain_absolu` over one day (`features/dashboard/lib/dashboard.ts`), which is
 * `_ytd`'s own definition over another window — so the day's pill and the
 * year's pill answer one question twice and never two questions once.
 *
 * The series it reduces is the chart's, read once by the page under the chart's
 * own condition and therefore costing no request of its own: one read, two
 * consumers.
 */
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

import { EmptyState } from '@/components/EmptyState'
import { Explain } from '@/components/Explain'
import { PILL, Period, SignedFigure } from '@/components/FigurePill'
import { RecomposingFigure } from '@/components/RecomposingFigure'
import { Stat } from '@/components/Stat'
import type { PerfPoint } from '@/features/accounts/lib/api'
import type { PortfolioTotalsResponse } from '@/features/dashboard/lib/api'
import type { PositionsResponse } from '@/features/shares/lib/api'
import type { RuntimeState } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { renderFigure } from '@/lib/absence'
import { gainTotal, portfolioTerms, sumRendering } from '@/lib/gain'
import { dayMove, heroReading, unpricedLines } from '@/features/dashboard/lib/dashboard'
import { useI18n } from '@/lib/i18n'

interface DashboardHeadProps {
  /**
   * The two reads the block is **made of**, `null` while either is in flight —
   * or while one of them has failed, in which case the page renders its own
   * empty state instead of this block and names the failure there (#829).
   */
  positions: PositionsResponse | null
  totals: PortfolioTotalsResponse | null
  /**
   * This process's own state. `null` — nothing says yet. It decides whether the
   * newest row is today's, and whether the reconstruction is running (#1260).
   */
  runtime: RuntimeState | null
  /**
   * The portfolio's series — the chart's own read, shared rather than asked for
   * twice. `null` and never `[]`: a series that has not answered is not a day
   * on which nothing moved, and the pill it feeds is then simply not drawn.
   */
  history: readonly PerfPoint[] | null
  /**
   * The portfolio's chart and its range control, under the value and its
   * pills — composed by the page, which owns the range. `null` draws the value
   * alone.
   */
  chart?: ReactNode
}

export function DashboardHead({
  positions,
  totals,
  runtime,
  history,
  chart = null,
}: DashboardHeadProps) {
  const { t } = useI18n()
  const f = useFormatters()

  // **A read that has not landed is not a fact**, and the two the block *needs*
  // are waited for together. Absence of data with no error is the first load,
  // and it is not a state to write a sentence about — but the sentences below
  // are written about `totals` as much as about `positions`, so letting one land
  // first turns *not arrived yet* into a statement: `totals.data?.totals ?? null`
  // put *« un grand livre d'événements datés ajouterait… »* under a portfolio
  // that has one, for as long as the second request took, and then swapped the
  // headline for a different number. The two optional reads below are not in
  // this rule: their absence removes a line rather than falsifying one.
  if (!positions || !totals) return null

  const rows = positions.positions
  const totalsRow = totals.totals
  const currency = positions.base_currency ?? totals.base_currency ?? null

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
          <div className="flex flex-col items-center gap-2">
            <Link to="/ledger" className="font-medium underline underline-offset-4">
              {t('dashboard.empty.link')}
            </Link>
            {/* Quieter than the way on, and a gesture rather than a predicate
                (#1262): it opens the first-run walk and decides nothing. */}
            <Link
              to="/"
              search={{ open: 'first-run' }}
              className="rounded-sm text-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
            >
              {t('dashboard.empty.resume')}
            </Link>
          </div>
        }
      />
    )
  }

  // **A row from a past day is not the value** (#1260). During the rebuild a
  // held line with no close caps the series the day before its acquisition, so
  // the newest row is a day of cash alone, and nothing here can move it to now.
  const reading = totalsRow === null ? 'valued' : heroReading(totalsRow, runtime, new Date())
  const valued = reading === 'valued'
  const rebuilding = runtime?.rebuilding ?? null

  const terms = portfolioTerms(rows, totalsRow?.transfer_fees ?? null)
  const total = gainTotal(terms)

  // **The head is on one instant** (#1049). The gain is priced by the scrape,
  // the totals row by the last perf pass, and between two passes the identity
  // a reader checks by hand — *value − contributed = gain* — failed by whatever
  // the market moved since. The row defines `gain_absolu` as exactly that
  // difference (`performance.py`), so the live gain less it is the market's
  // move since the pass — and a market move moves the securities, never the
  // cash or the contribution, which change only with an event and an event
  // reruns the pass. The move is added to the row's own value, so nothing
  // is read from one snapshot and subtracted from another. A gain the head
  // cannot compute moves nothing: the row's figures then agree with nothing on
  // screen they could contradict.
  const drift =
    total.known && totalsRow?.total_value != null && totalsRow.net_contributed != null
      ? totalsRow.net_contributed + total.value - totalsRow.total_value
      : 0
  const totalValue = totalsRow?.total_value == null ? null : totalsRow.total_value + drift
  // The securities are read only where there is no value, and so no drift.
  const holdingsValue = totalsRow?.holdings_value ?? null
  // **The hero is the value, and on an install with no cash ledger the value
  // is the securities' alone** (#708: `total_value` is `NULL` there, and
  // `holdings_value` is written always). It is then said under its own name —
  // *Titres* — rather than as the portfolio's value, which it is not, and the
  // cash line under it has nothing to name.
  const heroIsHoldings = totalValue === null && holdingsValue !== null
  const heroValue = totalValue ?? holdingsValue

  const ytdGain = totalsRow?.ytd?.gain ?? null
  const ytdTwr = totalsRow?.ytd?.twr ?? null
  // `ytd` **absent** and a `ytd` **member** absent are two pieces of news, and
  // the server says so in two shapes on purpose (`build_portfolio_totals`: *an
  // unwritable member stays a null member inside a present object*). Read
  // through `?.` alone the two collapse, and the sentences below — which are
  // about a history not rebuilt that far back — get printed for a figure that
  // simply is not computable on this install. Since #708 that is not a corner
  // case: an install with no cash event has a `twr_index` of `NULL` for ever,
  // so the collapse would make the sentence permanent.
  const ytdAbsent = (totalsRow?.ytd ?? null) === null
  // `ytd: null` has **two** causes and they are not the same sentence (#763):
  // the reconstruction has not reached January, **or** the portfolio is younger
  // than the year — a first event in March, and no day on or before
  // 31 December exists for the delta to count from. Written as one sentence,
  // the app announced a reconstruction to somebody who has nothing to
  // reconstruct. It is the exact defect `totals: null` had one resource up, and
  // the discriminant is already read: `runtime.rebuilding`. No fourth kind of
  // absence is invented for it and no field is added to any payload.
  //
  // The second sentence needs a **positive** observation, which is #709's rule
  // about the third answer applied here: a runtime read that has not landed —
  // or one that failed — says nothing about this process, and *your ledger does
  // not go back that far* is a claim about the reader's own data, not one to
  // make on silence. So absence keeps the rebuild's sentence, which names
  // something the app is doing and is repaired by waiting.
  const ytdPending = t(
    rebuilding === false ? 'dashboard.ytd.noPreviousYear' : 'dashboard.ytd.pending',
  )
  // Base 100 leaves this page and the mock-up's `TWR 202,89 (+102,9 %)` with it.
  // An index on base 100 is an instrument for putting two series side by side,
  // and this page has one; `+102,89 %` carries the same information in the unit
  // the reader thinks in. Where the index earns its place is the accounts page
  // (#721), which compares — and there it comes with the rebasing rule, since
  // two indices counted from different origins share a unit without being a
  // comparison. The index stays the store's own.
  const twrMove =
    totalsRow?.twr_index == null || totalsRow.twr_since == null
      ? null
      : (totalsRow.twr_index - 100) / 100

  // A read that has not landed, or one that failed, means the perimeter is
  // *unknown*, and an unknown perimeter is not written down at all: the figures
  // above it are exact either way.

  // The series reaches here as `readonly PerfPoint[] | null` and the `null` is
  // load-bearing: a series that has not answered is not a day on which nothing
  // moved.
  const today = dayMove(history, new Date())
  const unpriced = reading === 'partial' ? unpricedLines(rows) : []

  return (
    // **The hero sits on the ground, not in a card** (DESIGN.md): the value,
    // its pills and the curve are the page's first object without a box to
    // say so, and the gradient that used to say *start here* went with the
    // card. `mb-5` doubles the page's 20 px rhythm, so the hero stands 40 px
    // off the first section, the one large gap the layout allows there.
    <div className="mb-5">
      <div>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <Stat
            size="head"
            label={t(heroIsHoldings && valued ? 'dashboard.holdings' : 'dashboard.portfolioValue')}
            // A value is not a direction: it is set in the colour of text, and
            // the sign lives on the pills under it. It recomposes when a poll
            // moves it (#1180); the pills under it change instantly. Keyed by
            // what it measures: the value and the securities are two figures,
            // and one never recomposes into the other.
            value={
              valued ? (
                <RecomposingFigure
                  key={heroIsHoldings ? 'holdings' : 'portfolio'}
                  value={heroValue}
                  currency={currency}
                />
              ) : (
                // An empty plane of the figure's height (#795): no skeleton,
                // no spinner. Another key, so the figure that replaces it
                // mounts and shows at once instead of recomposing from nothing.
                <span key="unvalued" aria-hidden className="invisible">
                  &nbsp;
                </span>
              )
            }
          >
            {reading === 'partial' ? (
              <div className="max-w-prose space-y-1 text-sm text-muted-foreground">
                <p>
                  {runtime?.reconstruction
                    ? t('dashboard.rebuilding.progress', runtime.reconstruction)
                    : t('dashboard.rebuilding.progressUnobserved')}
                </p>
                {unpriced.length === 0 ? null : (
                  <p>
                    {t('dashboard.rebuilding.unpriced', {
                      lines: f.list(unpriced),
                    })}
                  </p>
                )}
              </div>
            ) : null}
            {!valued ? null : (
              <>
                {/* What of the value is cash (#1174), right under it. It takes no
                drift (#1151), and it is a balance, not a direction: no sign
                colour, even below zero; `0` is a figure, not an absence. */}
                {totalsRow?.cash_balance == null || heroIsHoldings ? null : (
                  <p className="text-sm text-muted-foreground">
                    {t('dashboard.cashLine', {
                      amount: f.currency(totalsRow.cash_balance, currency),
                    })}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {/* The gain is the value's subtitle now, and it keeps its named
                  absences (#775): a rate on its way is said, a fourth term
                  nothing can bound is the em dash. */}
                  {total.known ? (
                    <Period
                      amount={total.value}
                      text={t('dashboard.gain.pill', {
                        amount: f.signedCurrency(total.value, currency),
                      })}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t('dashboard.gain.pillAbsent', {
                        reason: renderFigure(sumRendering(total), () => '', t),
                      })}
                    </p>
                  )}
                  {/* The year's gain, in euros (#1174). Its percentage stays in the
                  IRR's bubble — a group apart. The one figure the rebuild
                  degrades, and it says why: a reason does not fit in a pill. A
                  `ytd` present with a null `gain` is not computable here and
                  draws nothing. */}
                  {totalsRow === null ? null : ytdGain !== null ? (
                    <Period
                      amount={ytdGain}
                      text={t('dashboard.ytd.pill', {
                        amount: f.signedCurrency(ytdGain, currency),
                      })}
                    />
                  ) : ytdAbsent ? (
                    <p className="text-sm text-muted-foreground">
                      {t('dashboard.ytd.pillAbsent', { reason: ytdPending })}
                    </p>
                  ) : null}
                  {/* The day's **period of the total**, and it stays with it. */}
                  {totalsRow === null || today === null ? null : (
                    <Period
                      amount={today}
                      text={t('dashboard.day.gain', {
                        amount: f.signedCurrency(today, currency),
                      })}
                    />
                  )}
                  {totalsRow?.xirr == null ? null : (
                    <span role="group" aria-label={t('dashboard.xirr')} className={PILL}>
                      <span className="text-muted-foreground">{t('dashboard.xirr')}</span>
                      <SignedFigure amount={totalsRow.xirr} text={f.percent(totalsRow.xirr)} />
                      <span className="text-xs font-normal text-muted-foreground">
                        {t('dashboard.xirr.unit')}
                      </span>
                      {/* The TWR lives here since #1112: one rate per screen, and the
                      bubble is where the second one says why it differs. */}
                      {twrMove === null ? (
                        <Explain
                          figure={t('dashboard.xirr')}
                          body="dashboard.xirr.explain"
                          anchor="xirr"
                        />
                      ) : (
                        <Explain
                          figure={t('dashboard.xirr')}
                          body="dashboard.xirr.explainTwr"
                          values={{
                            explain: t('dashboard.xirr.explain'),
                            twr: f.percent(twrMove),
                            since: f.date(totalsRow.twr_since),
                            ytd:
                              ytdTwr === null
                                ? ''
                                : t('dashboard.xirr.explainTwr.ytd', {
                                    percent: f.percent(ytdTwr),
                                  }),
                          }}
                          anchor="xirr"
                        />
                      )}
                    </span>
                  )}
                </div>
              </>
            )}
          </Stat>
        </div>

        {chart === null ? null : <div className="mt-6">{chart}</div>}

        {/* `totals: null` has **two** causes and they are not the same sentence
        (#745): no ledger at all, or a reporting currency nobody has answered.
        The second is the ordinary one here — reaching this line at all means
        positions exist, so a ledger exists — and it is the actionable one: the
        perf job writes nothing until the dial is answered (#702), every figure
        it computes being money. Written as one sentence, the app told a reader
        with a full portfolio that they had no ledger. */}
        {totalsRow === null ? (
          <p className="max-w-prose text-sm text-muted-foreground">
            {currency === null ? t('dashboard.awaitingCurrency') : t('dashboard.withoutLedger')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
