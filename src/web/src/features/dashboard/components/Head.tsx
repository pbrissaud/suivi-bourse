/**
 * The head of the dashboard (« Relevé », DESIGN.md › The hero).
 *
 * « Valeur du portefeuille », the value in the hero rung, and under it the
 * variation over the chart's period in mono, coloured by sign (`totals.variation`
 * of the range the page holds: the line and the chart share it). On the right a
 * three-row statement, *Premier versement*, *Liquidités* and *Net si tout vendu*.
 * Under them a 10 px two-colour bar, then one line: *Versé net* and *Gain total*
 * on the left, *TRI x % par an* alone on the right.
 *
 * **Every figure is the server's** (`GET /api/portfolio-totals`): the gain total
 * is the app's one official gain (latent + realised + dividends − fees, over the
 * net contribution), the net if sold is the value less the projected tax of the
 * accounts that carry a model. Nothing is summed here.
 *
 * **Absence is per field.** A figure that does not exist for this installation
 * is left out, not dashed: an install with no cash ledger has no cash, no net
 * contribution and no IRR, and its value is the securities' alone, said under its
 * own name (#708). A past-day row during the rebuild asserts no value at all
 * (#1260).
 *
 * **A read that fails is named by whoever is empty because of it, not here**
 * (#799, #829): the block reads nothing of its own, the page hands it the reads.
 */
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

import { EmptyState } from '@/components/EmptyState'
import { RecomposingFigure } from '@/components/RecomposingFigure'
import {
  Tooltip as Hint,
  TooltipContent as HintContent,
  TooltipProvider as HintProvider,
  TooltipTrigger as HintTrigger,
} from '@/components/ui/tooltip'
import type { PortfolioTotalsResponse } from '@/features/dashboard/lib/api'
import { heroReading, unpricedLines, type DashboardRange } from '@/features/dashboard/lib/dashboard'
import type { PositionsResponse } from '@/features/shares/lib/api'
import type { RuntimeState } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { signClass } from '@/lib/sign'

interface DashboardHeadProps {
  /**
   * The two reads the block is **made of**, `null` while either is in flight —
   * or while one of them has failed, in which case the page renders its own
   * empty state instead of this block and names the failure there (#829).
   */
  positions: PositionsResponse | null
  totals: PortfolioTotalsResponse | null
  /** This process's own state: it decides whether the newest row is today's. */
  runtime: RuntimeState | null
  /** The period the page holds, which the variation line shares with the chart. */
  range: DashboardRange
  /** The chart and its controls, composed by the page, which owns the range. */
  chart?: ReactNode
}

