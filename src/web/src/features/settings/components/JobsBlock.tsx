import { Unreadable } from '@/components/Unreadable'
import { Section } from '@/components/ui/section'
import type { HealthJobs, HealthState, HealthStatus } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey, type MessageValues } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'
import { cn } from '@/lib/utils'

const JOB_TONE: Record<HealthStatus, string> = {
  ok: 'text-gain',
  attention: 'text-attention',
  unknown: 'text-muted-foreground',
}

const JOB_DOT: Record<HealthStatus, string> = {
  ok: 'bg-gain',
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

interface JobsBlockProps {
  /** `null` until `GET /health` has landed. */
  health: HealthState | null
  /** Set when `GET /health` refused: the bell links here in that state. */
  failure?: ReadFailure | null
}

export function JobsBlock({ health, failure = null }: JobsBlockProps) {
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
      {rows === null ? (
        <p className="text-sm text-muted-foreground">{t('settings.jobs.unfolded')}</p>
      ) : (
        <dl className="divide-y text-sm">
          {JOB_KEYS.map((key) => (
            <div key={key} className="py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <dt>{t(JOB_NAMES[key])}</dt>
                <dd className="tabular ml-auto text-xs text-muted-foreground">
                  {rows[key].at === null ? t('settings.jobs.never') : format.dateTime(rows[key].at)}
                </dd>
              </div>
              <dd className={cn('mt-0.5 text-xs', JOB_TONE[rows[key].status])}>
                {t(...verdictOf(key, rows))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
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
