/**
 * The accounts page (#721, ADR-0019, ADR-0016).
 *
 * It exists to answer *which of my accounts is working*, and it is the only one
 * of the four that had been **rendered and never judged**: measured on a
 * declared account it reproduced the dashboard's head to the cent, and its
 * *compared performance* drew a series. At N = 2 what the measurement showed is
 * not that each column discriminates — it is that **the instrument of
 * comparison was not one**. `pea 171,5` against `TR 115,0` compares 6,8 years
 * with 2,4.
 *
 * Three page-level objects, and each is a decision:
 *
 *  - **One range control**, driving the chart **and** the table's `perf` column.
 *    Two would be two announcers contradicting each other, which is the defect
 *    the dashboard has already paid for once.
 *  - **One mention of the date**, at the level of the page — the money figures
 *    are a **day**, and a table of money with no date reads as *now*. The
 *    *interval* is deliberately not written in words anywhere: the range control
 *    already carries it, and a sentence repeating it would be the second
 *    announcer under another name.
 *  - **A subtitle that tells the two rates apart**, because an account can show
 *    `−0,62 €` of gain and `+15 %` of performance in the same row, and both are
 *    correct.
 *
 * Reads and failures follow the shares page's rule and for the same reason:
 * `/api/runtime` answers from process memory and never opens the store (#668),
 * so the shell's banner is silent on the one failure that empties this page.
 */
import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueries, useQuery } from '@tanstack/react-query'

import { AccountSheet } from '@/components/accounts/AccountSheet'
import { AccountsChart } from '@/components/accounts/AccountsChart'
import { AccountsTable } from '@/components/accounts/AccountsTable'
import { Band } from '@/components/Band'
import { EmptyState } from '@/components/EmptyState'
import {
  buildAccountRows,
  DEFAULT_RANGE,
  figuresAsOf,
  isDefaultAccount,
  portfolioRow,
  PORTFOLIO_KEY,
  rebase,
  seriesColour,
  sortRows,
  visibleColumns,
  windowStart,
  type FigureColumn,
  type Range,
  type Sort,
} from '@/lib/accounts'
import { api } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { oneBand, readConditions } from '@/lib/status'

export default function AccountsPage() {
  const { t } = useI18n()
  const f = useFormatters()
  const [range, setRange] = useState<Range>(DEFAULT_RANGE)
  const [selected, setSelected] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort | null>(null)

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: api.portfolioTotals })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })

  const declared = accounts.data?.accounts ?? []

  // One read per account, and the whole series each time. The bound this page
  // applies is a `max` over the accounts' openings, and no payload states an
  // opening — so the series is what defines the longest window, and asking the
  // server for that window would mean knowing it before reading what defines
  // it. Read once for the four presets, which is also what keeps the chart and
  // the table's scalar column one arithmetic rather than two.
  const histories = useQueries({
    queries: declared.map((account) => ({
      queryKey: ['account-history', account.id],
      queryFn: () => api.accountHistory(account.id),
    })),
  })
  const portfolioHistory = useQuery({
    queryKey: ['portfolio-totals-history'],
    queryFn: api.portfolioTotalsHistory,
  })

  const failure = oneBand(
    readConditions({
      shellError: runtime.error,
      errors: [
        accounts.error,
        totals.error,
        // The fourth read of the page, and it feeds a cell like the other
        // three: without it a failing `/api/portfolio-totals/history` renders
        // the `Portefeuille` row's `perf` as a silent dash — *there is nothing
        // to compute* said about a store that did not answer.
        portfolioHistory.error,
        ...histories.map((one) => one.error),
      ],
    }),
  )

  const points = histories.map((one) => one.data?.points ?? [])
  const from = windowStart(range, new Date(), points)

  // `useQueries` hands back a new array on every render, so the rebasing is
  // memoised against what actually moved: when each read landed, which accounts
  // there are, and the window. Selecting a curve or sorting a column must not
  // replay a few thousand points per account.
  const stamp = `${histories.map((one) => one.dataUpdatedAt).join('|')} ${declared
    .map((account) => account.id)
    .join('|')} ${from}`
  const rebased = useMemo(
    () =>
      from === null
        ? []
        : declared.map((account, index) => rebase(account.id, points[index] ?? [], from)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stamp],
  )

  const portfolioSeries =
    from === null ? null : rebase(PORTFOLIO_KEY, portfolioHistory.data?.points ?? [], from)

  const performance = new Map(rebased.map((one) => [one.key, one.performance]))
  const rows = buildAccountRows(declared, performance)
  const visible = visibleColumns(rows)
  const currency = totals.data?.base_currency ?? null

  // The colour a curve is drawn in, by account — the chart draws in row order,
  // so the swatch in the table and the line in the plot cannot drift apart.
  const drawnKeys = rebased.filter((one) => one.points.length > 0).map((one) => one.key)
  const colourOf = (account: string) => {
    const index = drawnKeys.indexOf(account)
    return index === -1 ? null : seriesColour(index)
  }

  const labels = new Map(
    declared.map((account) => [
      account.id,
      isDefaultAccount(account.id) ? t('accounts.default.label') : account.label ?? account.id,
    ]),
  )

  // At N = 1 there is no `Portefeuille` line: it would copy the single row
  // above it, with a rule drawn between a line and itself. The page itself
  // survives — it leaves the **navigation**, never the route, so a bookmark
  // that was valid yesterday does not cost a 404 (`AppSidebar`).
  const portfolio =
    rows.length > 1 ? portfolioRow(totals.data?.totals ?? null, portfolioSeries?.performance ?? null) : null

  const asOf = figuresAsOf(portfolio === null ? rows : [...rows, portfolio])

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('page.accounts')}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">{t('accounts.subtitle')}</p>
        {asOf === null ? null : (
          <p className="text-sm text-muted-foreground">
            {t('accounts.asOf', { date: f.date(asOf) })}
          </p>
        )}
      </header>

      {failure ? <Band>{t(failure.message)}</Band> : null}

      {/* A read that has not landed is not a fact: nothing is claimed while the
          declaration is in flight, and above all not that there is none. */}
      {failure || !accounts.data ? null : rows.length === 0 ? (
        <EmptyState
          title={t('accounts.empty.title')}
          description={t('accounts.empty.body')}
          action={
            <Link to="/donnees" className="font-medium underline underline-offset-4">
              {t('accounts.empty.link')}
            </Link>
          }
        />
      ) : (
        <>
          <AccountsChart
            series={rebased}
            labels={labels}
            range={range}
            onRangeChange={setRange}
            selected={selected}
          />
          <AccountsTable
            rows={sortRows(rows, sort)}
            portfolio={portfolio}
            visible={visible}
            currency={currency}
            rebuilding={runtime.data?.rebuilding ?? null}
            selected={selected}
            // **Posé, jamais basculé.** Le basculement servait un clic, qui a
            // deux états à alterner ; le survol en a deux qu'il nomme lui-même
            // — entrer et sortir — et un basculement les ferait se battre dès
            // que la souris repasse sur la même ligne.
            onSelect={setSelected}
            onOpen={setOpened}
            sort={sort}
            onSort={(column: FigureColumn) =>
              setSort((previous) =>
                previous?.column === column
                  ? { column, direction: previous.direction === 'asc' ? 'desc' : 'asc' }
                  : { column, direction: 'desc' },
              )
            }
            colourOf={colourOf}
          />
        </>
      )}

      <AccountSheet
        row={rows.find((row) => row.id === opened) ?? null}
        onClose={() => setOpened(null)}
      />
    </div>
  )
}
