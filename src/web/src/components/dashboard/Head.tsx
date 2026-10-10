/**
 * The head of the dashboard.
 *
 * **One head, no discriminated union.** `MODE_MULTI_CURRENCY` is dead and a
 * `default` account is always seeded, so there is nothing to branch the whole
 * block on. Absence is rendered **per field**, and the statistics **shrink**
 * rather than fill with dashes: four dashes in the densest block of the page
 * would apply the absence rule where it has no subject — a field that does not
 * exist for this installation is not a missing value. A sentence under the head
 * names what a ledger would add.
 *
 * **A read that fails is named by whoever is empty because of it, not here**
 * (#799, then #829). The head keeps its figures in every one of those cases,
 * which is the property both tickets bought.
 *
 * **The block reads nothing of its own** since the same ticket. The five reads
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
 * beside the day's and the year's, and the four terms the gain is the sum of
 * left the head for a card of their own (`GainBreakdown.tsx`). That reverses
 * variant A, which kept the gain alone at the top — and it is the same
 * argument read the other way round: the terms were subordinated by size, and
 * they are subordinated by distance now, which a reader cannot sum by accident
 * either.
 *
 * **The chart is the hero's right-hand side** (`HeroChart.tsx`), handed in by
 * the page as `aside`: the block still reads nothing of its own.
 *
 * **The year-to-date is two figures that do not touch**: the euro on a pill
 * beside the head figure, the percentage inside the IRR's bubble, with the TWR
 * it belongs to (#1112: one performance figure per screen, and it is the IRR).
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
 * is the movement of `gain_absolu` over one day (`lib/dashboard.ts`), which is
 * `_ytd`'s own definition over another window — so the two pills answer one
 * question twice and never two questions once.
 *
 * The series it reduces is the chart's, read once by the page under the chart's
 * own condition and therefore costing no request of its own: one read, two
 * consumers.
 */
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

import { EmptyState } from '@/components/EmptyState'
import { Explain } from '@/components/Explain'
import { Stat } from '@/components/Stat'
import { Card, CardContent } from '@/components/ui/card'
import type { PerfPoint, PortfolioTotalsResponse, PositionsResponse } from '@/lib/api'
import {
  declaredLabel,
  DEFAULT_ACCOUNT_LABEL,
  projectedTaxTotal,
  type AccountRow,
} from '@/lib/accounts'
import { ABSENT, useFormatters } from '@/lib/format'
import { renderFigure } from '@/lib/absence'
import { gainTotal, portfolioTerms, sumRendering } from '@/lib/gain'
import { dayMove } from '@/lib/dashboard'
import { useI18n } from '@/lib/i18n'
import { signClass, signOf, type Sign } from '@/lib/sign'
import { cn } from '@/lib/utils'

interface DashboardHeadProps {
  /**
   * The two reads the block is **made of**, `null` while either is in flight —
   * or while one of them has failed, in which case the page renders its own
   * empty state instead of this block and names the failure there (#829).
   */
  positions: PositionsResponse | null
  totals: PortfolioTotalsResponse | null
  /** Whether the reconstruction is running. `null` — nothing says yet. */
  rebuilding: boolean | null
  /**
   * The portfolio's series — the chart's own read, shared rather than asked for
   * twice. `null` and never `[]`: a series that has not answered is not a day
   * on which nothing moved, and the pill it feeds is then simply not drawn.
   */
  history: readonly PerfPoint[] | null
  /**
   * The accounts, for the net-of-tax line under the hero (#1112). `null` while
   * the read is in flight or when it failed: the line is then not drawn, and
   * the hero above it is exact either way.
   */
  accounts?: readonly AccountRow[] | null
  /**
   * What the hero carries on its right — the sparkline and the range control,
   * composed by the page, which owns the range. `null` draws the value alone.
   */
  aside?: ReactNode
}

