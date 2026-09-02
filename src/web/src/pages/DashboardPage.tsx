/**
 * The dashboard — the head (#718), then the chart and the movers (#727).
 *
 * Four page-level decisions live here rather than in a block:
 *
 *  - **Two permanent time announcers at most**, and they are the mention under
 *    the title (*as of 7 August 2026, 17:42* — the freshest quote the page
 *    holds) and the movers' **reference close**, which is a different instant
 *    and is the subject of that block. The two transitory ones are elsewhere by
 *    construction: the time-weighted return's base date, on the head and only
 *    while it moves, and the reconstruction's progress, which is a card of the
 *    notifications panel since #829 (ADR-0037) and only there.
 *  - **No installation fact lands here.** A notice posted on the dashboard is invisible
 *    to whoever lands on another page, and it would compete with the one global
 *    indicator — the bell since #829 (ADR-0037), the banner before it.
 *  - **`/` is the dashboard unconditionally**, zero events included: a bookmark
 *    valid yesterday is valid tomorrow, and a redirection conditioned on data is
 *    how an app takes its reader somewhere they did not ask for.
 *  - **The four states are one decision** (`lib/dashboard.ts`), not a `?.length`
 *    per block: *no events* is a sentence and a link, while *events and nothing
 *    held* is an ordinary page whose blocks each say why they are empty.
 *  - **The page reads, the blocks render** (#799). Every read the dashboard
 *    makes is declared here and handed down; what may be *not answered yet*
 *    crosses as `readonly X[] | null` and never as `[]` (ADR-0026). It is not a
 *    tidying: a read declared inside the block that consumes it is a read whose
 *    failure nothing above it can name, which is exactly how a `503` on
 *    `/api/portfolio-totals/history` took the chart off the dashboard on every
 *    load without a word on screen.
 *  - **A failed read is named where its content would have been** (#829,
 *    ADR-0037). There is no band: the strip that carried this sentence across
 *    the top of the column is gone and is not replaced, so *this did not answer*
 *    is said by the surface that is empty because of it — the page when the two
 *    reads it is *made of* fail, the block when its own read does. That is the
 *    same repair #799 made, kept: a failed sparkline still costs the reader
 *    nothing but the sparkline, and the total gain and its four terms stay on
 *    screen. What it drops is the announcer at the top, which put the emptiness
 *    at one end of the screen and its reason at the other.
 *  - **What empties the page and what empties a block are two lists.**
 *    `dashboardState` takes the two reads the page is *made of*; each block's
 *    own read is handed to that block. Folded into one, a failed accounts read
 *    would put the page in `failed` and empty it — the very disappearance being
 *    repaired, one level up.
 *  - **It is a column, and it was a plateau** (#787, #790, then #838). Two
 *    tracks from `lg` — the head and the chart drawn on the wide one, the
 *    movements and the comparison read down the rail — is what the drawing was
 *    read as on its source; read **rendered** it lays the head and the chart
 *    across the full width and puts the two lists side by side under them. The
 *    split the plateau encoded survives as that row: what is *drawn* is above,
 *    what is *read down* is below, and the two lists are half the page each
 *    from `md` instead of a third of it from `lg`.
 *  - **One range control, and it is the page's** (#838, ADR-0019). It sits on a
 *    row of its own between the head and the chart, preceded by the extent it
 *    selects, and it drives the chart and the comparison alike. There were two
 *    — the chart's and the accounts card's — offering the same four options one
 *    row apart and answering differently; ADR-0019's *one range for every figure
 *    on the surface* is kept by there being one control rather than one per
 *    card, and `ACCOUNT_RANGE` is where the comparison's own vocabulary for it
 *    is stated.
 */
import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'

import { Segmented } from '@/components/Segmented'
import { Unreadable } from '@/components/Unreadable'
import { AccountsCard } from '@/components/dashboard/AccountsCard'
import { DashboardHead } from '@/components/dashboard/Head'
import { InvestmentRhythm } from '@/components/dashboard/InvestmentRhythm'
import { Movers } from '@/components/dashboard/Movers'
import { PortfolioChart } from '@/components/dashboard/PortfolioChart'
import { NoBaseCurrency } from '@/components/NoBaseCurrency'
import { api, type PerfPoint } from '@/lib/api'
import {
  ACCOUNT_RANGE,
  DASHBOARD_RANGES,
  DEFAULT_DASHBOARD_RANGE,
  dashboardState,
  hasCashLedger,
  windowFloor,
  type DashboardRange,
} from '@/lib/dashboard'
import { useFormatters } from '@/lib/format'
import { currencyUnanswered } from '@/lib/firstRun'
import { useI18n } from '@/lib/i18n'
import { buildShareRows } from '@/lib/shares'
import { oneFailure, readConditions } from '@/lib/status'
import { usePageHeading } from '@/lib/pageHeading'

