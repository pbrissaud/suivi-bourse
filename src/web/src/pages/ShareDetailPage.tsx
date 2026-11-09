/**
 * One title's page, `/shares/<symbol>` (« Relevé »): the sheet of the shares
 * table, made a page. The data is the table's — the positions, the failures
 * counter, the day's move — plus the ledger, whose events it lists and plots.
 *
 * The header names the title and dates the quote (`CW8 · PEA · Cours au …`).
 * A symbol the portfolio does not know is said, with the way back.
 */
import { useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { EmptyState } from '@/components/EmptyState'
import { NoBaseCurrency } from '@/components/NoBaseCurrency'
import { Unreadable } from '@/components/Unreadable'
import { dataApi } from '@/features/data/lib/api'
import { ShareDetail } from '@/features/shares/components/ShareDetail'
import { sharesApi, type ChartWindow } from '@/features/shares/lib/api'
import { buildShareRows, heldRows, placedValue } from '@/features/shares/lib/shares'
import { settingsApi } from '@/features/settings/lib/api'
import { api } from '@/lib/api'
import { currencyUnanswered } from '@/lib/firstRun'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { problemMessageKey } from '@/lib/problem'
import { oneFailure, readConditions } from '@/lib/status'

export default function ShareDetailPage() {
  const { t } = useI18n()
  const f = useFormatters()
  const { symbol } = useParams({ from: '/shares/$symbol' })
  const [window, setWindow] = useState<ChartWindow>('1Y')

  const positions = useQuery({ queryKey: ['positions'], queryFn: sharesApi.positions })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  const ledger = useQuery({ queryKey: ['events'], queryFn: dataApi.events })

  const failures = useMemo(
    () => new Map((runtime.data?.symbols ?? []).map((s) => [s.symbol, s.failure_count])),
    [runtime.data],
  )
  const all = useMemo(() => positions.data?.positions ?? [], [positions.data])
  const rows = useMemo(() => buildShareRows(all, failures), [all, failures])
  const row = rows.find((candidate) => candidate.symbol === symbol) ?? null
  const move = all.find((p) => p.symbol === symbol)?.day_change_pct ?? null
  const currency = positions.data?.base_currency ?? null
  const failure = oneFailure(readConditions({ queries: [positions] }))

  // The name once the positions answer; the bare symbol over a read in flight
  // would be a phrase the page invented, so the bar says nothing until then.
  usePageHeading(
    row ? (row.name ?? row.symbol) : positions.data ? symbol : '',
    row === null || row.price?.at == null
      ? null
      : [
          row.symbol,
          row.accounts.join(', '),
          t('shares.pricedAt', { date: f.dateTime(row.price.at) }),
        ]
          .filter(Boolean)
          .join(' · '),
  )

  if (currencyUnanswered(config.data?.settings) === true) return <NoBaseCurrency />
  if (failure !== null) return <Unreadable failure={failure} />
  // Nothing is claimed over a read in flight, above all not that the title is unknown.
  if (!positions.data) return null

  if (row === null) {
    return (
      <EmptyState
        title={t('shares.fiche.unknown.title')}
        description={t('shares.fiche.unknown.body', { symbol })}
        action={
          <Link to="/shares" search={{}} className="font-medium underline underline-offset-4">
            {t('shares.fiche.back')}
          </Link>
        }
      />
    )
  }

  return (
    <ShareDetail
      row={row}
      positions={all.filter((position) => position.symbol === symbol)}
      currency={currency}
      whole={placedValue(heldRows(rows))}
      move={move}
      ledger={ledger.data ?? null}
      ledgerFailure={ledger.error ? { message: problemMessageKey(ledger.error) } : null}
      window={window}
      onWindowChange={setWindow}
    />
  )
}