export function DashboardHead({
  positions,
  totals,
  rebuilding,
  history,
  accounts = null,
  aside = null,
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
          <Link to="/ledger" className="font-medium underline underline-offset-4">
            {t('dashboard.empty.link')}
          </Link>
        }
      />
    )
  }

  const terms = portfolioTerms(rows, totalsRow?.transfer_fees ?? null)
  const total = gainTotal(terms)

  // **The head is on one instant** (#1049). The gain is priced by the scrape,
  // the totals row by the last perf pass, and between two passes the identity
  // a reader checks by hand — *value − contributed = gain* — failed by whatever
  // the market moved since. The row defines `gain_absolu` as exactly that
  // difference (`performance.py`), so the live gain less it is the market's
  // move since the pass — and a market move moves the securities, never the
  // cash or the contribution, which change only with an event and an event
  // reruns the pass. The move is added to the row's own two figures, so nothing
  // is read from one snapshot and subtracted from another. A gain the head
  // cannot compute moves nothing: the row's figures then agree with nothing on
  // screen they could contradict.
  const drift =
    total.known && totalsRow?.total_value != null && totalsRow.net_contributed != null
      ? totalsRow.net_contributed + total.value - totalsRow.total_value
      : 0
  const totalValue = totalsRow?.total_value == null ? null : totalsRow.total_value + drift
  const holdingsValue =
    totalsRow?.holdings_value == null ? null : totalsRow.holdings_value + drift
  // **The hero is the value, and on an install with no cash ledger the value
  // is the securities' alone** (#708: `total_value` is `NULL` there, and
  // `holdings_value` is written always). It is then said under its own name —
  // *Titres* — rather than as the portfolio's value, which it is not, and the
  // statistic of the same name below steps aside rather than repeat it.
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
  const ytdAbsence = (member: number | null) =>
    member === null && ytdAbsent ? `${ABSENT} — ${ytdPending}` : ABSENT
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
    totalsRow?.twr_index === null || totalsRow?.twr_index === undefined
      ? null
      : (totalsRow.twr_index - 100) / 100

  // A read that has not landed, or one that failed, means the perimeter is
  // *unknown*, and an unknown perimeter is not written down at all: the figures
  // above it are exact either way.

  // The series reaches here as `readonly PerfPoint[] | null` and the `null` is
  // load-bearing: a series that has not answered is not a day on which nothing
  // moved.
  const today = dayMove(history, new Date())

  // **What would be left after tax** (#1112), off the hero *as displayed*, drift
  // included, so the line always differs from the figure above it by exactly
  // the tax. An account the tax cannot be stated for is named rather than
  // counted as zero: a net that leaves a term out is a net that flatters.
  const net = accounts === null ? null : projectedTaxTotal(accounts)
  const names = (rows: readonly AccountRow[]) =>
    rows.map((row) => declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)).join(', ')
  const netLines =
    net === null || heroValue === null
      ? []
      : net.unmodelled.length === 0 && net.uncomputable.length === 0
        ? [t('dashboard.net.amount', { amount: f.currency(heroValue - net.tax, currency) })]
        : [
            ...(net.unmodelled.length === 0
              ? []
              : [t('dashboard.net.unmodelled', { accounts: names(net.unmodelled) })]),
            ...(net.uncomputable.length === 0
              ? []
              : [t('dashboard.net.uncomputable', { accounts: names(net.uncomputable) })]),
          ]

  return (
    // The hero card, and the one gradient in the product (#787): it is the
    // page's first object, so it is the one that may say *start here* without
    // another card having to compete. The ground stays `--card` and the wash
    // sits over it — a figure read against a saturated field is a figure read
    // badly.
    //
    // **It falls from the top left**, which is the maquette's own `160deg` and
    // the reverse of what shipped: `bg-gradient-to-br` piled the tint into the
    // bottom right corner, under nothing, while the figure the card exists for
    // sits at the top left. A wash is a light source, and a light source behind
    // the reader's back lights nothing.
    //
    // And it is `--accent` rather than the mint. The preset states that token as
    // *a muted raise of the ground*, which is exactly what the maquette paints
    // there — a cool lift of the surface, not a mark. Taking the mint instead
    // put a **meaning** into the chrome: it is `--gain` and `--price`, and a
    // card washed in the colour of a gain is a card that says something about
    // the figure on it. It also survives the light ground, which a hand-written
    // midnight value would not.
    <Card className="gap-0 bg-linear-160 from-chart-2/9 to-card to-55% py-7">
      <CardContent className="px-7">
        {/* **A row that wraps, and not a grid of two fixed tracks** (#838):
            the value on the left, the curve on the right, and under `sm` the
            curve goes under the pills at the full width of the card. */}
        <div className="flex flex-wrap items-end justify-between gap-6">
          <Stat
            size="head"
            label={t(heroIsHoldings ? 'dashboard.holdings' : 'dashboard.portfolioValue')}
            // A value is not a direction: it is set in the colour of text, and
            // the sign lives on the pills under it.
            value={f.currency(heroValue, currency)}
          >
            {/* Right under the value, before the pills (DESIGN.md, Atelier). */}
            {netLines.map((line) => (
              <p key={line} className="text-sm text-muted-foreground">
                {line}
              </p>
            ))}
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
              {/* The two **periods of the total**, and they stay with it. */}
              {totalsRow === null || today === null ? null : (
                <Period
                  amount={today}
                  text={t('dashboard.day.gain', { amount: f.signedCurrency(today, currency) })}
                />
              )}
              {totalsRow === null ? null : ytdGain === null ? (
                // The one figure the rebuild degrades, and it says which figure
                // and why — the head above it is exact from the first cycle. It
                // stays a **sentence** rather than a pill: what it carries is a
                // reason, and a reason does not fit in a badge.
                <p className="text-sm text-muted-foreground">{ytdAbsence(ytdGain)}</p>
              ) : (
                <Period
                  amount={ytdGain}
                  text={t('dashboard.ytd.gain', { amount: f.signedCurrency(ytdGain, currency) })}
                />
              )}
            </div>
          </Stat>

          {aside}
        </div>

        {/* The statistics, on a row of their own — and only the ones that exist.
        They are **not** terms of the gain: `Versé net` and `Titres` are what
        the value is made of, and the two rates are not sums at all. Four
        columns from `sm`, two under it; a statistic that does not exist for
        this installation leaves its slot rather than a dash in it. */}
        <div className="mt-6.5 grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4.5 sm:grid-cols-4">
          {totalsRow?.net_contributed == null ? null : (
            <Stat
              label={t('dashboard.netContributed')}
              value={f.currency(totalsRow.net_contributed, currency)}
              explain={
                <Explain
                  figure={t('dashboard.netContributed')}
                  body="dashboard.netContributed.explain"
                  anchor="net-contributed"
                />
              }
            />
          )}
          {/* The securities, beside the value they are part of — and it is the
              one money statistic an install with **no cash ledger** still has:
              `holdings_value` is written always (#708), where `total_value` and
              both returns are `NULL`. It is also what makes *events, and nothing
              held* an ordinary page rather than an empty one: `0,00 €` is a
              figure, in the colour of text, read beside the em dash of the latent
              gain — the one place in the product where the two are side by side
              at the scale of the portfolio. */}
          {holdingsValue === null || heroIsHoldings ? null : (
            <Stat
              label={t('dashboard.holdings')}
              value={f.currency(holdingsValue, currency)}
            />
          )}
          {totalsRow?.xirr == null ? null : (
            <Stat
              label={t('dashboard.xirr')}
              value={
                <>
                  {f.percent(totalsRow.xirr)}
                  <span className="text-xs font-normal text-muted-foreground">
                    {' '}
                    {t('dashboard.xirr.unit')}
                  </span>
                </>
              }
              valueClassName={signClass(totalsRow.xirr)}
              explain={
                // The TWR lives here since #1112: one rate per screen, and the
                // bubble is where the second one says why it differs.
                twrMove === null ? (
                  <Explain figure={t('dashboard.xirr')} body="dashboard.xirr.explain" anchor="xirr" />
                ) : (
                  <Explain
                    figure={t('dashboard.xirr')}
                    body="dashboard.xirr.explainTwr"
                    values={{
                      explain: t('dashboard.xirr.explain'),
                      twr: f.percent(twrMove),
                      ytd:
                        ytdTwr === null
                          ? ''
                          : t('dashboard.xirr.explainTwr.ytd', { percent: f.percent(ytdTwr) }),
                    }}
                    anchor="xirr"
                  />
                )
              }
            />
          )}
        </div>

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
      </CardContent>
    </Card>
  )
}

