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
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Allocation } from '@/components/dashboard/Allocation'
import { DashboardHead } from '@/components/dashboard/Head'
import { Movers } from '@/components/dashboard/Movers'
import { PortfolioChart } from '@/components/dashboard/PortfolioChart'
import { api } from '@/lib/api'
import { dashboardState } from '@/lib/dashboard'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { buildShareRows, heldRows } from '@/lib/shares'
import { oneBand, readConditions } from '@/lib/status'

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
  const rows = useMemo(
    () => buildShareRows(positions.data?.positions ?? [], new Map()),
    [positions.data],
  )
  const held = heldRows(rows)

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

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('page.dashboard')}</h1>
        {pricedAt === null || state !== 'portfolio' ? null : (
          <p className="text-sm text-muted-foreground">
            {t('dashboard.pricedAt', { date: f.dateTime(pricedAt) })}
          </p>
        )}
      </header>

      <DashboardHead />

      {state !== 'portfolio' ? null : (
        <>
          <PortfolioChart />
          <Allocation rows={rows} currency={positions.data?.base_currency ?? null} />
          <Movers
            movers={movers.data?.movers ?? []}
            reference={movers.data?.reference ?? null}
            held={held.length}
            currency={positions.data?.base_currency ?? null}
          />
        </>
      )}
    </div>
  )
}
