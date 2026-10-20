/**
 * One account, read in depth.
 *
 * What eight columns could never hold: the value and the cash under it, the gain
 * and the money-weighted rate as pills, the curve, the dividends and fees this
 * account has paid, the lines it holds and the last events that name it. It
 * reads like the dashboard's head (#1277): the value is the page's one hero, on
 * the ground, and only the reassignment — a decision — is a card.
 *
 * Five things are decisions rather than layout:
 *
 *  The rule the control exists to keep is about **several spans read side by
 *  side** — one account's ancient volatility setting the scale for every other
 *  — and it lands on the dashboard's accounts card, which is the surface that
 *  compares accounts. Here there is one series on one axis, so the defect has
 *  no subject and the control was buying a choice at the price of a second
 *  announcer for *how did this period go*. What stands at the head instead is
 *  the annualised IRR (#1112), the one rate on the screen: it runs from the
 *  account's origin, so it has no window to narrow, and the TWR is said inside
 *  its bubble rather than beside it.
 *  - **The head is one row of one read** (#970). The gain it announces is the
 *    payload's `gain_absolu`, beside the value and the contribution it is the
 *    difference of, which is what makes the subtraction printed on that line
 *    true. It was re-summed from the four terms — an identity rather than a
 *    decomposition somebody has to trust — and the four terms come off a
 *    *second* endpoint, so the identity was true of the formulas and false of
 *    the page: one scrape between the page's two requests and the head
 *    contradicted both its own subtraction and the rail beside it.
 *  - **Dividends are promoted, not recomputed.** The block reads the very term
 *    the block above decomposes — one arithmetic, rendered at two altitudes —
 *    because *what has this account paid me* is the one term that answers a
 *    question on its own, and reading it out of a sum is not answering it.
 *  - **A block waiting on a read renders nothing at all, title included**, and
 *    a block with nothing in it does not exist (#724). The two are the same
 *    absence on screen and they are not the same fact: the first is `null`, the
 *    second is a landed payload with no row in it.
 *  - **Every figure that rests on a convention carries its own bubble, and none
 *    is repeated.** One icon per figure and per surface — there is no prose on
 *    this page explaining its own rules.
 */
import { useId, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Pencil } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { AccountCurve } from '@/features/accounts/components/AccountCurve'
import { Refusal } from '@/components/Refusal'
import { Unreadable } from '@/components/Unreadable'
import { Explain } from '@/components/Explain'
import { PILL, SignedFigure } from '@/components/FigurePill'
import { Stat } from '@/components/Stat'
import { ShareBar } from '@/components/ShareBar'
import { TYPE_LABEL } from '@/features/data/components/LedgerTable'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Section } from '@/components/ui/section'
import { renderFigure } from '@/lib/absence'
import {
  accountColour,
  accountEvents,
  accountPositions,
  declaredLabel,
  degradedReason,
  distinctSymbols,
  dividendPayers,
  onContributed,
  valueSeries,
  DEFAULT_ACCOUNT_LABEL,
  type AccountRow,
  type DegradedReason,
  type Reassignment as ReassignmentOffer,
} from '@/features/accounts/lib/accounts'
import { accountsApi, type PerfPoint } from '@/features/accounts/lib/api'
import type { LedgerEvent } from '@/features/data/lib/api'
import type { Position } from '@/features/shares/lib/api'
import type { Advisory } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { portfolioTerms, termAmount, termRendering } from '@/lib/gain'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { FIELDS, identityOf } from '@/features/data/lib/ledger'
import { problemSentence } from '@/lib/problem'
import {
  buildShareRows,
  heldRows,
  marketValue,
  placedValue,
  unrealisedRatio,
  weightRendering,
  weightShare,
} from '@/features/shares/lib/shares'
import { signClass } from '@/lib/sign'
import type { ReadFailure } from '@/lib/status'
import { cn } from '@/lib/utils'

const REASON_LABELS: Record<DegradedReason, MessageKey> = {
  withoutCashLedger: 'accounts.reason.withoutCashLedger',
  rebuilding: 'accounts.reason.rebuilding',
  empty: 'accounts.reason.empty',
}

/**
 * **Every row of the detail is full** (#1277). The members present share it
 * equally and an absent one gives its share to the others, so a block that has
 * nothing to say never leaves a hole. `grid-cols-1` is not decoration: with a
 * column named at `lg` alone the implicit track below it is `auto`, so one long
 * event label took the column past the width of a phone
 * (`lint/grid-base-columns.grit`).
 */
