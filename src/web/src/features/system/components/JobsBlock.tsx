import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { Refusal } from '@/components/Refusal'
import { Unreadable } from '@/components/Unreadable'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/ui/section'
import type { JobInfo, JobsHistory, JobTrack } from '@/features/settings/lib/api'
import { JobTicks, mergeTracks } from '@/features/system/components/JobHistogram'
import { systemApi } from '@/features/system/lib/api'
import { useClock } from '@/features/system/lib/clock'
import { isMessageKey, useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import type { ReadFailure } from '@/lib/status'

interface JobsBlockProps {
  /** The jobs the server runs, in its order (#1253); `null` while unread. */
  jobs: JobInfo[] | null
  jobsFailure?: ReadFailure | null
  /** `null` while `GET /api/jobs/history` is in flight or refused. */
  history?: JobsHistory | null
  historyFailure?: ReadFailure | null
  /** Under the rows: the followed titles. */
  children?: ReactNode
}

/** The name the owner reads: the glossary's, then the server's key, then its id. */
export function jobName(t: (key: MessageKey) => string, job: JobInfo): string {
  const named = `system.job.${job.id}`
  if (isMessageKey(named)) return t(named)
  return isMessageKey(job.label_key) ? t(job.label_key) : job.id
}

function trackOf(job: JobInfo, history: JobsHistory): JobTrack | null {
  if (job.kind === 'family') {
    // Every track carries the same 24 hours: any singleton's are the frame.
    const hours = Object.values(history.jobs)[0]?.slots ?? []
    return mergeTracks(history.scrape, hours, history.scrape_recent)
  }
  return history.jobs[job.id] ?? null
}

/** *Tâches*: one ruled row per job — state, 24 hourly ticks, last and next pass, « Lancer ». */
export function JobsBlock({
  jobs,
  jobsFailure = null,
  history = null,
  historyFailure = null,
  children,
}: JobsBlockProps) {
  const { t } = useI18n()

  // In flight: the plane keeps its place, empty (#795).
  if (jobs === null) {
    return (
      <Section title={t('system.jobs')}>
        {jobsFailure === null ? <div className="h-48" /> : <Unreadable failure={jobsFailure} />}
      </Section>
    )
  }

  return (
    <Section title={t('system.jobs')} aside={<Window />}>
      <div className="text-sm">
        {jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            track={history === null ? null : trackOf(job, history)}
            started={history?.started ?? null}
          />
        ))}
      </div>
      {historyFailure === null ? null : <Unreadable failure={historyFailure} />}
      {children}
    </Section>
  )
}

function Window() {
  const { t } = useI18n()
  return <span className="text-sm text-muted-foreground">{t('system.jobs.window')}</span>
}

function JobRow({
  job,
  track,
  started,
}: {
  job: JobInfo
  track: JobTrack | null
  started: string | null
}) {
  const { t } = useI18n()
  const clock = useClock()
  const client = useQueryClient()
  const name = jobName(t, job)
  const now = new Date()

  const write = useMutation({
    mutationFn: () => systemApi.runJob(job.id),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['jobs-history'] }),
      ]),
  })

  const when = [
    job.last_run_at === null ? null : clock.when(job.last_run_at, now),
    job.next_run_at === null
      ? job.cadence
      : t('system.jobs.next', { at: clock.when(job.next_run_at, now) }),
  ]
    .filter((part) => part !== null && part !== '')
    .join(' · ')

  return (
    <div className="border-b">
      <div
        role="group"
        aria-label={name}
        className="grid min-h-12 grid-cols-1 items-center gap-x-5 gap-y-2 py-2 md:grid-cols-[minmax(12rem,1.2fr)_minmax(14rem,1fr)_13rem_4.5rem]"
      >
        <div className="flex flex-col">
          <span className="text-md font-medium">{name}</span>
          <span className="text-muted-foreground">{job.state}</span>
        </div>
        <div>
          {track !== null && started !== null ? (
            <JobTicks label={name} track={track} started={started} />
          ) : null}
        </div>
        <span className="fig text-muted-foreground md:text-right">{when}</span>
        <div className="md:text-right">
          <Button
            type="button"
            size="sm"
            aria-label={t('system.jobs.run.label', { job: name })}
            disabled={write.isPending}
            onClick={() => write.mutate()}
          >
            {t('system.jobs.run')}
          </Button>
        </div>
      </div>
      {write.error ? <Refusal className="mb-2">{t(problemMessageKey(write.error))}</Refusal> : null}
    </div>
  )
}
