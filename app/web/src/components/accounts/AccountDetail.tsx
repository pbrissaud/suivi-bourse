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
 *  - **One range control, and it drives the curve *and* the rate beside it.**
 *    That is ADR-0019's rule amended in its subject and not in its rule: the two
 *    are read off the same rebasing over the same window, so they cannot answer
 *    *how did this period go* twice. `MAX` is not offered, and for ADR-0019's
 *    own reason — a time-weighted index has no bounded amplitude.
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
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { AccountCurve } from '@/components/accounts/AccountCurve'
import { Band } from '@/components/Band'
import { Explain } from '@/components/Explain'
import { ShareBar } from '@/components/ShareBar'
import { Stat } from '@/components/Stat'
import { TYPE_LABEL } from '@/components/data/LedgerTable'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { renderFigure } from '@/lib/absence'
import {
  accountEvents,
  accountPositions,
  declaredLabel,
  declaredType,
  degradedReason,
  distinctSymbols,
  isDefaultAccount,
  rebase,
  valueSeries,
  windowStart,
  DEFAULT_ACCOUNT_LABEL,
  DEFAULT_ACCOUNT_TYPE,
  DEFAULT_RANGE,
  RANGES,
  type AccountRow,
  type DegradedReason,
  type Range,
  type Reassignment as ReassignmentOffer,
} from '@/lib/accounts'
import { api, type LedgerEvent, type PerfPoint, type Position } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
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
import { useI18n, type MessageKey } from '@/lib/i18n'
import { FIELDS, identityOf } from '@/lib/ledger'
import { problemSentence } from '@/lib/problem'
import { buildShareRows, heldRows, marketValue, unrealisedRatio } from '@/lib/shares'
import { signClass } from '@/lib/sign'
import { cn } from '@/lib/utils'

