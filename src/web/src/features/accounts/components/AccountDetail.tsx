/**
 * One account, read in depth (« Relevé »).
 *
 * The head reads like the dashboard's, on the ground: the value in the hero
 * rung, the gain and the annualised rate under it, three facts of the account
 * on the right, a two-colour bar and one line saying what was paid in and what
 * it became. The chart follows, with its two readings (Montants · Performance)
 * as text tabs and the period as a segmented control in words. Then three
 * sections: where the gain comes from, what the account would net if sold today
 * (income tax and social levies apart), and the lines it holds.
 *
 * Every block has its three states. A block waiting on a read renders nothing
 * at all, title included; a block whose read refused says so in its own place;
 * a block with nothing in it does not exist.
 */
import { figured } from '@/features/benchmark/lib/comparison'
import { useId, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { AccountCurve } from '@/features/accounts/components/AccountCurve'
import { Refusal } from '@/components/Refusal'
import { Unreadable } from '@/components/Unreadable'
import { EmptyState } from '@/components/EmptyState'
import { Segmented } from '@/components/Segmented'
import { Stat } from '@/components/Stat'
import { TextTabs } from '@/components/TextTabs'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Section } from '@/components/ui/section'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { renderFigure } from '@/lib/absence'
import {
  accountPositions,
  declaredLabel,
  degradedReason,
  distinctSymbols,
  firstDay,
  rebase,
  shifted,
  valueSeries,
  DEFAULT_ACCOUNT_LABEL,
  type AccountRow,
  type DegradedReason,
  type Reassignment as ReassignmentOffer,
  type ValuePoint,
} from '@/features/accounts/lib/accounts'
import { accountsApi, type PerfPoint } from '@/features/accounts/lib/api'
import { accountReading, unpricedLines } from '@/features/dashboard/lib/dashboard'
import type { LedgerEvent } from '@/features/data/lib/api'
import type { Position } from '@/features/shares/lib/api'
import type { RuntimeState } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { portfolioTerms, termAmount, termRendering, type GainTermName } from '@/lib/gain'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'
import {
  buildShareRows,
  heldRows,
  marketValue,
  placedValue,
  unrealised,
  weightRendering,
  weightShare,
} from '@/features/shares/lib/shares'
import { MONEY_DECIMALS, RATIO_DECIMALS, signClass } from '@/lib/sign'
import { ShareBar } from '@/components/ShareBar'
import type { ReadFailure } from '@/lib/status'

const REASON_LABELS: Record<DegradedReason, MessageKey> = {
  withoutCashLedger: 'accounts.reason.withoutCashLedger',
  rebuilding: 'accounts.reason.rebuilding',
  empty: 'accounts.reason.empty',
}

/** The two sections of the middle row share it equally. */
const FULL_ROW = 'grid grid-cols-1 items-start gap-5 lg:grid-flow-col lg:auto-cols-fr'

const SPANS = ['1M', 'YTD', '1Y', 'MAX'] as const
type Span = (typeof SPANS)[number]
const READINGS = ['amounts', 'performance'] as const
type Reading = (typeof READINGS)[number]

/** The terms of the gain, in the order the section lists them. */
const GAIN_ROWS: readonly { term: GainTermName; name: MessageKey; hue: number }[] = [
  { term: 'unrealised', name: 'accounts.gain.unrealised', hue: 1 },
  { term: 'realised', name: 'accounts.gain.realised', hue: 2 },
  { term: 'dividends', name: 'accounts.gain.dividends', hue: 3 },
]

interface AccountDetailProps {
  row: AccountRow
  /** This account's share of the portfolio, or `null` where it cannot be stated. */
  share: number | null
  /** The name of the taxation model the account carries, where it carries one. */
  modelName: string | null
  /** The whole payload's rows, or `null` while the read has not landed. */
  positions: readonly Position[] | null
  /** The whole ledger, or `null` while that read is in flight. */
  events: readonly LedgerEvent[] | null
  /** The account's own perf series, whole, or `null` while its read is in flight. */
  points: readonly PerfPoint[] | null
  currency: string | null
  runtime: RuntimeState | undefined | null
  /** The standing offer to move the events nobody assigned onto a declared account. */
  reassignment: ReassignmentOffer
  /** The reads above that refused, one entry per read. */
  failures?: {
    positions?: ReadFailure | null
    points?: ReadFailure | null
    events?: ReadFailure | null
  }
  /** Opens the panel — where a model is chosen. */
  onEdit: () => void
}

