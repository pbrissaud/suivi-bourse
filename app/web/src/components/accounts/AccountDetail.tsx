/**
 * One account, read in depth (ADR-0028, ADR-0018, ADR-0019, ADR-0016).
 *
 * What eight columns could never hold: the gain over its four terms, the split
 * between securities and cash, the money-weighted rate, the dividends this
 * account has actually paid, the lines it holds and the last events that name
 * it. As columns they were never going to fit — ADR-0019 had already noted that
 * at three accounts the table's naming problem returns — and as a panel they
 * were behind a click.
 *
 * Five things are decisions rather than layout:
 *
 *  - **No range control, and the head figure is a ratio rather than a rate**
 *    (#833, ADR-0028 corrected). The detail carried a copy of ADR-0019's control
 *    driving a windowed time-weighted rate; the maquette this page takes its
 *    form from defines its range presets and renders them nowhere, and the
 *    correction is not a matter of taste. The rule the control exists to keep is
 *    about **several spans read side by side** — one account's ancient
 *    volatility setting the scale for every other — and it lands on the
 *    dashboard's accounts card, which is the surface that compares accounts.
 *    Here there is one series on one axis, so the defect has no subject and the
 *    control was buying a choice at the price of a second announcer for *how did
 *    this period go*. What stands at the head instead is `Performance totale`,
 *    `gain ÷ versé net` — cumulative, of the same family as the *sur versé*
 *    under the dividends, and covering the account's whole life so that it
 *    implies no window and needs none stated.
 *  - **The total is computed from its four terms and never read** (ADR-0018).
 *    The payload carries `gain_absolu`, which is the same number written down
 *    elsewhere; computing here is what makes the four an identity rather than a
 *    decomposition somebody has to trust.
 *  - **Dividends are promoted, not recomputed.** The block reads the very term
 *    the block above decomposes — one arithmetic, rendered at two altitudes —
 *    because *what has this account paid me* is the one term that answers a
 *    question on its own, and reading it out of a sum is not answering it.
 *  - **A block waiting on a read renders nothing at all, title included**
 *    (ADR-0026), and a block with nothing in it does not exist (#724). The two
 *    are the same absence on screen and they are not the same fact: the first is
 *    `null`, the second is a landed payload with no row in it.
 *  - **Every figure that rests on a convention carries its own bubble, and none
 *    is repeated.** One icon per figure and per surface (ADR-0016) — there is no
 *    prose on this page explaining its own rules.
 */
import { useId, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Pencil } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { AccountCurve } from '@/components/accounts/AccountCurve'
import { Refusal } from '@/components/Refusal'
import { Unreadable } from '@/components/Unreadable'
import { Explain } from '@/components/Explain'
import { ShareBar } from '@/components/ShareBar'
import { TYPE_LABEL } from '@/components/data/LedgerTable'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { renderFigure } from '@/lib/absence'
import {
  accountColour,
  accountEvents,
  accountPositions,
  declaredLabel,
  declaredType,
  degradedReason,
  distinctSymbols,
  dividendPayers,
  isDefaultAccount,
  onContributed,
  valueSeries,
  DEFAULT_ACCOUNT_LABEL,
  DEFAULT_ACCOUNT_TYPE,
  type AccountRow,
  type DegradedReason,
  type Reassignment as ReassignmentOffer,
} from '@/lib/accounts'
import { api, type LedgerEvent, type PerfPoint, type Position } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import {
  gainTotal,
  portfolioTerms,
  sumRendering,
  termAmount,
  termRendering,
} from '@/lib/gain'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { FIELDS, identityOf } from '@/lib/ledger'
import { problemSentence } from '@/lib/problem'
import {
  buildShareRows,
  heldRows,
  marketValue,
  placedValue,
  unrealisedRatio,
  weightRendering,
  weightShare,
} from '@/lib/shares'
import { signClass } from '@/lib/sign'
import type { ReadFailure } from '@/lib/status'
import { cn } from '@/lib/utils'


const REASON_LABELS: Record<DegradedReason, MessageKey> = {
  withoutCashLedger: 'accounts.reason.withoutCashLedger',
  rebuilding: 'accounts.reason.rebuilding',
  empty: 'accounts.reason.empty',
}

