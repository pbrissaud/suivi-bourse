/**
 * The analyst panel (#1117): a `tint` plane that answers questions about the
 * portfolio through the MCP tools, streamed by `useChat` from `/agent`.
 *
 * **Three widths, one body** (DESIGN.md, Layout; design review 10A). From
 * 1 440 px it docks beside the page at 380 px and the page shrinks; from 768
 * it is a right `sheet` over the page; under 768 a full-screen `sheet` with a
 * back button. Every list portalled from inside a sheet is handed the sheet's
 * own element as `container`: portalled to `body`, it would sit outside the
 * dialog's scroll lock and its wheel would scroll nothing (2026-09-28).
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
import { Link } from '@tanstack/react-router'
import type { UIMessage } from 'ai'
import { ArrowLeft, History, SquarePen, Trash2, X } from 'lucide-react'
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
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { declaredLabel, DEFAULT_ACCOUNT_LABEL } from '@/lib/accounts'
import {
  type AnalystToolPart,
  errorSentence,
  exampleQuestions,
  getToolName,
  isToolUIPart,
  textOf,
  threadNotWritable,
  toolRunning,
  toolSentence,
  unreadableFiles,
} from '@/lib/analyst'
import { useAnalystPanel } from '@/lib/analystPanel'
import { type AgentConfig, api } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** At most this many threads under *Fils récents*. */
const RECENT = 20

export function AnalystPanel() {
  const { open, setOpen, layout } = useAnalystPanel()
  const [sheet, setSheet] = useState<HTMLElement | null>(null)

  if (layout === 'docked') {
    if (!open) return null
    return (
      <AnalystRegion className="sticky top-0 h-svh w-[380px] shrink-0">
        <AnalystBody container={null} />
      </AnalystRegion>
    )
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        ref={setSheet}
        side="right"
        showCloseButton={false}
        // The body puts focus in the input on mount; the provider puts it back
        // on the button on close. Radix doing either too would fight them.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className={cn(
          'gap-0 border-l-0 bg-muted p-0',
          // DESIGN.md's one shadow: the sheet lying over the page.
          'shadow-[-8px_0_24px_color-mix(in_oklch,black_8%,transparent)]',
          layout === 'full' ? 'w-full sm:max-w-none' : 'w-[380px] sm:max-w-[380px]',
        )}
      >
        <AnalystSheetNames />
        <AnalystRegion className="h-full">
          <AnalystBody container={sheet} />
        </AnalystRegion>
      </SheetContent>
    </Sheet>
  )
}

/** The dialog's own name and description, which Radix asks every sheet for. */
function AnalystSheetNames() {
  const { t } = useI18n()
  return (
    <>
      <SheetTitle className="sr-only">{t('analyst.title')}</SheetTitle>
      <SheetDescription className="sr-only">{t('analyst.cif')}</SheetDescription>
    </>
  )
}

/** The `complementary` region named *Analyste*, at every width. */
function AnalystRegion({ className, children }: { className?: string; children: React.ReactNode }) {
  const { t } = useI18n()
  return (
    <aside aria-label={t('analyst.title')} className={cn('flex flex-col bg-muted', className)}>
      {children}
    </aside>
  )
}

function AnalystBody({ container }: { container: HTMLElement | null }) {
  const config = useQuery({ queryKey: ['agent-config'], queryFn: api.agentConfig })

  return (
    <>
      <AnalystHeader config={config.data} container={container} />
      {/* A read that has not answered renders nothing (#795). */}
      {config.data === undefined ? null : config.data.enabled ? <AnalystThread /> : <AnalystOff />}
    </>
  )
}

