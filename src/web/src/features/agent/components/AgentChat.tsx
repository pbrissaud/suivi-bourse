/**
 * The agent (#1117, #1196): a conversation about the portfolio through the
 * MCP tools, streamed by `useChat` from `/api/agent/chat`, on its own page.
 *
 * **A page, not a panel** (#1196). Docked beside the page, the panel took
 * 380 px from content designed for 1 040, and bought one line of context the
 * agent reads through its tools anyway. From 1 024 px the recent threads are a
 * 240 px column beside the conversation; below, they are the header's menu.
 *
 * **Built on the shadcn AI components**: `message-scroller` keeps a streamed
 * answer in view while the reader is at the live edge, `message` and `bubble`
 * lay the turns out, `attachment` shows a refused file. The answers are read
 * in Prose (15/22), their Markdown drawn rather than shown; a tool call is one
 * muted `trace` line in plain words whose chevron opens the raw call in a
 * `code-block` (2A).
 *
 * **Announced once** (11A): the scroller's content is a `log` live region,
 * which would read every streamed token; it is silenced, and one polite
 * region says *Réponse en cours* at the start and the whole answer at the end.
 */
import { useChat } from '@ai-sdk/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import type { UIMessage } from 'ai'
import { ArrowUp, History, SquarePen, Trash2, X } from 'lucide-react'
import {
  type ClipboardEvent,
  type ComponentProps,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentTitle,
} from '@/components/ui/attachment'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockContent, CodeBlockLine } from '@/components/ui/code-block'
import { useHighlightedCode } from '@/hooks/use-highlighted-code'
import { Message, MessageContent } from '@/components/ui/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { declaredLabel, DEFAULT_ACCOUNT_LABEL } from '@/features/accounts/lib/accounts'
import {
  type AgentToolPart,
  errorSentence,
  exampleQuestions,
  getToolName,
  isToolUIPart,
  pendingAnswer,
  textOf,
  threadNotWritable,
  toolRunning,
  toolSentence,
  turnRefusal,
  unreadableFiles,
} from '@/features/agent/lib/agentChat'
import { RefusalNotice } from '@/features/agent/components/RefusalNotice'
import { useAgentChat } from '@/features/agent/lib/agentChatProvider'
import {
  FactCard,
  ProfileChips,
  proposalOf,
  type ThreadProposal,
  useProposals,
} from '@/features/agent/components/AgentProfile'
import { EventsCard } from '@/features/agent/components/EventsCard'
import { accountsApi } from '@/features/accounts/lib/api'
import { agentApi, type AgentConfig } from '@/features/agent/lib/api'
import { sharesApi } from '@/features/shares/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { isSessionEnded } from '@/lib/session'

/** At most this many threads under *Fils récents*. */
const RECENT = 20

/** The thread the address names; `undefined` on `/agent`, a thread not yet asked. */
export function useThreadParam(): string | undefined {
  return useParams({ strict: false }).threadId
}

/** The page's body: the thread column from 1 024 px, then the conversation. */
export function AgentChat({ wide }: { wide: boolean }) {
  const { t } = useI18n()
  const config = useQuery({ queryKey: ['agent-config'], queryFn: agentApi.agentConfig })

  // A read that has not answered renders nothing (#795).
  if (config.data === undefined) return null
  if (!config.data.enabled) return <AgentOff />
  return (
    <div className="flex h-full min-h-0">
      {wide ? (
        // A rail, flush with the navigation and as tall as the page: a box
        // floating in the corner read as detached from the conversation.
        <nav
          aria-labelledby="agent-threads"
          className="flex w-60 shrink-0 flex-col gap-1 border-r bg-muted p-2"
        >
          <NewThread />
          <p id="agent-threads" className="label px-2 pt-2 pb-1">
            {t('agent.recent')}
          </p>
          <ThreadList />
        </nav>
      ) : null}
      {/* Centred in what the rail leaves, at 768 px: wider, a line ran past 110
          characters; pinned to the rail, the right of the screen stood empty. */}
      <section className="mx-auto flex min-h-0 w-full max-w-column min-w-0 flex-col lg:max-w-reading lg:pt-5">
        <AgentHeader config={config.data} wide={wide} />
        <AgentThread />
      </section>
    </div>
  )
}

