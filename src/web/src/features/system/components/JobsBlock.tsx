import { useState } from 'react'

import { Unreadable } from '@/components/Unreadable'
import { Section } from '@/components/ui/section'
import {
  HOUR,
  JobHistogram,
  lastFaultyHour,
  mergeTracks,
} from '@/features/system/components/JobHistogram'
import type { JobInfo, JobsHistory, JobTrack } from '@/features/settings/lib/api'
import type { HealthJob, HealthJobs, HealthState, HealthStatus } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { isMessageKey, useI18n, type MessageKey, type MessageValues } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'
import { cn } from '@/lib/utils'

const JOB_TONE: Record<HealthStatus, string> = {
  ok: 'text-foreground',
  attention: 'text-attention',
  unknown: 'text-muted-foreground',
}

/** Symbols under the scrape shown before "see the others". */
const SYMBOLS_OPEN = 5

interface JobsBlockProps {
  /** `null` until `GET /health` has landed. */
  health: HealthState | null
  /** Set when `GET /health` refused: the bell links here in that state. */
  failure?: ReadFailure | null
  /** `null` while `GET /api/jobs/history` is in flight or refused. */
  history?: JobsHistory | null
  historyFailure?: ReadFailure | null
  /** The jobs the server runs, in its order (#1253); `null` while unread. */
  jobs?: JobInfo[] | null
  jobsFailure?: ReadFailure | null
}

export function JobsBlock({
  health,
  failure = null,
  history = null,
  historyFailure = null,
  jobs = null,
  jobsFailure = null,
}: JobsBlockProps) {
  const { t } = useI18n()
  const format = useFormatters()

  if (health === null) {
    if (failure === null) return null
    return (
      <Section title={t('settings.jobs')}>
        <Unreadable failure={failure} />
      </Section>
    )
  }

  // `readHealth` does not check the jobs' keys, so a payload short of one the
  // server lists is treated like an unreadable one rather than crashing the table.
  const rows =
    health.jobs !== null &&
    (jobs ?? []).every((job) => !job.in_health || health.jobs?.[job.id as keyof HealthJobs] != null)
      ? health.jobs
      : null
  // In flight: the strips keep their place, empty (#795).
  const pending = history === null && historyFailure === null
  // Under two hours of life there is no history worth drawing: the bars would
  // be 23 "no pass" slots and one block, which reads as a broken chart.
  const young = history !== null && Date.parse(history.started) > Date.parse(history.now) - 2 * HOUR

  return (
    <Section
      title={t('settings.jobs')}
      aside={
        // The glyph carries the state as the history bar's does; a dot would
        // be one colour for both, `attention` aliasing `foreground` (#1429).
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {health.status === 'attention' ? (
            <span aria-hidden className="text-foreground">
              ▲
            </span>
          ) : null}
          {t('settings.jobs.state', { state: health.status })}
        </span>
      }
    >
      {health.scheduler_running ? null : (
        <p className="mb-3 text-sm text-attention">{t('settings.jobs.scheduler')}</p>
      )}
      {history === null ? null : (
        <p className="mb-2 text-xs text-muted-foreground">
          {young
            ? t('settings.jobs.young', { at: format.dateTime(history.started) })
            : Date.parse(history.started) > Date.parse(history.now) - 24 * HOUR
              ? t('settings.jobs.since', { at: format.dateTime(history.started) })
              : t('settings.jobs.day')}
        </p>
      )}
      {rows === null ? (
        <p className="text-sm text-muted-foreground">{t('settings.jobs.unfolded')}</p>
      ) : (
        <dl className="divide-y text-sm">
          {/* The jobs with a `/health` line first, then the ones read off their history. */}
          {[...(jobs ?? [])]
            .sort((a, b) => Number(b.in_health) - Number(a.in_health))
            .map((job) => {
              const line: HealthJob | undefined = job.in_health
                ? rows[job.id as keyof HealthJobs]
                : undefined
              if (line === undefined)
                return (
                  <PassRow
                    key={job.id}
                    job={job}
                    history={history}
                    pending={pending}
                    young={young}
                  />
                )
              const track = history === null ? null : trackOf(job, history)
              return (
                <div key={job.id} className="py-2.5">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <dt>{labelOf(t, job)}</dt>
                    {/* No pass, no instant: the verdict under it says so, once (#1412). */}
                    {line.at === null ? null : (
                      <dd className="tabular ml-auto text-xs text-muted-foreground">
                        {format.dateTime(line.at)}
                      </dd>
                    )}
                  </div>
                  <dd className={cn('mt-0.5 text-xs', JOB_TONE[line.status])}>
                    {t(...verdictOf(job.id, rows, line))}
                  </dd>
                  <dd className="mt-2">
                    <History
                      label={labelOf(t, job)}
                      track={track}
                      pending={pending}
                      flagged={line.status === 'attention'}
                      started={young ? null : history?.started}
                    />
                    {job.kind === 'family' && history !== null && !young ? (
                      <SymbolHistories
                        label={labelOf(t, job)}
                        tracks={history.scrape}
                        started={history.started}
                      />
                    ) : null}
                  </dd>
                </div>
              )
            })}
        </dl>
      )}
      {jobsFailure === null ? null : <Unreadable failure={jobsFailure} />}
      {historyFailure === null ? null : <Unreadable failure={historyFailure} />}
    </Section>
  )
}