const FULL_ROW = 'grid grid-cols-1 gap-5 lg:grid-flow-col lg:auto-cols-fr'

/**
 * The advisory the open account wears beside its name, **as a chip and never as
 * a gesture** (#829).
 *
 * An advisory is read twice: here, beside the figure it comments on, which is
 * the **reading**; and in the notifications panel, which is the **inventory**.
 * What the chip never offers is the acknowledgement — one fact cannot propose
 * two different gestures depending on where it is met, so the gesture belongs
 * to the panel and to the panel alone.
 *
 * `null` is *the read has not landed*, and it draws nothing: a chip is a claim
 * about the reader's own account. An empty array is an answer — this
 * portfolio has nothing to say about itself — and draws nothing either, which
 * is the same rendering for two different truths and legitimately so: an
 * absent chip asserts nothing at all.
 */
function cashShare(advisories: readonly Advisory[] | null, account: string): number | null {
  const found = (advisories ?? []).find(
    (advisory) => advisory.kind === 'cash_share' && advisory.detail.account === account,
  )
  const share = found === undefined ? null : Number(found.detail.share)
  return share === null || !Number.isFinite(share) ? null : share
}

interface AccountDetailProps {
  row: AccountRow
  /**
   * The whole payload's rows, or **`null` while the read has not landed** —
   * which is not the same shape as *the payload is empty*, and the difference is
   * three blocks. `?? []` here summed three terms over nothing and printed them
   * as zeros beside a fourth read off the account row. The head is no longer
   * among them (#970) — it is made of the account row alone and waits on
   * nothing — but the dividends, the composition and the lines all are.
   */
  positions: readonly Position[] | null
  /** The whole ledger, or **`null` while that read is in flight**. */
  events: readonly LedgerEvent[] | null
  /**
   * The account's own perf series, whole, or **`null` while its read is in
   * flight**. Whole is also what is drawn since #833: there is no window to cut
   * it to any more, the detail having no range control.
   */
  points: readonly PerfPoint[] | null
  currency: string | null
  /** Whether the reconstruction is still running. `null` — not observed yet. */
  rebuilding: boolean | null
  /**
   * What this portfolio says about itself, or `null` while the read is in
   * flight. The detail wears the one about **its** account, as a chip.
   */
  advisories: readonly Advisory[] | null
  /**
   * The standing offer to move the events nobody assigned onto a declared
   * account (#725), or `none` where there is nothing to move — which is what
   * the detail of every account but the seeded one gets.
   */
  reassignment: ReassignmentOffer
  /**
   * **The reads above that refused**, one entry per read, `null` when it
   * answered or is still in flight (#829).
   *
   * The two are not the same news and the difference is what the reader is
   * owed: in flight a block is simply not there yet and claims nothing, refused
   * it is not coming and the block says so **in its own place**. There is no
   * band at the top of the page to say it on the block's behalf any more — and
   * one condition for the three reads would have taken a detail that had two of
   * them off the screen to report the third.
   */
  failures?: {
    positions?: ReadFailure | null
    points?: ReadFailure | null
    events?: ReadFailure | null
  }
  /**
   * The account's rank in the bar, which is the index of its hue on the
   * identity wheel (`accountColour`). Passed rather than derived: the wheel is
   * the *bar's* order, and a block deriving its own would drift from it.
   */
  hue: number
  /** Renaming, and removing — the panel the pencil beside the name opens. */
  onEdit: () => void
}

