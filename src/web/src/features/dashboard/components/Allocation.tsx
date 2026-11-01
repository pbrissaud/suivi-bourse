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
 * the securities, and it is not drawn while fewer than two accounts have a
 * weight — a split by account of one account is a full circle.
 *
 * **The account view divides the accounts' worth, cash included** (#1426) — the
 * accounts bar's own basis — and the securities view divides the securities.
 * Each names its whole: « Valeur des comptes » or « Titres ».
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
import {
  accountAllocation,
  DEFAULT_ACCOUNT_LABEL,
  declaredLabel,
  type AccountRow,
} from '@/features/accounts/lib/accounts'
import { accountReading } from '@/features/dashboard/lib/dashboard'
import type { RuntimeState } from '@/lib/api'
import type { PositionsResponse } from '@/features/shares/lib/api'
import type { Width } from '@/features/dashboard/lib/dashboardBlocks'
import type { RenderState } from '@/features/dashboard/lib/dashboardLayout'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { allocation, type AllocationSlice, type ShareRow } from '@/features/shares/lib/shares'

type View = 'security' | 'account'

interface AllocationCardProps {
  positions: PositionsResponse | null
  rows: readonly ShareRow[]
  /** `/api/accounts`, `null` while unanswered: the account view's own read (#1426). */
  accounts: readonly AccountRow[] | null
  runtime: RuntimeState | null
  /** The width the grid draws the card at — not the saved one (`lib/dashboardLayout`). */
  width?: Width
}

/** What this block renders: the block's own `null` and the grid's, one rule. */
export function allocationRenderState({
  positions,
}: Pick<AllocationCardProps, 'positions'>): RenderState {
  return positions === null ? 'pending' : 'renders'
}

export function AllocationCard({
  positions,
  rows,
  accounts,
  runtime,
  width = 'half',
}: AllocationCardProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const mobile = useIsMobile()
  const [chosen, setChosen] = useState<View>('security')
  // Frozen with the card's body while the grid is arranged (design review
  // 8A): at full width it sits on the title row, which edit mode leaves live.
  const frame = useContext(SectionControlsContext)
  if (positions === null) return null

  // **One basis with the accounts bar** (#1426): an account's worth, cash included.
  const byAccount =
    accounts === null
      ? null
      : accountAllocation(accounts, (row) => declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL))
  const selectable = byAccount !== null && byAccount.slices.reduce((n, s) => n + s.count, 0) >= 2
  const view = selectable ? chosen : 'security'
  const split = view === 'account' && byAccount !== null ? byAccount : allocation(rows)
  // **One row not yet valued drops every share** (#1285), `AccountsBar`'s own
  // predicate, over every row — the ones left out of the split included.
  const now = new Date()
  const waiting =
    view === 'account' &&
    accounts !== null &&
    accounts.some((row) => accountReading(row, runtime, now) !== 'valued')
  const totalLabel = t(
    view === 'account' ? 'dashboard.allocation.total.accounts' : 'shares.allocation.total',
  )
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

  const empty = split.slices.length === 0 || waiting
  const scope = (
    <AllocationScope
      slices={split.slices}
      unit={view === 'account' ? 'accounts' : 'lines'}
      className="label block"
    />
  )
  const placeholder = waiting ? (
    <EmptyState title={t('dashboard.allocation.byAccount.pending')} />
  ) : (
    <EmptyState
      title={t('shares.allocation.empty')}
      description={t('shares.allocation.empty.body')}
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
            <span className="label">{totalLabel}</span>
            <span className="tabular text-2xl font-semibold">
              {f.currency(split.total, currency)}
            </span>
          </span>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {full ? null : selector}
        {waiting ? null : scope}
        {full && !waiting ? (
          <AllocationFigure
            {...split}
            currency={currency}
            title={t('dashboard.allocation.title')}
            name={name}
            totalLabel={totalLabel}
            amounts
          />
        ) : (
          <>
            {empty ? (
              placeholder
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
