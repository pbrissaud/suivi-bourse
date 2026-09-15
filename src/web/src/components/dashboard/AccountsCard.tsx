/**
 * The accounts, compared — on the dashboard now.
 *
 * What travels with it is not the table, it is the rule — and the rule is the
 * whole of why this file exists rather than a `<Sparkline>` beside a name:
 *
 *  - **One range for every figure drawn on the card, sparkline included.** The
 *    curve and the percentage beside it are read off the *same* rebasing
 *    (`lib/accounts.ts`), so they cannot answer *how did this period go* twice.
 *  The longest window is the youngest account's opening, which only the series
 *  states — hence one whole series read per account and the bound applied to
 *  the *drawing*.
 *  - **The N series are waited for together.** The comparison *is* the object:
 *    an account landing after the others moves the day every curve is rebased
 *    on, and the whole card would be redrawn under the reader's eyes. Until
 *    they have all landed the card renders **nothing at all, title included**.
 *
 *  - **At one account there is no card, and no read either.** A comparison of
 *    one account against nothing is the head's own figure with a border around
 *    it, and *a block with nothing in it does not exist*.
 *  The block's emptiness is therefore decided on what came back and not on the
 *  window: no account with a performance is *nothing to compare over this
 *  range*, which is a named absence. Per row the em dash stands, and there it
 *  is right — an account with no cash movement has no index at all (#708).
 *  - **A series that failed to read empties the card, and the card says why**
 *    (#799, then #829).
 *  - **The reads are the page's** for that reason, and they cross as `readonly
 *    PerfPoint[] | null` per account: *failed* and *in flight* are one silence
 *    in the block, and are told apart one level up.
 *
 * The curve is stroked in `--foreground` and never in the mint, which is the
 * rule the dashboard's own performance reading already holds: a rebased index
 * crosses its base, and a portfolio down 8 % would draw its whole descent in
 * the colour the app uses for a gain.
 */
import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer } from 'recharts'

import { EmptyState } from '@/components/EmptyState'
import { Unreadable } from '@/components/Unreadable'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  accountColour,
  DEFAULT_ACCOUNT_LABEL,
  declaredLabel,
  rebase,
  settledSeries,
  windowStart,
  type Range,
} from '@/lib/accounts'
import type { Account, PerfPoint } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { signClass } from '@/lib/sign'
import type { ReadFailure } from '@/lib/status'
import { cn } from '@/lib/utils'

interface AccountsCardProps {
  /**
   * What is declared.
   */
  accounts: readonly Account[] | null
  /**
   * One series per declared account, in the accounts' own order. Each is `null`
   * while its own read has not answered, and the card waits for **all** of them
   * (see {@link settledSeries}): the comparison *is* the object.
   */
  series: readonly (readonly PerfPoint[] | null)[]
  /**
   * The page's period.
   */
  range: Range
  /** The reporting currency the values are said in. */
  currency: string | null
  /**
   * The card's own reads, refused — the declaration or any of the series. In
   * flight the card draws nothing and claims nothing; refused, it says so where
   * the comparison would have been (#829).
   */
  failure?: ReadFailure | null
}

