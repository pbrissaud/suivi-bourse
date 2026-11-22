/**
 * The agent's memory (#1619): every confirmed fact and project of the profile
 * (#1116), one ruled row each with its value, its confirmation date, *Modifier*
 * and *Oublier*. The rows are the empty thread's own (`FactDetail`), read under
 * the same key, so an edit or a forgetting made here shows there too.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useRef } from 'react'

import { EmptyState } from '@/components/EmptyState'
import { Unreadable } from '@/components/Unreadable'
import { entries, FactDetail } from '@/features/agent/components/AgentProfile'
import { profileApi } from '@/features/agent/lib/profile'
import { ACT } from '@/features/agent/lib/styles'
import { useI18n } from '@/lib/i18n'
import { oneFailure, readConditions } from '@/lib/status'

export function AgentMemoryView() {
  const { t } = useI18n()
  const list = useRef<HTMLDivElement>(null)
  const profile = useQuery({ queryKey: ['profile'], queryFn: profileApi.profile })
  const failure = oneFailure(readConditions({ queries: [profile] }))
  const all = profile.data && entries(profile.data)

  return (
    <div className="flex flex-col gap-9">
      {/* The control line: the way back, and nothing to act on yet. */}
      <div>
        <Link to="/agent" className={ACT}>
          {t('agent.stats.back')}
        </Link>
      </div>
      {/* A forgotten fact takes its row, and the last one the list: the focus lands here. */}
      <div
        ref={list}
        role="group"
        tabIndex={-1}
        aria-label={t('agent.memory.title')}
        className="focus:outline-none"
      >
        {failure !== null ? (
          <Unreadable failure={failure} />
        ) : all === undefined ? null : all.length === 0 ? (
          <EmptyState title={t('agent.memory.empty')} />
        ) : (
          <ul className="border-t">
            {all.map((entry) => (
              <li key={entry.key} className="border-b py-2.5">
                <FactDetail entry={entry} onForgotten={() => list.current?.focus()} row />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
