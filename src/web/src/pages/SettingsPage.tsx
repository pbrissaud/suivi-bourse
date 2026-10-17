import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'

import { Unreadable } from '@/components/Unreadable'
import { agentApi } from '@/features/agent/lib/api'
import { AccessBlock } from '@/features/settings/components/AccessBlock'
import { AgentBlock } from '@/features/settings/components/AgentBlock'
import { DeviceBlock } from '@/features/settings/components/DeviceBlock'
import { DialsBlock } from '@/features/settings/components/DialsBlock'
import { TaxationBlock } from '@/features/settings/components/TaxationBlock'
import { ThemeBlock } from '@/features/settings/components/ThemeBlock'
import { settingsApi } from '@/features/settings/lib/api'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { oneFailure, readConditions } from '@/lib/status'

/** What the owner sets. What the installation reports is on `/status`. */
export default function SettingsPage() {
  const { t } = useI18n()
  usePageHeading(t('page.settings'))

  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  const agent = useQuery({ queryKey: ['agent-config'], queryFn: agentApi.agentConfig })
  const theme = useQuery({ queryKey: ['theme'], queryFn: settingsApi.theme })

  const settingsFailure = oneFailure(readConditions({ queries: [config] }))
  const agentFailure = oneFailure(readConditions({ queries: [agent] }))
  const themeFailure = oneFailure(readConditions({ queries: [theme] }))

  // `/settings#agent`, from the agent page's *Configure*: the block is drawn
  // only once its read lands, so the router's own hash scroll finds nothing.
  // Focus follows the scroll, so a keyboard lands where the eye does.
  const hash = useLocation({ select: (location) => location.hash })
  const agentDrawn = agent.data !== undefined || agentFailure !== null
  useEffect(() => {
    if (hash !== 'agent' || !agentDrawn) return
    const target = document.getElementById('agent')
    target?.scrollIntoView()
    target?.focus({ preventScroll: true })
  }, [hash, agentDrawn])

  return (
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
      {/* The browser's own preferences: outside every `Unreadable` branch, the
          block reads no query and renders when all of them fail. */}
      <div id="device" className="scroll-mt-20 xl:col-span-2">
        <DeviceBlock />
      </div>
      <div className="xl:col-span-2">
        {settingsFailure !== null ? (
          <Unreadable failure={settingsFailure} />
        ) : config.data ? (
          <DialsBlock config={config.data} runtime={runtime.data} />
        ) : null}
      </div>
      <div id="agent" tabIndex={-1} className="scroll-mt-20 outline-none">
        {agentFailure !== null ? (
          <Unreadable failure={agentFailure} />
        ) : agent.data ? (
          <AgentBlock config={agent.data} />
        ) : null}
      </div>
      {themeFailure !== null ? (
        <Unreadable failure={themeFailure} />
      ) : theme.isSuccess ? (
        <ThemeBlock stored={theme.data} />
      ) : null}
      <AccessBlock />
      <TaxationBlock />
    </div>
  )
}
