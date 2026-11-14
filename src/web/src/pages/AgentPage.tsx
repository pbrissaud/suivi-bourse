import { useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'

import { AgentChat, useThreadParam } from '@/features/agent/components/AgentChat'
import { useAgentChat } from '@/features/agent/lib/agentChatProvider'
import { useWide } from '@/features/agent/lib/useWide'
import { useT } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'

/**
 * `/agent` and `/agent/$threadId` (#1196): the address names the thread.
 *
 * `/agent` is a new thread: the one on screen if nothing was asked in it yet,
 * a fresh one otherwise. `/agent/$threadId` shows that thread — the one
 * already on screen, a stream in flight included, or else read back from the
 * server; a thread that cannot be read says so and the address stays.
 */
export default function AgentPage() {
  const t = useT()
  const threadId = useThreadParam()
  const { chat, opening, startThread, openThread } = useAgentChat()
  const wide = useWide()
  const navigate = useNavigate()
  usePageHeading(t('page.agent'))

  useEffect(() => {
    if (threadId === undefined) {
      if (chat.messages.length > 0 || opening !== null) startThread()
    } else if (threadId !== (opening?.id ?? chat.id)) {
      openThread(threadId)
    }
  }, [threadId, chat, opening, startThread, openThread])

  // « Nouveau fil ⌘N »: the rail says it, so it does it where the browser lets it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'n') return
      event.preventDefault()
      void navigate({ to: '/agent' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  // The rail meets the navigation and runs the page's height: the negative
  // margins give back the shell's envelope (`px-3.5 pt-6 pb-14`, `md:px-8
  // md:pt-8`, Shell.tsx) and 3.5rem is the header's `h-14`. Change either there
  // and this line with it. The conversation scrolls inside, the composer
  // stays in view.
  return (
    <div className="-mx-3.5 -mt-6 -mb-14 h-[calc(100svh-3.5rem)] md:-mx-8 md:-mt-8">
      <AgentChat wide={wide} />
    </div>
  )
}