export function DashboardHead({
  positions,
  totals,
  runtime,
  range,
  chart = null,
}: DashboardHeadProps) {
  const { t } = useI18n()
  const f = useFormatters()

  // A read that has not landed is not a fact, and the two the block needs are
  // waited for together: `totals` alone would print « no ledger » under a
  // portfolio that has one for as long as `positions` took.
  if (!positions || !totals) return null

  const rows = positions.positions
  const totalsRow = totals.totals
  const currency = positions.base_currency ?? totals.base_currency ?? null

  // The two empties are not the same: *no events at all* is a sentence and a
  // way to the ledger; *events, nothing held* is an ordinary page.
  if (rows.length === 0 && totalsRow === null) {
    return (
      <EmptyState
        title={t('dashboard.empty.title')}
        description={t('dashboard.empty.body')}
        action={
          <Link to="/ledger" className="font-medium underline underline-offset-4">
            {t('empty.toLedger')}
          </Link>
        }
      />
    )
  }

  // A row from a past day is not the value (#1260).
  const reading = totalsRow === null ? 'valued' : heroReading(totalsRow, runtime, new Date())
  const valued = reading === 'valued'
  const unpriced = reading === 'partial' ? unpricedLines(rows) : []

  // On an install with no cash ledger `total_value` is NULL (#708) and the
  // value is the securities' alone, said under its own name.
  const totalValue = totalsRow?.total_value ?? null
  const holdingsValue = totalsRow?.holdings_value ?? null
  const heroIsHoldings = totalValue === null && holdingsValue !== null
  const heroValue = totalValue ?? holdingsValue

  const variation = totalsRow?.variation?.[range] ?? null
  const firstDeposit = totalsRow?.variation?.MAX?.start_date ?? null
  const cash = heroIsHoldings ? null : (totalsRow?.cash ?? null)
  const netIfSold = heroIsHoldings ? null : (totalsRow?.net_if_sold_today ?? null)
  const contributed = totalsRow?.net_contributed ?? null
  const gain = totalsRow?.gain_total ?? null
  const xirr = totalsRow?.xirr ?? null

  // The two-colour bar: what was put in, and the gain on top of it.
  const gainShare =
    valued && totalValue !== null && totalValue > 0 && gain?.amount != null
      ? Math.min(Math.max(gain.amount / totalValue, 0), 1)
      : null

  const statement: [string, ReactNode][] = []
  if (valued && firstDeposit !== null) {
    statement.push([t('dashboard.firstDeposit'), f.date(firstDeposit)])
  }
  if (valued && cash !== null) {
    statement.push([t('dashboard.cash'), f.currency(cash, currency)])
  }
  if (valued && netIfSold !== null) {
    const estimated = totalsRow?.estimated_accounts ?? []
    statement.push([
      t('dashboard.netIfSold'),
      <Hint key="net">
        <HintTrigger asChild>
          <span
            tabIndex={0}
            className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {f.currency(netIfSold, currency)}
          </span>
        </HintTrigger>
        <HintContent>
          {estimated.length === 0
            ? t('dashboard.netIfSold.gross')
            : t('dashboard.netIfSold.estimated', {
                count: estimated.length,
                accounts: f.list(estimated),
              })}
        </HintContent>
      </Hint>,
    ])
  }

  return (
    <HintProvider>
      <div className="flex flex-col">
        <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
          <div
            role="group"
            aria-label={t(
              heroIsHoldings && valued ? 'dashboard.holdings' : 'dashboard.portfolioValue',
            )}
            className="flex min-w-0 flex-col gap-2.5"
          >
            <p className="text-md text-muted-foreground">
              {t(heroIsHoldings && valued ? 'dashboard.holdings' : 'dashboard.portfolioValue')}
            </p>
            <p className="fig text-hero font-medium tracking-hero">
              {valued ? (
                // Keyed by what it measures: the value and the securities are
                // two figures, and one never recomposes into the other.
                <RecomposingFigure
                  key={heroIsHoldings ? 'holdings' : 'portfolio'}
                  value={heroValue}
                  currency={currency}
                />
              ) : (
                // An empty plane of the figure's height (#795): no skeleton.
                <span aria-hidden className="invisible">
                  &nbsp;
                </span>
              )}
            </p>
            {valued && variation?.amount != null ? (
              <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
                <span className={`fig text-prose ${signClass(variation.amount)}`}>
                  {f.signedCurrency(variation.amount, currency)}
                </span>
                {variation.pct == null ? null : (
                  <span className={`fig text-sm ${signClass(variation.pct)}`}>
                    ({f.percent(variation.pct, 1, 1)})
                  </span>
                )}
                <span className="text-muted-foreground">
                  {t('dashboard.variation.since', {
                    range,
                    date: f.date(variation.start_date),
                  })}
                </span>
              </p>
            ) : null}
            {reading === 'partial' ? (
              <div className="max-w-prose space-y-1 text-md text-muted-foreground">
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
          </div>

          {statement.length === 0 ? null : (
            <dl
              aria-label={t('dashboard.trajectory')}
              className="grid grid-cols-[auto_auto] items-baseline gap-x-6 gap-y-1.5 pb-1.5"
            >
              {statement.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-right text-sm text-muted-foreground">{label}</dt>
                  <dd className="fig text-right text-md">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        {valued && (contributed !== null || gain?.amount != null || xirr !== null) ? (
          <div className="mt-5 flex flex-col gap-2.5">
            {gainShare === null ? null : (
              <div
                role="img"
                aria-label={t('dashboard.bar', {
                  contributed: f.percentPoints((1 - gainShare) * 100, 1),
                  gain: f.percentPoints(gainShare * 100, 1),
                })}
                className="flex h-2.5 gap-0.5 overflow-hidden rounded-xs"
              >
                <span className="block bg-alloc-5" style={{ flex: 1 - gainShare }} />
                <span className="block bg-alloc-1" style={{ flex: gainShare }} />
              </div>
            )}
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5">
              <p className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
                {contributed === null ? null : (
                  <span className="inline-flex items-baseline gap-2">
                    <span aria-hidden className="size-2 self-center rounded-xs bg-alloc-5" />
                    <span className="text-muted-foreground">
                      {t('dashboard.chart.contributed')}
                    </span>
                    <span className="fig text-prose">{f.currency(contributed, currency)}</span>
                  </span>
                )}
                <span
                  role="group"
                  aria-label={t('dashboard.gainTotal')}
                  className="inline-flex items-baseline gap-2"
                >
                  <span aria-hidden className="size-2 self-center rounded-xs bg-alloc-1" />
                  <span className="text-muted-foreground">{t('dashboard.gainTotal')}</span>
                  {gain?.amount == null ? (
                    <span className="fig text-prose">—</span>
                  ) : (
                    <>
                      <span className={`fig text-prose ${signClass(gain.amount)}`}>
                        {f.signedCurrency(gain.amount, currency)}
                      </span>
                      {gain.pct == null ? null : (
                        <span className={`fig text-sm ${signClass(gain.pct)}`}>
                          ({f.percent(gain.pct, 1, 1)})
                        </span>
                      )}
                    </>
                  )}
                </span>
              </p>
              {xirr === null ? null : (
                <p className="text-muted-foreground">
                  {t('dashboard.xirr.line', { value: f.percentPoints(xirr * 100, 2) })}
                </p>
              )}
            </div>
          </div>
        ) : null}

        {chart === null ? null : <div className="mt-9">{chart}</div>}

        {/* `totals: null` has two causes and they are not one sentence (#745):
        no ledger at all, or a reporting currency nobody has answered. */}
        {totalsRow === null ? (
          <p className="max-w-prose text-md text-muted-foreground">
            {currency === null ? t('dashboard.awaitingCurrency') : t('dashboard.withoutLedger')}
          </p>
        ) : null}
      </div>
    </HintProvider>
  )
}
