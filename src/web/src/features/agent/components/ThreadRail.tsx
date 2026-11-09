/**
 * The agent's rail (« Relevé », `Agent-Refonte.dc.html`): 240 px on `muted`,
 * « Nouveau fil ⌘N », a search field, the threads grouped by day, and
 * « Statistiques » at the foot. Under 1 024 px the same body lives in a popover
 * of the page's control line.
 *
 * A thread is deleted from its own head (`ThreadHead`), not from here: the rail
 * is for finding one, and a bin beside every title was the way a conversation
 * got lost.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChartColumn, Search, SquarePen } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Input } from '@/components/ui/input'
import { agentApi } from '@/features/agent/lib/api'
import { RAIL_ROW } from '@/features/agent/lib/styles'
import { groupThreads, monthName, type ThreadGroup } from '@/features/agent/lib/threads'
import { type MessageKey, useI18n } from '@/lib/i18n'

/** The rail's body: reused as is by the popover under 1 024 px. */
export function RailBody({ onOpened }: { onOpened?: () => void }) {
  const { t, locale } = useI18n()
  const [search, setSearch] = useState('')
  const threads = useQuery({ queryKey: ['agent-threads'], queryFn: agentApi.agentThreads })

  const groups = useMemo(() => {
    const asked = search.trim().toLocaleLowerCase(locale)
    const kept = (threads.data ?? []).filter(
      (thread) =>
        asked === '' ||
        (thread.title || t('agent.recent.untitled')).toLocaleLowerCase(locale).includes(asked),
    )
    return groupThreads(kept, new Date())
  }, [threads.data, search, locale, t])

  return (
    <>
      <Link
        to="/agent"
        // Exact: `/agent/x` starts with `/agent` and is not a new thread.
        activeOptions={{ exact: true }}
        className={`${RAIL_ROW} font-medium`}
        onClick={onOpened}
      >
        <span className="inline-flex items-center gap-2">
          <SquarePen className="size-4" aria-hidden="true" />
          {t('agent.newThread')}
        </span>
        <kbd className="fig font-sans text-xs text-muted-foreground">⌘N</kbd>
      </Link>
      <div className="relative mt-2 mb-3">
        <Search
          className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t('agent.rail.search')}
          placeholder={t('agent.rail.search')}
          className="h-8 bg-background pl-8 text-sm md:text-sm"
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {threads.error ? (
          <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
            {t('agent.recent.unreadable', { reason: threads.error.message })}
          </p>
        ) : threads.data === undefined ? null : threads.data.length === 0 ? (
          <p className="px-2.5 py-1.5 text-sm text-muted-foreground">{t('agent.recent.empty')}</p>
        ) : groups.length === 0 ? (
          <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
            {t('agent.rail.none', { search: search.trim() })}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.key} aria-label={groupName(group, locale, t)}>
              <p className="label px-2.5 pt-2 pb-0.5">{groupName(group, locale, t)}</p>
              <ul>
                {group.threads.map((thread) => (
                  <li key={thread.id}>
                    <Link
                      to="/agent/$threadId"
                      params={{ threadId: thread.id }}
                      className={RAIL_ROW}
                      onClick={onOpened}
                    >
                      <span className="min-w-0 truncate">
                        {thread.title || t('agent.recent.untitled')}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <div className="mt-auto border-t pt-3">
        <Link to="/agent/stats" className={RAIL_ROW} onClick={onOpened}>
          <span className="inline-flex items-center gap-2">
            <ChartColumn className="size-4" aria-hidden="true" />
            {t('agent.stats.link')}
          </span>
        </Link>
      </div>
    </>
  )
}

function groupName(group: ThreadGroup, locale: string, t: (key: MessageKey) => string): string {
  if (group.key === 'today') return t('agent.rail.today')
  if (group.key === 'yesterday') return t('agent.rail.yesterday')
  if (group.month === null) return t('agent.rail.undated')
  return monthName(group.month, new Date(), locale)
}

/** The wide rail: flush with the navigation, as tall as the page. */
export function ThreadRail() {
  const { t } = useI18n()
  return (
    <nav
      aria-label={t('agent.rail')}
      className="flex w-60 shrink-0 flex-col gap-1 border-r bg-muted px-3 py-4"
    >
      <RailBody />
    </nav>
  )
}
