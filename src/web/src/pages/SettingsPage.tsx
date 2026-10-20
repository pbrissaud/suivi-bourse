import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation } from '@tanstack/react-router'

import { Unreadable } from '@/components/Unreadable'
import { accountsApi } from '@/features/accounts/lib/api'
import { agentApi } from '@/features/agent/lib/api'
import { AccessBlock } from '@/features/settings/components/AccessBlock'
import { AdvancedSection } from '@/features/settings/components/AdvancedSection'
import { AgentBlock } from '@/features/settings/components/AgentBlock'
import { DeviceSection } from '@/features/settings/components/DeviceSection'
import { PortfolioSection } from '@/features/settings/components/PortfolioSection'
import type { SectionRead } from '@/features/settings/components/SettingsSection'
import { TaxationBlock } from '@/features/settings/components/TaxationBlock'
import { ThemeBlock } from '@/features/settings/components/ThemeBlock'
import { settingsApi } from '@/features/settings/lib/api'
import { api } from '@/lib/api'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { oneFailure, readConditions } from '@/lib/status'

/** The sections, top to bottom: an anchor waits for every one above it. */
const SECTIONS = [
  { id: 'device', title: 'settings.device.title' },
  { id: 'portfolio', title: 'settings.portfolio.title' },
  { id: 'agent', title: 'settings.agent.title' },
  { id: 'security', title: 'settings.access.title' },
  { id: 'taxation', title: 'settings.taxation' },
  { id: 'theme', title: 'settings.theme.title' },
  { id: 'advanced', title: 'settings.advanced.title' },
] as const satisfies readonly { id: string; title: MessageKey }[]

/** What the owner sets. What the installation reports is on `/system`. */
export default function SettingsPage() {
  const { t } = useI18n()
  usePageHeading(t('page.settings'))

  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  const agent = useQuery({ queryKey: ['agent-config'], queryFn: agentApi.agentConfig })
  const theme = useQuery({ queryKey: ['theme'], queryFn: settingsApi.theme })
  // The taxation block draws nothing until this lands; it reads the same key.
  const taxation = useQuery({ queryKey: ['taxation-models'], queryFn: accountsApi.taxationModels })

  const settingsFailure = oneFailure(readConditions({ queries: [config] }))
  const agentFailure = oneFailure(readConditions({ queries: [agent] }))
  const themeFailure = oneFailure(readConditions({ queries: [theme] }))
  const taxationFailure = oneFailure(readConditions({ queries: [taxation] }))

  const settingsRead: SectionRead =
    settingsFailure !== null
      ? { kind: 'failed', failure: settingsFailure, retry: () => void config.refetch() }
      : config.data
        ? { kind: 'ready' }
        : { kind: 'pending' }

  // `/settings#agent`, `#portfolio`…: a section is drawn only once its read
  // lands, so the router's own hash scroll finds nothing, and a section above
  // that lands later would push the target away from where the page scrolled.
  // Wait for the target and every section above it to settle (data or failure),
  // then scroll and focus, so a keyboard lands where the eye does.
  const settled: Record<(typeof SECTIONS)[number]['id'], boolean> = {
    device: true,
    portfolio: settingsRead.kind !== 'pending',
    agent: agent.data !== undefined || agentFailure !== null,
    security: true,
    taxation: taxation.data !== undefined || taxationFailure !== null,
    theme: theme.isSuccess || themeFailure !== null,
    advanced: settingsRead.kind !== 'pending',
  }
  const hash = useLocation({ select: (location) => location.hash })
  const target = SECTIONS.findIndex((section) => section.id === hash)
  const landed = target >= 0 && SECTIONS.slice(0, target + 1).every(({ id }) => settled[id])
  useEffect(() => {
    if (!landed) return
    const element = document.getElementById(hash)
    element?.scrollIntoView()
    element?.focus({ preventScroll: true })
  }, [hash, landed])

  return (
    <div className="max-w-settings">
      {/* Under 1 024 px the gutter titles stack with their rows, so the page
          opens on a one-line index instead. */}
      <nav
        aria-label={t('settings.index')}
        className="-mx-3.5 mb-4 flex gap-5 overflow-x-auto px-3.5 md:-mx-5 md:px-5 lg:hidden"
      >
        {SECTIONS.map(({ id, title }) => (
          <Link
            key={id}
            to="/settings"
            hash={id}
            className="inline-flex min-h-11 items-center text-base whitespace-nowrap text-muted-foreground hover:text-foreground"
          >
            {t(title)}
          </Link>
        ))}
      </nav>

      {/* Their own box, so that the first section is the first child. */}
      <div>
        {/* The browser's own preferences: outside every read, so the section
          renders when all of them fail. */}
        <DeviceSection />
        <PortfolioSection read={settingsRead} />
        {/* Until each block moves onto `SettingsSection`, these wrappers wear its
          box: same id, focus and scroll offset, same rule above. */}
        <div id="agent" tabIndex={-1} className="scroll-mt-20 border-t py-8 outline-none">
          {agentFailure !== null ? (
            <Unreadable failure={agentFailure} />
          ) : agent.data ? (
            <AgentBlock config={agent.data} />
          ) : null}
        </div>
        <div id="security" tabIndex={-1} className="scroll-mt-20 border-t py-8 outline-none">
          <AccessBlock />
        </div>
        <div id="taxation" tabIndex={-1} className="scroll-mt-20 border-t py-8 outline-none">
          <TaxationBlock />
        </div>
        <div id="theme" tabIndex={-1} className="scroll-mt-20 border-t py-8 outline-none">
          {themeFailure !== null ? (
            <Unreadable failure={themeFailure} />
          ) : theme.isSuccess ? (
            <ThemeBlock stored={theme.data} />
          ) : null}
        </div>
        <AdvancedSection runtime={runtime.data} read={settingsRead} />
      </div>
    </div>
  )
}
