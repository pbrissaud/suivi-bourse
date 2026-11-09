/**
 * The agent's statistics (« Relevé », `Agent-Stats-Refonte.dc.html`): a hero of
 * the tokens exchanged since the start of the period, the bar of where they
 * came from (read back from the cache, new, written), the weeks stacked the
 * same way, and the *Par modèle* and *Par fil* tables.
 *
 * **No price, and no duration.** The server counts tokens, requests and tool
 * calls and prices nothing: the mockup's *Coût* and *Durée* readings, its cost
 * columns and its median turn are not here, since a figure no endpoint serves
 * would have to be invented. The period is the chart's, and it drives every
 * figure of the page.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { EmptyState } from '@/components/EmptyState'
import { Segmented } from '@/components/Segmented'
import { Unreadable } from '@/components/Unreadable'
import { Section } from '@/components/ui/section'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { agentApi, type AgentStats, type AgentStatsRange } from '@/features/agent/lib/api'
import { chartTop, monthTicks, sharesOf } from '@/features/agent/lib/statsView'
import { compactTokens } from '@/features/agent/lib/threads'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { oneFailure, readConditions } from '@/lib/status'

/** A share, not a change: unsigned, whole. */
const wholePercent = (locale: string, value: number) =>
  new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value)

const RANGES: AgentStatsRange[] = ['1M', 'YTD', '1Y', 'MAX']