export interface AccountDetailProps {
  row: AccountRow
  /**
   * The whole payload's rows, or **`null` while the read has not landed** —
   * which is not the same shape as *the payload is empty*, and the difference is
   * three blocks. `?? []` here summed three terms over nothing and printed them
   * as zeros beside a fourth read off the account row, so a detail opened cold
   * announced a `Gain total` the rail beside it contradicted.
   */
  positions: readonly Position[] | null
  /** The whole ledger, or **`null` while that read is in flight** (ADR-0026). */
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
   * The standing offer to move the events nobody assigned onto a declared
   * account (#725), or `none` where there is nothing to move — which is what the
   * detail of every account but the seeded one gets. It is **here** since
   * ADR-0028 because its subject is *this account's* events: the seeded row is
   * the one carrying them, and its own detail is where its owner is looking at
   * them.
   */
  reassignment: ReassignmentOffer
  /**
   * **The reads above that refused**, one entry per read, `null` when it
   * answered or is still in flight (#829, ADR-0037).
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
   * The account's rank in the rail, which is the index of its hue on the
   * identity wheel (`accountColour`). Passed rather than derived: the wheel is
   * the *rail's* order, and a block deriving its own would drift from it.
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
  reassignment,
  failures = {},
  hue,
  onEdit,
}: AccountDetailProps) {
  const { t } = useI18n()
  const f = useFormatters()
  // The detail is a **landmark named by the account it is about**, which is what
  // a reader jumping past the rail lands on and what says, without a colour,
  // which of the rail's entries is open.
  const heading = useId()

  const name = declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)
  const type = declaredType(row) ?? (isDefaultAccount(row.id) ? t(DEFAULT_ACCOUNT_TYPE) : row.id)
  const reason = degradedReason(row, rebuilding)

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
  const total = terms === null ? null : gainTotal(terms)
  // **What this account has done, cumulatively** — `gain ÷ versé net`, the
  // maquette's `Performance totale`. The numerator is the total *computed* from
  // the four terms and never `row.gain_absolu`: the figure sits under the block
  // that decomposes it, and reading two producers for one number one card apart
  // is what would let the head and its own ratio disagree. They telescope
  // exactly, the fourth term being what closes the gap (`lib/gain.ts`), which is
  // why the rail one column over can divide `gain_absolu` and land on the same
  // percentage.
  const performance =
    total === null || !total.known ? null : onContributed(total.value, row.net_contributed)
  // What the dividends are worth against the same denominator — the maquette's
  // *sur versé*, one arithmetic shared with the figure above (`onContributed`).
  const dividendsOnContributed =
    terms === null ? null : onContributed(termAmount(terms, 'dividends'), row.net_contributed)
  // And what the broker took, against that same denominator — the drawing's
  // *x % du versé*. Signed negative in the store, read here as a share, so its
  // magnitude is what the sentence carries.
  const feesOnContributed = onContributed(row.transfer_fees ?? null, row.net_contributed)
  // The time-weighted rate the drawing puts under the annualised one. Stored as
  // an index on 100, read as a move — the dashboard's own arithmetic.
  const twr = row.twr_index === null || row.twr_index === undefined ? null : (row.twr_index - 100) / 100

  // **The whole series, and no window at all** (#833). The curve is drawn over
  // the account's own history from end to end: there is no control to ask for
  // less, and its legend states the extent rather than leaving it implied
  // (ADR-0028).
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

  return (
    <section aria-labelledby={heading} className="space-y-6">
      {/* **Réaffecter, jamais refuser** (#725). It sits above the figures and
          not under them: an owner who ran a month before declaring anything has
          their whole ledger under this row, and what they came for is the way
          out — not this account's composition. */}
      {reassignment.kind === 'standing' ? <Reassignment offer={reassignment} /> : null}

