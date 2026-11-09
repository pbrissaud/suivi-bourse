import { useQuery } from '@tanstack/react-query'

import { Unreadable } from '@/components/Unreadable'
import { Section } from '@/components/ui/section'
import { accountsApi } from '@/features/accounts/lib/api'
import { dataApi } from '@/features/data/lib/api'
import { settingsApi } from '@/features/settings/lib/api'
import { DataBlock } from '@/features/system/components/DataBlock'
import { FollowedTitles } from '@/features/system/components/FollowedTitles'
import { InstallationBlock } from '@/features/system/components/InstallationBlock'
import { JobsBlock } from '@/features/system/components/JobsBlock'
import { RebuildBlock } from '@/features/system/components/RebuildBlock'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { oneFailure, readConditions } from '@/lib/status'

/**
 * The installation as it is: the jobs and the titles they follow, the store,
 * the build. A fixed title and no subtitle (« l'état, pas l'explication »).
 */
export default function SystemPage() {
  const { t } = useI18n()
  usePageHeading(t('page.system'))

  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const store = useQuery({ queryKey: ['store'], queryFn: settingsApi.store })
  const history = useQuery({ queryKey: ['jobs-history'], queryFn: settingsApi.jobsHistory })
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: settingsApi.jobs })
  const events = useQuery({ queryKey: ['events'], queryFn: dataApi.events })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })
  const firstEvent = (events.data ?? []).reduce<string | null>(
    (oldest, event) =>
      event.date !== null && (oldest === null || event.date < oldest) ? event.date : oldest,
    null,
  )
  const dataFailure = oneFailure(readConditions({ queries: [store, events] }))

  return (
    <div className="space-y-5">
      <RebuildBlock
        runtime={runtime.data ?? null}
        firstEvent={firstEvent}
        accounts={accounts.data ?? null}
      />
      <JobsBlock
        jobs={jobs.data ?? null}
        jobsFailure={oneFailure(readConditions({ queries: [jobs] }))}
        history={history.data ?? null}
        historyFailure={oneFailure(readConditions({ queries: [history] }))}
      >
        {runtime.data ? <FollowedTitles followed={runtime.data.followed} /> : null}
      </JobsBlock>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {dataFailure === null ? (
          <DataBlock
            events={events.data?.length ?? null}
            sizeBytes={store.data ? store.data.size_bytes : undefined}
            orphans={store.data?.orphans ?? null}
          />
        ) : (
          <Section title={t('system.data')}>
            <Unreadable failure={dataFailure} />
          </Section>
        )}
        <InstallationBlock
          runtime={runtime.data ?? null}
          startedAt={history.data?.started ?? null}
        />
      </div>
    </div>
  )
}