export function AccountDetail({
  row,
  positions,
  events,
  points,
  currency,
  rebuilding,
  advisories,
  reassignment,
  failures = {},
  hue,
  onEdit,
}: AccountDetailProps) {
  const { t } = useI18n()
  const f = useFormatters()
  // The detail is a **landmark named by the account it is about**, which is what
  // a reader jumping past the bar lands on and what says, without a colour,
  // which of the bar's chips is open.
  const heading = useId()

  const name = declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)
  const reason = degradedReason(row, rebuilding)
  const cash = cashShare(advisories, row.id)

  // **Every derivation below is memoised, and against the reads themselves.**
  // The series is some two and a half thousand days long and the ledger is the
  // whole of it, so clicking a range preset — or opening a bubble, which is a
  // state of this component — must not replay them. TanStack Query hands back a
  // stable array while the entry is cached, so the identity of the payload is
  // the honest key and no hand-built stamp is needed here.
  //
  // The four terms, and the three that come off the positions, wait together
  // with the block that renders them: three zeros beside a real fourth term is a
  // head that contradicts itself, not a head that is loading.
  const held = useMemo(
    () => (positions === null ? null : accountPositions(positions, row.id)),
    [positions, row.id],
  )
  const terms = useMemo(
    () => (held === null ? null : portfolioTerms(held, row.transfer_fees)),
    [held, row.transfer_fees],
  )
  // What the dividends are worth against the net contribution — the maquette's
  // *sur versé*, one arithmetic shared with the fees below (`onContributed`).
  const dividendsOnContributed =
    terms === null ? null : onContributed(termAmount(terms, 'dividends'), row.net_contributed)
  // And what the broker took, against that same denominator — the drawing's
  // *x % du versé*. Signed negative in the store, read here as a share, so its
  // magnitude is what the sentence carries.
  const feesOnContributed = onContributed(row.transfer_fees ?? null, row.net_contributed)
  // The time-weighted rate, said inside the IRR's bubble (#1112). Stored as an
  // index on 100, read as a move — the dashboard's own arithmetic.
  const twr =
    row.twr_index === null || row.twr_index === undefined ? null : (row.twr_index - 100) / 100

  // **The whole series, and no window at all** (#833). The curve is drawn over
  // the account's own history from end to end: there is no control to ask for
  // less, and its legend states the extent rather than leaving it implied.
  //
  const curve = useMemo(() => (points === null ? [] : valueSeries(points)), [points])

  const lines = useMemo(
    () => (held === null ? null : heldRows(buildShareRows(held, new Map()))),
    [held],
  )
  const symbols = held === null ? 0 : distinctSymbols(held)
  // The whole the weight of each line divides — the shares page's own three
  // functions, read here for the first time. They shipped with #791 and outlived
  // the column that read them, which is why they are the ones called rather than
  // a division written again in this file.
  const placed = lines === null ? 0 : placedValue(lines)
  // **Every position of the account**, closed ones included: a line that was
  // sold kept the dividends it paid while it was held, which is the sentence the
  // encashed figure one card up already carries.
  const payers = useMemo(() => (held === null ? null : dividendPayers(held)), [held])
  const last = useMemo(
    () => (events === null ? null : accountEvents(events, row.id)),
    [events, row.id],
  )

  // The row exists only if one of its two members does — an empty grid would
  // still cost the 20 px between sections.
  const hasPayers = payers !== null && payers.length > 0
  const hasEvents = last === null ? Boolean(failures.events) : last.length > 0
  const hasActivity = hasPayers || hasEvents

  return (
    <section aria-labelledby={heading} className="space-y-5">
      {/* **Réaffecter, jamais refuser** (#725). It sits above the figures and
          not under them: an owner who ran a month before declaring anything has
          their whole ledger under this row, and what they came for is the way
          out — not this account's composition. It is the one card left on the
          page, because it asks for a decision. */}
      {reassignment.kind === 'standing' ? <Reassignment offer={reassignment} /> : null}

      {/* **The head sits on the ground, not in a card** (#1277, DESIGN.md): the
          value, its pills and the curve are the page's first object without a
          box to say so, exactly as on the dashboard. `mb-10` doubles the page's
          20 px rhythm, so the first section stands 40 px off the figures row,
          the one large gap the layout allows there. The section carries the
          name through `aria-labelledby`, so a detail whose figures are still in
          flight is not a region with no name at all. */}
      <div className="mb-10">
        <div className="flex flex-wrap items-center gap-2">
          {/* The heading is the **name alone**: it is the accessible name of the
              whole detail (`aria-labelledby`), and a region called *Alpha ·
              CTO* names a thing nobody calls that. The kind identifier rides
              beside it as ordinary text, which is where a screen reader reads
              it after the heading rather than inside it. */}
          <h2 id={heading} className="label">
            {name}
          </h2>
          <span className="label">· {row.id}</span>
          {/* **The gesture is a pencil beside the name**, where it was the name
              itself. One control for one gesture: a heading that is also a
              button reads as a link to somewhere. */}
          <button
            type="button"
            aria-label={t('accounts.detail.edit')}
            onClick={onEdit}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:-m-2.5 pointer-coarse:size-11"
          >
            <Pencil aria-hidden className="size-3.25" />
          </button>
          {/* The advisory, **read beside its figure and offering nothing**
              (#829). It says what the panel's card says in one line; what it
              does not carry is the acknowledgement. */}
          {cash === null ? null : (
            <span className="shrink-0 rounded-md bg-attention/14 px-1.5 py-0.5 text-2xs font-medium text-attention">
              {t('accounts.advisory.cash', { share: cash })}
            </span>
          )}
        </div>

        {/* **The head waits on nothing** (#970). Its figures — the value, the
            contribution, the gain and the IRR — are members of **one**
            `account_metrics` row, so there is no second read for them to be a
            scrape apart from. The curve below still waits on its own read: a
            read that has not answered costs its own half and never the other. */}
        <Stat
          size="head"
          label={t('accounts.figure.totalValue')}
          // A value is not a direction: it is set in the colour of text, and the
          // sign lives on the pills under it.
          value={f.currency(row.total_value, currency)}
        >
          {/* What of the value is cash, and what was paid in: the two figures it
              is a change of and made of, on one line and a rung down. The cash
              is a balance, not a direction — no sign colour, `0` is a figure. */}
          <p className="text-sm text-muted-foreground">
            {/* The cash waits for the unit it is said in: the sentence names an
                amount, and *dont 500,00 de liquidités* over a read that has not
                landed would be a bare number in a sentence. */}
            {row.cash_balance === null || currency === null
              ? null
              : t('accounts.cashLine', { amount: f.currency(row.cash_balance, currency) })}
            {row.cash_balance === null || currency === null ? null : ' · '}
            <span role="group" aria-label={t('accounts.figure.netContributed')}>
              {t('accounts.figure.netContributed')}{' '}
              <span className="tabular text-foreground">
                {f.currency(row.net_contributed, currency)}
              </span>
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span role="group" aria-label={t('accounts.figure.gain')} className={PILL}>
              {/* The figure and its words are two nodes: the unit follows the
                  totals read, and a sentence composed around a bare amount
                  would be said, for a moment, about a figure with no unit. */}
              <SignedFigure
                amount={row.gain_absolu}
                text={f.signedCurrency(row.gain_absolu, currency)}
              />
              <span className="text-muted-foreground">{t('accounts.gain.pill')}</span>
              <Explain
                figure={t('accounts.figure.gain')}
                body="accounts.detail.gainTotal.explain"
                anchor="total-gain"
              />
            </span>
            {/* **The one rate on this screen, the annualised IRR** (#1112). The
                TWR went into its bubble, which says why the two differ: three
                rates on one head read as three answers to one question. A null
                IRR keeps its pill, with the em dash. */}
            <span role="group" aria-label={t('accounts.figure.xirr')} className={PILL}>
              <span className="text-muted-foreground">{t('accounts.figure.xirr')}</span>
              <SignedFigure amount={row.xirr} text={f.percent(row.xirr)} />
              {row.xirr == null ? null : (
                <span className="text-xs font-normal text-muted-foreground">
                  {t('accounts.xirr.unit')}
                </span>
              )}
              {twr === null ? (
                <Explain
                  figure={t('accounts.figure.xirr')}
                  body="accounts.xirr.explain"
                  anchor="xirr"
                />
              ) : (
                <Explain
                  figure={t('accounts.figure.xirr')}
                  body="accounts.xirr.explainTwr"
                  values={{ explain: t('accounts.xirr.explain'), twr: f.percent(twr) }}
                  anchor="xirr"
                />
              )}
            </span>
          </div>
        </Stat>

        {/* The curve, full width under the pills. Nothing at all while the
            series is in flight, and the reason in its place where the read
            refused. The legend states the extent it was drawn over, which is the
            account's whole history: a curve with no stated span beside a total
            is the unbounded-window failure in miniature. */}
        {points === null ? (
          failures.points ? (
            <div className="mt-6">
              <Unreadable failure={failures.points} />
            </div>
          ) : null
        ) : curve.length === 0 ? null : (
          <div className="mt-6">
            <AccountCurve points={curve} currency={currency} />
          </div>
        )}

        {/* The reason a detail has no figures — a **reason**, never a progress
            with a target date. */}
        {reason === null ? null : (
          <p className="mt-4 text-sm text-attention">{t(REASON_LABELS[reason])}</p>
        )}

        {/* **The secondary figures, one row on the Figure rung** (#1277):
            dividends received, fees paid and the projected tax. **The whole row
            waits on the positions** — the dividends and the tax are derived
            from them, and a tax beside a gain the page is still refusing to
            state would be a figure derived from nothing. In flight the row does
            not exist (#724); refused, it says why, once, across the row. */}
        {terms === null ? (
          failures.positions ? (
            <div data-row="figures" className={cn(FULL_ROW, 'mt-6 border-t pt-5')}>
              <Unreadable failure={failures.positions} />
            </div>
          ) : null
        ) : (
          <div data-row="figures" className={cn(FULL_ROW, 'mt-6 border-t pt-5')}>
            <Stat
              size="figure"
              label={t('accounts.detail.dividends')}
              explain={
                <Explain
                  figure={t('accounts.detail.dividends.encashed')}
                  body="accounts.detail.dividends.explain"
                  anchor="dividends"
                />
              }
              // **In the plain foreground** (#1283). A figure nobody signs
              // carries no hue: a colour would say *which way it went*, and the
              // sign of this one is fixed by its nature.
              value={renderFigure(
                termRendering(terms, 'dividends'),
                () => f.currency(termAmount(terms, 'dividends'), currency),
                t,
              )}
            >
              {/* A **rate on the denominator this page already has**: the
                  contribution at the head is what the ratio beside it divides,
                  so the dividends divide it too rather than acquiring a base of
                  their own. */}
              <p
                role="group"
                aria-label={t('accounts.detail.dividends.onContributed')}
                className="flex items-baseline gap-1.5 text-xs text-muted-foreground"
              >
                <span>{t('accounts.detail.dividends.onContributed')}</span>
                <span className="tabular">
                  {dividendsOnContributed === null
                    ? ABSENT
                    : f.percentPoints(dividendsOnContributed * 100)}
                </span>
              </p>
            </Stat>

            {/* Dropped at **zero and only at zero**: an install whose transfers
                are free reads no fee term and never learns it exists. `null` is
                a different sentence — the server has no day to bound the fees
                by — and it renders, as a dash, because a total that goes out
                incomplete owes the reader the cause under it (#775). */}
            {row.transfer_fees === 0 ? null : (
              <Stat
                size="figure"
                label={t('accounts.figure.fees')}
                value={f.currency(row.transfer_fees ?? null, currency)}
              >
                {feesOnContributed === null ? null : (
                  <p className="tabular text-xs text-muted-foreground">
                    {t('accounts.figure.feesOnContributed', {
                      percent: f.percentPoints(Math.abs(feesOnContributed) * 100),
                    })}
                  </p>
                )}
              </Stat>
            )}

            <ProjectedTax row={row} currency={currency} />
          </div>
        )}
      </div>

      {/* Three sections, and the page's one rhythm between them: 20 px. A block
          with nothing in it does not exist (#724). */}
      {lines === null || lines.length === 0 ? null : (
        <div data-row="holdings" className={FULL_ROW}>
          <Section
            level={3}
            title={t('accounts.detail.lines')}
            aside={
              <span
                role="group"
                aria-label={t('accounts.figure.holdings')}
                className="tabular text-2xl font-semibold"
              >
                {f.currency(row.holdings_value, currency)}
              </span>
            }
          >
            {/* **Four columns and a header row** (#838). The weight's bar is
                what makes the column readable at a glance rather than a fourth
                figure to compare by arithmetic. Under `md` the bar's column is
                what goes, the two figures being the ones a phone came for. */}
            <div
              aria-hidden
              className="flex items-center gap-4 border-b pb-1.5 text-xs text-muted-foreground"
            >
              <span className="min-w-0 flex-1">{t('shares.column.symbol')}</span>
              <span className="hidden w-30 shrink-0 md:block lg:w-45">
                {t('accounts.detail.lines.weight')}
              </span>
              <span className="w-23 shrink-0 text-right lg:w-27.5">{t('shares.column.value')}</span>
              <span className="w-15.5 shrink-0 text-right lg:w-20">
                {t('shares.column.unrealised')}
              </span>
            </div>
            <ul aria-label={t('accounts.detail.lines')}>
              {lines.map((line) => {
                const ratio = unrealisedRatio(line)
                const share = weightShare(line, placed)
                return (
                  <li
                    key={line.symbol}
                    className="flex items-center gap-4 border-b py-2.5 text-sm last:border-0"
                  >
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="min-w-0 truncate font-medium">
                        {line.name ?? line.symbol}
                      </span>
                      {line.name === null ? null : (
                        <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                          {line.symbol}
                        </span>
                      )}
                    </span>
                    {/* Bar and figure together — the bar is `aria-hidden`
                        because the percentage is written beside it, which is
                        `ShareBar`'s own rule (#800). The word that says *which*
                        percentage it is has to be announced, the row carrying
                        two others. */}
                    <span className="hidden w-30 shrink-0 items-center gap-2.5 md:flex lg:w-45">
                      <span className="sr-only">{t('accounts.detail.lines.weight')}</span>
                      <ShareBar
                        share={share}
                        className="min-w-0 flex-1"
                        fill={accountColour(hue)}
                      />
                      <span className="tabular w-11 shrink-0 text-right text-xs text-muted-foreground">
                        {renderFigure(
                          weightRendering(line, placed),
                          // `?? 0` is never reached: `weightRendering` answers
                          // `figure` on exactly the rows where `weightShare`
                          // answers a number, which is the whole reason the two
                          // are one pair in `features/shares/lib/shares.ts`.
                          () => f.percentPoints((share ?? 0) * 100),
                          t,
                        )}
                      </span>
                    </span>
                    <span className="tabular w-23 shrink-0 text-right lg:w-27.5">
                      {f.currency(marketValue(line), currency)}
                    </span>
                    <span
                      className={cn(
                        'tabular w-15.5 shrink-0 text-right text-xs lg:w-20',
                        signClass(ratio),
                      )}
                    >
                      {ratio === null ? ABSENT : f.percent(ratio)}
                    </span>
                  </li>
                )
              })}
            </ul>
            {/* The reduction is a URL, so it survives a reload and can be
                handed to somebody else — and it counts what that page counts:
                symbols, closed lines included, since it folds them there. */}
            <Link
              to="/shares"
              search={{ account: row.id }}
              className="mt-2 inline-block text-xs text-primary underline underline-offset-4"
            >
              {t('accounts.detail.lines.link', { count: symbols })}
            </Link>
          </Section>
        </div>
      )}

      {/* The payers and the latest events share one row, and each takes the
          whole row when the other is absent (`FULL_ROW`). */}
      {!hasActivity ? null : (
        <div data-row="activity" className={FULL_ROW}>
          {/* **Which lines pay the dividends** — the question the encashed figure
            raises and cannot answer (#833). Nothing at all while the positions
            are in flight, and no block where no line has ever paid. */}
          {payers === null || payers.length === 0 ? null : (
            <Section
              level={3}
              title={t('accounts.detail.payers')}
              aside={<span className="label">{t('accounts.detail.payers.period')}</span>}
            >
              <ul aria-label={t('accounts.detail.payers')} className="divide-y divide-border/60">
                {payers.map((payer) => (
                  <li key={payer.symbol} className="flex flex-col gap-1 py-2 text-sm">
                    <span className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate font-medium">{payer.symbol}</span>
                      <span className="tabular shrink-0">{f.currency(payer.amount, currency)}</span>
                      <span className="tabular w-16 shrink-0 text-right text-muted-foreground">
                        {f.percentPoints(payer.share * 100)}
                      </span>
                    </span>
                    <ShareBar
                      share={payer.share}
                      fill="color-mix(in oklab, var(--foreground) 70%, transparent)"
                    />
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {last === null ? (
            failures.events ? (
              <Unreadable failure={failures.events} />
            ) : null
          ) : last.length === 0 ? null : (
            <Section level={3} title={t('accounts.detail.events')}>
              <ul aria-label={t('accounts.detail.events')} className="divide-y divide-border/60">
                {last.map((event, index) => (
                  <li
                    key={event.id ?? `${event.date}-${index}`}
                    className="flex items-baseline justify-between gap-3 py-2 text-sm"
                  >
                    {/* **What it is about, then what it is.** The type alone read
                      as *Versement · Versement · Retrait* down the block, three
                      rows saying nothing about which security or which transfer
                      — the ledger's own identity column is what discriminates,
                      here as there (`identityOf`). */}
                    <span className="min-w-0">
                      <span className="block truncate">{eventName(event) ?? ABSENT}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t(TYPE_LABEL[event.event_type])} · {f.date(event.date)}
                      </span>
                    </span>
                    {/* The field the **type** declares, and never a total composed
                      out of the others: a purchase states a quantity and a
                      transfer an amount, so the one that is a figure of the row
                      is the one rendered — and the two do not share a
                      rendering. `× 0,1661` beside `10,20 €` is a quantity; a
                      bare `0,1661` in the same column is read as money. */}
                    <span className="tabular shrink-0">
                      {FIELDS[event.event_type].amount ? (
                        f.currency(event.amount, currency)
                      ) : (
                        <span className="text-muted-foreground">
                          {`\u00d7\u00a0${f.quantity(event.quantity)}`}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {/* Reduced onto this account, exactly as the holdings reduce onto
                it: a detail owes its reader *more of what this block is
                showing*, and the whole ledger is a different page about a
                different subject. The reduction is a URL, so it survives a
                reload and can be handed to somebody else. */}
              <Link
                to="/ledger"
                search={{ account: row.id }}
                className="mt-3 inline-block text-sm font-medium underline underline-offset-4"
              >
                {t('accounts.detail.events.link')}
              </Link>
            </Section>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * What the account would owe if it were emptied today — the third term of the
 * figures row (#919, #1277).
 *
 * **Every account carrying a model gets it; only an account carrying none is
 * silent** (D11). Sending `none`, `withholding_income` and a dateless aged
 * wrapper to the same blank as *never answered* would make a declaration
 * indistinguishable from its absence — and the sentence that says why a
 * modelless account is silent is raised once, as an advisory, in the place
 * built for saying it.
 *
 * It sits on the Figure rung with the two measured facts beside it, and a
 * projection never outranks a measurement: the caveat is the first thing under
 * it, in body text.
 */
function ProjectedTax({ row, currency }: { row: AccountRow; currency: string | null }) {
  const { t } = useI18n()
  const f = useFormatters()
  if (row.taxation_kind === undefined) return null

  const label = t('accounts.detail.projectedTax')
  // **Visible body text, never an `Explain` bubble** (D13). A bubble opens on
  // click and nothing else, and every bubble in this product explains a
  // convention behind a number the reader can otherwise trust. Here, not
  // clicking costs the entire epistemic status of the figure: `Impôt projeté
  // 4 168,95 €` reads as a fact.
  //
  // A model that taxes something else says what it taxes, in its own words —
  // the catalogue already holds one sentence per kind, and a second copy here
  // would drift.
  const sentence =
    row.taxation_kind === 'none' || row.taxation_kind === 'withholding_income'
      ? t(`taxation.kind.${row.taxation_kind}.assessed`)
      : t('accounts.detail.projectedTax.caveat')

  // **No figure at all where the model taxes something else** (D11). An empty
  // `role="group"` is a named region announcing nothing, which is worse than the
  // absence it was standing in for: the term carries this model's own sentence.
  if (row.taxation_kind === 'withholding_income') {
    return (
      <div className="min-w-0 space-y-1">
        <span className="label text-muted-foreground">{label}</span>
        <p className="text-xs text-muted-foreground">{sentence}</p>
      </div>
    )
  }

  const rates = row.projected_rates
  const ratesName = t(
    rates !== undefined && rates.length > 1
      ? 'accounts.detail.projectedTax.rates'
      : 'accounts.detail.projectedTax.rate',
  )
  return (
    <Stat
      size="figure"
      label={label}
      value={
        row.taxation_kind === 'none'
          ? f.currency(0, currency)
          : row.projected_tax === undefined
            ? ABSENT
            : f.currency(row.projected_tax, currency)
      }
    >
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>{sentence}</p>
        {/* The kink, which is the most interesting thing the arithmetic knows
            and is otherwise invisible: an owner three months from their PEA's
            fifth anniversary would see one number with no hint it is about to
            fall.

            **And the sentence names the calendar it is on** (#952). The day is
            the server's, decided against the UTC day; `f.date` renders it in the
            reader's own locale, and the two disagree by the reader's offset once
            in a wrapper's life — on precisely the day its owner would look.
            Naming the boundary is what makes both readings true rather than
            contradictory: the hours are the offset, and the reader can place
            them. */}
        {row.projected_rate_changes_on === undefined ? null : (
          <p>
            {t('accounts.detail.projectedTax.changesOn', {
              day: f.date(row.projected_rate_changes_on),
            })}
          </p>
        )}
        {/* **The footing names the rate that produced the figure** (D14). The
            record ships no rate, so the reader learns which one theirs is; a
            ladder has no single rate to name and the footing names its rungs
            instead. The levy is folded in — it applies on both sides of an aged
            threshold, and naming the income rate alone would contradict the
            figure above on a mature PEA.

            **And the base the rate was applied to**, because the head states a
            `Gain` that is a different quantity: latent *plus* realised,
            dividends and fees. Multiply the rate by the gain above and you miss
            by a factor of three on a real account. */}
        {rates === undefined ? null : (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            {row.projected_base === undefined ? null : (
              <span role="group" aria-label={t('accounts.detail.projectedTax.base')}>
                {t('accounts.detail.projectedTax.base')}{' '}
                <span className="tabular text-foreground">
                  {f.currency(row.projected_base, currency)}
                </span>
              </span>
            )}
            <span role="group" aria-label={ratesName}>
              {ratesName}{' '}
              <span className="tabular text-foreground">
                {rates.map((rate) => f.percentPoints(rate * 100)).join(' · ')}
              </span>
            </span>
          </div>
        )}
      </div>
    </Stat>
  )
}

/** The row's own name — the ticker where there is one, the label otherwise. */
function eventName(event: LedgerEvent): string | null {
  const identity = identityOf(event)
  return identity.ticker ?? identity.label
}

/**
 * The standing half of the reassignment (#725).
 *
 * The other half rides **inside** the first declaration, where there is no list
 * of accounts to choose from yet. This one needs no file at all to be reached
 * — events typed into the app before anything was declared land
 * under the seeded row, and the declaration that follows does not claim them —
 * so it stands on its own, with the declared accounts as its targets.
 *
 * **No correspondence layer**: what crosses the wire is one target id, and the
 * population is the `account` column's own value. A `default → pea` map beside
 * the events would be a second truth about the account an event names.
 */
function Reassignment({ offer }: { offer: Extract<ReassignmentOffer, { kind: 'standing' }> }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const heading = useId()
  const move = useMutation({
    mutationFn: (id: string) => accountsApi.reassignEvents(id),
    // The whole cache: what account an event names moves every page's grouping,
    // not just this block's count.
    onSuccess: () => void queryClient.invalidateQueries(),
  })

  // A select of one entry is a question whose answer is already known — the rule
  // `accountChoice` states for the event form, applied to the one control here.
  const only = offer.targets.length === 1 ? offer.targets[0].id : ''
  const [target, setTarget] = useState('')
  const chosen = target || only

  return (
    // A **named landmark**, like the removal block one file over: it is the
    // thing the bar's link leads to, and a block a reader is sent to has to be
    // one they — and a test — can take hold of by its name. `Card` ships a
    // `div`, so the role is stated rather than inherited from a `<section>`.
    <Card role="region" aria-labelledby={heading}>
      <CardHeader>
        <h3 id={heading} className="text-sm font-medium">
          {t('accounts.reassign.title')}
        </h3>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="max-w-prose text-sm text-muted-foreground">
          {t('accounts.reassign.body', { count: offer.count })}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label htmlFor="reassign-target" className="text-sm font-medium">
              {t('accounts.reassign.target')}
            </label>
            <select
              id="reassign-target"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              value={chosen}
              onChange={(changed) => setTarget(changed.target.value)}
            >
              {/* Absent where there is one account: the empty entry is what
                    makes a choice a choice, and there is none to make. */}
              {offer.targets.length === 1 ? null : (
                <option value="">{t('accounts.reassign.choose')}</option>
              )}
              {offer.targets.map((account) => (
                <option key={account.id} value={account.id}>
                  {declaredLabel(account) ?? account.id}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            disabled={chosen === '' || move.isPending}
            onClick={() => move.mutate(chosen)}
          >
            {t('accounts.reassign.submit')}
          </Button>
        </div>
        {move.error ? <Refusal>{problemSentence(t, move.error)}</Refusal> : null}
      </CardContent>
    </Card>
  )
}
