/**
 * The analyst panel's state, above the shell (#1117): whether it is open,
 * which thread it holds, and the `Chat` that streams it.
 *
 * **Closing keeps the thread.** The `Chat` lives here and not in the panel,
 * so a panel unmounted by a close, or remounted by a change of width, picks
 * the same conversation back up — the messages, a stream in flight, an error
 * waiting for *Réessayer*.
 *
 * **And a reload keeps it too.** The thread's id is remembered in this
 * browser (`sb.analyst.thread`) once it holds a question, and read back from
 * the server the first time the panel opens; a thread that is gone, or an
 * analyst switched off since, starts an empty one instead, silently.
 *
 * **⌘/Ctrl + J opens and closes it**, and so does the header's button; the
 * palette keeps ⌘K. Focus goes to the input on open (the panel's job, it owns
 * the field) and back to the button on close (this module's: it holds the
 * button's ref).
 */
import { Chat } from '@ai-sdk/react'
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
  type RefObject,
} from 'react'

import { type AnalystLayout, analystSeam, layoutFor } from '@/lib/analyst'
import { AgentError, api } from '@/lib/api'
import { browserStorage, rememberPreference } from '@/lib/storage'

/** The thread on screen, kept across a reload. Per browser, a convenience. */
export const THREAD_STORAGE_KEY = 'sb.analyst.thread'

interface AnalystPanelValue {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  /** The header's button, where focus returns on close. */
  trigger: RefObject<HTMLButtonElement | null>
  /** The thread on screen. A new one has no file until its first question. */
  chat: Chat<UIMessage>
  /** Start an empty thread under a fresh id. */
  startThread: () => void
  /** Read a stored thread from the server, then show it. */
  openThread: (id: string) => void
  /** A thread being read: nothing of it is drawn until it lands. */
  opening: { id: string; error: string | null } | null
  /** The thread now holds a question: remember it across a reload. */
  remember: () => void
  layout: AnalystLayout
}

const AnalystPanelContext = createContext<AnalystPanelValue | null>(null)

function chatFor(id: string, messages: UIMessage[] = []): Chat<UIMessage> {
  return new Chat<UIMessage>({ id, messages, transport: analystSeam.transport() })
}

/** The width class the window is in, following it as it is resized. */
function useLayout(): AnalystLayout {
  const [layout, setLayout] = useState<AnalystLayout>(() => layoutFor(window.innerWidth))
  useEffect(() => {
    const onResize = () => setLayout(layoutFor(window.innerWidth))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return layout
}

function storedThread(): string | null {
  try {
    return browserStorage()?.getItem(THREAD_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function forgetThread() {
  try {
    browserStorage()?.removeItem(THREAD_STORAGE_KEY)
  } catch {
    // Not remembered is the ordinary state.
  }
}

export function AnalystPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false)
  const [chat, setChat] = useState(() => chatFor(generateId()))
  const [opening, setOpening] = useState<AnalystPanelValue['opening']>(null)
  /** The remembered thread, until the first opening has read it back. */
  const remembered = useRef(storedThread())
  const trigger = useRef<HTMLButtonElement | null>(null)
  const layout = useLayout()

  const setOpen = useCallback((next: boolean) => setOpenState(next), [])
  const toggle = useCallback(() => setOpenState((current) => !current), [])

  // Back to the button once a close has committed: a closed panel must not
  // leave focus on nothing. A reopening before the frame cancels it.
  const wasOpen = useRef(open)
  useEffect(() => {
    const closed = wasOpen.current && !open
    wasOpen.current = open
    if (!closed) return
    const frame = requestAnimationFrame(() => trigger.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        toggle()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [toggle])

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
    forgetThread()
    setOpening(null)
    replace(chatFor(generateId()))
  }, [replace])

  const read = useCallback(
    async (id: string, quietly: boolean) => {
      const sequence = ++reading.current
      setOpening({ id, error: null })
      try {
        const thread = await api.agentThread(id)
        if (sequence !== reading.current) return
        rememberPreference(THREAD_STORAGE_KEY, thread.id)
        replace(chatFor(thread.id, thread.messages))
        setOpening(null)
      } catch (error) {
        if (sequence !== reading.current) return
        if (quietly) {
          // Forgotten only when the server says it is gone, or the analyst
          // off (both a 404): a network failure keeps it for the next reload.
          if (error instanceof AgentError && error.status === 404) forgetThread()
          setOpening(null)
        } else {
          setOpening({ id, error: error instanceof Error ? error.message : String(error) })
        }
      }
    },
    [replace],
  )

  const openThread = useCallback((id: string) => void read(id, false), [read])

  // The first opening reads the remembered thread back; never on mount, so a
  // page that never opens the panel pays nothing for it.
  useEffect(() => {
    if (!open || remembered.current === null) return
    const id = remembered.current
    remembered.current = null
    void read(id, true)
  }, [open, read])

  const remember = useCallback(() => rememberPreference(THREAD_STORAGE_KEY, chat.id), [chat])

  const value = useMemo<AnalystPanelValue>(
    () => ({
      open,
      setOpen,
      toggle,
      trigger,
      chat,
      startThread,
      openThread,
      opening,
      remember,
      layout,
    }),
    [open, setOpen, toggle, chat, startThread, openThread, opening, remember, layout],
  )

  return <AnalystPanelContext.Provider value={value}>{children}</AnalystPanelContext.Provider>
}

export function useAnalystPanel(): AnalystPanelValue {
  const value = useContext(AnalystPanelContext)
  if (!value) throw new Error('useAnalystPanel outside AnalystPanelProvider')
  return value
}