export function AccountsCard({
  accounts,
  range,
  currency,
  series,
  failure = null,
}: AccountsCardProps) {
  const { t } = useI18n()
  const f = useFormatters()

  const declared = accounts ?? []
  /** Two accounts is where a comparison starts — and where the page's reads do. */
  const comparable = declared.length > 1

  const landed = settledSeries(series)
  const from = landed === null ? null : windowStart(range, new Date(), landed)

  // The rebasing is memoised against what actually moved: the series the page
  // hands down — itself memoised there against when each read landed, which is
  // what makes this array a stable dependency — the accounts, and the window.
  //
  // `settledSeries` is called a second time **inside** rather than closed over,
  // and it is not a duplication for its own sake: it answers a fresh array on
  // every call, so a dependency on it would move on every render and the memo
  // would compute the rebasing each time. It is a loop over a handful of reads;
  // `rebase` is a loop over some two and a half thousand days per account.
  const rebased = useMemo(() => {
    const settled = settledSeries(series)
    if (from === null || settled === null || accounts === null) return []
    return accounts.map((account, index) => rebase(account.id, settled[index] ?? [], from))
  }, [series, accounts, from])

  // Nothing at all while any of it is in flight, title included,
  // and nothing where there is only one account to compare — a comparison of
  // one is the head's own figure with a border round it.
  //
  // A read that **failed** is neither of those, and it is named here since
  // #829: there is no band left to name it, and a card that vanished over a
  // `503` would take its reason with it. It is checked **before** the
  // one-account case on purpose — `comparable` is counted off the declaration,
  // so when that is what failed, *there is nothing to compare* is not a fact
  // this card holds. At one account the declaration answered and no series is
  // read at all, so there is no failure to reach this line with.
  if (failure !== null && (accounts === null || landed === null)) {
    return <Unreadable failure={failure} />
  }
  if (accounts === null || !comparable || landed === null) return null

  /** How many accounts the window actually says something about. */
  const drawn = rebased.filter((series) => series.performance !== null).length

  return (
    <Card className="gap-4">
      <CardHeader>
        {/* **The perimeter names itself here** (#838). The drawing heads this
            card with the count of accounts the figures are consolidated over,
            as a link to the page that holds them — so the statistic block one
            card up carries no `2 comptes` line, and the count is stated once,
            on the surface that *is* the comparison. */}
        <h2 className="eyebrow">
          <Link to="/accounts" className="inline-flex items-center gap-1.5 hover:text-foreground">
            {t('dashboard.scope', { count: declared.length })}
            <ArrowRight aria-hidden className="size-2.75" />
          </Link>
        </h2>
      </CardHeader>
      <CardContent>
        {drawn === 0 ? (
          // A **fact**: the reads have landed and not one account's series says
          // anything over this window, which is what an empty perf cache looks
          // like — named, rather than spelled as N em dashes.
          <EmptyState title={t('dashboard.accounts.empty')} />
        ) : (
          <ul aria-label={t('dashboard.accounts.title')} className="flex flex-col gap-4">
            {declared.map((account, index) => {
              const series = rebased[index]
              const performance = series?.performance ?? null
              return (
                <li key={account.id} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {declaredLabel(account) ?? t(DEFAULT_ACCOUNT_LABEL)}
                    </span>
                    {/* What the account is worth, which is the figure the two
                        rates below are rates *of*. Set in the mono face like
                        every other amount read down a column. */}
                    <span className="tabular shrink-0 font-mono text-sm">
                      {f.currency(account.total_value ?? null, currency)}
                    </span>
                  </div>
                  {/* The curve and the windowed figure beside it are one
                      rebasing over one window — the card's whole rule, made
                      structural. The hue is the account's own, and it is the
                      rail's wheel rather than a second one. */}
                  <span aria-hidden className="block h-7.5">
                    {series && series.points.length > 1 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={series.points}>
                          <Line
                            type="monotone"
                            dataKey="index"
                            stroke={accountColour(index)}
                            strokeWidth={1.5}
                            dot={false}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : null}
                  </span>
                  <p className="text-xs text-muted-foreground">
                    {t('accounts.chart.rangeName', { range })}
                    {' · '}
                    {t('dashboard.accounts.perf')}{' '}
                    {/* The em dash, and it is right: an account with no cash
                        movement has no index at all (#708), so there is nothing
                        to compute rather than something missing. */}
                    <span className={cn('tabular', signClass(performance))}>
                      {performance === null ? ABSENT : f.percent(performance)}
                    </span>
                    {' · '}
                    {t('dashboard.accounts.xirr')}{' '}
                    <span className={cn('tabular', signClass(account.xirr ?? null))}>
                      {f.percent(account.xirr ?? null)}
                    </span>
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
