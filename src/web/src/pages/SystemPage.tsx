import { useQuery } from '@tanstack/react-query'

import { accountsApi } from '@/features/accounts/lib/api'
import { dataApi } from '@/features/data/lib/api'
import { JobsBlock } from '@/features/settings/components/JobsBlock'
import { OrphansBlock } from '@/features/settings/components/OrphansBlock'
import { RebuildBlock } from '@/features/settings/components/RebuildBlock'
import { settingsApi } from '@/features/settings/lib/api'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { oneFailure, readConditions, readHealth } from '@/lib/status'

/** A `200` from `/health` whose body is not a health payload (#819). */
const UNREADABLE_HEALTH = new Error('/health answered with something that is not a health payload')

/** What the installation is doing: read, never set. */
export default function SystemPage() {
  const { t } = useI18n()
  usePageHeading(t('page.system'))

  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const store = useQuery({ queryKey: ['store'], queryFn: settingsApi.store })
  // Same key as the bell, so the two never disagree.
  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
  const events = useQuery({ queryKey: ['events'], queryFn: dataApi.events })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })
  const firstEvent = (events.data ?? []).reduce<string | null>(
    (oldest, event) =>
      event.date !== null && (oldest === null || event.date < oldest) ? event.date : oldest,
    null,
  )

  // The error alone, never the cached answer (#1180): the red bell's link must
  // not land on a green list from the last answer.
  const healthFailure = oneFailure(
    readConditions({
      queries: [
        { error: health.error },
        {
          error:
            health.data !== undefined && readHealth(health.data) === null
              ? UNREADABLE_HEALTH
              : null,
        },
      ],
    }),
  )
  const readableHealth =
    health.data === undefined || healthFailure !== null ? null : readHealth(health.data)

  return (
    <div className="space-y-5">
      <RebuildBlock
        runtime={runtime.data ?? null}
        firstEvent={firstEvent}
        accounts={accounts.data ?? null}
      />
      <JobsBlock health={readableHealth} failure={healthFailure} />
      <OrphansBlock orphans={store.data?.orphans ?? null} />
    </div>
  )
}
