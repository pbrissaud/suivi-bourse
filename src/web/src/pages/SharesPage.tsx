/**
 * The shares page (« Relevé »): the table alone.
 *
 * A summary line (the value, the cost, the securities' latent gain with its
 * base written beside it), then the table of the lines held — one row per
 * symbol across its accounts (`features/shares/lib/shares.ts`) — whose total row
 * sums the rows above it. A row leads to `/shares/<symbol>`; the sheet that used
 * to open here is that page.
 *
 * `?account=` (an account's panel leads here) reduces the table to that
 * account's lines and says so. `?symbol=` is the old address of a title's sheet
 * (the ⌘K palette still builds it): it is handed over to the page.
 *
 * A read that did not answer is said where the table would have been, and
 * nothing is claimed over a read still in flight.
 */
import { useMemo, useState } from 'react'
import { Link, Navigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { Unreadable } from '@/components/Unreadable'
import { EmptyState } from '@/components/EmptyState'
import { NoBaseCurrency } from '@/components/NoBaseCurrency'
import { ProvisionalNote } from '@/components/ProvisionalNote'
import { SharesList } from '@/features/shares/components/SharesList'
import { SharesTable } from '@/features/shares/components/SharesTable'
import { useIsMobile } from '@/hooks/use-mobile'
import { settingsApi } from '@/features/settings/lib/api'
import { sharesApi } from '@/features/shares/lib/api'
import { api } from '@/lib/api'
import { renderFigure } from '@/lib/absence'
import { useFormatters } from '@/lib/format'
import { currencyUnanswered } from '@/lib/firstRun'
import { sumRendering, termAmount, termRendering, termTone } from '@/lib/gain'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import {
  DEFAULT_SORT,
  buildShareRows,
  heldRows,
  nextSort,
  placedValue,
  sharesTotals,
  type ShareSort,
  type SortColumn,
} from '@/features/shares/lib/shares'
import { oneFailure, readConditions } from '@/lib/status'

export default function SharesPage() {
  const { t } = useI18n()
  const mobile = useIsMobile()
  const f = useFormatters()
  // The order is a state of the page, not an address: nobody links to this
  // table sorted by invested amount.
  const [sort, setSort] = useState<ShareSort>(DEFAULT_SORT)
  const { account = null, symbol = null } = useSearch({ from: '/shares' })

  const positions = useQuery({ queryKey: ['positions'], queryFn: sharesApi.positions })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })

  const failures = useMemo(
    () => new Map((runtime.data?.symbols ?? []).map((s) => [s.symbol, s.failure_count])),
    [runtime.data],
  )
  // The day's move under the price rides on the position row; null says nothing
  // rather than something false.
  const moves = useMemo(
    () => new Map((positions.data?.positions ?? []).map((p) => [p.symbol, p.day_change_pct])),
    [positions.data],
  )

  // The reduction is applied to the positions before the folding: reducing
  // afterwards would keep a line held on two accounts whole and state the other
  // account's quantity under a bar naming this one.
  const reduced = useMemo(() => {
    const all = positions.data?.positions ?? []
    return account === null ? all : all.filter((position) => position.account === account)
  }, [positions.data, account])

  const rows = useMemo(() => buildShareRows(reduced, failures), [reduced, failures])
  const held = heldRows(rows, sort)
  const heldSymbols = new Set(held.map((row) => row.symbol))
  const totals = sharesTotals(
    reduced.filter((position) => heldSymbols.has(position.symbol)),
    held,
  )
  const invested = held.reduce((sum, row) => sum + row.cost_basis, 0)
  // The latent gain over **the cost of the lines it is the gain of** (the base
  // is said beside it): the payload carries no portfolio-wide ratio, and one
  // reduced to an account is of that account's lines.
  const latentGain = termAmount(totals.terms, 'unrealised')
  const gainRatio = latentGain !== null && invested > 0 ? latentGain / invested : null
  const currency = positions.data?.base_currency ?? null
  const failure = oneFailure(readConditions({ queries: [positions] }))

  const pricedAt = rows.reduce<string | null>(
    (newest, row) =>
      row.price?.at != null && (newest === null || row.price.at > newest) ? row.price.at : newest,
    null,
  )
  usePageHeading(
    t('page.shares'),
    pricedAt === null ? null : t('shares.pricedAt', { date: f.dateTime(pricedAt) }),
  )

  if (symbol !== null) {
    return <Navigate to="/shares/$symbol" params={{ symbol }} replace />
  }

  // With no reporting currency nothing is converted, and this page would be a
  // column of dashes with no reason given.
  if (currencyUnanswered(config.data?.settings) === true) {
    return <NoBaseCurrency />
  }

  if (failure !== null) {
    return <Unreadable failure={failure} />
  }

  const { valuation, terms } = totals

  return (
    <div className="space-y-6">
      {account === null ? null : (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <p>{t('shares.reduced', { account })}</p>
          <Link
            to="/shares"
            search={{}}
            className="text-muted-foreground underline underline-offset-4"
          >
            {t('shares.reduced.undo')}
          </Link>
        </div>
      )}

      <ProvisionalNote />

      {!positions.data ? null : held.length === 0 ? (
        account !== null ? (
          <EmptyState
            title={t('shares.reduced.empty.title')}
            description={t('shares.reduced.empty.body', { account })}
            action={
              <Link to="/shares" search={{}} className="font-medium underline underline-offset-4">
                {t('shares.reduced.undo')}
              </Link>
            }
          />
        ) : (
          <EmptyState
            title={t('shares.empty.title')}
            description={t('shares.empty.body')}
            action={
              <Link to="/ledger" className="font-medium underline underline-offset-4">
                {t('empty.toLedger')}
              </Link>
            }
          />
        )
      ) : (
        <div className="flex flex-col">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pb-4">
            <p className="flex flex-wrap items-baseline gap-x-2.5">
              <span className="fig text-4xl font-medium">
                {renderFigure(
                  sumRendering(valuation),
                  () => f.currency(valuation.known ? valuation.value : null, currency),
                  t,
                )}
              </span>
              <span className="text-muted-foreground">
                {t('shares.summary.on')} <span className="fig text-foreground">{held.length}</span>{' '}
                {t('shares.summary.lines', { count: held.length })}{' '}
                <span className="fig text-foreground">{f.currency(invested, currency)}</span>{' '}
                {t('shares.summary.invested')}
              </span>
            </p>
            <p className="text-muted-foreground">
              {t('shares.summary.gain')}{' '}
              <span className={`fig ${termTone(terms, 'unrealised')}`}>
                {renderFigure(
                  termRendering(terms, 'unrealised'),
                  () => f.signedCurrency(termAmount(terms, 'unrealised'), currency),
                  t,
                )}
              </span>{' '}
              {gainRatio === null ? null : (
                <span className={`fig text-sm ${termTone(terms, 'unrealised')}`}>
                  ({f.percent(gainRatio)})
                </span>
              )}{' '}
              {gainRatio === null ? null : (
                <span className="text-sm">
                  {t('shares.summary.gainBase', { base: f.currency(invested, currency) })}
                </span>
              )}{' '}
              <span className="text-sm">{t('shares.summary.scope')}</span>
            </p>
          </div>

          {mobile ? (
            <SharesList rows={held} currency={currency} totals={totals} />
          ) : (
            <SharesTable
              rows={held}
              currency={currency}
              sort={sort}
              onSort={(column: SortColumn) => setSort((previous) => nextSort(previous, column))}
              moves={moves}
              whole={placedValue(held)}
              totals={{ ...totals, invested }}
              gainRatio={gainRatio}
            />
          )}
        </div>
      )}
    </div>
  )
}