/** The name the server gives a job, or its id for a key this build lacks. */
function labelOf(t: (key: MessageKey) => string, job: JobInfo): string {
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

/** A job's histogram, or the empty 70 px it will take (no spinner, #795). */
function History({
  label,
  track,
  pending,
  flagged,
  started,
}: {
  label: string
  track: JobTrack | null
  pending: boolean
  flagged: boolean
  /** `null` for a process too young to draw; `undefined` while unread. */
  started?: string | null
}) {
  if (track === null) return pending ? <div className="h-[70px]" /> : null
  if (started === null) return null
  return (
    <JobHistogram
      label={label}
      track={track}
      initial={flagged ? lastFaultyHour(track) : null}
      started={started}
    />
  )
}

/** A job with no line in `/health` (the ingestion): its row is read off its own history. */
function PassRow({
  job,
  history,
  pending,
  young,
}: {
  job: JobInfo
  history: JobsHistory | null
  pending: boolean
  young: boolean
}) {
  const { t } = useI18n()
  const format = useFormatters()
  const track = history?.jobs[job.id] ?? null
  const last = track?.last ?? null
  const failed = last?.outcome === 'error'
  // Its own wording when it has one, the outcome's otherwise.
  const verdict = `${job.label_key}.verdict`

  return (
    <div className="py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <dt>{labelOf(t, job)}</dt>
        <dd className="tabular ml-auto text-xs text-muted-foreground">
          {last !== null
            ? format.dateTime(last.at)
            : history === null
              ? null
              : t('settings.jobs.never')}
        </dd>
      </div>
      {last === null ? null : (
        <dd className={cn('mt-0.5 text-xs', failed ? JOB_TONE.attention : JOB_TONE.ok)}>
          {t(isMessageKey(verdict) ? verdict : 'settings.jobs.outcome', {
            outcome: last.outcome,
          })}
        </dd>
      )}
      <dd className="mt-2">
        <History
          label={labelOf(t, job)}
          track={track}
          pending={pending}
          flagged={failed}
          started={young ? null : history?.started}
        />
      </dd>
    </div>
  )
}

/** One mini-histogram per held symbol, the worst first, five open. */
function SymbolHistories({
  label,
  tracks,
  started,
}: {
  label: string
  tracks: Record<string, JobTrack>
  started: string
}) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const sum = (track: JobTrack, field: 'errors' | 'attentions') =>
    track.slots.reduce((total, slot) => total + slot[field], 0)
  const symbols = Object.keys(tracks).sort(
    (a, b) =>
      sum(tracks[b], 'errors') - sum(tracks[a], 'errors') ||
      sum(tracks[b], 'attentions') - sum(tracks[a], 'attentions') ||
      a.localeCompare(b),
  )
  const shown = all ? symbols : symbols.slice(0, SYMBOLS_OPEN)

  return (
    <div className="mt-3 space-y-2">
      {shown.map((symbol) => (
        <div key={symbol}>
          <p className="mb-0.5 text-xs text-muted-foreground">{symbol}</p>
          <JobHistogram
            label={`${label} · ${symbol}`}
            track={tracks[symbol]}
            height={32}
            started={started}
          />
        </div>
      ))}
      {symbols.length > shown.length ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="py-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {t('settings.jobs.others', { count: symbols.length - shown.length })}
        </button>
      ) : null}
    </div>
  )
}

/**
 * One job's verdict and the values its message interpolates. A job whose
 * `/health` line this build does not know reads as its state alone.
 */
function verdictOf(id: string, jobs: HealthJobs, line: HealthJob): [MessageKey, MessageValues] {
  if (id === 'scrape') {
    const job = jobs.scrape
    return [
      'settings.jobs.scrape.verdict',
      {
        verdict: job.verdict,
        held: job.held,
        polled: job.held - job.closed,
        closed: job.closed,
        count: job.attention.length,
        symbols: job.attention.join(', '),
      },
    ]
  }
  if (id === 'backfill') {
    const job = jobs.backfill
    return [
      'settings.jobs.backfill.verdict',
      {
        verdict: job.verdict,
        complete: job.complete,
        scope: job.in_scope,
        count: job.attention.length,
        symbols: job.attention.join(', '),
      },
    ]
  }
  if (id === 'performance')
    return ['settings.jobs.performance.verdict', { verdict: jobs.performance.verdict }]
  return ['settings.jobs.state', { state: line.status }]
}
