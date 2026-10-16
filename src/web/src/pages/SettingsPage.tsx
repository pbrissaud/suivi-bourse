import { useQuery } from '@tanstack/react-query'

import { Unreadable } from '@/components/Unreadable'
import { agentApi } from '@/features/agent/lib/api'
import { AccessBlock } from '@/features/settings/components/AccessBlock'
import { AgentBlock } from '@/features/settings/components/AgentBlock'
import { DialsBlock } from '@/features/settings/components/DialsBlock'
import { TaxationBlock } from '@/features/settings/components/TaxationBlock'
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

  const settingsFailure = oneFailure(readConditions({ queries: [config] }))
  const agentFailure = oneFailure(readConditions({ queries: [agent] }))

  return (
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
      <div className="xl:col-span-2">
        {settingsFailure !== null ? (
          <Unreadable failure={settingsFailure} />
        ) : config.data ? (
          <DialsBlock config={config.data} runtime={runtime.data} />
        ) : null}
      </div>
      {agentFailure !== null ? (
        <Unreadable failure={agentFailure} />
      ) : agent.data ? (
        <AgentBlock config={agent.data} />
      ) : null}
      <AccessBlock />
      <TaxationBlock />
    </div>
  )
}
