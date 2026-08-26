/**
 * The dashboard — the head (#718), then the chart, the allocation and the
 * movers (#727).
 *
 * Four page-level decisions live here rather than in a block:
 *
 *  - **Two permanent time announcers at most**, and they are the mention under
 *    the title (*as of 7 August 2026, 17:42* — the freshest quote the page
 *    holds) and the movers' **reference close**, which is a different instant
 *    and is the subject of that block. The two transitory ones are elsewhere by
 *    construction: the time-weighted return's base date, on the head and only
 *    while it moves, and the reconstruction's progress, in the banner and only
 *    there.
 *  - **No installation fact lands here.** A notice posted on the dashboard is invisible
 *    to whoever lands on another page, and it would compete with the banner —
 *    which was validated in production and which the installation tab's badge is
 *    the counterpart of (#724).
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
 *  - **And the band is the page's, above both tracks.** It used to be the
 *    head's, and the head rendered it *instead* of itself — right for the two
 *    reads the head is made of, wrong for the four the page's other blocks are
 *    made of, since a failed sparkline would have wiped the total gain and its
 *    four terms to say so. Raised here it names **any** read of the page while
 *    every block that did answer keeps its figures. The alternative — a sentence
 *    inside each block, which is not a band and therefore does not compete with
 *    the shell's — was refused: an unreadable store fails every store read at
 *    once, so it would put three sentences on one screen where `oneFailure` puts
 *    one, and *one band on screen or none* is a rule about announcers rather
 *    than about a component's name.
 *  - **What empties the page and what is merely named are two lists.** The band
 *    takes every read; `dashboardState` takes the two the page is *made of*.
 *    Folded into one, a failed accounts read would put the page in `failed` and
 *    empty it — the very disappearance being repaired, one level up.
 *  - **It is a plateau, not a column** (#787, #790). Two tracks from `lg`, and
 *    the split is *drawn against read down*: the wide one carries the three
 *    figures that are **drawn** — the head, the value/performance chart, and the
 *    allocation, whose ring plus legend wants the same width the chart does —
 *    and the rail carries the two that are **read down as lists**, the movers
 *    and the accounts. That is the maquette's own order, and it is the one the
 *    eye follows: a donut squeezed into a third of the page loses its legend to
 *    two columns of six, and a list of five rows does not gain a thing from
 *    twice the width. Below `lg` the tracks collapse into one, so
 *    the 976 px case ADR-0022 measured is the **stacked** page and cannot
 *    overflow sideways; the two-track grid only starts where there is room for
 *    it. And it starts only where there is something to put in the rail: at
 *    zero events — or while the two reads are in flight — the second track
 *    would be a third of the page held empty beside one sentence.
 */
import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'

import { Refusal } from '@/components/Refusal'
import { AccountsCard } from '@/components/dashboard/AccountsCard'
import { Allocation } from '@/components/dashboard/Allocation'
import { DashboardHead } from '@/components/dashboard/Head'
import { Movers } from '@/components/dashboard/Movers'
import { PortfolioChart } from '@/components/dashboard/PortfolioChart'
import { NoBaseCurrency } from '@/components/NoBaseCurrency'
import { api, type PerfPoint } from '@/lib/api'
import { dashboardState, hasCashLedger } from '@/lib/dashboard'
import { useFormatters } from '@/lib/format'
import { currencyUnanswered } from '@/lib/firstRun'
import { useI18n } from '@/lib/i18n'
import { buildShareRows } from '@/lib/shares'
import { oneFailure, readConditions } from '@/lib/status'
import { usePageHeading } from '@/lib/pageHeading'
import { cn } from '@/lib/utils'

export default function DashboardPage() {
  const { t } = useI18n()
  const f = useFormatters()

  const positions = useQuery({ queryKey: ['positions'], queryFn: api.positions })
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: api.portfolioTotals })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  // The same read the bell and the first-run modal compose their own
  // predicates from — one query key, so it is one request and no new API state.
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })

  // **The two reads the page is made of, and them alone.** A block's own read
  // failing removes that block and is named in the band below; it never puts
  // the page in `failed`, which is a screen with nothing on it but a sentence.
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
  // line is worth (ADR-0004's carrying convention included), so the allocation
  // and the table cannot disagree about the same portfolio. The failure counter
  // is a rendering concern there and has no subject here, so the map is empty.
  //
  // Both blocks below take the rows **whole**, closed lines included, and each
  // reduces them with the same predicate: what is in the portfolio is one
  // question, and a page whose two blocks answered it apart is what put a sold
  // line in the movers' own sentence.
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

  // **One band, for every read the page makes** — and one is the count, not the
  // maximum: `readConditions` short-circuits under the shell's own band and
  // `oneFailure` keeps the first of what is left, so an unreadable store, which
  // fails every one of them at once, is still one sentence on screen.
  //
  // The order is **causal down the page**: the two reads the page is made of
  // first, a store that will not answer them being the cause of every failed
  // read under them, then the block reads in the order the blocks are read in.
  // The movers are here too, for the defect's own reason one block along: the
  // block renders nothing on `null` and a failed read reaches it as one.
  const failure = oneFailure(
    readConditions({
      errors: [
        positions.error,
        totals.error,
        perf.error,
        valuation.error,
        accounts.error,
        movers.error,
        ...histories.map((one) => one.error),
      ],
    }),
  )

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

  return (
    <div className="space-y-6">
      {/* Above both tracks, so that naming a failed read never costs the page a
          block that did answer (#799). */}
      {failure ? <Refusal>{t(failure.message)}</Refusal> : null}

      <div
        className={cn(
          'grid grid-cols-1 items-start gap-6',
          state === 'portfolio' && 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]',
        )}
      >
        {/* The wide track: what the page leads with, then what it draws. */}
        <div className="space-y-6 lg:col-start-1">
          <DashboardHead
            positions={positions.data ?? null}
            totals={totals.data ?? null}
            accounts={accounts.data?.accounts ?? null}
            rebuilding={runtime.data?.rebuilding ?? null}
            history={perf.data?.points ?? null}
          />

          {state !== 'portfolio' ? null : (
            <>
              <PortfolioChart
                ledger={ledger}
                currency={totals.data?.base_currency ?? null}
                performance={perf.data?.points ?? null}
                valuation={valuation.data?.points ?? null}
              />
              <Allocation rows={rows} currency={positions.data?.base_currency ?? null} />
            </>
          )}
        </div>

        {/* The rail: two blocks that are read down rather than across. */}
        {state !== 'portfolio' ? null : (
          <div className="space-y-6 lg:col-start-2 lg:row-start-1">
            <Movers
              // `?? null` and never `?? []`: this read is armed only once the
              // page reaches `portfolio`, so there is a real window in which an
              // empty array would state *« Rien à comparer »* about movements
              // nobody has answered for (ADR-0026).
              movers={movers.data?.movers ?? null}
              reference={movers.data?.reference ?? null}
              rows={rows}
              currency={positions.data?.base_currency ?? null}
            />
            {/* Last, and it is allowed to render nothing at all: at one account
                a comparison is the head's own figure with a border round it, so
                the rail then holds the movers alone. */}
            <AccountsCard accounts={accounts.data?.accounts ?? null} series={series} />
          </div>
        )}
      </div>
    </div>
  )
}
