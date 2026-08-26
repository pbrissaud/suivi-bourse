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
 * **A read that fails is named by whoever is empty because of it, not here**
 * (#799, then #829). The band used to be mounted in this block and rendered
 * *instead* of it, which was right for the two reads the head is made of and
 * wrong for every other read on the page: a `/api/positions/history` that failed
 * would have wiped the total gain and its four terms to say so. #799 moved it a
 * step up, above both tracks; ADR-0037 removed the strip altogether, and the
 * sentence went down instead of up — the page renders its own empty state when
 * the two reads *it* is made of refuse, and each other block carries the reason
 * its own read did (`pages/DashboardPage.tsx`). The head keeps its figures in
 * every one of those cases, which is the property both tickets bought.
 *
 * **The block reads nothing of its own** since the same ticket. The five reads
 * it renders are the page's, handed down as props, and the two shapes that can
 * be *not answered yet* cross the boundary as `readonly X[] | null` — never as
 * `[]` (ADR-0026).
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
 * **The year-to-date is two figures that do not touch**: the euro on a pill
 * beside the head figure, the percentage filed inside the TWR statistic. Measured on the
 * real portfolio, `+40,69 €` and `−1,25 %` over the same period, of opposite
 * signs and both correct — the portfolio grew by 6 673 € of deposits while its
 * holdings lost 1,25 %. Side by side they read as a contradiction; they are
 * not one.
 *
 * **There is no range control.** The delta is fixed to year-to-date, on the
 * gain and on the time-weighted return, and **never on the money-weighted
 * one**, which is annualised from the origin and has no window to narrow.
 *
 * **And since #790 the head is a card, with the two periods of the total in
 * it.** *Today* and *since 1 January* are the same figure over two other
 * windows, so they stay **with** the total and never join the row of four:
 * mounted there they would read as two more things to add, which is the exact
 * addition ADR-0018's subordination exists to prevent. That *the same figure*
 * is load-bearing rather than decorative: the day's move is the movement of
 * `gain_absolu` over one day (`lib/dashboard.ts`), which is `_ytd`'s own
 * definition over another window — so the two pills answer one question twice
 * and never two questions once.
 *
 * The series it reduces is the chart's, read once by the page under the chart's
 * own condition and therefore costing no request of its own: one read, two
 * consumers.
 */
import { Link } from '@tanstack/react-router'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

import { EmptyState } from '@/components/EmptyState'
import { Explain } from '@/components/Explain'
import { Stat } from '@/components/Stat'
import { Card, CardContent } from '@/components/ui/card'
import type { Account, PerfPoint, PortfolioTotalsResponse, PositionsResponse } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { renderFigure } from '@/lib/absence'
import {
  GAIN_TERMS,
  gainTotal,
  portfolioTerms,
  sumRendering,
  termAmount,
  termCarriesSign,
  termIsRendered,
  termRendering,
  type GainTermName,
} from '@/lib/gain'
import { dayMove } from '@/lib/dashboard'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { signClass, signOf, type Sign } from '@/lib/sign'
import { cn } from '@/lib/utils'

const TERM_LABELS: Record<GainTermName, MessageKey> = {
  unrealised: 'gain.term.unrealised',
  realised: 'gain.term.realised',
  dividends: 'gain.term.dividends',
  transferFees: 'gain.term.transferFees',
}

export interface DashboardHeadProps {
  /**
   * The two reads the block is **made of**, `null` while either is in flight —
   * or while one of them has failed, in which case the page renders its own
   * empty state instead of this block and names the failure there (#829).
   */
  positions: PositionsResponse | null
  totals: PortfolioTotalsResponse | null
  /**
   * The perimeter the consolidated figures name. `null` is *unknown*, and an
   * unknown perimeter is not written down at all (ADR-0026).
   */
  accounts: readonly Account[] | null
  /** Whether the reconstruction is running. `null` — nothing says yet. */
  rebuilding: boolean | null
  /**
   * The portfolio's series — the chart's own read, shared rather than asked for
   * twice. `null` and never `[]`: a series that has not answered is not a day
   * on which nothing moved, and the pill it feeds is then simply not drawn.
   */
  history: readonly PerfPoint[] | null
}

export function DashboardHead({
  positions,
  totals,
  accounts,
  rebuilding,
  history,
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
  // `ytd` **absent** and a `ytd` **member** absent are two pieces of news, and
  // the server says so in two shapes on purpose (`build_portfolio_totals`: *an
  // unwritable member stays a null member inside a present object*). Read
  // through `?.` alone the two collapse, and the sentences below — which are
  // about a history not rebuilt that far back — get printed for a figure that
  // simply is not computable on this install. Since #708 that is not a corner
  // case: an install with no cash event has a `twr_index` of `NULL` for ever,
  // so the collapse would make the sentence permanent. An absent member takes
  // the bare em dash, which by ADR-0016 says *there is nothing to compute* —
  // the truth about a time-weighted return with no cash ledger under it.
  const ytdAbsent = (totalsRow?.ytd ?? null) === null
  const ytdAbsence = (member: number | null) =>
    member === null && ytdAbsent ? `${ABSENT} — ${ytdPending}` : ABSENT
  // `ytd: null` has **two** causes and they are not the same sentence (#763):
  // the reconstruction has not reached January, **or** the portfolio is younger
  // than the year — a first event in March, and no day on or before
  // 31 December exists for the delta to count from. Written as one sentence,
  // the app announced a reconstruction to somebody who has nothing to
  // reconstruct. It is the exact defect `totals: null` had one resource up, and
  // the discriminant is already on screen: `runtime.rebuilding`, which the TWR
  // statistic consumes below for its base date. No fourth kind of absence is
  // invented for it (ADR-0021) and no field is added to any payload.
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

  // **Not `?? 0`.** ADR-0013 seeds a `default` row that is never removed, so
  // there is always at least one account and `0 compte` is a state the product
  // declares impossible — printed, as it was, under the consolidated figures as
  // the statement of their perimeter. A read that has not landed, or one that
  // failed, means the perimeter is *unknown*, and an unknown perimeter is not
  // written down at all: the figures above it are exact either way.
  const accountCount = accounts?.length ?? null

  // The series reaches here as `readonly PerfPoint[] | null` and the `null` is
  // load-bearing: a series that has not answered is not a day on which nothing
  // moved (ADR-0026).
  const today = dayMove(history, new Date())

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
    // midnight value would not (ADR-0023).
    <Card className="gap-0 border-border/60 bg-linear-160 from-accent to-card to-60%">
      <CardContent className="space-y-6">
        {/* **The total and its terms, side by side and never at equal weight.**
            ADR-0016 is amended in its wording and not in its rule (#787): what
            it refuses is four numeric columns of the *same* weight, where
            nothing says the last three are inside the first — the twelve-column
            table it was measured on. Subordination is a **size** as much as a
            position, and `head` against `term` is a factor of three: read here,
            nobody adds the four to the one. What the ADR buys is that the
            reader cannot sum them by accident, and this arrangement buys it. */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <Stat
            size="head"
            label={t('dashboard.gainTotal')}
            // Unknown here has **two** causes since #775 and they read apart: a
            // held position whose rate has not resolved is *named*, because the app
            // repairs it by itself, while a fourth term nothing can bound wears the
            // em dash — a total amputated of a term is not that total (ADR-0018),
            // and *there is nothing to compute* is the truth about it. That second
            // one is also what `totals: null` now produces on a portfolio that has
            // positions: the headline goes out, and the sentence at the foot of the
            // block says why.
            value={renderFigure(
              sumRendering(total),
              () => f.currency(total.known ? total.value : null, currency),
              t,
            )}
            valueClassName={signClass(total.known ? total.value : null)}
            explain={
              <Explain
                figure={t('dashboard.gainTotal')}
                body="dashboard.gainTotal.explain"
                anchor="total-gain"
              />
            }
          >
            {/* The two **periods of the total**, and they stay with it. */}
            {totalsRow === null ? null : (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {today === null ? null : (
                  <Period
                    amount={today}
                    text={t('dashboard.day.gain', { amount: f.signedCurrency(today, currency) })}
                  />
                )}
                {ytdGain === null ? (
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
            )}
          </Stat>

          {/* Two by two, so the four read as a block beside the total and not
              as a row under it: at two columns the eye takes them as one
              object. Below `md` they fall under it and the rule comes back —
              side by side is a statement the width has to be able to make. */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 border-t pt-4 md:border-0 md:pt-0">
            {GAIN_TERMS.map((term) => {
              const value = termAmount(terms, term)
              if (!termIsRendered(term, value)) return null
              return (
                <Stat
                  key={term}
                  size="term"
                  label={t(TERM_LABELS[term])}
                  value={renderFigure(
                    termRendering(terms, term),
                    () => f.currency(value, currency),
                    t,
                  )}
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
        </div>

        {/* The statistics, on a row of their own — and only the ones that
            exist. They are **not** terms of the total: `Valeur totale` and
            `Versé net` are what the gain is the difference of, and the two rates
            are not sums at all, so they keep the full width the four do not.

            **A row that spreads rather than one that packs left.** `flex
            flex-wrap` put a fixed gap between the figures and left the rest of
            the card empty — invisible while the content column was capped at
            1 280 px, and the whole right half of the card since #792 uncapped it
            (ADR-0022, amended). `auto-fit` collapses the tracks nothing fills,
            so the figures that **do** exist share the width whatever their
            number. The floor is **8rem and not 9**, measured: at 9 the five
            statistics came to more than the card holds and the row wrapped four
            and one. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-x-6 gap-y-4 border-t pt-4">
          {totalsRow?.total_value == null ? null : (
            <Stat
              label={t('dashboard.totalValue')}
              value={f.currency(totalsRow.total_value, currency)}
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
          {totalsRow?.holdings_value == null ? null : (
            <Stat
              label={t('dashboard.holdings')}
              value={f.currency(totalsRow.holdings_value, currency)}
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
                  anchor="net-contributed"
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
              {rebuilding && totalsRow?.twr_since ? (
                <p className="text-xs text-muted-foreground">
                  {t('dashboard.twr.since', { date: f.date(totalsRow.twr_since) })}
                </p>
              ) : null}
              {/* The other half of the year-to-date pair — and it degrades the
                  same way, sentence included. The two are **deliberately** far
                  apart (they read as a contradiction side by side), so a reader
                  looking at this one never sees the caption written under the
                  other: a bare dash here says, by the product's own rule, *there
                  is nothing to compute*, when what is going on is a history not
                  yet rebuilt that far — nameable and repairable. */}
              <p className="text-sm text-muted-foreground">
                {ytdTwr === null
                  ? ytdAbsence(ytdTwr)
                  : t('dashboard.twr.ytd', { percent: f.percent(ytdTwr) })}
              </p>
            </Stat>
          )}
        </div>

        {/* The consolidated figures name their perimeter — and at N = 1 the link
            disappears of itself, the accounts page having left the navigation. */}
        {accountCount === null ? null : (
          <p className="text-sm text-muted-foreground">
            {accountCount > 1 ? (
              <Link to="/comptes" className="underline underline-offset-4">
                {t('dashboard.scope', { count: accountCount })}
              </Link>
            ) : (
              t('dashboard.scope', { count: accountCount })
            )}
          </p>
        )}

        {/* `totals: null` has **two** causes and they are not the same sentence
            (#745): no ledger at all, or a reporting currency nobody has answered.
            The second is the ordinary one here — reaching this line at all means
            positions exist, so a ledger exists — and it is the actionable one:
            the perf job writes nothing until the dial is answered (#702), every
            figure it computes being money. Written as one sentence, the app told
            a reader with a full portfolio that they had no ledger. The condition
            is read where ADR-0021 says it is stated, the head's `currency` being
            `null`, and no fourth kind of absence is invented for it. */}
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
 * and these two are the head's figure seen through another window. Mounted as
 * statistics they join a row of things to add, which is the reading ADR-0018's
 * subordination exists to prevent; mounted as pills beside the headline they
 * read as what they are.
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
        'tabular inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium',
        PERIOD_TONES[sign],
      )}
    >
      {Arrow === null ? null : <Arrow className="size-3" aria-hidden />}
      {text}
    </span>
  )
}