function AgentHeader({ config, wide }: { config: AgentConfig; wide: boolean }) {
  const { t } = useI18n()

  return (
    <header className="flex items-center gap-1 px-4 pb-2">
      <div className="min-w-0 flex-1">
        {config.provider !== null ? (
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">
              {t(`agent.provider.${config.provider}`)} · {config.model_name ?? config.model}
            </span>
            {config.provider === 'ollama' ? (
              <span className="shrink-0 rounded-full border px-1.5 text-xs font-medium">
                {t('agent.experimental')}
              </span>
            ) : null}
          </p>
        ) : null}
        <ProfileChips />
      </div>
      {wide ? null : (
        <>
          <NewThread icon />
          <RecentThreads />
        </>
      )}
    </header>
  )
}

/** *Nouveau fil*: `/agent`, which starts an empty thread. */
function NewThread({ icon = false }: { icon?: boolean }) {
  const { t } = useI18n()
  return (
    <Button
      asChild
      variant="ghost"
      size={icon ? 'icon' : 'default'}
      className={icon ? 'size-11' : 'min-h-11 justify-start'}
    >
      <Link
        to="/agent"
        aria-label={t('agent.newThread')}
        title={t('agent.newThread')}
        // Exact: `/agent/x` starts with `/agent` and is not a new thread.
        activeOptions={{ exact: true }}
      >
        <SquarePen />
        {icon ? null : t('agent.newThread')}
      </Link>
    </Button>
  )
}

