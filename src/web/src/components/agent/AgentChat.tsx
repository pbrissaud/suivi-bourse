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
 * in Prose (15/22); a tool call is one muted line in plain words with a
 * *détail* disclosure holding the raw call (2A).
 *
 * **Announced once** (11A): the scroller's content is a `log` live region,
 * which would read every streamed token; it is silenced, and one polite
 * region says *Réponse en cours* at the start and the whole answer at the end.
 */
import { useChat } from '@ai-sdk/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import type { UIMessage } from 'ai'
import { History, SquarePen, Trash2 } from 'lucide-react'
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentTitle,
} from '@/components/ui/attachment'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
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
import { declaredLabel, DEFAULT_ACCOUNT_LABEL } from '@/lib/accounts'
import {
  type AgentToolPart,
  errorSentence,
  exampleQuestions,
  getToolName,
  isToolUIPart,
  textOf,
  threadNotWritable,
  toolRunning,
  toolSentence,
  unreadableFiles,
} from '@/lib/agentChat'
import { useAgentChat } from '@/lib/agentChatProvider'
import { type AgentConfig, api } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

/** At most this many threads under *Fils récents*. */
const RECENT = 20

/** The thread the address names; `undefined` on `/agent`, a thread not yet asked. */
export function useThreadParam(): string | undefined {
  return useParams({ strict: false }).threadId
}

