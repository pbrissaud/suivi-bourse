/**
 * The accounts, compared — on the dashboard now (ADR-0028, ADR-0019).
 *
 * ADR-0019 built the comparison as an eight-column table under one range
 * control, on a page that has since become a master-detail: **a page showing
 * one account at a time cannot compare accounts**, so the comparison changes
 * address and this card is the new one. What travels with it is not the table,
 * it is the rule — and the rule is the whole of why this file exists rather
 * than a `<Sparkline>` beside a name:
 *
 *  - **One range for every figure drawn on the card, sparkline included.** The
 *    curve and the percentage beside it are read off the *same* rebasing
 *    (`lib/accounts.ts`), so they cannot answer *how did this period go* twice.
 *    A thirty-day sparkline beside a one-year percentage is the defect ADR-0019
 *    measured, one surface further along.
 *  - **`MAX` is not offered**, for ADR-0019's own reason and not by
 *    inheritance: a time-weighted index has no bounded amplitude, so one
 *    account's ancient volatility sets the scale for every other. The longest
 *    window is the youngest account's opening, which only the series states —
 *    hence one whole series read per account and the bound applied to the
 *    *drawing*.
 *  - **The N series are waited for together.** The comparison *is* the object:
 *    an account landing after the others moves the day every curve is rebased
 *    on, and the whole card would be redrawn under the reader's eyes. Until
 *    they have all landed the card renders **nothing at all, title included**
 *    (ADR-0026).
 *  - **At one account there is no card, and no read either.** A comparison of
 *    one account against nothing is the head's own figure with a border around
 *    it, and *a block with nothing in it does not exist*. The guard is on the
 *    **queries** rather than on the rendering, because ADR-0013 seeds a
 *    `default` row that is never removed: the single-account install is the
 *    ordinary one, and gated on the rendering alone every dashboard load
 *    fetched that account's whole daily series — some 2 500 points — to throw
 *    it away.
 *  - **Nothing drawable is said, not dashed.** `windowStart` answers `null` on
 *    `SINCE_OPENING` alone, so an empty perf cache — a fresh install whose
 *    backfill has not run — left the other three presets rendering an em dash
 *    per account, which by ADR-0016 says *there is nothing to compute* about a
 *    history that is merely not rebuilt yet. The block's emptiness is therefore
 *    decided on what came back and not on the window: no account with a
 *    performance is *nothing to compare over this range*, which is a named
 *    absence. Per row the em dash stands, and there it is right — an account
 *    with no cash movement has no index at all (#708).
 *  - **A series that failed to read makes the card vanish rather than speak**,
 *    which is `PortfolioChart`'s own behaviour on its two series and follows
 *    from `lib/status.ts`: there is one band on screen or none, and the head's
 *    is the announcer of a store that will not answer — these N reads open no
 *    store the two the head waits for have not opened first.
 *
 * The curve is stroked in `--foreground` and never in the mint, which is the
 * rule the dashboard's own performance reading already holds: a rebased index
 * crosses its base, and a portfolio down 8 % would draw its whole descent in
 * the colour the app uses for a gain.
 *
 * It carries **no convention bubble of its own**: ADR-0016 puts one icon per
 * figure *and per surface*, and the head's `TWR` bubble — four figures up the
 * same page — is where the time-weighted convention is stated, warning about
 * the period in the sentence this card's percentage rests on.
 */
import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Line, LineChart, ResponsiveContainer } from 'recharts'

import { EmptyState } from '@/components/EmptyState'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  DEFAULT_ACCOUNT_LABEL,
  DEFAULT_RANGE,
  RANGES,
  declaredLabel,
  rebase,
  settledSeries,
  windowStart,
  type Range,
} from '@/lib/accounts'
import { api, type PerfPoint } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { signClass } from '@/lib/sign'
import { cn } from '@/lib/utils'

export function AccountsCard() {
  const { t } = useI18n()
  const f = useFormatters()
  const [range, setRange] = useState<Range>(DEFAULT_RANGE)

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  const declared = accounts.data?.accounts ?? []
  /** Two accounts is where a comparison starts — and where the reads do. */
  const comparable = declared.length > 1

  // One read per account, and the whole series each time — the same arrangement
  // the accounts page has, and for the same reason: the bound this card applies
  // is a `max` over the accounts' openings, and no payload states an opening.
  const histories = useQueries({
    queries: comparable
      ? declared.map((account) => ({
          queryKey: ['account-history', account.id],
          queryFn: () => api.accountHistory(account.id),
        }))
      : [],
  })

  // `?? null` and never `?? []`: an empty series is a **payload** — an account
  // whose perf cache says nothing — and a request in flight is not one.
  const points: (readonly PerfPoint[] | null)[] = histories.map((one) => one.data?.points ?? null)
  const landed = settledSeries(points)
  const from = landed === null ? null : windowStart(range, new Date(), landed)

  // `useQueries` hands back a new array on every render, so the rebasing is
  // memoised against what actually moved: when each read landed, which accounts
  // there are, and the window.
  const stamp = `${histories.map((one) => one.dataUpdatedAt).join('|')} ${declared
    .map((account) => account.id)
    .join('|')} ${from}`
  const rebased = useMemo(
    () =>
      from === null || landed === null
        ? []
        : declared.map((account, index) => rebase(account.id, landed[index] ?? [], from)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stamp],
  )

  // Nothing at all while any of it is in flight, title included (ADR-0026) —
  // and nothing either where there is only one account to compare.
  if (!accounts.data || !comparable || landed === null) return null

  /** How many accounts the window actually says something about. */
  const drawn = rebased.filter((series) => series.performance !== null).length

  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{t('dashboard.accounts.title')}</h2>
        {/* **The** range control of the card, and it drives both figures on
            every row. Radios rather than tabs: it is a setting of one thing. */}
        <div
          role="radiogroup"
          aria-label={t('dashboard.accounts.range')}
          className="flex shrink-0 gap-1"
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

      <CardContent>
        {drawn === 0 ? (
          // A **fact**: the reads have landed and not one account's series says
          // anything over this window, which is what an empty perf cache looks
          // like — named, rather than spelled as N em dashes.
          <EmptyState title={t('dashboard.accounts.empty')} />
        ) : (
          <ul aria-label={t('dashboard.accounts.title')} className="divide-y divide-border/60">
            {declared.map((account, index) => {
              const series = rebased[index]
              const performance = series?.performance ?? null
              return (
                <li key={account.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {declaredLabel(account) ?? t(DEFAULT_ACCOUNT_LABEL)}
                  </span>
                  {/* The curve and the figure beside it are one rebasing over
                      one window — the card's whole rule, made structural. */}
                  <span aria-hidden className="h-7 w-20 shrink-0 sm:w-28">
                    {series && series.points.length > 1 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={series.points}>
                          <Line
                            type="monotone"
                            dataKey="index"
                            stroke="var(--foreground)"
                            strokeWidth={1.5}
                            dot={false}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : null}
                  </span>
                  <span className={cn('tabular w-20 shrink-0 text-right', signClass(performance))}>
                    {/* The em dash, and it is right: an account with no cash
                        movement has no index at all (#708), so there is
                        nothing to compute rather than something missing. */}
                    {performance === null ? ABSENT : f.percent(performance)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