export function AgentStatsView() {
  const { t } = useI18n()
  const [range, setRange] = useState<AgentStatsRange>('YTD')
  const stats = useQuery({
    queryKey: ['agent-stats', range],
    queryFn: () => agentApi.stats(range),
    placeholderData: keepPreviousData,
  })
  const failure = oneFailure(readConditions({ queries: [stats] }))
  const data = stats.data

  return (
    <div className="flex flex-col gap-9">
      {/* The control line: the way back on the left, the period on the right. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/agent"
          className="text-sm text-muted-foreground underline decoration-border underline-offset-3 hover:text-foreground"
        >
          {t('agent.stats.back')}
        </Link>
        <Segmented
          label={t('agent.stats.period')}
          mode="radio"
          size="compact"
          bordered
          options={RANGES.map((value) => ({ value, label: t(`agent.stats.range.${value}`) }))}
          value={range}
          onChange={setRange}
        />
      </div>
      {failure !== null ? (
        <Unreadable failure={failure} />
      ) : data === undefined ? null : data.totals.requests === 0 ? (
        <EmptyState title={t('agent.stats.empty')} description={t('agent.stats.empty.why')} />
      ) : (
        <>
          <Hero data={data} />
          <Weeks data={data} />
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ByModel data={data} />
            <ByThread data={data} />
          </div>
        </>
      )}
    </div>
  )
}

function Hero({ data }: { data: AgentStats }) {
  const { t, locale } = useI18n()
  const f = useFormatters()
  const since = data.since ? f.date(data.since) : null
  const shares = sharesOf(data.totals)
  const share = (value: number) => wholePercent(locale, value)
  const providers = [...new Set(data.models.map((m) => m.provider).filter((p) => p !== null))]
  const parts = [
    { key: 'cache', label: t('agent.stats.cache'), value: data.totals.cache_read },
    { key: 'fresh', label: t('agent.stats.fresh'), value: data.totals.fresh },
    { key: 'output', label: t('agent.stats.output'), value: data.totals.output },
  ] as const
  const swatch = { cache: 'bg-alloc-5', fresh: 'bg-alloc-1', output: 'bg-alloc-2' } as const
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
        <div className="flex min-w-0 flex-col gap-2.5">
          <p className="text-muted-foreground">
            {t('agent.stats.hero', {
              providers: providers.length === 0 ? 'none' : f.list(providers as string[]),
              since: since ?? 'none',
            })}
          </p>
          <p className="fig text-hero font-medium tracking-hero">
            {compactTokens(data.totals.tokens, locale)}
          </p>
        </div>
        <dl className="grid grid-cols-[auto_auto] items-baseline gap-x-6 gap-y-1.5 pb-1.5">
          {(
            [
              ['agent.stats.threads', data.totals.threads],
              ['agent.stats.requests', data.totals.requests],
              ['agent.stats.tools', data.totals.tool_calls],
            ] as const
          ).map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-right text-sm text-muted-foreground">{t(key)}</dt>
              <dd className="fig text-right text-md">{f.number(value, 0)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="flex flex-col gap-2.5">
        <div
          role="img"
          aria-label={t('agent.stats.bar', {
            cache: share(shares.cache),
            fresh: share(shares.fresh),
            output: share(shares.output),
          })}
          className="flex h-2.5 gap-0.5 overflow-hidden rounded-sm"
        >
          {parts.map((part) => (
            <span
              key={part.key}
              className={`block ${swatch[part.key]}`}
              style={{ flexGrow: part.value, flexBasis: 0 }}
            />
          ))}
        </div>
        <p className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
          {parts.map((part) => (
            <span key={part.key} className="inline-flex items-baseline gap-2">
              <span
                aria-hidden="true"
                className={`size-2 self-center rounded-xs ${swatch[part.key]}`}
              />
              <span className="text-muted-foreground">{part.label}</span>
              <span className="fig text-prose">{compactTokens(part.value, locale)}</span>
            </span>
          ))}
        </p>
      </div>
    </div>
  )
}

function Weeks({ data }: { data: AgentStats }) {
  const { t, locale } = useI18n()
  const f = useFormatters()
  const top = chartTop(Math.max(0, ...data.weeks.map((w) => w.cache_read + w.fresh + w.output)))
  const ticks = [top, (top * 2) / 3, top / 3, 0]
  const month = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' })
  const pct = (value: number) => `${(value / top) * 100}%`
  return (
    <figure
      aria-label={t('agent.stats.weeks')}
      className="m-0 grid grid-cols-[3.25rem_minmax(0,1fr)] grid-rows-[13rem_1.5rem]"
    >
      <div className="fig relative text-xs text-muted-foreground">
        {ticks.map((tick, index) => (
          <span
            key={tick}
            className="absolute right-2.5 -translate-y-1/2 whitespace-nowrap"
            style={{ top: `${(index / 3) * 100}%` }}
          >
            {compactTokens(Math.round(tick), locale)}
          </span>
        ))}
      </div>
      <div className="relative flex items-end gap-0.5 border-b">
        {ticks.slice(0, 3).map((tick, index) => (
          <span
            key={tick}
            aria-hidden="true"
            className="absolute inset-x-0 border-t border-dashed"
            style={{ top: `${(index / 3) * 100}%` }}
          />
        ))}
        {data.weeks.map((week) => (
          <span
            key={week.week}
            title={`${f.date(week.week)} · ${compactTokens(week.cache_read + week.fresh + week.output, locale)}`}
            className="relative flex h-full min-w-0 flex-1 flex-col justify-end"
          >
            <span className="block bg-alloc-2" style={{ height: pct(week.output) }} />
            <span className="block bg-alloc-1" style={{ height: pct(week.fresh) }} />
            <span className="block bg-alloc-5" style={{ height: pct(week.cache_read) }} />
          </span>
        ))}
      </div>
      <div />
      <div className="fig relative text-xs text-muted-foreground">
        {monthTicks(data.weeks).map(({ index, week }) => (
          <span
            key={week}
            className="absolute top-1.5 -translate-x-1/2"
            style={{ left: `${((index + 0.5) / data.weeks.length) * 100}%` }}
          >
            {month.format(new Date(week))}
          </span>
        ))}
      </div>
    </figure>
  )
}

function ByModel({ data }: { data: AgentStats }) {
  const { t, locale } = useI18n()
  const f = useFormatters()
  const since = data.since ? f.date(data.since) : null
  return (
    <Section
      title={t('agent.stats.models')}
      aside={since ? t('agent.stats.since', { since }) : null}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('agent.stats.col.model')}</TableHead>
            <TableHead numeric>{t('agent.stats.col.requests')}</TableHead>
            <TableHead numeric>{t('agent.stats.col.tokens')}</TableHead>
            <TableHead numeric>{t('agent.stats.col.cache')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.models.map((m) => (
            <TableRow key={`${m.provider}-${m.model}`} tall>
              <TableCell className="max-w-0 min-w-40">
                <span className="flex flex-col">
                  <span className="truncate font-medium">{m.model}</span>
                  <span className="truncate text-xs text-muted-foreground">{m.provider ?? ''}</span>
                </span>
              </TableCell>
              <TableCell numeric>{f.number(m.requests, 0)}</TableCell>
              <TableCell numeric>{compactTokens(m.tokens, locale)}</TableCell>
              <TableCell numeric className="text-muted-foreground">
                {m.cache_ratio === null ? '—' : wholePercent(locale, m.cache_ratio)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  )
}

function ByThread({ data }: { data: AgentStats }) {
  const { t, locale } = useI18n()
  const f = useFormatters()
  const since = data.since ? f.date(data.since) : null
  return (
    <Section
      title={t('agent.stats.threadsTable')}
      aside={since ? t('agent.stats.since', { since }) : null}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('agent.stats.col.thread')}</TableHead>
            <TableHead numeric>{t('agent.stats.col.requests')}</TableHead>
            <TableHead numeric>{t('agent.stats.col.tokens')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.threads.map((thread) => (
            <TableRow key={thread.id} tall>
              <TableCell className="max-w-0 min-w-40">
                <Link
                  to="/agent/$threadId"
                  params={{ threadId: thread.id }}
                  className="flex flex-col hover:[&_span:first-child]:underline hover:[&_span:first-child]:underline-offset-4"
                >
                  <span className="truncate font-medium">
                    {thread.title || t('agent.recent.untitled')}
                  </span>
                  <span className="fig truncate text-xs text-muted-foreground">
                    {f.date(thread.last_at)}
                  </span>
                </Link>
              </TableCell>
              <TableCell numeric>{f.number(thread.requests, 0)}</TableCell>
              <TableCell numeric>{compactTokens(thread.tokens, locale)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  )
}