function AnalystHeader({
  config,
  container,
}: {
  config: AgentConfig | undefined
  container: HTMLElement | null
}) {
  const { t } = useI18n()
  const { setOpen, layout, startThread } = useAnalystPanel()
  const on = config?.enabled === true

  return (
    <header className="flex items-center gap-1 px-4 pt-3 pb-2">
      {layout === 'full' ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t('analyst.back')}
          onClick={() => setOpen(false)}
        >
          <ArrowLeft />
        </Button>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">{t('analyst.title')}</h2>
        {on && config.provider !== null ? (
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">
              {t(`analyst.provider.${config.provider}`)} · {config.model}
            </span>
            {config.provider === 'ollama' ? (
              <span className="shrink-0 rounded-full border px-1.5 text-xs font-medium">
                {t('analyst.experimental')}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      {on ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={t('analyst.newThread')}
            title={t('analyst.newThread')}
            onClick={startThread}
          >
            <SquarePen />
          </Button>
          <RecentThreads container={container} />
        </>
      ) : null}
      {layout === 'full' ? null : (
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t('analyst.close')}
          onClick={() => setOpen(false)}
        >
          <X />
        </Button>
      )}
    </header>
  )
}

/** *Fils récents*: the last twenty, opened or deleted from here. */
function RecentThreads({ container }: { container: HTMLElement | null }) {
  const { t } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  const { chat, openThread, startThread } = useAnalystPanel()
  const [open, setOpen] = useState(false)
  const threads = useQuery({
    queryKey: ['agent-threads'],
    queryFn: api.agentThreads,
    enabled: open,
  })
  const remove = useMutation({
    mutationFn: api.forgetAgentThread,
    onSuccess: (_, id) => {
      if (id === chat.id) startThread()
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['agent-threads'] }),
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t('analyst.recent')}
          title={t('analyst.recent')}
        >
          <History />
        </Button>
      </PopoverTrigger>
      <PopoverContent container={container} align="end" className="w-80 p-1">
        <p className="label px-2 py-1.5">{t('analyst.recent')}</p>
        {threads.error ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            {t('analyst.recent.unreadable', { reason: threads.error.message })}
          </p>
        ) : threads.data === undefined ? null : threads.data.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">{t('analyst.recent.empty')}</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {threads.data.slice(0, RECENT).map((thread) => {
              const title = thread.title || t('analyst.recent.untitled')
              return (
                <li key={thread.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    className="flex min-h-11 min-w-0 flex-1 flex-col items-start rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    aria-current={thread.id === chat.id ? 'true' : undefined}
                    onClick={() => {
                      setOpen(false)
                      openThread(thread.id)
                    }}
                  >
                    <span className="w-full truncate text-sm">{title}</span>
                    <span className="text-xs text-muted-foreground">
                      {f.dateTime(thread.updated_at)}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11"
                    aria-label={t('analyst.delete.named', { title })}
                    title={t('analyst.delete')}
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
      </PopoverContent>
    </Popover>
  )
}

/** Disabled (4A): the button stays, the panel says what is missing. */
function AnalystOff() {
  const { t } = useI18n()
  const { setOpen } = useAnalystPanel()
  return (
    <div className="flex flex-1 flex-col items-start gap-3 px-4 py-6">
      <p className="text-prose">{t('analyst.disabled')}</p>
      <Button asChild className="min-h-11">
        <Link to="/settings" onClick={() => setOpen(false)}>
          {t('analyst.configure')}
        </Link>
      </Button>
    </div>
  )
}

function AnalystThread() {
  const { opening } = useAnalystPanel()
  // A thread being read draws nothing until it lands (#795); one that could
  // not be read says so, in the server's words.
  if (opening !== null) {
    return opening.error === null ? null : (
      <p role="alert" className="px-4 py-3 text-sm text-destructive">
        {opening.error}
      </p>
    )
  }
  return <AnalystConversation />
}

function AnalystConversation() {
  const { t } = useI18n()
  const { chat, remember } = useAnalystPanel()
  const { messages, sendMessage, status, error, stop, setMessages, clearError } = useChat({
    chat,
  })
  const busy = status === 'submitted' || status === 'streaming'
  const notKept = useNotKept(chat.id, error)
  const announcement = useAnnouncement(status, messages)

  const ask = (text: string) => {
    remember()
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
          {t('analyst.notKept')}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller>
            <MessageScrollerViewport aria-label={t('analyst.messages')} className="px-4">
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
                    <p className="text-sm text-muted-foreground">{t('analyst.waiting')}</p>
                  </MessageScrollerItem>
                ) : null}
                {failed ? (
                  <MessageScrollerItem messageId="error">
                    <div role="alert" className="flex flex-col items-start gap-2">
                      <p className="text-sm text-destructive">{errorSentence(error)}</p>
                      <Button variant="outline" className="min-h-11" onClick={retry}>
                        {t('analyst.retry')}
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
    if (started && (was === 'ready' || was === 'error')) setSaid(t('analyst.answering'))
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
      <p className="text-prose">{t('analyst.empty')}</p>
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
function ToolLine({ part }: { part: AnalystToolPart }) {
  const { t } = useI18n()
  const name = getToolName(part)
  const sentence = toolSentence(name)
  return (
    <details className="group text-sm text-muted-foreground">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md">
        <span className="min-w-0 flex-1">{t(sentence.key, sentence.values)}</span>
        <span className="shrink-0 text-xs underline-offset-2 group-open:underline">
          {t('analyst.tool.detail')}
        </span>
      </summary>
      <dl className="mt-1 flex flex-col gap-2 rounded-md bg-card p-2 text-xs">
        <div>
          <dt className="font-medium">{t('analyst.tool.input')}</dt>
          <dd>
            <pre className="font-mono break-all whitespace-pre-wrap">
              {name}({JSON.stringify(part.input ?? {}, null, 2)})
            </pre>
          </dd>
        </div>
        {part.state === 'output-available' ? (
          <div>
            <dt className="font-medium">{t('analyst.tool.output')}</dt>
            <dd>
              <pre className="max-h-60 overflow-auto font-mono break-all whitespace-pre-wrap">
                {JSON.stringify(part.output, null, 2)}
              </pre>
            </dd>
          </div>
        ) : null}
        {part.state === 'output-error' ? (
          <div>
            <dt className="font-medium">{t('analyst.tool.output')}</dt>
            <dd>{t('analyst.tool.failed', { reason: part.errorText })}</dd>
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

  // Focus goes to the input on open (11A): the panel mounts on open.
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
  // Every model the analyst runs on reads text only (`agent_routes` refuses
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
                <AttachmentDescription>{t('analyst.files.refused')}</AttachmentDescription>
              </AttachmentContent>
            </Attachment>
          ))}
        </div>
      ) : null}
      <form onSubmit={submit} className="flex items-end gap-2">
        <label htmlFor={fieldId} className="sr-only">
          {t('analyst.input')}
        </label>
        <Textarea
          id={fieldId}
          ref={input}
          value={text}
          rows={1}
          placeholder={t('analyst.input.placeholder')}
          className="max-h-40 min-h-11 resize-none bg-card"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
        />
        {busy ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={onStop}>
            {t('analyst.stop')}
          </Button>
        ) : (
          <Button type="submit" className="min-h-11" disabled={text.trim() === ''}>
            {t('analyst.send')}
          </Button>
        )}
      </form>
      <p className="text-xs text-muted-foreground">{t('analyst.cif')}</p>
    </div>
  )
}
