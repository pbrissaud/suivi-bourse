/**
 * *The workloads* — the bell's one word, developed (#830, ADR-0036, ADR-0037,
 * ADR-0038).
 *
 * The panel behind the bell says **health** in one card and one sentence, and
 * offers a link rather than an acknowledgement because health is repaired and
 * never dismissed. That link lands here, and this is what it lands on: the
 * three workloads `/health` folds its word out of, each with its last pass and
 * its verdict. A card that led somewhere and then said the same sentence again
 * would be a link to nothing.
 *
 * Four things are decisions rather than layout:
 *
 *  - **Three rows and not four.** `/health` carries the scrape, the backfill and
 *    the performance pass; **ingestion is not a job** — it is the boot or a
 *    write — so it has no last pass to state and no verdict to wear. The
 *    mock-up draws four rows and names the ledger write and a retention purge
 *    among them; the record wins, as #787 says it does, and inventing an
 *    observation the server does not publish is the one thing a page about
 *    health may not do.
 *  - **The verdict is a sentence, and the colour repeats it.** The server's
 *    vocabulary — `frozen`, `backoff`, `unconvertible` — is never rendered raw:
 *    each word is a phrase in the reader's language, carrying the counts that
 *    make it actionable (how many securities are held, how many series are
 *    complete out of how many) and **naming** the securities that ask to be
 *    looked at. A hue alone would say *something* is wrong and never *what*.
 *  - **A stopped scheduler is said above the rows, not inside them.** It is the
 *    *cause* of three jobs that will never run again, however well their last
 *    pass went, so it is the card's own sentence rather than a fourth line —
 *    naming a symptom beside its cause is the defect `installationState`'s
 *    causal order exists against.
 *  - **A job this process has never run has no last pass**, and that is named
 *    rather than dashed: an em dash is *there is nothing to compute*
 *    (ADR-0021), and a container a minute old has plenty to compute and has
 *    simply not got there yet.
 *
 * **`null` is a read in flight and the card does not exist** (ADR-0026), title
 * included: *everything is running* is a claim about an installation nobody has
 * observed yet.
 */
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import type { HealthJobs, HealthState, HealthStatus } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey, type MessageValues } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** The id the card's landmark is named by — one constant, two readers. */
const JOBS_HEADING = 'settings-jobs'

/**
 * What a job's own word is worth, in the tone the bell already uses for the
 * whole. Declared here rather than borrowed from `STATE_TONE`: that record is
 * over the five states of the **installation**, and these are the three words a
 * single job is said in — one of them, `unreachable`, cannot happen to a job,
 * because a job nobody could read about has no row at all.
 */
const JOB_TONE: Record<HealthStatus, string> = {
  ok: 'text-gain',
  attention: 'text-attention',
  unknown: 'text-muted-foreground',
}

/** The three, in the order the app runs them: read, reconstruct, compute. */
const JOB_KEYS = ['scrape', 'backfill', 'performance'] as const

type JobKey = (typeof JOB_KEYS)[number]

const JOB_NAMES: Record<JobKey, MessageKey> = {
  scrape: 'settings.jobs.scrape',
  backfill: 'settings.jobs.backfill',
  performance: 'settings.jobs.performance',
}

export interface JobsBlockProps {
  /** `null` until `GET /health` has landed, failure included (ADR-0026). */
  health: HealthState | null
}

export function JobsBlock({ health }: JobsBlockProps) {
  const { t } = useI18n()
  const format = useFormatters()

  if (health === null) return null

  const jobs = health.jobs

  return (
    <Card role="region" aria-labelledby={JOBS_HEADING}>
      <CardHeader>
        <h2 id={JOBS_HEADING} className="text-lg font-semibold tracking-tight">
          {t('settings.jobs')}
        </h2>
        {/* The whole, in the word the bell wears its colour from. */}
        <p className={cn('text-sm font-medium', JOB_TONE[health.status])}>
          {t('settings.jobs.state', { state: health.status })}
        </p>
        {/* The cause, above the three symptoms it would produce. */}
        {health.scheduler_running ? null : (
          <p className="max-w-prose text-sm text-attention">{t('settings.jobs.scheduler')}</p>
        )}
      </CardHeader>
      <CardContent>
        {jobs === null ? (
          // The server could not fold its own three records — which is a defect
          // in the shaping and not a reason to restart anything, so it answers
          // `200` and says so. There is nothing to tabulate, and the sentence is
          // the server's claim rather than this page's.
          <p className="max-w-prose text-sm text-muted-foreground">{t('settings.jobs.unfolded')}</p>
        ) : (
          <dl className="divide-y rounded-lg border text-sm">
            {JOB_KEYS.map((key) => (
              <div
                key={key}
                className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-baseline"
              >
                <dt className="font-medium">{t(JOB_NAMES[key])}</dt>
                <dd className="space-y-1">
                  <p className={cn('text-sm', JOB_TONE[jobs[key].status])}>
                    {t(...verdictOf(key, jobs))}
                  </p>
                  <p className="tabular text-xs text-muted-foreground">
                    {jobs[key].at === null
                      ? t('settings.jobs.never')
                      : t('settings.jobs.last', { at: format.dateTime(jobs[key].at) })}
                  </p>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * One job's verdict as a sentence and the values it interpolates.
 *
 * The **key** is one per job rather than one per word: the three vocabularies
 * do not overlap in meaning even where they overlap in spelling — `failing` is
 * a ticker nobody could price on one row and a reconstruction wedged on
 * yfinance on the next — and one `select` per job is what lets each sentence
 * carry the counts that job has. A word this front does not know falls through
 * to the `other` branch, which says the job ran and no more: inventing a
 * reading for a server that is ahead of this bundle is worse than saying less
 * than it did.
 */
function verdictOf(key: JobKey, jobs: HealthJobs): [MessageKey, MessageValues] {
  if (key === 'scrape') {
    const job = jobs.scrape
    return [
      'settings.jobs.scrape.verdict',
      // The securities that ask to be looked at, **named** — a count alone
      // leaves the one thing the reader cannot look up: which line to read.
      { verdict: job.verdict, held: job.held, count: job.attention.length, symbols: job.attention.join(', ') },
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
  const job = jobs.performance
  // The error is the server's own English and is deliberately not rendered:
  // what a page says is a sentence in the reader's language, and *what* failed
  // is read in the logs, where a stack trace is worth something.
  return ['settings.jobs.performance.verdict', { verdict: job.verdict }]
}