/** Whole months between two days, never less than one. */
function monthsBetween(from: string, to: Date): number {
  const start = new Date(`${from}T00:00:00Z`)
  const months =
    (to.getUTCFullYear() - start.getUTCFullYear()) * 12 + (to.getUTCMonth() - start.getUTCMonth())
  return Math.max(1, months)
}

export function AccountDetail({
  row,
  share,
  modelName,
  positions,
  events,
  points,
  currency,
  runtime,
  reassignment,
  failures = {},
  onEdit,
}: AccountDetailProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const heading = useId()
  const [span, setSpan] = useState<Span>('MAX')
  const [reading, setReading] = useState<Reading>('amounts')

  const name = declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)
  const reason = degradedReason(row, runtime?.rebuilding ?? null)
  const now = new Date()
  // A row cut before today is not the value: a rebuild caps a held line with
  // no close the day before its acquisition, so no figure of the head is
  // today's. The curve is a true history and stays.
  const status = accountReading(row, runtime, now)
  const valued = status === 'valued'

  const held = useMemo(
    () => (positions === null ? null : accountPositions(positions, row.id)),
    [positions, row.id],
  )
  const empty = reason === 'empty' && held !== null && held.length === 0
  const terms = useMemo(
    () => (held === null ? null : portfolioTerms(held, row.transfer_fees)),
    [held, row.transfer_fees],
  )
  const lines = useMemo(
    () => (held === null ? null : heldRows(buildShareRows(held, new Map()))),
    [held],
  )
  const placed = lines === null ? 0 : placedValue(lines)
  const unpriced = status === 'partial' && held !== null ? unpricedLines(held) : []

  // The curve, cut to the period; the performance is rebased on the window's
  // first day.
  const start =
    span === 'MAX'
      ? null
      : span === 'YTD'
        ? `${now.getUTCFullYear()}-01-01`
        : span === '1Y'
          ? shifted(now, 1, 0)
          : shifted(now, 0, 1)
  const amounts = useMemo(
    () =>
      points === null
        ? []
        : valueSeries(points).filter((point) => start === null || point.t >= start),
    [points, start],
  )
  const performance = useMemo<ValuePoint[]>(() => {
    if (points === null) return []
    const from = start ?? firstDay(points)
    if (from === null) return []
    return rebase(row.id, points, from).points.map((point) => ({
      t: point.t,
      value: point.index / 100 - 1,
      contributed: null,
    }))
  }, [points, row.id, start])
  const curve = reading === 'amounts' ? amounts : performance

  const gainPct =
    row.gain_absolu === null || row.net_contributed === null || row.net_contributed <= 0
      ? null
      : row.gain_absolu / row.net_contributed
  const opened = row.opened_on ?? row.first_payment ?? null
  const monthly = (() => {
    const from = points === null ? null : firstDay(points)
    if (from === null || row.net_contributed === null || row.net_contributed <= 0) return null
    return row.net_contributed / monthsBetween(from, now)
  })()
  const invested = Math.max(0, Math.min(row.total_value ?? 0, row.net_contributed ?? 0))
  const earned = Math.max(0, (row.total_value ?? 0) - (row.net_contributed ?? 0))
  // The three facts of the account; one that cannot be stated is left out.
  const facts: { name: string; value: string }[] = [
    ...(opened === null ? [] : [{ name: t('accounts.form.openedOn'), value: f.date(opened) }]),
    ...(!valued || row.cash_balance === null
      ? []
      : [{ name: t('accounts.fact.cash'), value: f.currency(row.cash_balance, currency) }]),
    ...(!valued || share === null
      ? []
      : [{ name: t('accounts.fact.share'), value: f.percentPoints(share * 100, 1) }]),
  ]
  // The opening day contradicts what the ledger says: said beside the fact.
  const today = now.toISOString().slice(0, 10)
  const openingNote =
    row.opened_on === undefined
      ? null
      : row.opened_on > today
        ? t('accounts.opening.future')
        : row.first_payment !== undefined && row.opened_on > row.first_payment
          ? t('accounts.opening.afterPayment', { date: f.date(row.first_payment) })
          : null
  const net =
    row.total_value === null || row.projected_tax === undefined
      ? null
      : row.total_value - row.projected_tax

  return (
    <section aria-labelledby={heading} className="space-y-5">
      {reassignment.kind === 'standing' ? <Reassignment offer={reassignment} /> : null}

      <h2 id={heading} className="sr-only">
        {name}
      </h2>

      {empty ? (
        <EmptyState
          title={t('accounts.bare.title')}
          description={t('accounts.bare.body')}
          action={
            <Link to="/ledger" className="font-medium underline underline-offset-4">
              {t('empty.toLedger')}
            </Link>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
            <Stat
              size="head"
              label={t('accounts.figure.totalValue')}
              value={
                valued ? (
                  f.currency(row.total_value, currency)
                ) : (
                  <span key="unvalued" aria-hidden className="invisible">
                    &nbsp;
                  </span>
                )
              }
            >
              {status === 'partial' ? (
                <div className="max-w-prose space-y-1 text-sm text-muted-foreground">
                  <p>
                    {runtime?.reconstruction
                      ? t('dashboard.rebuilding.progress', runtime.reconstruction)
                      : t('dashboard.rebuilding.progressUnobserved')}
                  </p>
                  {unpriced.length === 0 ? null : (
                    <p>{t('dashboard.rebuilding.unpriced', { lines: f.list(unpriced) })}</p>
                  )}
                </div>
              ) : null}
              {!valued ? null : (
                <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 pt-1.5">
                  <span
                    role="group"
                    aria-label={t('accounts.figure.gain')}
                    className={`fig text-2xl font-medium ${signClass(row.gain_absolu, MONEY_DECIMALS)}`}
                  >
                    {f.signedCurrency(row.gain_absolu, currency)}
                  </span>
                  {gainPct === null ? null : (
                    <span className={`fig text-prose ${signClass(gainPct, RATIO_DECIMALS)}`}>
                      ({f.percent(gainPct, 1, 1)})
                    </span>
                  )}
                  <span className="text-muted-foreground">{t('accounts.gain.pill')}</span>
                  {gainPct === null || row.net_contributed === null || currency === null ? null : (
                    // The base under the percentage, in a few words.
                    <span className="text-sm text-muted-foreground">
                      {t('dashboard.gainTotal.base', {
                        base: f.currency(row.net_contributed, currency),
                      })}
                    </span>
                  )}
                  <span aria-hidden className="text-border">
                    ·
                  </span>
                  <span
                    role="group"
                    aria-label={t('accounts.figure.xirr')}
                    className="text-muted-foreground"
                  >
                    {t('accounts.figure.xirr')}{' '}
                    <span className="fig text-foreground">
                      {row.xirr === null ? ABSENT : f.percentPoints(row.xirr * 100, 2)}
                    </span>{' '}
                    {t('accounts.xirr.unit')}
                  </span>
                </p>
              )}
              {/* TRI, defined where it is shown: a clause, readable on touch. */}
              <p className="text-xs text-muted-foreground">{t('accounts.xirr.definition')}</p>
            </Stat>

            <dl aria-label={t('accounts.facts')} className="flex flex-col gap-1.5 pb-1.5">
              {facts.map(({ name: label, value }) => (
                <div key={label} className="flex items-baseline justify-between gap-6">
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="fig text-md">{value}</dd>
                </div>
              ))}
            </dl>
            {openingNote === null ? null : (
              <p className="w-full text-right text-sm text-attention">{openingNote}</p>
            )}
          </div>

          {!valued || row.net_contributed === null || invested + earned <= 0 ? null : (
            <div className="space-y-2.5">
              <ShareBar
                share={null}
                fill=""
                size="split"
                label={t('accounts.bar.label')}
                segments={[
                  { weight: invested, fill: 'var(--alloc-5)' },
                  ...(earned > 0 ? [{ weight: earned, fill: 'var(--gain)' }] : []),
                ]}
              />
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5">
                <p className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
                  <span role="group" aria-label={t('accounts.figure.netContributed')}>
                    <span className="text-muted-foreground">
                      {t('accounts.figure.netContributed')}
                    </span>{' '}
                    <span className="fig text-prose">
                      {f.currency(row.net_contributed, currency)}
                    </span>
                  </span>
                  {earned > 0 && row.gain_absolu !== null ? (
                    <span>
                      <span className="text-muted-foreground">{t('accounts.figure.gain')}</span>{' '}
                      <span
                        className={`fig text-prose ${signClass(row.gain_absolu, MONEY_DECIMALS)}`}
                      >
                        {f.signedCurrency(row.gain_absolu, currency)}
                      </span>
                    </span>
                  ) : null}
                </p>
                {monthly === null || currency === null ? null : (
                  <p className="text-sm text-muted-foreground">
                    {figured(t('accounts.monthly', { amount: f.currency(monthly, currency) }), [
                      f.currency(monthly, currency),
                    ])}
                  </p>
                )}
              </div>
            </div>
          )}

          {reason === null ? null : (
            <p className="text-sm text-attention">{t(REASON_LABELS[reason])}</p>
          )}

          {points === null ? (
            failures.points ? (
              <Unreadable failure={failures.points} />
            ) : null
          ) : amounts.length === 0 ? null : (
            <div className="space-y-4 pt-4">
              <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                <TextTabs
                  label={t('accounts.reading')}
                  value={reading}
                  onChange={setReading}
                  tabs={READINGS.map((one) => ({
                    value: one,
                    label: t(`accounts.reading.${one}` as MessageKey),
                  }))}
                  className="flex-1 border-b-0"
                />
                <Segmented
                  bordered
                  mode="radio"
                  size="compact"
                  label={t('accounts.period')}
                  value={span}
                  onChange={setSpan}
                  options={SPANS.map((one) => ({
                    value: one,
                    label: t(`accounts.period.${one}` as MessageKey),
                  }))}
                />
              </div>
              {curve.length === 0 ? null : (
                <AccountCurve
                  points={curve}
                  currency={currency}
                  kind={reading === 'amounts' ? 'amount' : 'ratio'}
                />
              )}
            </div>
          )}

          <div className={`${FULL_ROW} pt-6`}>
            {terms === null ? (
              failures.positions ? (
                <Unreadable failure={failures.positions} />
              ) : null
            ) : (
              <Section
                level={2}
                title={t('accounts.gain.title')}
                aside={
                  <span className="text-sm text-muted-foreground">{t('accounts.gain.since')}</span>
                }
              >
                <div className="space-y-3">
                  <p className="flex flex-wrap items-baseline gap-x-2.5">
                    <span
                      className={`fig text-4xl font-medium ${signClass(row.gain_absolu, MONEY_DECIMALS)}`}
                    >
                      {valued ? f.signedCurrency(row.gain_absolu, currency) : ABSENT}
                    </span>
                    <span className="text-muted-foreground">{t('accounts.gain.afterFees')}</span>
                  </p>
                  <ul>
                    {GAIN_ROWS.map(({ term, name: label, hue }) => (
                      <li
                        key={term}
                        className="flex items-baseline justify-between gap-3 border-t py-2"
                      >
                        <span className="inline-flex items-center gap-2.5">
                          <span
                            aria-hidden
                            className="size-2 rounded-xs"
                            style={{ background: `var(--alloc-${hue})` }}
                          />
                          {t(label)}
                        </span>
                        <span className="fig">
                          {renderFigure(
                            termRendering(terms, term),
                            () => f.signedCurrency(termAmount(terms, term), currency),
                            t,
                          )}
                        </span>
                      </li>
                    ))}
                    <li className="flex items-baseline justify-between gap-3 border-t py-2 text-muted-foreground">
                      <span className="pl-4.5">{t('accounts.gain.fees')}</span>
                      <span className="fig">
                        {renderFigure(
                          termRendering(terms, 'transferFees'),
                          () => f.signedCurrency(termAmount(terms, 'transferFees'), currency),
                          t,
                        )}
                      </span>
                    </li>
                  </ul>
                </div>
              </Section>
            )}

            {!valued ? null : (
              <Section
                level={2}
                title={t('accounts.exit.title')}
                aside={
                  modelName === null ? undefined : (
                    <span className="text-sm text-muted-foreground">{modelName}</span>
                  )
                }
              >
                <Exit
                  row={row}
                  net={net}
                  modelName={modelName}
                  currency={currency}
                  onEdit={onEdit}
                />
              </Section>
            )}
          </div>

          {lines === null || lines.length === 0 ? null : (
            <Section
              level={2}
              title={t('accounts.detail.lines')}
              aside={
                <span className="text-sm text-muted-foreground">
                  {t('accounts.lines.count', { count: lines.length })}
                </span>
              }
            >
              <div className="space-y-3">
                {valued && row.holdings_value !== null ? (
                  <p className="flex flex-wrap items-baseline gap-x-2.5">
                    <span
                      role="group"
                      aria-label={t('accounts.figure.holdings')}
                      className="fig text-4xl font-medium"
                    >
                      {f.currency(row.holdings_value, currency)}
                    </span>
                    <span className="text-muted-foreground">{t('accounts.lines.invested')}</span>
                  </p>
                ) : null}
                <ShareBar
                  share={null}
                  fill=""
                  size="stack"
                  label={t('accounts.lines.bar')}
                  segments={lines.map((line, index) => ({
                    weight: Math.max(marketValue(line) ?? 0, 0),
                    fill: `var(--alloc-${(index % 4) + 1})`,
                  }))}
                />
                <Table aria-label={t('accounts.detail.lines')}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('accounts.lines.security')}</TableHead>
                      <TableHead numeric>{t('accounts.detail.lines.weight')}</TableHead>
                      <TableHead numeric>{t('accounts.lines.cost')}</TableHead>
                      <TableHead numeric>{t('accounts.lines.value')}</TableHead>
                      <TableHead numeric>{t('accounts.lines.gain')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((line, index) => {
                      const gain = unrealised(line)
                      const weight = weightShare(line, placed)
                      return (
                        <TableRow key={line.symbol} tall className="group">
                          <TableCell>
                            <Link
                              to="/shares/$symbol"
                              params={{ symbol: line.symbol }}
                              className="inline-flex min-w-0 items-center gap-2.5 text-md font-medium group-hover:underline group-hover:underline-offset-4"
                            >
                              <span
                                aria-hidden
                                className="size-2 shrink-0 rounded-xs"
                                style={{ background: `var(--alloc-${(index % 4) + 1})` }}
                              />
                              <span className="truncate">{line.name ?? line.symbol}</span>
                              {line.name === null ? null : (
                                <span className="fig text-xs font-normal text-muted-foreground">
                                  {line.symbol}
                                </span>
                              )}
                            </Link>
                          </TableCell>
                          <TableCell numeric className="text-muted-foreground">
                            {renderFigure(
                              weightRendering(line, placed),
                              () => f.percentPoints((weight ?? 0) * 100, 1),
                              t,
                            )}
                          </TableCell>
                          <TableCell numeric>{f.currency(line.cost_basis, currency)}</TableCell>
                          <TableCell numeric>{f.currency(marketValue(line), currency)}</TableCell>
                          <TableCell numeric className={signClass(gain, MONEY_DECIMALS)}>
                            {gain === null ? ABSENT : f.signedCurrency(gain, currency)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
                <Link
                  to="/shares"
                  search={{ account: row.id }}
                  className="inline-block text-sm underline underline-offset-4"
                >
                  {t('accounts.detail.lines.link', { count: distinctSymbols(held ?? []) })}
                </Link>
              </div>
            </Section>
          )}

          {events === null && failures.events ? <Unreadable failure={failures.events} /> : null}
        </>
      )}
    </section>
  )
}

/**
 * What the account would net if everything in it were sold today, the income
 * tax and the social levies apart. Rows are the payload's: the tax is the
 * server's, and an account without a model states none.
 */
function Exit({
  row,
  net,
  modelName,
  currency,
  onEdit,
}: {
  row: AccountRow
  net: number | null
  modelName: string | null
  currency: string | null
  onEdit: () => void
}) {
  const { t } = useI18n()
  const f = useFormatters()

  if (row.taxation_kind === undefined) {
    return (
      <div className="space-y-3">
        <p className="flex flex-wrap items-baseline gap-x-2.5">
          <span className="fig text-4xl font-medium text-muted-foreground">{ABSENT}</span>
          <span className="text-muted-foreground">{t('accounts.exit.noModel')}</span>
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          {t('accounts.exit.choose')}
        </Button>
      </div>
    )
  }

  const rates = row.projected_rates
  const lines: { label: string; value: string }[] = []
  if (row.projected_base !== undefined)
    lines.push({
      label: t('accounts.exit.base'),
      value: f.currency(row.projected_base, currency),
    })
  if (row.projected_income_tax !== undefined)
    lines.push({
      label: t('accounts.exit.income'),
      value: f.currency(-row.projected_income_tax, currency),
    })
  if (row.projected_social_levy !== undefined)
    lines.push({
      label: t('accounts.exit.levy'),
      value: f.currency(-row.projected_social_levy, currency),
    })
  if (row.projected_tax !== undefined)
    lines.push({
      label: t('accounts.detail.projectedTax'),
      value: f.currency(-row.projected_tax, currency),
    })
  if (rates !== undefined && rates.length > 0)
    lines.push({
      label: t(
        rates.length > 1
          ? 'accounts.detail.projectedTax.rates'
          : 'accounts.detail.projectedTax.rate',
      ),
      value: rates.map((rate) => f.percentPoints(rate * 100, 1)).join(' · '),
    })

  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-baseline gap-x-2.5">
        <span className="fig text-4xl font-medium">
          {net === null ? f.currency(row.total_value, currency) : f.currency(net, currency)}
        </span>
        <span className="text-muted-foreground">{t('accounts.exit.net')}</span>
      </p>
      <ul>
        {lines.map(({ label, value }) => (
          <li key={label} className="flex items-baseline justify-between gap-3 border-t py-2">
            <span className="text-muted-foreground">{label}</span>
            <span className="fig">{value}</span>
          </li>
        ))}
        {modelName === null ? null : (
          <li className="flex items-baseline justify-between gap-3 border-t py-2">
            <span className="text-muted-foreground">{t('accounts.exit.model')}</span>
            <Link to="/settings" className="underline underline-offset-4">
              {modelName}
            </Link>
          </li>
        )}
      </ul>
      {row.projected_rate_changes_on === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          {t('accounts.detail.projectedTax.changesOn', {
            day: f.date(row.projected_rate_changes_on),
          })}
        </p>
      )}
    </div>
  )
}

/**
 * The standing offer to move the events nobody assigned onto a declared account
 * (#725). It stands on its own, because events typed into the app before
 * anything was declared land under the seeded row and the declaration that
 * follows does not claim them. It is the one card on the page: it asks for a
 * decision.
 */
function Reassignment({ offer }: { offer: Extract<ReassignmentOffer, { kind: 'standing' }> }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const heading = useId()
  const move = useMutation({
    mutationFn: (id: string) => accountsApi.reassignEvents(id),
    // The whole cache: what account an event names moves every page's grouping.
    onSuccess: () => void queryClient.invalidateQueries(),
  })

  // A select of one entry is a question whose answer is already known.
  const only = offer.targets.length === 1 ? offer.targets[0].id : ''
  const [target, setTarget] = useState('')
  const chosen = target || only

  return (
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
            variant="primary"
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