/**
 * One **period of the total** — today, or since 1 January.
 *
 * A pill and not a statistic, deliberately: a `Stat` is a figure of its own,
 * and these two are the head's figure seen through another window.
 *
 * **It is tinted by its sign, and it carries the arrow of that sign** (#831,
 * the maquette's own pill). The neutral chip it used to be — a hairline border
 * on `bg-background/60`, with the sign in the text colour alone — put the two
 * periods in the chrome of the card rather than in the family of the figure
 * above them, and left the sign said **once**, in colour. The tint is the
 * figure's own token at a twelfth, so the pill stays a ground and never a mark;
 * the arrow is the redundant encoding that makes the direction legible without
 * the hue, which is the rule the allocation's ramp already answers one card
 * down. A **zero** takes neither: it is a figure, not a direction, and
 * `lib/sign.ts` is what says so.
 */
const PERIOD_TONES: Record<Sign, string> = {
  gain: 'bg-gain/12 text-gain',
  loss: 'bg-loss/12 text-loss',
  // A day that moved by nothing is a figure in the colour of text, on the
  // card's own muted ground — never the grey of absence, which it is not.
  zero: 'bg-muted text-foreground',
  absent: 'bg-muted text-muted-foreground',
}

function Period({ amount, text }: { amount: number; text: string }) {
  const sign = signOf(amount)
  const Arrow = sign === 'gain' ? ArrowUpRight : sign === 'loss' ? ArrowDownRight : null
  return (
    <span
      className={cn(
        'tabular inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm font-medium',
        PERIOD_TONES[sign],
      )}
    >
      {Arrow === null ? null : <Arrow className="size-3" aria-hidden />}
      {text}
    </span>
  )
}
