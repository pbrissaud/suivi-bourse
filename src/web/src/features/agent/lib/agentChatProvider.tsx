/**
 * The agent's conversation, above the router outlet (#1117, #1196): which
 * thread is on screen, and the `Chat` that streams it.
 *
 * **Leaving the page keeps the thread.** The `Chat` lives here and not in the
 * `/agent` page, so a page unmounted by a navigation picks the same
 * conversation back up when the reader returns — the messages, a stream still
 * in flight or finished meanwhile, an error waiting for *Réessayer*.
 *
 * The thread's address is the URL's (`/agent/$threadId`), not this module's:
 * the page asks for the thread its address names, and a reload reads it back
 * from the server.
 */
import { Chat } from '@ai-sdk/react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { generateId, type UIMessage } from 'ai'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { agentSeam, joinAssistantMessages } from '@/features/agent/lib/agentChat'
import { agentApi } from '@/features/agent/lib/api'

interface AgentChatValue {
  /** The thread on screen. A new one has no file until its first question. */
  chat: Chat<UIMessage>
  /** Start an empty thread under a fresh id. */
  startThread: () => void
  /** Read a stored thread from the server, then show it. */
  openThread: (id: string) => void
  /** Read the thread on screen again from the server: a statement wrote messages into it (#1120). */
  reloadThread: () => Promise<void>
  /** A thread being read: nothing of it is drawn until it lands. */
  opening: { id: string; error: string | null } | null
  /** The thread on screen was read back with its last turn failed, and not asked again since. */
  failedOnReload: boolean
  /** A question was asked: the failure the thread was read with is over. */
  settle: () => void
}

const AgentChatContext = createContext<AgentChatValue | null>(null)

/**
 * A thread's `Chat`. A turn that ends gives the thread a title, or a newer
 * date: the list follows, whether or not the page is on screen to see it end.
 */
function chatFor(client: QueryClient, id: string, messages: UIMessage[] = []): Chat<UIMessage> {
  return new Chat<UIMessage>({
    id,
    messages,
    transport: agentSeam.transport(),
    onFinish: () => void client.invalidateQueries({ queryKey: ['agent-threads'] }),
  })
}

export function AgentChatProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const [chat, setChat] = useState(() => chatFor(client, generateId()))
  const [opening, setOpening] = useState<AgentChatValue['opening']>(null)
  const [failedOnReload, setFailedOnReload] = useState(false)

  // The chat on screen, for stopping it from outside a state updater.
  const current = useRef(chat)
  useEffect(() => {
    current.current = chat
  }, [chat])
  const replace = useCallback((next: Chat<UIMessage>) => {
    current.current.stop()
    setChat(next)
  }, [])

  /** The last read asked for: an answer to an earlier one is dropped. */
  const reading = useRef(0)

  const startThread = useCallback(() => {
    reading.current += 1
    setOpening(null)
    setFailedOnReload(false)
    replace(chatFor(client, generateId()))
  }, [client, replace])

  const openThread = useCallback(
    async (id: string) => {
      const sequence = ++reading.current
      // Back to the thread already on screen: whatever was being read, or
      // failed to be, is dropped, and the stream in flight is left alone.
      if (id === current.current.id) {
        setOpening(null)
        return
      }
      setOpening({ id, error: null })
      try {
        const thread = await agentApi.agentThread(id)
        if (sequence !== reading.current) return
        replace(chatFor(client, thread.id, joinAssistantMessages(thread.messages)))
        setFailedOnReload(thread.failed === true)
        setOpening(null)
      } catch (error) {
        if (sequence !== reading.current) return
        setOpening({ id, error: error instanceof Error ? error.message : String(error) })
      }
    },
    [client, replace],
  )

  const reloadThread = useCallback(async () => {
    const thread = await agentApi.agentThread(current.current.id)
    replace(chatFor(client, thread.id, joinAssistantMessages(thread.messages)))
    void client.invalidateQueries({ queryKey: ['agent-threads'] })
  }, [client, replace])

  const settle = useCallback(() => setFailedOnReload(false), [])

  const value = useMemo<AgentChatValue>(
    () => ({
      chat,
      startThread,
      openThread: (id) => void openThread(id),
      reloadThread,
      opening,
      failedOnReload,
      settle,
    }),
    [chat, startThread, openThread, reloadThread, opening, failedOnReload, settle],
  )

  return <AgentChatContext.Provider value={value}>{children}</AgentChatContext.Provider>
}

export function useAgentChat(): AgentChatValue {
  const value = useContext(AgentChatContext)
  if (!value) throw new Error('useAgentChat outside AgentChatProvider')
  return value
}
