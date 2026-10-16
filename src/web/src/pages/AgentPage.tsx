import { useEffect, useState } from 'react'

import { AgentChat, useThreadParam } from '@/features/agent/components/AgentChat'
import { useAgentChat } from '@/features/agent/lib/agentChatProvider'
import { useT } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'

/** From here the recent threads are a column beside the conversation. */
const WIDE_FROM = 1024

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= WIDE_FROM)
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= WIDE_FROM)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return wide
}

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
  usePageHeading(t('page.agent'))

  useEffect(() => {
    const title = document.title
    document.title = t('page.agent')
    return () => {
      document.title = title
    }
  }, [t])

  useEffect(() => {
    if (threadId === undefined) {
      if (chat.messages.length > 0 || opening !== null) startThread()
    } else if (threadId !== (opening?.id ?? chat.id)) {
      openThread(threadId)
    }
  }, [threadId, chat, opening, startThread, openThread])

  // The content area's height, less the header (56 px) and the gutter above
  // and below: the conversation scrolls inside, the composer stays in view.
  // From 1 024 px the gutter is given back, so the threads' rail meets the
  // navigation and runs the page's height: `lg:-m-7` undoes the shell's
  // `lg:p-7` (Shell.tsx) and 3.5rem is the header's `h-14`. Change either
  // there and this line with it.
  return (
    <div className="h-[calc(100svh-5.25rem)] md:h-[calc(100svh-6rem)] lg:-m-7 lg:h-[calc(100svh-3.5rem)]">
      <AgentChat wide={wide} />
    </div>
  )
}