/** *Fils récents* under 1 024 px: the same list, in the header's menu. */
function RecentThreads() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t('agent.recent')}
          title={t('agent.recent')}
        >
          <History />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-1"
        // Escape on a deletion being asked answers the question, not the menu:
        // Radix hears the key on the document before the row does.
        onEscapeKeyDown={(event) => {
          if (document.activeElement?.closest('[data-confirm-delete]')) event.preventDefault()
        }}
      >
        <p className="label px-2 py-1.5">{t('agent.recent')}</p>
        <ThreadList onOpened={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The last twenty threads, opened (a push: Back returns) or deleted from here.
 *
 * **A deletion is asked in the row**, which names the thread and offers *Le
 * garder* first: the bin sits next to the link, and a slip lost a whole
 * conversation. In the row and not in a dialog, because under 1 024 px the list
 * lives in a popover that a dialog would close, unmounting the dialog with it.
 */
function ThreadList({ onOpened }: { onOpened?: () => void }) {
  const { t } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  const navigate = useNavigate()
  const threadId = useThreadParam()
  const threads = useQuery({ queryKey: ['agent-threads'], queryFn: agentApi.agentThreads })
  const [doomed, setDoomed] = useState<string | null>(null)
  const list = useRef<HTMLUListElement>(null)
  // Kept: focus goes back to the bin that asked, not to the top of the page.
  const keep = (id: string) => {
    setDoomed(null)
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>(`[data-delete="${CSS.escape(id)}"]`)?.focus(),
    )
  }
  const remove = useMutation({
    mutationFn: agentApi.forgetAgentThread,
    onSuccess: (_, id) => {
      // The thread on screen is gone: an empty one takes its place, and the
      // address that named it is not kept in the history.
      if (id === threadId) void navigate({ to: '/agent', replace: true })
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['agent-threads'] }),
  })

  return (
    <>
      {threads.error ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">
          {t('agent.recent.unreadable', { reason: threads.error.message })}
        </p>
      ) : threads.data === undefined ? null : threads.data.length === 0 ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">{t('agent.recent.empty')}</p>
      ) : (
        // `-m-1 p-1`: room inside the scroll box for the focus rings it would clip.
        <ul ref={list} className="-m-1 max-h-80 min-h-0 overflow-y-auto p-1 lg:max-h-none">
          {threads.data.slice(0, RECENT).map((thread) => {
            const title = thread.title || t('agent.recent.untitled')
            if (doomed === thread.id) {
              return (
                <li
                  key={thread.id}
                  data-confirm-delete
                  className="flex flex-col gap-2 rounded-md bg-card p-2"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') keep(thread.id)
                  }}
                >
                  <p className="line-clamp-2 text-sm break-words text-muted-foreground">{title}</p>
                  <p className="text-sm">{t('agent.delete.question')}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      className="min-h-11"
                      autoFocus
                      onClick={() => keep(thread.id)}
                    >
                      {t('agent.delete.keep')}
                    </Button>
                    <Button
                      variant="destructive"
                      className="min-h-11"
                      onClick={() => {
                        setDoomed(null)
                        remove.mutate(thread.id)
                      }}
                    >
                      {t('agent.delete.confirm')}
                    </Button>
                  </div>
                </li>
              )
            }
            return (
              <li key={thread.id} className="flex items-center gap-1">
                <Link
                  to="/agent/$threadId"
                  params={{ threadId: thread.id }}
                  className="flex min-h-11 min-w-0 flex-1 flex-col items-start rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-[current=page]:bg-background aria-[current=page]:font-medium"
                  onClick={onOpened}
                >
                  {/* Two lines: a title cut at 25 characters told two threads apart badly. */}
                  <span className="line-clamp-2 w-full text-sm break-words">{title}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {f.dateTime(thread.updated_at)}
                  </span>
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11"
                  data-delete={thread.id}
                  aria-label={t('agent.delete.named', { title })}
                  title={t('agent.delete')}
                  onClick={() => setDoomed(thread.id)}
                >
                  <Trash2 />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {remove.error ? (
        <p role="status" className="px-2 py-1.5 text-sm text-destructive">
          {remove.error.message}
        </p>
      ) : null}
    </>
  )
}

/**
 * Disabled (4A): the page says what is missing, and what the agent would do.
 * It sits where the conversation would, the page's gutter given back by
 * `AgentPage` from 1 024 px, and the link lands on the agent's own block.
 */
function AgentOff() {
  const { t } = useI18n()
  return (
    <div className="mx-auto flex w-full max-w-column flex-col items-start gap-3 px-4 py-6 lg:max-w-reading lg:pt-12">
      <p className="text-prose font-medium">{t('agent.disabled')}</p>
      <p className="max-w-prose text-prose text-muted-foreground">{t('agent.disabled.detail')}</p>
      <Button asChild className="min-h-11">
        <Link to="/settings" hash="agent">
          {t('agent.configure')}
        </Link>
      </Button>
    </div>
  )
}

function AgentThread() {
  const { t } = useI18n()
  const { chat, opening, openThread } = useAgentChat()
  // A thread being read draws nothing until it lands (#795); one that could
  // not be read — gone, never there, or a server out of reach — says so in
  // the server's words, and offers it again or a new one rather than
  // rewriting the address.
  if (opening !== null) {
    if (opening.error === null) return null
    const { id, error } = opening
    return (
      <div className="flex flex-col items-start gap-3 px-4 py-3">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-11" onClick={() => openThread(id)}>
            {t('agent.retry')}
          </Button>
          <Button asChild variant="outline" className="min-h-11">
            <Link to="/agent">{t('agent.newThread')}</Link>
          </Button>
        </div>
      </div>
    )
  }
  // Keyed: what the conversation remembers of its stream (the announcement,
  // the scroll) is one thread's, never carried into the next.
  return <AgentConversation key={chat.id} />
}

/** The refusals the reader mends in Settings: another key, more credit, another model. */
const SETTINGS_REASONS = ['key', 'quota', 'model']

function AgentConversation() {
  const { t } = useI18n()
  // The page's own read, already in the cache: it names the provider a refusal blames.
  const provider =
    useQuery({ queryKey: ['agent-config'], queryFn: agentApi.agentConfig }).data?.provider ?? null
  const { chat, failedOnReload, settle } = useAgentChat()
  const threadId = useThreadParam()
  const navigate = useNavigate()
  const { messages, sendMessage, status, error, stop, setMessages, clearError } = useChat({
    chat,
  })
  const busy = status === 'submitted' || status === 'streaming'
  const notKept = useNotKept(chat.id, error)
  const announcement = useAnnouncement(status, messages)
  const proposals = useProposals(chat.id, messages, busy)

  const ask = (text: string) => {
    // The first question gives the thread its address, in place of `/agent`:
    // one history entry, and a reload reads the thread back.
    if (threadId === undefined) {
      void navigate({ to: '/agent/$threadId', params: { threadId: chat.id }, replace: true })
    }
    // A failed turn is dropped by the server whatever is asked next, so the
    // page drops it too: what is on screen is what the model will be given.
    if (failed) {
      const last = messages.map((m) => m.role).lastIndexOf('user')
      if (last !== -1) setMessages(messages.slice(0, last))
    }
    if (error) clearError()
    settle()
    void sendMessage({ text })
  }

  // *Réessayer*: the question again, as a new turn, in place of the failed one.
  const retry = () => {
    const last = messages.map((m) => m.role).lastIndexOf('user')
    if (last === -1) return
    const text = textOf(messages[last])
    if (text === '') return
    ask(text)
  }

  // A session that ended (#1203): the question goes back into the input, to be
  // sent again once the code is typed, and the turn it opened is taken away.
  const [returned, setReturned] = useState<{ text: string } | null>(null)
  useEffect(() => {
    if (!isSessionEnded(error)) return
    const last = messages.map((m) => m.role).lastIndexOf('user')
    if (last !== -1) {
      setReturned({ text: textOf(messages[last]) })
      setMessages(messages.slice(0, last))
    }
    clearError()
  }, [error, messages, setMessages, clearError])

  const streamFailed = error !== undefined && !threadNotWritable(error) && !isSessionEnded(error)
  // A thread read back whose last turn failed: the error is gone with the
  // stream, so the page says it in a generic sentence under the partial answer.
  const failed = streamFailed || failedOnReload
  const refusal = streamFailed ? turnRefusal(error) : null
  const retryButton = (
    <div className="flex flex-wrap items-center gap-3 pt-1">
      <Button variant="outline" className="min-h-11" onClick={retry}>
        {t('agent.retry')}
      </Button>
      {refusal && SETTINGS_REASONS.includes(refusal.reason) ? (
        <Link
          to="/settings"
          hash="agent"
          className="text-sm text-primary underline underline-offset-4"
        >
          {t('agent.refusal.settings')}
        </Link>
      ) : null}
    </div>
  )
  const waiting = pendingAnswer(status, messages.at(-1))

  return (
    <>
      {notKept ? (
        <p role="status" className="mx-4 mb-2 rounded-md bg-card px-3 py-2 text-sm">
          {t('agent.notKept')}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {/* A thread read back opens on its last question, not halfway down its answer. */}
        <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
          <MessageScroller>
            <MessageScrollerViewport aria-label={t('agent.messages')} className="px-4">
              {/* Silenced: the polite region below announces the whole answer once. */}
              <MessageScrollerContent aria-live="off" className="gap-5 py-3">
                {messages.length === 0 ? (
                  <MessageScrollerItem messageId="examples">
                    <Examples onAsk={ask} />
                  </MessageScrollerItem>
                ) : null}
                {messages.map((message) => (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === 'user'}
                  >
                    <Turn
                      message={message}
                      live={busy && message === messages.at(-1)}
                      proposals={proposals}
                    />
                  </MessageScrollerItem>
                ))}
                {waiting ? (
                  <MessageScrollerItem messageId="waiting">
                    {/* The model is reading, thinking or writing its proposals (#1271). */}
                    <Trace>
                      <TraceLine status="running">
                        <TraceTitle>{t('agent.waiting')}</TraceTitle>
                      </TraceLine>
                    </Trace>
                  </MessageScrollerItem>
                ) : null}
                {failed ? (
                  <MessageScrollerItem messageId="error">
                    <div role={refusal && provider ? undefined : 'alert'}>
                      {refusal && provider ? (
                        <RefusalNotice
                          provider={t(`agent.provider.${provider}`)}
                          reason={refusal.reason}
                          said={refusal.said}
                        >
                          {retryButton}
                        </RefusalNotice>
                      ) : (
                        <div className="flex flex-col items-start gap-2">
                          <p className="text-sm text-destructive">
                            {streamFailed ? errorSentence(error) : t('agent.failed.reloaded')}
                          </p>
                          {retryButton}
                        </div>
                      )}
                    </div>
                  </MessageScrollerItem>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            {/* Bordered: over the text, a bare arrow on the page's ground hid words. */}
            <MessageScrollerButton className="size-11 border" />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {/* Drawn like the answer, or a screen reader reads its asterisks. */}
        <AnswerMarkdown>{announcement}</AnswerMarkdown>
      </div>
      <Composer busy={busy} onAsk={ask} onStop={() => void stop()} returned={returned} />
    </>
  )
}

/** Thread not writable (4A): said once the server said it, until the thread changes. */
function useNotKept(threadId: string, error: Error | undefined): boolean {
  const [notKept, setNotKept] = useState(false)
  // A new thread starts kept.
  useEffect(() => setNotKept(false), [threadId])
  useEffect(() => {
    if (threadNotWritable(error)) setNotKept(true)
  }, [error])
  return notKept
}

/** *Réponse en cours* once at the start, the answer once it is whole. */
function useAnnouncement(status: string, messages: UIMessage[]): string {
  const { t } = useI18n()
  const [said, setSaid] = useState('')
  const previous = useRef(status)
  useEffect(() => {
    const was = previous.current
    previous.current = status
    const started = status === 'submitted' || status === 'streaming'
    // From rest to work, whichever of the two the first render lands on: a
    // quick transport can batch `submitted` away.
    if (started && (was === 'ready' || was === 'error')) setSaid(t('agent.answering'))
    if (status === 'ready' && (was === 'streaming' || was === 'submitted')) {
      const last = messages.at(-1)
      // The cards sit under the answer, so the announcement ends on them (#1271).
      const count =
        last?.role === 'assistant' ? last.parts.filter((p) => proposalOf(p) !== null).length : 0
      const answer = last?.role === 'assistant' ? textOf(last) : ''
      setSaid(count === 0 ? answer : `${answer}\n\n${t('agent.proposals.below', { count })}`)
    }
  }, [status, messages, t])
  return said
}

/** Empty thread (4A): three questions from the portfolio, each one click. */
function Examples({ onAsk }: { onAsk: (text: string) => void }) {
  const { t } = useI18n()
  const positions = useQuery({ queryKey: ['positions'], queryFn: sharesApi.positions })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })
  const questions = useMemo(() => {
    // Both reads, or an account would be named by its id for a moment.
    if (positions.data === undefined) return null
    if (accounts.data === undefined && accounts.error === null) return null
    const named = new Map(
      (accounts.data?.accounts ?? []).map((a) => [
        a.id,
        declaredLabel(a) ?? t(DEFAULT_ACCOUNT_LABEL),
      ]),
    )
    return exampleQuestions(positions.data.positions, (id) => named.get(id) ?? id).map((q) =>
      t(q.key, q.values),
    )
  }, [positions.data, accounts.data, accounts.error, t])

  return (
    <div className="flex flex-col gap-3">
      <p className="text-prose">{t('agent.empty')}</p>
      {questions === null ? null : (
        <ul className="flex flex-col gap-2">
          {questions.map((question) => (
            <li key={question}>
              <button
                type="button"
                className="min-h-11 w-full rounded-card border bg-card px-3 py-2 text-left text-sm hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                onClick={() => onAsk(question)}
              >
                {question}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * How an answer's Markdown is drawn. No raw HTML: `react-markdown` drops it.
 *
 * - **A heading is a bold line**, not an `<h2>`: the page has one outline, and
 *   an answer is not a section of it.
 * - **Inline code is plain text**: the model quotes a field name now and then,
 *   and mono in the middle of a sentence is a bug (DESIGN.md).
 * - **A link is its words, an image its alt text**: the answer reads ledger
 *   notes the owner typed, and an address it was steered to write is neither
 *   followed nor fetched from here — an image URL would leak whatever the
 *   model put in its query string the moment the answer renders.
 */
const strongLine = ({ node: _, ...props }: ComponentProps<'p'> & ExtraProps) => (
  <p className="font-semibold" {...props} />
)
const ANSWER: Components = {
  h1: strongLine,
  h2: strongLine,
  h3: strongLine,
  h4: strongLine,
  h5: strongLine,
  h6: strongLine,
  strong: ({ node: _, ...props }) => <strong className="font-semibold" {...props} />,
  ul: ({ node: _, ...props }) => (
    <ul className="flex list-disc flex-col gap-1 pl-5 [&_ol]:mt-1 [&_ul]:mt-1" {...props} />
  ),
  ol: ({ node: _, ...props }) => (
    <ol className="flex list-decimal flex-col gap-1 pl-5 [&_ol]:mt-1 [&_ul]:mt-1" {...props} />
  ),
  code: ({ children }) => <>{children}</>,
  pre: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
  a: ({ children }) => <>{children}</>,
  img: ({ alt }) => <>{alt}</>,
  table: ({ node: _, ...props }) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums" {...props} />
    </div>
  ),
  th: ({ node: _, ...props }) => <th className="label border-b px-2 py-1.5 text-left" {...props} />,
  td: ({ node: _, ...props }) => <td className="border-b px-2 py-1.5" {...props} />,
}

const REMARK = [remarkGfm]

/**
 * An answer's text, drawn for the eye and again for the announcement. Memoised
 * on the text: every streamed token re-renders the conversation, and without it
 * each past answer of the thread was parsed again.
 */
const AnswerMarkdown = memo(function AnswerMarkdown({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={REMARK} components={ANSWER}>
      {children}
    </Markdown>
  )
})

/**
 * `live`: the turn still streams, so a call without its answer is running, not
 * halted. `proposals`: the thread's, as stored; `undefined` while unread.
 */
function Turn({
  message,
  live,
  proposals,
}: {
  message: UIMessage
  live: boolean
  proposals: Map<string, ThreadProposal> | undefined
}) {
  if (message.role === 'user') {
    return (
      <Message align="end">
        <Bubble variant="outline" align="end">
          <BubbleContent className="bg-card text-prose whitespace-pre-wrap">
            {textOf(message)}
          </BubbleContent>
        </Bubble>
      </Message>
    )
  }
  const { steps, cards } = stepsAndText(message.parts, proposals)
  return (
    <Message>
      <MessageContent className="gap-2">
        {steps.map((group, index) => {
          const key = `${message.id}-${index}`
          if (Array.isArray(group)) {
            return (
              <Trace key={key}>
                {group.map((part) => (
                  <ToolLine key={part.toolCallId} part={part} live={live} />
                ))}
              </Trace>
            )
          }
          return group.trim() === '' ? null : (
            <div key={key} className="flex flex-col gap-3 text-prose">
              <AnswerMarkdown>{group}</AnswerMarkdown>
            </div>
          )
        })}
        {cards.map((proposal) =>
          'kind' in proposal ? (
            <EventsCard key={proposal.id} proposal={proposal} />
          ) : (
            <FactCard key={proposal.id} proposal={proposal} />
          ),
        )}
      </MessageContent>
    </Message>
  )
}

/**
 * The parts in order, consecutive tool calls gathered into one Trace, and
 * apart from them the proposals' cards (5A), drawn under the answer (#1271):
 * the model calls `propose_profile_fact` before it writes, so a card drawn
 * where its call sits stood above the words it is about. The call keeps its
 * trace line; a card is there once its state is read, and not before.
 */
function stepsAndText(
  parts: UIMessage['parts'],
  proposals: Map<string, ThreadProposal> | undefined,
): { steps: (string | AgentToolPart[])[]; cards: ThreadProposal[] } {
  const steps: (string | AgentToolPart[])[] = []
  const cards: ThreadProposal[] = []
  for (const part of parts) {
    if (part.type === 'text') steps.push(part.text)
    else if (isToolUIPart(part)) {
      const last = steps.at(-1)
      if (Array.isArray(last)) last.push(part)
      else steps.push([part])
      const ref = proposalOf(part)
      const proposal = ref === null ? undefined : proposals?.get(ref.id)
      if (proposal) cards.push(proposal)
    }
  }
  return { steps, cards }
}

/**
 * One tool call (2A): a Trace line in plain words, shimmering while it runs,
 * whose chevron opens the raw call and what came back.
 */
function ToolLine({ part, live }: { part: AgentToolPart; live: boolean }) {
  const { t } = useI18n()
  const name = getToolName(part)
  const sentence = toolSentence(name)
  // Stopped or cut mid-call: the answer never comes, so the line stops shimmering.
  const running = toolRunning(part) && live
  // Halted: the call failed, or a stop cut it off (the server closes it as
  // `interrupted`). Said in words and a mark too, never by the colour alone.
  const outcome = part.callProviderMetadata?.pydantic_ai?.outcome
  const failed =
    part.state === 'output-error' ||
    (toolRunning(part) && !live) ||
    outcome === 'interrupted' ||
    outcome === 'failed'
  return (
    <TraceCollapsible>
      {/* 44 px on touch only: three reads stacked 156 px of chrome before the answer. */}
      <TraceCollapsibleTrigger className="min-h-8 pointer-coarse:min-h-11">
        <TraceLine status={running ? 'running' : failed ? 'error' : undefined}>
          {failed ? (
            <TraceIcon className="text-destructive">
              <X />
            </TraceIcon>
          ) : null}
          <TraceTitle className="overflow-visible whitespace-normal">
            {t(sentence.key, sentence.values)}
          </TraceTitle>
          {failed ? <span className="sr-only"> {t('agent.tool.halted')}</span> : null}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2 text-xs">
        <p className="font-medium">{t('agent.tool.input')}</p>
        <CodeBlock size="sm">
          <JsonContent code={`${name}(${JSON.stringify(part.input ?? {}, null, 2)})`} />
        </CodeBlock>
        {part.state === 'output-available' ? (
          <>
            <p className="font-medium">{t('agent.tool.output')}</p>
            <CodeBlock size="sm">
              <JsonContent code={JSON.stringify(part.output, sixFigures, 2)} className="max-h-60" />
            </CodeBlock>
          </>
        ) : null}
        {part.state === 'output-error' ? (
          <>
            <p className="font-medium">{t('agent.tool.output')}</p>
            <CodeBlock size="sm" variant="destructive">
              <CodeBlockContent wrap>
                {t('agent.tool.failed', { reason: part.errorText })}
              </CodeBlockContent>
            </CodeBlock>
          </>
        ) : null}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/**
 * JSON coloured by shiki. Mounted only once its line is opened (Radix drops a
 * closed collapsible's content), so the highlighter loads on the first *détail*.
 */
function JsonContent({ code, className }: { code: string; className?: string }) {
  const lines = useHighlightedCode(code, 'json')
  return (
    <CodeBlockContent wrap className={className}>
      {lines.map((line, index) => (
        <CodeBlockLine key={index}>{line}</CodeBlockLine>
      ))}
    </CodeBlockContent>
  )
}

/** A float at six significant figures: `16626.4`, not `16626.385821235686`. */
function sixFigures(_: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isInteger(value)
    ? Number(value.toPrecision(6))
    : value
}

/** The input, *Envoyer* or *Arrêter*, and the CIF line fixed under it (3A). */
function Composer({
  busy,
  onAsk,
  onStop,
  returned,
}: {
  busy: boolean
  onAsk: (text: string) => void
  onStop: () => void
  /** A question the server refused for want of a session, handed back. */
  returned: { text: string } | null
}) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [refused, setRefused] = useState<string[]>([])
  const input = useRef<HTMLTextAreaElement>(null)
  const fieldId = useId()
  const hintId = useId()

  // Focus goes to the input when the page mounts (11A).
  useEffect(() => {
    input.current?.focus()
  }, [])

  useEffect(() => {
    if (returned !== null) setText(returned.text)
  }, [returned])

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    const question = text.trim()
    if (busy || question === '') return
    setRefused([])
    setText('')
    onAsk(question)
  }

  // Image or PDF with a text-only model (4A): refused before anything is sent.
  // Every model the agent runs on reads text only (`agent_routes` refuses
  // any other part), so a file is never sent.
  const refuse = (files: FileList) => {
    if (files.length === 0) return false
    if (unreadableFiles(files)) {
      setRefused(Array.from(files, (file) => file.name))
      return true
    }
    return false
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (refuse(event.clipboardData.files)) event.preventDefault()
  }
  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    if (refuse(event.dataTransfer.files)) event.preventDefault()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event)
  }

  // The scroller's gutter, reserved here too: the input and *Envoyer* end where
  // the messages do, not 11 px past them.
  return (
    <div className="flex scrollbar-thin scrollbar-gutter-stable flex-col gap-2 overflow-hidden px-4 pt-2 pb-3">
      {refused.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1">
          {refused.map((name) => (
            <Attachment key={name} state="error" size="sm">
              <AttachmentContent>
                <AttachmentTitle>{name}</AttachmentTitle>
                <AttachmentDescription>{t('agent.files.refused')}</AttachmentDescription>
              </AttachmentContent>
            </Attachment>
          ))}
        </div>
      ) : null}
      <form onSubmit={submit} className="flex items-end gap-2">
        <label htmlFor={fieldId} className="sr-only">
          {t('agent.input')}
        </label>
        <Textarea
          id={fieldId}
          ref={input}
          value={text}
          rows={1}
          placeholder={t('agent.input.placeholder')}
          aria-describedby={hintId}
          // Body 14/20 like every control. Focused from the mount (11A), so the
          // focus is the border alone: the ring read as an alert on arrival.
          className="max-h-40 min-h-11 resize-none bg-card md:text-md focus-visible:ring-0"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
        />
        {busy ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={onStop}>
            {t('agent.stop')}
          </Button>
        ) : (
          // An arrow under 640 px: the word left the input 241 px on a phone.
          <Button
            type="submit"
            className="min-h-11 max-sm:size-11 max-sm:px-0"
            disabled={text.trim() === ''}
          >
            <ArrowUp className="sm:hidden" />
            <span className="max-sm:sr-only">{t('agent.send')}</span>
          </Button>
        )}
      </form>
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
        <p className="text-xs text-muted-foreground">{t('agent.cif')}</p>
        {/* Keys only where there is a keyboard to press them. */}
        <p id={hintId} className="hidden text-xs text-muted-foreground pointer-fine:block">
          {t('agent.input.hint')}
        </p>
      </div>
    </div>
  )
}
