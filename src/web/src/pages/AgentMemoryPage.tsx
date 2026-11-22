import { AgentMemoryView } from '@/features/agent/components/AgentMemory'
import { ThreadRail } from '@/features/agent/components/ThreadRail'
import { useWide } from '@/features/agent/lib/useWide'
import { useT } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'

/**
 * `/agent/memory`: what the agent knows about the owner (#1619), a page of its
 * own with the threads' rail beside it, as `/agent/stats` is.
 */
export default function AgentMemoryPage() {
  const t = useT()
  const wide = useWide()
  usePageHeading(t('agent.memory.title'))

  // Full bleed like the conversation, so the rail meets the navigation.
  return (
    <div className="-mx-3.5 -mt-6 -mb-14 flex h-[calc(100svh-3.5rem)] md:-mx-8 md:-mt-8">
      {wide ? <ThreadRail /> : null}
      <div className="min-w-0 flex-1 overflow-y-auto px-3.5 pt-6 pb-14 md:px-8 md:pt-8">
        <AgentMemoryView />
      </div>
    </div>
  )
}
