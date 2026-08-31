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
 *
 * **A read that was refused is not that**, and the difference is the whole of
 * why this block takes a second prop (#830, #829, ADR-0037). `/health` refusing
 * is precisely the state the bell sends the reader here in — `installationState`
 * reads `unreachable` off the failed request and the panel pins *Le magasin ne
 * répond pas* with a link to this page — so a card that vanished on it would
 * make the one link the panel offers land on a page that says nothing about
 * what the link was about. So the card stays, keeps its name, and carries
 * `Unreadable` in the space the three rows would have filled: the same rule the
 * dials and the store already follow, one block further along. The heading
 * survives because it is not a claim about the installation — it names what is
 * missing, which is what makes *the workloads could not be read* sayable at
 * all.
 */
import { Unreadable } from '@/components/Unreadable'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import type { HealthJobs, HealthState, HealthStatus } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey, type MessageValues } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'
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

/**
 * The same three states as a **mark** rather than as a colour on a word — the
 * dot the drawing puts beside this card's heading (#838). It is not the status
 * dot ADR-0037 removed: that one was a global indicator in the chrome, read on
 * every page and standing for the whole installation. This one names the card
 * it is in, on the page the bell's own link lands on.
 */
const JOB_DOT: Record<HealthStatus, string> = {
  ok: 'bg-gain',
  attention: 'bg-attention',
  unknown: 'bg-muted-foreground',
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
  /** `null` until `GET /health` has landed, refusal included (ADR-0026). */
  health: HealthState | null
  /**
   * `GET /health` refused — `null` when it answered or is still in flight. The
   * two are **not** the same news (StoreBlock states the same distinction over
   * `/api/store`): in flight nothing has been observed and the card does not
   * exist; refused, there is an observation to state — *this could not be read*
   * — and it is the one the bell just sent the reader here to read.
   */
  failure?: ReadFailure | null
}

export function JobsBlock({ health, failure = null }: JobsBlockProps) {
  const { t } = useI18n()
  const format = useFormatters()

  if (health === null) {
    // In flight, and nothing is rendered at all (ADR-0026).
    if (failure === null) return null
    // Refused, and the card owes the reason where its three rows would have
    // been. It is the state the bell's health entry links here in, so the page
    // saying nothing would be a link to a page about something else.
    return (
      <Card role="region" aria-labelledby={JOBS_HEADING}>
        <CardHeader>
          <h2 id={JOBS_HEADING} className="eyebrow">
            {t('settings.jobs')}
          </h2>
        </CardHeader>
        <CardContent>
          <Unreadable failure={failure} />
        </CardContent>
      </Card>
    )
  }

  // **The three keys are the server's contract, not the type's.** `readHealth`
  // admits any object here — it checks `typeof jobs === 'object'` and no more —
  // so a payload that passed the narrowing without them would crash this table
  // on its first row. A fold that came back short is the same news as a fold
  // that failed, and it is said with the same sentence rather than a second one.
  const rows =
    health.jobs !== null && JOB_KEYS.every((key) => health.jobs?.[key] != null)
      ? health.jobs
      : null

  return (
    <Card role="region" aria-labelledby={JOBS_HEADING}>
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {/* **The dot is the card's**, and it is the only one left in the
            product: it says which of the three words below applies before the
            word is read, and it is the bell's own colour on the surface the
            bell links to. */}
        <h2 id={JOBS_HEADING} className="eyebrow flex items-center gap-2.5">
          <span
            aria-hidden
            className={cn('inline-block size-2 rounded-full', JOB_DOT[health.status])}
          />
          {t('settings.jobs')}
        </h2>
        {/* The whole, in the word the bell wears its colour from. */}
        <p className="text-xs text-muted-foreground">
          {t('settings.jobs.state', { state: health.status })}
        </p>
      </CardHeader>
      <CardContent>
        {/* The cause, above the three symptoms it would produce. */}
        {health.scheduler_running ? null : (
          <p className="mb-3 max-w-prose text-sm text-attention">{t('settings.jobs.scheduler')}</p>
        )}
        {rows === null ? (
          <p className="max-w-prose text-sm text-muted-foreground">{t('settings.jobs.unfolded')}</p>
        ) : (
          // **Three columns, and a header row over them** (#838). The drawing
          // reads this block down a column — *what ran*, *when*, *what came of
          // it* — where the block laid each verdict under its own name, which
          // is a list of three paragraphs and not a plan of charge.
          <dl className="text-sm">
            <div
              aria-hidden
              className="hidden gap-4 border-b pb-2 sm:grid sm:grid-cols-[minmax(0,1fr)_10.5rem_minmax(0,14rem)]"
            >
              <span className="eyebrow">{t('settings.jobs.column.name')}</span>
              <span className="eyebrow">{t('settings.jobs.column.at')}</span>
              <span className="eyebrow">{t('settings.jobs.column.verdict')}</span>
            </div>
            {JOB_KEYS.map((key) => (
              <div
                key={key}
                className="grid grid-cols-1 gap-1 border-b py-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_10.5rem_minmax(0,14rem)] sm:items-baseline sm:gap-4"
              >
                <dt>{t(JOB_NAMES[key])}</dt>
                <dd className="tabular font-mono text-xs text-muted-foreground">
                  {/* The instant alone: the column over it is what names it,
                      so *Dernier passage 26 août* would say it twice (#838). */}
                  {rows[key].at === null
                    ? t('settings.jobs.never')
                    : format.dateTime(rows[key].at)}
                </dd>
                <dd className={cn('text-sm', JOB_TONE[rows[key].status])}>
                  {t(...verdictOf(key, rows))}
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
