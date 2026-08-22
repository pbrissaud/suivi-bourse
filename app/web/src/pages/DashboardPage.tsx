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
 *  - **No advisory lands here.** A notice posted on the dashboard is invisible
 *    to whoever lands on another page, and it would compete with the banner —
 *    which was validated in production and which the installation tab's badge is
 *    the counterpart of (#724).
 *  - **`/` is the dashboard unconditionally**, zero events included: a bookmark
 *    valid yesterday is valid tomorrow, and a redirection conditioned on data is
 *    how an app takes its reader somewhere they did not ask for.
 *  - **The four states are one decision** (`lib/dashboard.ts`), not a `?.length`
 *    per block: *no events* is a sentence and a link, while *events and nothing
 *    held* is an ordinary page whose blocks each say why they are empty.
 *  - **It is a plateau, not a column** (#787, #790). Two tracks from `lg`: the
 *    figures the reader came for on the wide one — the head, the chart, the
 *    accounts — and the two blocks that are *read down* in the rail beside it,
 *    the allocation and the movers. Below `lg` the tracks collapse into one, so
 *    the 976 px case ADR-0022 measured is the **stacked** page and cannot
 *    overflow sideways; the two-track grid only starts where there is room for
 *    it. And it starts only where there is something to put in the rail: at
 *    zero events — or while the two reads are in flight — the second track
 *    would be a third of the page held empty beside one sentence.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { AccountsCard } from '@/components/dashboard/AccountsCard'
import { Allocation } from '@/components/dashboard/Allocation'
import { DashboardHead } from '@/components/dashboard/Head'
import { Movers } from '@/components/dashboard/Movers'
import { PortfolioChart } from '@/components/dashboard/PortfolioChart'
import { api } from '@/lib/api'
import { dashboardState } from '@/lib/dashboard'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { buildShareRows } from '@/lib/shares'
import { oneBand, readConditions } from '@/lib/status'
import { usePageHeading } from '@/lib/pageHeading'
import { cn } from '@/lib/utils'

export default function DashboardPage() {
  const { t } = useI18n()
  const f = useFormatters()

  const positions = useQuery({ queryKey: ['positions'], queryFn: api.positions })
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: api.portfolioTotals })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })

  const state = dashboardState({
    failed: Boolean(
      oneBand(readConditions({ shellError: runtime.error, errors: [positions.error, totals.error] })),
    ),
    positions: positions.data,
    totals: totals.data,
  })

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

  return (
    <div
      className={cn(
        'grid items-start gap-6',
        state === 'portfolio' && 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]',
      )}
    >
      {/* The wide track: what the page leads with, then what it draws. */}
      <div className="space-y-6 lg:col-start-1">
        <DashboardHead />

        {state !== 'portfolio' ? null : (
          <>
            <PortfolioChart />
            <AccountsCard />
          </>
        )}
      </div>

      {/* The rail: two blocks that are read down rather than across. */}
      {state !== 'portfolio' ? null : (
        <div className="space-y-6 lg:col-start-2 lg:row-start-1">
          <Allocation rows={rows} currency={positions.data?.base_currency ?? null} />
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
        </div>
      )}
    </div>
  )
}
