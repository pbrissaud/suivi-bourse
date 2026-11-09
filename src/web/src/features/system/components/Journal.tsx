import { Link } from '@tanstack/react-router'
import { Download, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { EmptyState } from '@/components/EmptyState'
import { FilterButton } from '@/components/FilterButton'
import { TextTabs } from '@/components/TextTabs'
import { Unreadable } from '@/components/Unreadable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useClock } from '@/features/system/lib/clock'
import { type JournalSpan, useJournal } from '@/features/system/lib/useJournal'
import { type JournalJob, type JournalRow, ROUTES } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { cn } from '@/lib/utils'

type Tab = 'all' | 'warning' | 'error'

const JOBS: readonly JournalJob[] = ['scrape', 'backfill', 'performance', 'ingestion', 'system']
const SPANS: readonly JournalSpan[] = ['1h', '24h', '7d']

/** Typing in the search field asks the server once the hand stops. */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/**
 * The journal (DESIGN.md › Journal): « ← Système », « En direct » and
 * Télécharger on the first line; the tabs, the filters and the search under
 * it; then ruled rows — time in mono, level, task, the raw message in mono —
 * under day separators, a « détail » disclosure opening the traceback.
 */
export function Journal() {
  const { t } = useI18n()
  const clock = useClock()
  const [tab, setTab] = useState<Tab>('all')
  const [job, setJob] = useState<JournalJob | 'all'>('all')
  const [span, setSpan] = useState<JournalSpan>('7d')
  const [search, setSearch] = useState('')
  const [live, setLive] = useState(true)
  const q = useDebounced(search, 300)

  const journal = useJournal({ job, span, q }, live)
  const rows = journal.rows
  const warnings = rows.filter((row) => row.level === 'warning' || row.level === 'error').length
  const errors = rows.filter((row) => row.level === 'error').length
  const shown = useMemo(
    () =>
      rows.filter(
        (row) =>
          tab === 'all' ||
          (tab === 'warning'
            ? row.level === 'warning' || row.level === 'error'
            : row.level === 'error'),
      ),
    [rows, tab],
  )

  const now = new Date()
  const days: { key: string; text: string; rows: JournalRow[] }[] = []
  for (const row of shown) {
    const day = clock.day(row.time, now)
    const label = day.today ? t('journal.today', { day: day.text }) : day.text
    const group = days.at(-1)
    if (group !== undefined && group.key === day.key) group.rows.push(row)
    else days.push({ key: day.key, text: label, rows: [row] })
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-4">
        <Link
          to="/system"
          className="text-sm text-muted-foreground no-underline hover:text-foreground"
        >
          {t('journal.back')}
        </Link>
        <div className="flex items-center gap-4">
          <button
            type="button"
            aria-pressed={live}
            onClick={() => setLive(!live)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <i
              aria-hidden
              className={cn('block size-1.5 rounded-full', live ? 'bg-foreground' : 'bg-border')}
            />
            {t('journal.live')}
          </button>
          <Button asChild>
            <a href={ROUTES.logsDownload} download>
              <Download aria-hidden />
              {t('journal.download')}
            </a>
          </Button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b pb-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <TextTabs
            label={t('journal.tabs')}
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'all', label: t('journal.tab.all') },
              {
                value: 'warning',
                label: (
                  <>
                    {t('journal.tab.warning')} <span className="fig">{warnings}</span>
                  </>
                ),
              },
              {
                value: 'error',
                label: (
                  <>
                    {t('journal.tab.error')} <span className="fig">{errors}</span>
                  </>
                ),
              },
            ]}
          />
          <FilterButton
            label={t('journal.filter.job')}
            value={job}
            onChange={setJob}
            options={[
              { value: 'all', label: t('journal.filter.job.all') },
              ...JOBS.map((one) => ({ value: one, label: t(`system.job.${one}`) })),
            ]}
          />
          <FilterButton
            label={t('journal.filter.span')}
            value={span}
            onChange={setSpan}
            neutral="7d"
            options={SPANS.map((one) => ({ value: one, label: t(`journal.span.${one}`) }))}
          />
        </div>
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('journal.search')}
          aria-label={t('journal.search.label')}
          className="h-8 w-70"
        />
      </div>

      {journal.status === 'failed' ? (
        <Unreadable failure={{ message: problemMessageKey(journal.error) }} />
      ) : journal.status === 'loading' ? null : shown.length === 0 ? (
        <EmptyState title={t('journal.empty.title')} description={t('journal.empty.body')} />
      ) : (
        <div>
          {days.map((day) => (
            <section key={day.key} aria-label={day.text}>
              <h2 className="border-b pt-5 pb-1.5 text-xs font-medium text-muted-foreground">
                {day.text}
              </h2>
              <ol>
                {day.rows.map((row, index) => (
                  <Line key={`${row.time}-${index}`} row={row} time={clock.time(row.time)} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function Line({ row, time }: { row: JournalRow; time: string }) {
  const { t } = useI18n()
  const quiet = row.level === 'info' || row.level === 'debug'
  const message = cn(
    'font-mono text-xs break-words whitespace-pre-wrap',
    quiet ? 'text-muted-foreground' : 'text-foreground',
  )

  return (
    <li className="grid min-h-10 grid-cols-[3.5rem_5rem_minmax(0,1fr)] items-start gap-x-4 border-b py-2 text-sm md:grid-cols-[3.5rem_5rem_13rem_minmax(0,1fr)]">
      <span className="fig text-muted-foreground">{time}</span>
      <span
        className={cn(
          'flex items-center gap-1.25 font-medium whitespace-nowrap',
          quiet && 'text-muted-foreground',
        )}
      >
        {quiet ? null : <TriangleAlert aria-hidden className="size-3.5" />}
        {t(`journal.level.${row.level}`)}
      </span>
      <span className="hidden truncate text-muted-foreground md:block">
        {t(`system.job.${row.job}`)}
      </span>
      {row.detail === null ? (
        <span className={message}>{row.message}</span>
      ) : (
        <details>
          <summary
            className={cn(message, 'cursor-pointer list-none [&::-webkit-details-marker]:hidden')}
          >
            {row.message}{' '}
            <span className="font-sans text-sm text-muted-foreground underline decoration-border underline-offset-3">
              {t('journal.detail')}
            </span>
          </summary>
          <pre className="mt-2 rounded-md bg-muted p-3 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
            {row.detail}
          </pre>
        </details>
      )}
    </li>
  )
}