/** The page's body: the thread column from 1 024 px, then the conversation. */
export function AgentChat({ wide }: { wide: boolean }) {
  const { t } = useI18n()
  const config = useQuery({ queryKey: ['agent-config'], queryFn: api.agentConfig })

  // A read that has not answered renders nothing (#795).
  if (config.data === undefined) return null
  if (!config.data.enabled) return <AgentOff />
  return (
    <div className="flex h-full min-h-0 gap-5">
      {wide ? (
        <nav
          aria-labelledby="agent-threads"
          className="flex w-60 shrink-0 flex-col gap-1 rounded-lg bg-muted p-2"
        >
          <NewThread />
          <p id="agent-threads" className="label px-2 pt-2 pb-1">
            {t('agent.recent')}
          </p>
          <ThreadList />
        </nav>
      ) : null}
      <section className="mx-auto flex min-h-0 w-full max-w-180 min-w-0 flex-col">
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
              {t(`agent.provider.${config.provider}`)} · {config.model}
            </span>
            {config.provider === 'ollama' ? (
              <span className="shrink-0 rounded-full border px-1.5 text-xs font-medium">
                {t('agent.experimental')}
              </span>
            ) : null}
          </p>
        ) : null}
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
      <PopoverContent align="end" className="w-80 p-1">
        <p className="label px-2 py-1.5">{t('agent.recent')}</p>
        <ThreadList onOpened={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** The last twenty threads, opened (a push: Back returns) or deleted from here. */
function ThreadList({ onOpened }: { onOpened?: () => void }) {
  const { t } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  const navigate = useNavigate()
  const threadId = useThreadParam()
  const threads = useQuery({ queryKey: ['agent-threads'], queryFn: api.agentThreads })
  const remove = useMutation({
    mutationFn: api.forgetAgentThread,
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
        <ul className="max-h-80 overflow-y-auto lg:max-h-none">
          {threads.data.slice(0, RECENT).map((thread) => {
            const title = thread.title || t('agent.recent.untitled')
            return (
              <li key={thread.id} className="flex items-center gap-1">
                <Link
                  to="/agent/$threadId"
                  params={{ threadId: thread.id }}
                  className="flex min-h-11 min-w-0 flex-1 flex-col items-start rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-[current=page]:bg-accent"
                  onClick={onOpened}
                >
                  <span className="w-full truncate text-sm">{title}</span>
                  <span className="text-xs text-muted-foreground">
                    {f.dateTime(thread.updated_at)}
                  </span>
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11"
                  aria-label={t('agent.delete.named', { title })}
                  title={t('agent.delete')}
                  onClick={() => remove.mutate(thread.id)}
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

/** Disabled (4A): the page says what is missing. */
function AgentOff() {
  const { t } = useI18n()
  return (
    <div className="flex flex-col items-start gap-3 py-6">
      <p className="text-prose">{t('agent.disabled')}</p>
      <Button asChild className="min-h-11">
        <Link to="/settings">{t('agent.configure')}</Link>
      </Button>
    </div>
  )
}

function AgentThread() {
  const { t } = useI18n()
  const { chat, opening } = useAgentChat()
  // A thread being read draws nothing until it lands (#795); one that could
  // not be read — gone, or never there — says so in the server's words, and
  // offers a new one rather than rewriting the address.
  if (opening !== null) {
    return opening.error === null ? null : (
      <div className="flex flex-col items-start gap-3 px-4 py-3">
        <p role="alert" className="text-sm text-destructive">
          {opening.error}
        </p>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/agent">{t('agent.newThread')}</Link>
        </Button>
      </div>
    )
  }
  // Keyed: what the conversation remembers of its stream (the announcement,
  // the scroll) is one thread's, never carried into the next.
  return <AgentConversation key={chat.id} />
}

function AgentConversation() {
  const { t } = useI18n()
  const { chat } = useAgentChat()
  const threadId = useThreadParam()
  const navigate = useNavigate()
  const client = useQueryClient()
  const { messages, sendMessage, status, error, stop, setMessages, clearError } = useChat({
    chat,
  })
  const busy = status === 'submitted' || status === 'streaming'
  const notKept = useNotKept(chat.id, error)
  const announcement = useAnnouncement(status, messages)

  // A turn that ends has a title, or a newer date: the thread list follows.
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) void client.invalidateQueries({ queryKey: ['agent-threads'] })
    wasBusy.current = busy
  }, [busy, client])

  const ask = (text: string) => {
    // The first question gives the thread its address, in place of `/agent`:
    // one history entry, and a reload reads the thread back.
    if (threadId === undefined) {
      void navigate({ to: '/agent/$threadId', params: { threadId: chat.id }, replace: true })
    }
    if (error) clearError()
    void sendMessage({ text })
  }

  // *Réessayer*: the question again, as a new turn. The server keeps the
  // unanswered one in the file and replaces it rather than stacking a second.
  const retry = () => {
    const last = messages.map((m) => m.role).lastIndexOf('user')
    if (last === -1) return
    const text = textOf(messages[last])
    if (text === '') return
    setMessages(messages.slice(0, last))
    ask(text)
  }

  const failed = error !== undefined && !threadNotWritable(error)
  const waiting = busy && waitingOnTools(status, messages)

  return (
    <>
      {notKept ? (
        <p role="status" className="mx-4 mb-2 rounded-md bg-card px-3 py-2 text-sm">
          {t('agent.notKept')}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
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
                    <Turn message={message} />
                  </MessageScrollerItem>
                ))}
                {waiting ? (
                  <MessageScrollerItem messageId="waiting">
                    <p className="text-sm text-muted-foreground">{t('agent.waiting')}</p>
                  </MessageScrollerItem>
                ) : null}
                {failed ? (
                  <MessageScrollerItem messageId="error">
                    <div role="alert" className="flex flex-col items-start gap-2">
                      <p className="text-sm text-destructive">{errorSentence(error)}</p>
                      <Button variant="outline" className="min-h-11" onClick={retry}>
                        {t('agent.retry')}
                      </Button>
                    </div>
                  </MessageScrollerItem>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton className="size-11" />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <Composer busy={busy} onAsk={ask} onStop={() => void stop()} />
    </>
  )
}

/** Is the turn still on a tool, or not yet on its first word? */
function waitingOnTools(status: string, messages: UIMessage[]): boolean {
  const last = messages.at(-1)
  if (status === 'submitted' || last?.role !== 'assistant') return true
  const parts = last.parts.filter((p) => p.type === 'text' || isToolUIPart(p))
  const tail = parts.at(-1)
  return tail === undefined || (isToolUIPart(tail) && toolRunning(tail))
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
      setSaid(last?.role === 'assistant' ? textOf(last) : '')
    }
  }, [status, messages, t])
  return said
}

/** Empty thread (4A): three questions from the portfolio, each one click. */
function Examples({ onAsk }: { onAsk: (text: string) => void }) {
  const { t } = useI18n()
  const positions = useQuery({ queryKey: ['positions'], queryFn: api.positions })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
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

function Turn({ message }: { message: UIMessage }) {
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
  return (
    <Message>
      <MessageContent className="gap-2">
        {message.parts.map((part, index) => {
          const key = `${message.id}-${index}`
          if (part.type === 'text') {
            return part.text.trim() === '' ? null : (
              <p key={key} className="text-prose whitespace-pre-wrap">
                {part.text}
              </p>
            )
          }
          if (isToolUIPart(part)) return <ToolLine key={key} part={part} />
          return null
        })}
      </MessageContent>
    </Message>
  )
}

/** One tool call: its sentence, and the raw call behind *détail* (2A). */
function ToolLine({ part }: { part: AgentToolPart }) {
  const { t } = useI18n()
  const name = getToolName(part)
  const sentence = toolSentence(name)
  return (
    <details className="group text-sm text-muted-foreground">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md">
        <span className="min-w-0 flex-1">{t(sentence.key, sentence.values)}</span>
        <span className="shrink-0 text-xs underline-offset-2 group-open:underline">
          {t('agent.tool.detail')}
        </span>
      </summary>
      <dl className="mt-1 flex flex-col gap-2 rounded-md bg-card p-2 text-xs">
        <div>
          <dt className="font-medium">{t('agent.tool.input')}</dt>
          <dd>
            <pre className="font-mono break-all whitespace-pre-wrap">
              {name}({JSON.stringify(part.input ?? {}, null, 2)})
            </pre>
          </dd>
        </div>
        {part.state === 'output-available' ? (
          <div>
            <dt className="font-medium">{t('agent.tool.output')}</dt>
            <dd>
              <pre className="max-h-60 overflow-auto font-mono break-all whitespace-pre-wrap">
                {JSON.stringify(part.output, null, 2)}
              </pre>
            </dd>
          </div>
        ) : null}
        {part.state === 'output-error' ? (
          <div>
            <dt className="font-medium">{t('agent.tool.output')}</dt>
            <dd>{t('agent.tool.failed', { reason: part.errorText })}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  )
}

/** The input, *Envoyer* or *Arrêter*, and the CIF line fixed under it (3A). */
function Composer({
  busy,
  onAsk,
  onStop,
}: {
  busy: boolean
  onAsk: (text: string) => void
  onStop: () => void
}) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [refused, setRefused] = useState<string[]>([])
  const input = useRef<HTMLTextAreaElement>(null)
  const fieldId = useId()

  // Focus goes to the input when the page mounts (11A).
  useEffect(() => {
    input.current?.focus()
  }, [])

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

  return (
    <div className="flex flex-col gap-2 px-4 pt-2 pb-3">
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
          className="max-h-40 min-h-11 resize-none bg-card"
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
          <Button type="submit" className="min-h-11" disabled={text.trim() === ''}>
            {t('agent.send')}
          </Button>
        )}
      </form>
      <p className="text-xs text-muted-foreground">{t('agent.cif')}</p>
    </div>
  )
}