export default function DashboardPage() {
  const { t } = useI18n()
  const f = useFormatters()

  const [range, setRange] = useState<DashboardRange>(DEFAULT_DASHBOARD_RANGE)

  const positions = useQuery({ queryKey: ['positions'], queryFn: api.positions })
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: api.portfolioTotals })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  // The same read the bell and the first-run modal compose their own
  // predicates from — one query key, so it is one request and no new API state.
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })

  // **The two reads the page is made of, and them alone.** A block's own read
  // failing removes that block and is named **by that block**, in the slot the
  // content would have filled; it never puts the page in `failed`, which is a
  // screen with nothing on it but a sentence.
  const state = dashboardState({
    failed: Boolean(
      oneFailure(readConditions({ errors: [positions.error, totals.error] })),
    ),
    positions: positions.data,
    totals: totals.data,
  })

  // Exactly one of the two series is read, and the discriminant is the same one
  // that decides the chart's reading: an install with no cash event has no perf
  // series at all, and one with a cash ledger has no use for the valuation
  // curve. The head reduces the first for its *today* pill, so there is one
  // read here and two consumers below.
  const ledger = hasCashLedger(totals.data?.totals ?? null)
  const perf = useQuery({
    queryKey: ['portfolio-totals-history'],
    queryFn: api.portfolioTotalsHistory,
    enabled: state === 'portfolio' && ledger,
  })
  const valuation = useQuery({
    queryKey: ['positions-history'],
    queryFn: api.positionsHistory,
    enabled: state === 'portfolio' && !ledger,
  })

  const declared = accounts.data?.accounts ?? []
  // One read per account, and the whole series each time: the bound the card
  // applies is a `max` over the accounts' openings, and no payload states an
  // opening. Two accounts is where a comparison starts — and where the reads
  // do: ADR-0013 seeds a `default` row that is never removed, so gated on the
  // rendering alone every load would fetch that one account's whole daily
  // series to throw it away.
  const histories = useQueries({
    queries:
      state === 'portfolio' && declared.length > 1
        ? declared.map((account) => ({
            queryKey: ['account-history', account.id],
            queryFn: () => api.accountHistory(account.id),
          }))
        : [],
  })

  // `?? null` and never `?? []`: an empty series is a **payload** — an account
  // whose perf cache says nothing — and a request that has not answered is not
  // one. `useQueries` hands back a new array on every render, so the flattening
  // is memoised against what actually moved: when each read landed, and which
  // accounts there are.
  const stamp = `${histories.map((one) => one.dataUpdatedAt).join('|')} ${declared
    .map((account) => account.id)
    .join('|')}`
  const series: readonly (readonly PerfPoint[] | null)[] = useMemo(
    () => histories.map((one) => one.data?.points ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stamp],
  )

  // The rows are the shares page's, folded by symbol: one arithmetic for what a
  // line is worth (ADR-0004's carrying convention included), so this page and
  // that table cannot disagree about the same portfolio. The failure counter is
  // a rendering concern there and has no subject here, so the map is empty.
  //
  // The movers take the rows **whole**, closed lines included, and reduce them
  // with `isClosed`: what is in the portfolio is one question, and answering it
  // twice is what put a sold line in the movers' own sentence.
  const rows = useMemo(
    () => buildShareRows(positions.data?.positions ?? [], new Map()),
    [positions.data],
  )

  // The movers are read only once there is a portfolio to compare — and it is a
  // resource of its own rather than a member of the positions, so the shares
  // page, which does not want the second read, does not pay for it.
  const movers = useQuery({
    queryKey: ['movers'],
    queryFn: api.movers,
    enabled: state === 'portfolio',
  })

  // The investment rhythm (#751, ADR-0041). Read once there is a portfolio, like
  // the movers: it is derived from the ledger rather than from the perf series,
  // so it answers on an install whose reconstruction has never run — but a
  // dashboard that is not showing a portfolio is not showing this block either,
  // and a read nothing renders is a request nobody asked for.
  const rhythm = useQuery({
    queryKey: ['investment-rhythm'],
    queryFn: api.investmentRhythm,
    enabled: state === 'portfolio',
  })

  // **The two reads the page is made of**, and what they say when they fail:
  // the page is empty, and this is why. `oneFailure` keeps the first — an
  // unreadable store fails both at once, and one screen owes one sentence.
  const pageFailure = oneFailure(
    readConditions({ errors: [positions.error, totals.error] }),
  )

  // **One failure per block, handed to the block.** Each is the read that block
  // is made of, so what the reader loses is that block and what they are told
  // is why — in the space the chart, the list or the comparison would have
  // filled. The account series ride with the declaration: they are the same
  // card's second read, and `AccountsCard` draws nothing without either.
  const chartFailure = oneFailure(
    readConditions({ errors: [perf.error, valuation.error] }),
  )
  const moversFailure = oneFailure(readConditions({ errors: [movers.error] }))
  const rhythmFailure = oneFailure(readConditions({ errors: [rhythm.error] }))
  const accountsFailure = oneFailure(
    readConditions({ errors: [accounts.error, ...histories.map((one) => one.error)] }),
  )

  // **The extent the period covers**, beside the control that sets it. It is
  // read off the series the chart draws rather than computed from the range
  // alone: `MAX` has no floor to state, and a window whose floor predates the
  // first day recorded would announce an extent nothing was ever drawn over.
  const drawnDays = (ledger ? perf.data?.points : valuation.data?.points) ?? null
  const span = useMemo(() => {
    if (drawnDays === null || drawnDays.length === 0) return null
    const floor = windowFloor(range, new Date())
    const days = drawnDays
      .map((point) => point.t)
      .filter((day): day is string => day !== null && (floor === null || day >= floor))
    if (days.length === 0) return null
    return f.daySpan(days[0], days[days.length - 1])
  }, [drawnDays, range, f])

  // The freshest quote the page holds — one instant for the whole screen, and
  // nothing at all when nothing has ever been quoted: an invented *now* is
  // exactly the reading this mention exists to prevent.
  const pricedAt = rows.reduce<string | null>(
    (newest, row) =>
      row.price !== null && (newest === null || row.price.at > newest) ? row.price.at : newest,
    null,
  )

  // The name of the page and the instant its figures are of, both said in the
  // header (#789). The date waits for the read the way it always did: while
  // nothing has been quoted there is no instant, and an invented *now* is the
  // reading the mention exists to prevent.
  usePageHeading(
    t('page.dashboard'),
    pricedAt === null || state !== 'portfolio'
      ? null
      : t('dashboard.pricedAt', { date: f.dateTime(pricedAt) }),
  )

  // **The band's sentence, one floor down** (#829, ADR-0037). With no reporting
  // currency nothing is converted and the perf job writes nothing at all, so
  // this page would be a column of em dashes with no reason given anywhere. It
  // says why instead, and the ledger — where the events are *declared* — stays
  // readable throughout.
  //
  // `=== true` and never a truthy test: `undefined` is *the config has not
  // landed*, and a page emptied on a silence would be the claim ADR-0026
  // forbids.
  if (currencyUnanswered(config.data?.settings) === true) {
    return <NoBaseCurrency />
  }

  // **The page is what did not answer, and it says so where it is empty**
  // (#829, ADR-0037). `state` is `failed` on exactly this, and the head renders
  // nothing without its two reads — so without this the screen would be blank
  // and *the store is unreadable* would read as *you own nothing yet*.
  if (state === 'failed' && pageFailure !== null) {
    return <Unreadable failure={pageFailure} />
  }

  return (
    <div className="space-y-6">
      <DashboardHead
        positions={positions.data ?? null}
        totals={totals.data ?? null}
        rebuilding={runtime.data?.rebuilding ?? null}
        history={perf.data?.points ?? null}
      />

      {state !== 'portfolio' ? null : (
        <>
          {/* **One range control, and it is the page's** (#838, ADR-0019). The
              drawing sets it on a row of its own between the head and the
              chart, right-aligned and preceded by the extent it selects — so
              the chart, the movements and the comparison read the same window
              and no card announces a second one. Its two neighbours used to
              carry one each, which put two controls of the same four options on
              one screen saying different things. */}
          <div className="flex flex-wrap items-center justify-end gap-x-3.5 gap-y-2">
            {span === null ? null : (
              <span className="tabular font-mono text-xs text-muted-foreground">{span}</span>
            )}
            <Segmented
              bordered
              mode="radio"
              label={t('dashboard.chart.range')}
              value={range}
              onChange={setRange}
              options={DASHBOARD_RANGES.map((candidate) => ({
                value: candidate,
                label: t('dashboard.chart.rangeName', { range: candidate }),
              }))}
            />
          </div>

          <PortfolioChart
            ledger={ledger}
            range={range}
            currency={totals.data?.base_currency ?? null}
            performance={perf.data?.points ?? null}
            valuation={valuation.data?.points ?? null}
            failure={chartFailure}
          />

          {/* The two blocks that are **read down** rather than drawn, side by
              side from `md` and stacked under it. */}
          <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
            <Movers
              // `?? null` and never `?? []`: this read is armed only once the
              // page reaches `portfolio`, so there is a real window in which an
              // empty array would state *« Rien à comparer »* about movements
              // nobody has answered for (ADR-0026).
              movers={movers.data?.movers ?? null}
              reference={movers.data?.reference ?? null}
              rows={rows}
              currency={positions.data?.base_currency ?? null}
              failure={moversFailure}
            />
            {/* Allowed to render nothing at all: at one account a comparison is
                the head's own figure with a border round it. */}
            <AccountsCard
              accounts={accounts.data?.accounts ?? null}
              range={ACCOUNT_RANGE[range]}
              currency={positions.data?.base_currency ?? null}
              series={series}
              failure={accountsFailure}
            />
          </div>

          {/* **A block and not a page** (ADR-0041). The sidebar's five entries
              are argued as three and two, and a sixth would open a page holding
              one block; the eventual home is a `Projections` page, created the
              day #757 or #758 gives it a second occupant. It reads down rather
              than being drawn, so it sits under the two lists — and it is full
              width because what it holds is two figures, not a column.

              `?? null` and never a shape assembled here: a read that has not
              answered renders nothing at all, title included (ADR-0026). */}
          <InvestmentRhythm rhythm={rhythm.data ?? null} failure={rhythmFailure} />
        </>
      )}
    </div>
  )
}