const TERM_LABELS: Record<GainTermName, MessageKey> = {
  unrealised: 'gain.term.unrealised',
  realised: 'gain.term.realised',
  dividends: 'gain.term.dividends',
  transferFees: 'gain.term.transferFees',
}

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
   * flight**. It is windowed here rather than at the request: the longest range
   * offered is the account's own opening, and only the series says when that
   * was.
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
  /** Renaming, and removing — the panel this account's name opens. */
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
  onEdit,
}: AccountDetailProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const [range, setRange] = useState<Range>(DEFAULT_RANGE)
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

  // One window for the curve and for the rate beside it. `windowStart` takes the
  // landed series because the bound at *since the opening* is a fact about the
  // series — here there is one account, so the bound is its own opening.
  //
  // **`from === null` is not a read in flight.** It happens on `SINCE_OPENING`
  // alone, and it means this account's series carries no index at all (#708) —
  // a fact about the reader's data. Folded into the same branch as `points ===
  // null` it took the whole card away, **control included**, so the reader who
  // clicked *depuis l'ouverture* on an account with no cash ledger lost the very
  // radio that would have brought them back.
  const from = useMemo(
    () => (points === null ? null : windowStart(range, new Date(), [points])),
    [points, range],
  )
  const rebased = useMemo(
    () => (points === null || from === null ? null : rebase(row.id, points, from)),
    [points, from, row.id],
  )
  const curve = useMemo(
    () =>
      points === null || from === null
        ? []
        : valueSeries(points).filter((point) => point.t >= from),
    [points, from],
  )

  const lines = useMemo(
    () => (held === null ? null : heldRows(buildShareRows(held, new Map()))),
    [held],
  )
  const symbols = held === null ? 0 : distinctSymbols(held)
  const last = useMemo(
    () => (events === null ? null : accountEvents(events, row.id)),
    [events, row.id],
  )

  return (
    <section aria-labelledby={heading} className="space-y-6">
      <header className="space-y-1">
        {/* The name **is** the affordance, which is the ledger's own rule read
            one table over: a button exactly where the row may be edited. Every
            row may be, since ADR-0034 — an account is born in the app, so there
            is no second population for a plain-text name to have meant. */}
        <h2 id={heading} className="text-xl font-semibold tracking-tight">
          <button type="button" className="underline-offset-4 hover:underline" onClick={onEdit}>
            {name}
          </button>
        </h2>
        <p className="text-sm text-muted-foreground">{type}</p>
        {/* The id is what every event names and what a file's `account` column
            has to spell, so it is on screen wherever it is not already said.
            *Already said* is **either line above it**: an account whose id is
            `CTO` and whose type is `CTO` printed the same word twice, one over
            the other. The rail cannot carry it — it has a weight and a type on
            that line already — so it is here, where the account is read in
            full. */}
        {name === row.id || type === row.id ? null : (
          <p className="font-mono text-xs text-muted-foreground">{row.id}</p>
        )}
        {/* The reason a detail has no figures — a **reason**, never a progress
            with a target date, which stays on the banner. */}
        {reason === null ? null : (
          <p className="text-sm text-attention">{t(REASON_LABELS[reason])}</p>
        )}
      </header>

      {/* **Réaffecter, jamais refuser** (#725). It sits above the figures and
          not under them: an owner who ran a month before declaring anything has
          their whole ledger under this row, and what they came for is the way
          out — not this account's composition. */}
      {reassignment.kind === 'standing' ? <Reassignment offer={reassignment} /> : null}

      {/* ADR-0018's four terms, per account — the one place in the product where
          that decomposition exists for anything but the portfolio. */}
      {terms === null || total === null ? null : (
        <Card>
          <CardContent className="space-y-4">
            <Stat
              size="head"
              label={t('accounts.figure.gainTotal')}
              value={renderFigure(
                sumRendering(total),
                () => f.currency(total.known ? total.value : null, currency),
                t,
              )}
              valueClassName={signClass(total.known ? total.value : null)}
              explain={
                <Explain
                  figure={t('accounts.figure.gainTotal')}
                  body="accounts.detail.gainTotal.explain"
                  anchor="total-gain"
                />
              }
            >
              <ul className="mt-3 grid grid-cols-2 gap-3 border-t pt-3 lg:grid-cols-4">
                {GAIN_TERMS.map((term) => {
                  const amount = termAmount(terms, term)
                  // The fourth renders **only when it is not zero**: an account
                  // whose broker moves money for free reads three terms and
                  // never learns the fourth exists.
                  if (!termIsRendered(term, amount)) return null
                  return (
                    <li key={term}>
                      <Stat
                        size="term"
                        label={t(TERM_LABELS[term])}
                        value={renderFigure(
                          termRendering(terms, term),
                          () => f.currency(amount, currency),
                          t,
                        )}
                        // Colour only where the sign can turn — a dividend is
                        // never negative and a transfer fee never positive.
                        valueClassName={
                          amount === null
                            ? signClass(null)
                            : termCarriesSign(term)
                              ? signClass(amount)
                              : signClass(0)
                        }
                      />
                    </li>
                  )
                })}
              </ul>
            </Stat>

            {/* Not a fifth term — the **denominator** of the two rates on this
                page, and it sits outside the list for that reason: a total and
                its terms never share a row, and neither does a figure that is
                not one of them. */}
            <div className="border-t pt-4">
              <Stat
                size="term"
                label={t('accounts.figure.netContributed')}
                value={f.currency(row.net_contributed, currency)}
                explain={
                  <Explain
                    figure={t('accounts.figure.netContributed')}
                    body="accounts.netContributed.explain"
                    anchor="net-contributed"
                  />
                }
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* The chart and the rate beside it, under **one** range control. Nothing
          at all while the series is in flight, title and control included. */}
      {points === null ? null : (
        <Card className="gap-4">
          {/* The header carries the control and no title of its own: what the
              card holds is a rate **and** a curve, and a heading naming the
              curve would stand over an account that has none to draw. Each
              figure names itself instead. */}
          <CardHeader className="flex flex-wrap items-center justify-end gap-3">
            {/* It **wraps**, and that is the 390 px case rather than a taste:
                two of the four presets are named in words, and four radios in a
                row come to more than the width of a phone. */}
            <div
              role="radiogroup"
              aria-label={t('accounts.detail.range')}
              className="flex flex-wrap justify-end gap-1"
            >
              {RANGES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={candidate === range}
                  onClick={() => setRange(candidate)}
                  className={cn(
                    'rounded px-2 py-1 text-xs',
                    candidate === range ? 'bg-secondary font-medium' : 'text-muted-foreground',
                  )}
                >
                  {t('accounts.chart.rangeName', { range: candidate })}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Stat
              label={t('accounts.figure.performance')}
              value={
                // The em dash is right: an account with no cash movement has no
                // index at all (#708), so there is nothing to compute rather
                // than something missing.
                rebased?.performance == null ? ABSENT : f.percent(rebased.performance)
              }
              valueClassName={signClass(rebased?.performance ?? null)}
              explain={
                <Explain
                  figure={t('accounts.figure.performance')}
                  body="accounts.performance.explain"
                  anchor="twr"
                />
              }
            />
            {/* A block with nothing in it does not exist: an account with no
                cash ledger has no value to trace against a contribution, and the
                header above has already named that reason. */}
            {curve.length === 0 ? null : <AccountCurve points={curve} currency={currency} />}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <h3 className="text-sm font-medium">{t('accounts.detail.composition')}</h3>
          </CardHeader>
          <CardContent>
            {/* Subordination is vertical and it is a **nesting**, the same one
                the gain block uses one card over: the two are what the value is
                made of, and mounted beside it at equal weight nothing would say
                so. */}
            <Stat
              label={t('accounts.figure.totalValue')}
              value={f.currency(row.total_value, currency)}
            >
              <Composition row={row} />
              <ul className="mt-3 space-y-2 border-t pt-3">
                <li>
                  <Stat
                    size="term"
                    label={t('accounts.figure.holdings')}
                    value={f.currency(row.holdings_value, currency)}
                  />
                </li>
                <li>
                  <Stat
                    size="term"
                    label={t('accounts.figure.cash')}
                    value={f.currency(row.cash_balance, currency)}
                  />
                </li>
              </ul>
            </Stat>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-sm font-medium">{t('accounts.detail.return')}</h3>
          </CardHeader>
          <CardContent>
            <Stat
              label={t('accounts.figure.xirr')}
              value={f.percent(row.xirr)}
              valueClassName={signClass(row.xirr)}
              explain={
                <Explain
                  figure={t('accounts.figure.xirr')}
                  body="accounts.xirr.explain"
                  anchor="xirr"
                />
              }
            />
          </CardContent>
        </Card>

        {/* The dividends this account has paid — the same term the block above
            decomposes, read once and rendered at two altitudes. Nothing at all
            while the positions are in flight. */}
        {terms === null ? null : (
          <Card>
            <CardHeader>
              <h3 className="text-sm font-medium">{t('accounts.detail.dividends')}</h3>
            </CardHeader>
            <CardContent>
              {/* The figure's label is what it *is* — encashed — and never the
                  block's own name a second time. */}
              <Stat
                label={t('accounts.detail.dividends.encashed')}
                value={renderFigure(
                  termRendering(terms, 'dividends'),
                  () => f.currency(termAmount(terms, 'dividends'), currency),
                  t,
                )}
                explain={
                  <Explain
                    figure={t('accounts.detail.dividends.encashed')}
                    body="accounts.detail.dividends.explain"
                    anchor="dividends"
                  />
                }
              />
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Held lines only: a sold position is worth exactly zero, and a list
            ordered by value would put every one of them in one block at the
            bottom saying nothing. The page they lead to folds them instead. */}
        {lines === null || lines.length === 0 ? null : (
          <Card>
            <CardHeader>
              <h3 className="text-sm font-medium">{t('accounts.detail.lines')}</h3>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul aria-label={t('accounts.detail.lines')} className="divide-y divide-border/60">
                {lines.map((line) => {
                  const ratio = unrealisedRatio(line)
                  return (
                    <li key={line.symbol} className="flex items-baseline gap-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate font-medium">{line.symbol}</span>
                      <span className="tabular shrink-0">
                        {f.currency(marketValue(line), currency)}
                      </span>
                      <span className={cn('tabular w-20 shrink-0 text-right', signClass(ratio))}>
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
                to="/titres"
                search={{ compte: row.id }}
                className="text-sm font-medium underline underline-offset-4"
              >
                {t('accounts.detail.lines.link', { count: symbols })}
              </Link>
            </CardContent>
          </Card>
        )}

        {last === null || last.length === 0 ? null : (
          <Card>
            <CardHeader>
              <h3 className="text-sm font-medium">{t('accounts.detail.events')}</h3>
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
              <Link to="/donnees" className="text-sm font-medium underline underline-offset-4">
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
        {move.error ? <Band>{problemSentence(t, move.error)}</Band> : null}
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
function Composition({ row }: { row: AccountRow }) {
  const total = row.total_value
  const share = total === null || total <= 0 ? null : (row.holdings_value ?? 0) / total
  return (
    <ShareBar
      share={share}
      size="block"
      className="mt-2"
      // What `bg-foreground/70` compiled to, kept to the letter: the fill of a
      // split nobody ranks is chrome, and the ramps stay where they are earned.
      fill="color-mix(in oklab, var(--foreground) 70%, transparent)"
    />
  )
}