      {/* **One card at the head, and the curve is in it** (#838). The drawing
          leads an account with what it is worth, states underneath it the two
          figures that total is the difference of and what the broker took out
          of the transfers, puts the cumulative ratio at the right, and draws
          the value against the contribution *inside the same frame* — because
          the curve is that head's own reading over time and not a second
          block. What went with the split is the four-term list: the drawing
          shows the terms where they are read — the dividends have a card, the
          fees are the line under the gain, and the latent gain is a column of
          the lines table below. ADR-0018's identity is unchanged; what changed
          is that this page no longer states it twice. */}
      {/* The card itself is **not** conditional, and its name is why: it is
          what `aria-labelledby` points at, so a detail whose figures are still
          in flight would otherwise be a region with no name at all. What waits
          is each half of what it holds — the figures on the positions, the
          curve on the series — which is #799's rule kept inside one frame: a
          read that has not answered costs its own half and never the other. */}
      <Card className="gap-0 bg-linear-160 from-chart-2/8 to-card to-60% py-6">
        <CardContent className="px-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                {/* The heading is the **name alone**: it is the accessible name
                    of the whole detail (`aria-labelledby`), and a region called
                    *Alpha · CTO* names a thing nobody calls that. The kind
                    rides beside it as ordinary text, which is where the drawing
                    puts it and where a screen reader reads it after the heading
                    rather than inside it. */}
                <h2 id={heading} className="eyebrow">
                  {name}
                </h2>
                {type === null ? null : <span className="eyebrow">· {type}</span>}
                {/* **The gesture is a pencil beside the name**, where it was
                    the name itself. One control for one gesture: a heading that
                    is also a button reads as a link to somewhere, and the
                    drawing gives the editor an icon that says *edit*. */}
                <button
                  type="button"
                  aria-label={t('accounts.detail.edit')}
                  onClick={onEdit}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Pencil aria-hidden className="size-3.25" />
                </button>
              </div>

              {/* The figures wait on the positions — nothing at all while the
                  read is in flight (ADR-0026), the reason in their place where
                  it refused (#829, ADR-0037) — and the curve below waits on its
                  own read. One frame, two waits, neither costing the other. */}
              {terms === null || total === null ? (
                failures.positions ? <Unreadable failure={failures.positions} /> : null
              ) : (
                <>
                  <p
                    role="group"
                    aria-label={t('accounts.figure.totalValue')}
                    className="tabular text-5xl font-heavy tracking-tight"
                  >
                    {f.currency(row.total_value, currency)}
                  </p>
                  {/* The two figures the value is a change **of** and **by**, on
                      one line and a rung down: neither is the subject. */}
                  <p className="text-sm text-muted-foreground">
                    <span role="group" aria-label={t('accounts.figure.netContributed')}>
                      {t('accounts.figure.netContributed')}{' '}
                      <span className="tabular font-mono text-foreground">
                        {f.currency(row.net_contributed, currency)}
                      </span>
                    </span>
                    {' · '}
                    <span
                      role="group"
                      aria-label={t('accounts.figure.gain')}
                      className="inline-flex items-baseline gap-1"
                    >
                      {t('accounts.figure.gain')}
                      <Explain
                        figure={t('accounts.figure.gain')}
                        body="accounts.detail.gainTotal.explain"
                        anchor="total-gain"
                      />
                      <span
                        className={cn(
                          'tabular font-mono',
                          signClass(total.known ? total.value : null),
                        )}
                      >
                        {renderFigure(
                          sumRendering(total),
                          () => f.currency(total.known ? total.value : null, currency),
                          t,
                        )}
                      </span>
                    </span>
                  </p>
                  {/* ADR-0018's fourth term belongs to no security, so it is
                      the one the head says in its own words. Dropped at **zero
                      and only at zero**: an install whose transfers are free
                      reads no fourth term and never learns it exists. `null` is
                      a different sentence — the server has no day to bound the
                      fees by — and it renders, as a dash, because a total that
                      goes out incomplete owes the reader the cause under it
                      (#775). */}
                  {row.transfer_fees === 0 ? null : (
                    <p
                      role="group"
                      aria-label={t('accounts.figure.fees')}
                      className="text-xs text-muted-foreground"
                    >
                      {t('accounts.figure.fees')}{' '}
                      <span className="tabular font-mono">
                        {f.currency(row.transfer_fees ?? null, currency)}
                      </span>
                      {feesOnContributed === null ? null : (
                        <>
                          {' · '}
                          <span className="tabular font-mono">
                            {t('accounts.figure.feesOnContributed', {
                              percent: f.percentPoints(Math.abs(feesOnContributed) * 100),
                            })}
                          </span>
                        </>
                      )}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* **`Performance totale`, and it is a change** — hence `f.percent`
                and its sign, where the *sur versé* under the dividends is a
                share and carries none (`lib/format.ts`). Same arithmetic, two
                readings, and the formatter is what says which of the two a
                percentage is. It inherits the total's own absence: a rate still
                resolving leaves the gain unknown, so the ratio is not an em
                dash but the same named wait the figure beside it wears. */}
            {terms === null || total === null ? null : (
              <div
                role="group"
                aria-label={t('accounts.figure.totalPerformance')}
                className="flex min-w-0 flex-col gap-0.5"
              >
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {t('accounts.figure.totalPerformance')}
                  <Explain
                    figure={t('accounts.figure.totalPerformance')}
                    body="accounts.totalPerformance.explain"
                    anchor="total-performance"
                  />
                </span>
                <span
                  className={cn(
                    'tabular text-4xl font-heavy tracking-tight',
                    signClass(performance),
                  )}
                >
                  {renderFigure(
                    sumRendering(total),
                    () => (performance === null ? ABSENT : f.percent(performance)),
                    t,
                  )}
                </span>
              </div>
            )}
          </div>

          {/* The curve, inside the head it is the history of. Nothing at all
              while the series is in flight (ADR-0026), and the reason in its
              place where the read refused. The legend states the extent it was
              drawn over, which is the account's whole history: a curve with no
              stated span beside a total is the unbounded-window failure in
              miniature (ADR-0028). */}
          {points === null ? (
            failures.points ? (
              <div className="mt-4.5">
                <Unreadable failure={failures.points} />
              </div>
            ) : null
          ) : curve.length === 0 ? null : (
            <div className="mt-4.5">
              <AccountCurve points={curve} currency={currency} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* The reason a detail has no figures — a **reason**, never a progress
          with a target date. */}
      {reason === null ? null : (
        <p className="text-sm text-attention">{t(REASON_LABELS[reason])}</p>
      )}

      {/* **Three cards, one figure each, and a footing under it** (#838). The
          drawing gives them one shape — the eyebrow, the figure at 34 px, and
          one subordinate row pinned to the foot — so what a card holds is
          readable before any of it is read. `items-stretch` and the `mt-auto`
          inside each footing are what put those three rows on one line
          whatever the figures above them are. */}
      <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card className="gap-3">
          <CardHeader>
            <h3 className="eyebrow">{t('accounts.detail.composition')}</h3>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-3">
            {/* **The securities, and not the whole**: the drawing leads this
                card with what the account holds *in shares* and lets the bar
                and its two rows say the split. The account's total value is the
                head's, one card up — said once. */}
            <p
              role="group"
              aria-label={t('accounts.detail.composition')}
              className="tabular text-5xl font-heavy tracking-tight"
            >
              {f.currency(row.holdings_value, currency)}
            </p>
            {/* Subordination is vertical and it is a **nesting**: the two rows
                below are what the figure is made of, and mounted beside it at
                equal weight nothing would say so. */}
            <div className="mt-auto">
              <Composition row={row} hue={hue} />
            </div>
            <ul className="flex flex-col gap-1.5 text-xs">
              <li
                role="group"
                aria-label={t('accounts.figure.holdings')}
                className="flex items-baseline gap-2 text-muted-foreground"
              >
                <span
                  aria-hidden
                  className="inline-block size-2 shrink-0 rounded-xs"
                  style={{ backgroundColor: accountColour(hue) }}
                />
                {t('accounts.figure.holdings')}
                <span className="tabular ml-auto font-mono text-foreground">
                  {f.currency(row.holdings_value, currency)}
                </span>
              </li>
              <li
                role="group"
                aria-label={t('accounts.figure.cash')}
                className="flex items-baseline gap-2 text-muted-foreground"
              >
                <span aria-hidden className="inline-block size-2 shrink-0 rounded-xs bg-input" />
                {t('accounts.figure.cash')}
                <span className="tabular ml-auto font-mono text-foreground">
                  {f.currency(row.cash_balance, currency)}
                </span>
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card className="gap-3">
          <CardHeader>
            <h3 className="eyebrow flex items-center gap-1.5">
              {t('accounts.detail.return')}
              <Explain
                figure={t('accounts.figure.xirr')}
                body="accounts.xirr.explain"
                anchor="xirr"
              />
            </h3>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-3">
            <p
              role="group"
              aria-label={t('accounts.figure.xirr')}
              className={cn('tabular text-5xl font-heavy tracking-tight', signClass(row.xirr))}
            >
              {f.percent(row.xirr)}
            </p>
            {/* The other rate, and the drawing puts it here rather than in a
                card of its own: two ways of reading one account's return, the
                annualised one leading and the time-weighted one under it. */}
            {twr === null ? null : (
              <div
                role="group"
                aria-label={t('accounts.figure.twr')}
                className="mt-auto flex items-baseline justify-between gap-2.5 border-t pt-3"
              >
                <span className="text-xs text-muted-foreground">{t('accounts.figure.twr')}</span>
                <span className="tabular font-mono text-lg font-semibold">{f.percent(twr)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* The dividends this account has paid — the same term the head's gain
            counts, read once and rendered at two altitudes. Nothing at all
            while the positions are in flight. */}
        {terms === null ? null : (
          <Card className="gap-3">
            <CardHeader>
              <h3 className="eyebrow flex items-center gap-1.5">
                {t('accounts.detail.dividends')}
                <Explain
                  figure={t('accounts.detail.dividends.encashed')}
                  body="accounts.detail.dividends.explain"
                  anchor="dividends"
                />
              </h3>
            </CardHeader>
            <CardContent className="flex h-full flex-col gap-3">
              {/* **In the dividend's own colour** — the one mark of the three
                  the preset gives a hue to, and the same one the ledger draws a
                  dividend row in. A figure nobody signs, so the colour says
                  *what kind of money* and never *which way it went*. */}
              <p
                role="group"
                aria-label={t('accounts.detail.dividends.encashed')}
                className="tabular text-5xl font-heavy tracking-tight text-dividend"
              >
                {renderFigure(
                  termRendering(terms, 'dividends'),
                  () => f.currency(termAmount(terms, 'dividends'), currency),
                  t,
                )}
              </p>
              {/* What the drawing puts under the figure, and it is a **rate on
                  the denominator this page already has**: the contribution at
                  the head is what the ratio beside it divides, so the dividends
                  divide it too rather than acquiring a base of their own. It
                  carries no bubble — ADR-0016 puts one icon per figure and per
                  surface, and the figure above it has one. */}
              <div
                role="group"
                aria-label={t('accounts.detail.dividends.onContributed')}
                className="mt-auto flex items-baseline justify-between gap-2.5 border-t pt-3"
              >
                <span className="text-xs text-muted-foreground">
                  {t('accounts.detail.dividends.onContributed')}
                </span>
                <span className="tabular font-mono text-lg font-semibold">
                  {dividendsOnContributed === null
                    ? ABSENT
                    : f.percentPoints(dividendsOnContributed * 100)}
                </span>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      {/* **The lines take the whole track**, which is the maquette's own shape
          for this block and not a preference: every other block on this page is
          one figure and its terms, and this one is a table — the width it wants
          is what a table wants. Held lines only: a sold position is worth
          exactly zero, and a list ordered by value would put every one of them
          in one block at the bottom saying nothing. The page they lead to folds
          them instead. */}
      {lines === null || lines.length === 0 ? null : (
        <Card>
          <CardHeader>
            <h3 className="eyebrow">{t('accounts.detail.lines')}</h3>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {/* **Four columns and a header row** (#838). The block was one line
                per share with the weight wrapped under it, on the argument that
                the detail is the narrow track — and it is not: the drawing lays
                the four out in a row from `md`, and the weight's bar is what
                makes the column readable at a glance rather than a fourth
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
              <span className="w-23 shrink-0 text-right lg:w-27.5">
                {t('shares.column.value')}
              </span>
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
                        // The account's own hue, which is the colour its curve
                        // and its composition are already drawn in: rank is
                        // read off the order the list is already sorted in, so
                        // a ramp would say it a second time — the licence
                        // ADR-0023 gives and this list does not need.
                        fill={accountColour(hue)}
                      />
                      <span className="tabular w-11 shrink-0 text-right font-mono text-xs text-muted-foreground">
                        {renderFigure(
                          weightRendering(line, placed),
                          // `?? 0` is never reached: `weightRendering` answers
                          // `figure` on exactly the rows where `weightShare`
                          // answers a number, which is the whole reason the two
                          // are one pair in `lib/shares.ts`.
                          () => f.percentPoints((share ?? 0) * 100),
                          t,
                        )}
                      </span>
                    </span>
                    <span className="tabular w-23 shrink-0 text-right font-mono lg:w-27.5">
                      {f.currency(marketValue(line), currency)}
                    </span>
                    <span
                      className={cn(
                        'tabular w-15.5 shrink-0 text-right font-mono text-xs lg:w-20',
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
              className="inline-block text-xs text-primary hover:underline"
            >
              {t('accounts.detail.lines.link', { count: symbols })}
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* **Which lines pay the dividends** — the question the encashed figure
            raises and cannot answer (#833). It carries its own extent, for
            ADR-0028's reason one figure over: `position.dividends` is a
            lifetime total, so the span is the account's whole history and the
            block says so rather than leaving it implied — there being no range
            control above it any more to borrow a window from. Nothing at all
            while the positions are in flight, and no block where no line has
            ever paid. */}
        {payers === null || payers.length === 0 ? null : (
          <Card>
            <CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="eyebrow">{t('accounts.detail.payers')}</h3>
              <span className="text-xs text-muted-foreground">
                {t('accounts.detail.payers.period')}
              </span>
            </CardHeader>
            <CardContent>
              <ul aria-label={t('accounts.detail.payers')} className="divide-y divide-border/60">
                {payers.map((payer) => (
                  <li key={payer.symbol} className="flex flex-col gap-1 py-2 text-sm">
                    <span className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate font-medium">{payer.symbol}</span>
                      <span className="tabular shrink-0">
                        {f.currency(payer.amount, currency)}
                      </span>
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
            </CardContent>
          </Card>
        )}

        {last === null ? (
          failures.events ? <Unreadable failure={failures.events} /> : null
        ) : last.length === 0 ? null : (
          <Card>
            <CardHeader>
              <h3 className="eyebrow">{t('accounts.detail.events')}</h3>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul aria-label={t('accounts.detail.events')} className="divide-y divide-border/60">
                {last.map((event, index) => (
                  <li
                    key={event.id ?? `${event.date}-${index}`}
                    className="flex items-baseline justify-between gap-3 py-2 text-sm"
                  >
                    {/* The day under the type rather than beside it: the column
                        this block sits in is narrow at the width ADR-0022
                        measured, and a date that cannot wrap is what pushes a
                        row past its edge. */}
                    {/* **What it is about, then what it is.** The type alone
                        read as *Versement · Versement · Retrait* down the
                        block, three rows saying nothing about which security or
                        which transfer — the ledger's own identity column is
                        what discriminates, here as there (`identityOf`). */}
                    <span className="min-w-0">
                      <span className="block truncate">{eventName(event) ?? ABSENT}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t(TYPE_LABEL[event.event_type])} · {f.date(event.date)}
                      </span>
                    </span>
                    {/* The field the **type** declares, and never a total
                        composed out of the others: a purchase states a quantity
                        and a transfer an amount, so the one that is a figure of
                        the row is the one rendered — and the two do not share a
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
              {/* Reduced onto this account, exactly as the lines block above
                  reduces onto it: a detail owes its reader *more of what this
                  block is showing*, and the whole ledger is a different page
                  about a different subject. The reduction is a URL, so it
                  survives a reload and can be handed to somebody else. */}
              <Link
                to="/ledger"
                search={{ account: row.id }}
                className="text-sm font-medium underline underline-offset-4"
              >
                {t('accounts.detail.events.link')}
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </section>
  )
}

/** The row's own name — the ticker where there is one, the label otherwise. */
function eventName(event: LedgerEvent): string | null {
  const identity = identityOf(event)
  return identity.ticker ?? identity.label
}

/**
 * The standing half of the reassignment (#725, ADR-0006).
 *
 * The other half rides **inside** the first declaration, where there is no list
 * of accounts to choose from yet. This one needs no file at all to be reached
 * (ADR-0034) — events typed into the app before anything was declared land
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
    mutationFn: (id: string) => api.reassignEvents(id),
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
    // thing the rail's link leads to, and a block a reader is sent to has to be
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

/**
 * The split between securities and cash, drawn once and written twice under it.
 *
 * It was the product's second hand-written share bar and it is `ShareBar` now
 * (#800): the same track, the same fill, the same `aria-hidden` — both figures
 * are read out in full one line down — and the same *nothing at all* where the
 * total is not a figure, a bar over an unknown whole being a drawing of
 * nothing. That condition is now a `null` share rather than an early return,
 * which is the primitive's own rule and no longer this file's.
 */
/**
 * The split of what an account holds — **the account's own hue against the
 * cash's** (#838). The drawing draws the two halves rather than one fill on a
 * neutral track: the securities in the colour the rail gave this account, the
 * cash in the neutral the theme keeps for the empty half of a control, so the
 * bar says *these two close this whole* the way the rail's stacked one does.
 */
function Composition({ row, hue }: { row: AccountRow; hue: number }) {
  const total = row.total_value
  const share = total === null || total <= 0 ? null : (row.holdings_value ?? 0) / total
  return <ShareBar share={share} size="block" fill={accountColour(hue)} />
}
