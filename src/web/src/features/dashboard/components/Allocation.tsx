/**
 * Where the money is, on the dashboard (#1206) — **by security or by account**.
 *
 * The shares page draws the same split as bars (`AllocationBars`); showing it on
 * both pages is deliberate, the dashboard being the page the owner opens. Both views are exact from the ledger. Sector
 * and country are not offered: funds publish no sector, so an ETF-heavy
 * portfolio would be mostly *unknown*.
 *
 * **Two drawings.** At half width, and under 768 px whatever the saved width,
 * a one-column legend and the total on the title row — a ring in half a row
 * would be a coin. At full width, the ring with the total in its hole (#790,
 * the assumed exception to the subtotal rule) and the legend with its amounts.
 *
 * **The selector swaps what the slot draws**, like the hero chart's readings,
 * so it is `pressed` and not a radio group. Local and never saved; it opens on
 * the securities, and it is not drawn while fewer than two accounts hold a
 * placed line — a split by account of one account is a full circle.
 */
import { useContext, useState } from 'react'
import { Link } from '@tanstack/react-router'

import { EmptyState } from '@/components/EmptyState'
import { Segmented } from '@/components/Segmented'
import {
  AllocationBars,
  AllocationFigure,
  AllocationScope,
  AllocationUnplaced,
} from '@/features/shares/components/Allocation'
import { Section, SectionControlsContext } from '@/components/ui/section'
import { useIsMobile } from '@/hooks/use-mobile'
import { DEFAULT_ACCOUNT_LABEL, isDefaultAccount } from '@/features/accounts/lib/accounts'
import type { PositionsResponse } from '@/features/shares/lib/api'
import type { Width } from '@/features/dashboard/lib/dashboardBlocks'
import type { RenderState } from '@/features/dashboard/lib/dashboardLayout'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import {
  accountAllocation,
  allocation,
  type AllocationSlice,
  type ShareRow,
} from '@/features/shares/lib/shares'

type View = 'security' | 'account'

interface AllocationCardProps {
  positions: PositionsResponse | null
  rows: readonly ShareRow[]
  /** The width the grid draws the card at — not the saved one (`lib/dashboardLayout`). */
  width?: Width
}

/** What this block renders: the block's own `null` and the grid's, one rule. */
export function allocationRenderState({
  positions,
}: Pick<AllocationCardProps, 'positions'>): RenderState {
  return positions === null ? 'pending' : 'renders'
}

export function AllocationCard({ positions, rows, width = 'half' }: AllocationCardProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const mobile = useIsMobile()
  const [chosen, setChosen] = useState<View>('security')
  // Frozen with the card's body while the grid is arranged (design review
  // 8A): at full width it sits on the title row, which edit mode leaves live.
  const frame = useContext(SectionControlsContext)
  if (positions === null) return null

  // **An account is named by its id**, as the shares page's groups name it:
  // its declared label is on `/api/accounts`, which this page does not read
  // (#1174). The seeded account alone reads its catalogue name, since its id
  // (`default`) is a word in no language the owner chose.
  const accountName = (id: string) => (isDefaultAccount(id) ? t(DEFAULT_ACCOUNT_LABEL) : id)
  const byAccount = accountAllocation(positions.positions, accountName)
  const placedAccounts = byAccount.slices.reduce((sum, slice) => sum + slice.count, 0)
  const selectable = placedAccounts >= 2
  const view = selectable ? chosen : 'security'
  const split = view === 'account' ? byAccount : allocation(rows)
  const currency = positions.base_currency ?? null
  const full = width === 'full' && !mobile

  const name = (slice: AllocationSlice) =>
    slice.symbol === null
      ? t(
          view === 'account'
            ? 'dashboard.allocation.others.accounts'
            : 'dashboard.allocation.others.lines',
          { count: slice.count },
        )
      : (slice.label ?? slice.symbol)

  const selector = selectable ? (
    <div className="self-start" inert={frame?.inert || undefined}>
      <Segmented
        mode="pressed"
        size="compact"
        label={t('dashboard.allocation.view')}
        value={view}
        onChange={setChosen}
        options={[
          { value: 'security', label: t('dashboard.allocation.bySecurity') },
          { value: 'account', label: t('dashboard.allocation.byAccount') },
        ]}
      />
    </div>
  ) : null

  const empty = split.slices.length === 0
  const scope = (
    <AllocationScope
      slices={split.slices}
      unit={view === 'account' ? 'accounts' : 'lines'}
      className="label block"
    />
  )

  return (
    <Section
      title={t('dashboard.allocation.title')}
      aside={
        full ? (
          selector
        ) : empty ? null : (
          // **Named, because it is not the hero** (#1426): it sums the
          // securities only, so a bare amount a few rows under the portfolio's
          // value read as a second value of it. The name is also the basis
          // every share in the list divides, by security or by account.
          <span className="flex items-baseline gap-2">
            <span className="label">{t('shares.allocation.total')}</span>
            <span className="tabular text-2xl font-semibold">
              {f.currency(split.total, currency)}
            </span>
          </span>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {full ? null : selector}
        {scope}
        {full ? (
          <AllocationFigure
            {...split}
            currency={currency}
            title={t('dashboard.allocation.title')}
            name={name}
            amounts
          />
        ) : (
          <>
            {empty ? (
              <EmptyState
                title={t('shares.allocation.empty')}
                description={t('shares.allocation.empty.body')}
              />
            ) : (
              <AllocationBars
                slices={split.slices}
                name={name}
                columns={1}
                title={t('dashboard.allocation.title')}
              />
            )}
            <AllocationUnplaced unplaced={split.unplaced} />
          </>
        )}
        {view === 'account' ? (
          <Link
            to="/accounts"
            className="label self-start rounded-sm underline underline-offset-4 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {t('dashboard.allocation.toAccounts')}
          </Link>
        ) : null}
      </div>
    </Section>
  )
}
