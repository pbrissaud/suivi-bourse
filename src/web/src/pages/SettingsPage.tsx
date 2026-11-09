import { useEffect } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'

import { AdvancedSection } from '@/features/settings/components/AdvancedSection'
import { AgentSection } from '@/features/settings/components/AgentSection'
import { DeviceSection } from '@/features/settings/components/DeviceSection'
import { REFERENCES_HASH } from '@/features/settings/components/FundsList'
import { NotificationsSection } from '@/features/settings/components/NotificationsSection'
import { PortfolioSection } from '@/features/settings/components/PortfolioSection'
import { SecuritySection } from '@/features/settings/components/SecuritySection'
import type { SectionRead } from '@/features/settings/components/SettingsSection'
import { settingsApi } from '@/features/settings/lib/api'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { oneFailure, readConditions } from '@/lib/status'

/** The sections, top to bottom: an anchor waits for every one above it. */
const SECTIONS = ['security', 'portfolio', 'agent', 'notifications', 'display', 'advanced'] as const

/** Anchors that name a row inside a section rather than the section itself. */
const WITHIN: Record<string, (typeof SECTIONS)[number]> = {
  [REFERENCES_HASH]: 'portfolio',
  funds: 'portfolio',
  taxation: 'portfolio',
}

/** Scroll to a section and focus it, so a keyboard lands where the eye does. */
function land(id: string) {
  const element = document.getElementById(id)
  element?.scrollIntoView()
  element?.focus({ preventScroll: true })
}

/** What a section stands on: nothing yet, a sentence and a retry, or its data. */
function readOf(query: UseQueryResult): SectionRead {
  const failure = oneFailure(readConditions({ queries: [query] }))
  return failure !== null
    ? { kind: 'failed', failure, retry: () => void query.refetch() }
    : query.data !== undefined
      ? { kind: 'ready' }
      : { kind: 'pending' }
}

/** What the owner sets. What the installation reports is on `/system`. */
export default function SettingsPage() {
  const { t } = useI18n()
  usePageHeading(t('page.settings'))

  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  const agent = useQuery({ queryKey: ['agent-settings'], queryFn: settingsApi.agentSettings })
  const providers = useQuery({ queryKey: ['agent-providers'], queryFn: api.agentProviders })
  const channels = useQuery({
    queryKey: ['notification-channels'],
    queryFn: api.notificationChannels,
  })

  const settingsRead = readOf(config)
  // The agent's rows stand on both of its reads; the first failure is the one said.
  const agentRead: SectionRead =
    readOf(agent).kind === 'failed'
      ? readOf(agent)
      : readOf(providers).kind === 'failed'
        ? readOf(providers)
        : agent.data && providers.data
          ? { kind: 'ready' }
          : { kind: 'pending' }
  const channelsRead = readOf(channels)

  // `/settings#agent`, `#portfolio`…: a section is drawn only once its read
  // lands, so the router's own hash scroll finds nothing, and a section above
  // that lands later would push the target away from where the page scrolled.
  // Wait for the target and every section above it to settle (data or failure),
  // then scroll and focus, so a keyboard lands where the eye does.
  const settled: Record<(typeof SECTIONS)[number], boolean> = {
    security: true,
    portfolio: settingsRead.kind !== 'pending',
    agent: agentRead.kind !== 'pending',
    notifications: channelsRead.kind !== 'pending',
    display: true,
    advanced: settingsRead.kind !== 'pending',
  }
  const hash = useLocation({ select: (location) => location.hash })
  const anchor = WITHIN[hash] ?? hash
  const target = SECTIONS.findIndex((id) => id === anchor)
  const landed = target >= 0 && SECTIONS.slice(0, target + 1).every((id) => settled[id])
  useEffect(() => {
    // A row inside a section (the tax list) is where the eye is meant to land.
    if (landed) land(hash in WITHIN && hash !== REFERENCES_HASH ? hash : anchor)
  }, [anchor, hash, landed])

  return (
    <div>
      <SecuritySection read={settingsRead} />
      <PortfolioSection read={settingsRead} />
      <AgentSection read={agentRead} settings={agent.data} providers={providers.data} />
      <NotificationsSection read={channelsRead} />
      {/* The browser's own preferences: outside every read, so the section
          renders when all of them fail. */}
      <DeviceSection />
      <AdvancedSection read={settingsRead} />
    </div>
  )
}
