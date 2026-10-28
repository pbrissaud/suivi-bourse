/**
 * Why there is nothing to compare, in the server's words (#1207).
 *
 * The server reaches `nothing_to_compare` for four causes, and only
 * `no_events` is an empty ledger: an owner with years of events must not be
 * told to record their first ones. An absent or unknown reason reads as
 * `no_events`, so an older or newer server still renders. The ledger is the
 * way out only where the cause lives there.
 *
 * Its own component so the dashboard card (#1205) can render the same
 * sentences, and one payload never gets two explanations.
 */
import { Link } from '@tanstack/react-router'

import { EmptyState } from '@/components/EmptyState'
import type { BenchmarkResponse } from '@/features/benchmark/lib/api'
import { useI18n } from '@/lib/i18n'

export function NothingToCompare({ reason }: { reason: BenchmarkResponse['reason'] }) {
  const { t } = useI18n()
  const toLedger = (
    <Link to="/ledger" className="font-medium underline underline-offset-4">
      {t('empty.toLedger')}
    </Link>
  )
  switch (reason) {
    case 'not_computed':
      return (
        <EmptyState
          title={t('benchmark.empty.notComputed.title')}
          description={t('benchmark.empty.notComputed.body')}
        />
      )
    case 'nothing_held':
      return (
        <EmptyState
          title={t('benchmark.empty.nothingHeld.title')}
          description={t('benchmark.empty.nothingHeld.body')}
          action={toLedger}
        />
      )
    case 'no_rate_on_seed':
      return (
        <EmptyState
          title={t('benchmark.empty.noTotal.title')}
          description={t('benchmark.empty.noTotal.body')}
        />
      )
    default:
      return (
        <EmptyState
          title={t('benchmark.empty.noEvents.title')}
          description={t('benchmark.empty.noEvents.body')}
          action={toLedger}
        />
      )
  }
}
