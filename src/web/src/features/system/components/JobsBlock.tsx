import { useState } from 'react'

import { Unreadable } from '@/components/Unreadable'
import { Section } from '@/components/ui/section'
import {
  HOUR,
  JobHistogram,
  lastFaultyHour,
  mergeTracks,
} from '@/features/system/components/JobHistogram'
import type { JobsHistory, JobTrack } from '@/features/settings/lib/api'
import type { HealthJobs, HealthState, HealthStatus } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey, type MessageValues } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'
import { cn } from '@/lib/utils'

const JOB_TONE: Record<HealthStatus, string> = {
  ok: 'text-foreground',
  attention: 'text-attention',
  unknown: 'text-muted-foreground',
}

const JOB_DOT: Record<HealthStatus, string> = {
  ok: 'bg-foreground',
  attention: 'bg-attention',
  unknown: 'bg-muted-foreground',
}

const JOB_KEYS = ['scrape', 'backfill', 'performance'] as const

type JobKey = (typeof JOB_KEYS)[number]

const JOB_NAMES: Record<JobKey, MessageKey> = {
  scrape: 'settings.jobs.scrape',
  backfill: 'settings.jobs.backfill',
  performance: 'settings.jobs.performance',
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
}

export function JobsBlock({
  health,
  failure = null,
  history = null,
  historyFailure = null,
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

  // `readHealth` does not check the three keys, so a short payload is treated
  // like an unreadable one rather than crashing the table.
  const rows =
    health.jobs !== null && JOB_KEYS.every((key) => health.jobs?.[key] != null) ? health.jobs : null
  // In flight: the strips keep their place, empty (#795).
  const pending = history === null && historyFailure === null

  return (
    <Section
      title={t('settings.jobs')}
      aside={
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden className={cn('size-2 rounded-full', JOB_DOT[health.status])} />
          {t('settings.jobs.state', { state: health.status })}
        </span>
      }
    >
      {health.scheduler_running ? null : (
        <p className="mb-3 text-sm text-attention">{t('settings.jobs.scheduler')}</p>
      )}
      {history === null ? null : (
        <p className="mb-2 text-xs text-muted-foreground">
          {Date.parse(history.started) > Date.parse(history.now) - 24 * HOUR
            ? t('settings.jobs.since', { at: format.dateTime(history.started) })
            : t('settings.jobs.day')}
        </p>
      )}
      {rows === null ? (
        <p className="text-sm text-muted-foreground">{t('settings.jobs.unfolded')}</p>
      ) : (
        <dl className="divide-y text-sm">
          {JOB_KEYS.map((key) => {
            const track = history === null ? null : trackOf(key, history)
            return (
              <div key={key} className="py-2.5">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <dt>{t(JOB_NAMES[key])}</dt>
                  <dd className="tabular ml-auto text-xs text-muted-foreground">
                    {rows[key].at === null
                      ? t('settings.jobs.never')
                      : format.dateTime(rows[key].at)}
                  </dd>
                </div>
                <dd className={cn('mt-0.5 text-xs', JOB_TONE[rows[key].status])}>
                  {t(...verdictOf(key, rows))}
                </dd>
                <dd className="mt-2">
                  <History
                    label={t(JOB_NAMES[key])}
                    track={track}
                    pending={pending}
                    flagged={rows[key].status === 'attention'}
                  />
                  {key === 'scrape' && history !== null ? (
                    <SymbolHistories tracks={history.scrape} />
                  ) : null}
                </dd>
              </div>
            )
          })}
          <IngestionRow history={history} pending={pending} />
        </dl>
      )}
      {historyFailure === null ? null : <Unreadable failure={historyFailure} />}
    </Section>
  )
}

function trackOf(key: JobKey, history: JobsHistory): JobTrack {
  if (key === 'scrape')
    return mergeTracks(history.scrape, history.jobs.performance.slots, history.scrape_recent)
  return history.jobs[key]
}

/** A job's histogram, or the empty 70 px it will take (no spinner, #795). */
function History({
  label,
  track,
  pending,
  flagged,
}: {
  label: string
  track: JobTrack | null
  pending: boolean
  flagged: boolean
}) {
  if (track === null) return pending ? <div className="h-[70px]" /> : null
  return (
    <JobHistogram label={label} track={track} initial={flagged ? lastFaultyHour(track) : null} />
  )
}

/** The ingestion is not in `/health`: its row is read off its own history. */
function IngestionRow({ history, pending }: { history: JobsHistory | null; pending: boolean }) {
  const { t } = useI18n()
  const format = useFormatters()
  const track = history?.jobs.ingestion ?? null
  const last = track?.last ?? null
  const failed = last?.outcome === 'error'

  return (
    <div className="py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <dt>{t('settings.jobs.ingestion')}</dt>
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
          {t('settings.jobs.ingestion.verdict', { outcome: last.outcome })}
        </dd>
      )}
      <dd className="mt-2">
        <History
          label={t('settings.jobs.ingestion')}
          track={track}
          pending={pending}
          flagged={failed}
        />
      </dd>
    </div>
  )
}

/** One mini-histogram per held symbol, the worst first, five open. */
function SymbolHistories({ tracks }: { tracks: Record<string, JobTrack> }) {
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
            label={`${t('settings.jobs.scrape')} · ${symbol}`}
            track={tracks[symbol]}
            height={32}
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

/** One job's verdict and the values its message interpolates. */
function verdictOf(key: JobKey, jobs: HealthJobs): [MessageKey, MessageValues] {
  if (key === 'scrape') {
    const job = jobs.scrape
    return [
      'settings.jobs.scrape.verdict',
      {
        verdict: job.verdict,
        held: job.held,
        count: job.attention.length,
        symbols: job.attention.join(', '),
      },
    ]
  }
  if (key === 'backfill') {
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
  return ['settings.jobs.performance.verdict', { verdict: jobs.performance.verdict }]
}
