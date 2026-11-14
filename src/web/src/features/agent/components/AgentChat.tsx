/**
 * The agent (#1117, #1196): a conversation about the portfolio through the
 * MCP tools, streamed by `useChat` from `/api/agent/chat`, on its own page, in
 * the « Relevé » composition (`Agent-Refonte.dc.html`).
 *
 * **A page, not a panel** (#1196). From 1 024 px the threads are a 240 px rail
 * on `muted` (`ThreadRail`) beside a conversation centred at 768 px; below, the
 * rail is the header's menu. The user's turn has no bubble; the answer is read
 * in Prose (15/22), its Markdown drawn rather than shown; a tool call is one
 * muted `trace` line in plain words whose chevron opens the raw call in a
 * `code-block` (2A).
 *
 * **What the thread runs on is the thread's**: the composer's provider · model
 * picker rides with each question, and the server stores it with the thread.
 *
 * **Built on the shadcn AI components**: `message-scroller` keeps a streamed
 * answer in view while the reader is at the live edge, `message` lays the
 * turns out, `attachment` shows a refused file.
 *
 * **Announced once** (11A): the scroller's content is a `log` live region,
 * which would read every streamed token; it is silenced, and one polite
 * region says *Réponse en cours* at the start and the whole answer at the end.
 */
import { modelName } from '@/features/agent/lib/modelNames'
import { useChat } from '@ai-sdk/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import type { UIMessage } from 'ai'
import { ChevronRight, History, SquarePen, X } from 'lucide-react'
import { type ComponentProps, memo, useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockContent, CodeBlockLine } from '@/components/ui/code-block'
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
import { accountsApi } from '@/features/accounts/lib/api'
import { Composer } from '@/features/agent/components/Composer'
import { defaultRunner, providerName, type Runner } from '@/features/agent/components/ModelPicker'
import { RefusalNotice } from '@/features/agent/components/RefusalNotice'
import { EventsCard } from '@/features/agent/components/EventsCard'
import {
  FactCard,
  ProfileLine,
  proposalOf,
  type ThreadProposal,
  useProposals,
} from '@/features/agent/components/AgentProfile'
import { RailBody, ThreadRail } from '@/features/agent/components/ThreadRail'
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
} from '@/features/agent/lib/agentChat'
import { useAgentChat } from '@/features/agent/lib/agentChatProvider'
import { agentApi, type ConfiguredProvider } from '@/features/agent/lib/api'
import { ACT } from '@/features/agent/lib/styles'
import { useHighlightedCode } from '@/hooks/use-highlighted-code'
import { sharesApi } from '@/features/shares/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { isSessionEnded } from '@/lib/session'

/** The thread the address names; `undefined` on `/agent`, a thread not yet asked. */
export function useThreadParam(): string | undefined {
  return useParams({ strict: false }).threadId
}

/** The page's body: the rail from 1 024 px, then the conversation. */
export function AgentChat({ wide }: { wide: boolean }) {
  const settings = useQuery({ queryKey: ['agent-settings'], queryFn: agentApi.settings })

  // A read that has not answered renders nothing (#795).
  if (settings.data === undefined) return null
  if (!settings.data.enabled) return <AgentOff />
  return (
    <div className="flex h-full min-h-0">
      {wide ? <ThreadRail /> : null}
      <section className="flex min-h-0 w-full min-w-0 flex-col">
        {wide ? null : <NarrowBar />}
        <AgentThread />
      </section>
    </div>
  )
}

/** Under 1 024 px the rail is two buttons: a new thread, and the recent ones. */
function NarrowBar() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <header className="flex items-center justify-end gap-1 px-4 pt-2 pb-2">
      <Button asChild variant="outline" size="icon">
        <Link
          to="/agent"
          aria-label={t('agent.newThread')}
          title={t('agent.newThread')}
          // Exact: `/agent/x` starts with `/agent` and is not a new thread.
          activeOptions={{ exact: true }}
        >
          <SquarePen />
        </Link>
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            aria-label={t('agent.recent')}
            title={t('agent.recent')}
          >
            <History />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex max-h-96 w-80 flex-col gap-1 p-2">
          <RailBody onOpened={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </header>
  )
}

/**
 * Disabled (4A): the page says what is missing, and what the agent would do.
 * It sits where the conversation would, and the link lands on the agent's own
 * block of the settings.
 */
function AgentOff() {
  const { t } = useI18n()
  return (
    <div className="mx-auto flex h-full w-full max-w-reading flex-col items-center justify-center gap-3 px-4 py-6 text-center md:px-8">
      <p className="text-prose font-medium">{t('agent.disabled')}</p>
      <p className="max-w-prose text-prose text-muted-foreground">{t('agent.disabled.detail')}</p>
      <Button asChild variant="primary">
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
          <Button variant="outline" onClick={() => openThread(id)}>
            {t('agent.retry')}
          </Button>
          <Button asChild variant="outline">
            <Link to="/agent">{t('agent.newThread')}</Link>
          </Button>
        </div>
      </div>
    )
  }
  // Keyed: what the conversation remembers of its stream (the announcement,
  // the scroll, the model picked) is one thread's, never carried into the next.
  return <AgentConversation key={chat.id} />
}

/** The refusals the reader mends in Settings: another key, more credit, another model. */
const SETTINGS_REASONS = ['key', 'quota', 'model']

/** What a thread runs on: its stored provider while that still exists, else the default one. */
function runnerOf(
  stored: { provider_id: string | null; model: string | null } | null,
  providers: readonly ConfiguredProvider[] | undefined,
): Runner | null {
  if (providers === undefined) return null
  const kept = providers.find((p) => p.id === stored?.provider_id)
  return kept
    ? { provider_id: kept.id, model: stored?.model ?? kept.default_model }
    : defaultRunner(providers)
}

function AgentConversation() {
  const { t } = useI18n()
  const providers = useQuery({ queryKey: ['agent-providers'], queryFn: agentApi.providers })
  const { chat, failedOnReload, settle, reloadThread, ranOn } = useAgentChat()
  const threadId = useThreadParam()
  const navigate = useNavigate()
  const { messages, sendMessage, status, error, stop, setMessages, clearError } = useChat({
    chat,
  })
  const busy = status === 'submitted' || status === 'streaming'
  const notKept = useNotKept(chat.id, error)
  const announcement = useAnnouncement(status, messages)
  const proposals = useProposals(chat.id, messages, busy)
  // The picker's choice is the thread's: it starts from what the thread ran
  // on, and rides with each question from here on.
  const [picked, setPicked] = useState<Runner | null>(null)
  const runner = picked ?? runnerOf(ranOn, providers.data)
  const provider = providers.data?.find((p) => p.id === runner?.provider_id)

  // A statement wrote a proposal and four messages into the thread on the
  // server: the thread is read back, and the card appears (#1120).
  const statementSent = () => {
    if (threadId === undefined) {
      void navigate({ to: '/agent/$threadId', params: { threadId: chat.id }, replace: true })
    }
    void reloadThread()
  }

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
    void sendMessage(
      { text },
      runner
        ? {
            body: {
              provider_id: runner.provider_id,
              ...(runner.model ? { model: runner.model } : {}),
            },
          }
        : undefined,
    )
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
    <div className="flex flex-wrap items-center gap-4 pt-1">
      <Button variant="outline" onClick={retry}>
        {t('agent.retry')}
      </Button>
      {refusal && SETTINGS_REASONS.includes(refusal.reason) ? (
        <Link to="/settings" hash="agent" className={ACT}>
          {t('agent.refusal.settings')}
        </Link>
      ) : null}
    </div>
  )
  const waiting = pendingAnswer(status, messages.at(-1))
  const modelId = runner?.model ?? provider?.default_model ?? null
  const model = modelId === null ? null : modelName(modelId)

  return (
    <>
      {notKept ? (
        <p role="status" className="mx-4 mb-2 text-sm text-muted-foreground">
          {t('agent.notKept')}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {/* A thread read back opens on its last question, not halfway down its answer.
            And it stays there (#1368): the scroller follows the bottom only while
            an answer streams — proposal cards, read once the turn has ended,
            grow the thread under the reader without pulling the view down. */}
        <MessageScrollerProvider autoScroll={busy} defaultScrollPosition="last-anchor">
          <MessageScroller>
            <MessageScrollerViewport aria-label={t('agent.messages')}>
              {/* Silenced: the polite region below announces the whole answer once. */}
              <MessageScrollerContent
                aria-live="off"
                className="mx-auto w-full max-w-reading gap-7 px-4 py-7 md:px-8"
              >
                {messages.length > 0 ? (
                  <MessageScrollerItem messageId="head">
                    <ThreadHead threadId={chat.id} />
                  </MessageScrollerItem>
                ) : (
                  <MessageScrollerItem messageId="examples">
                    <Examples onAsk={ask} />
                  </MessageScrollerItem>
                )}
                {messages.map((message) => (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === 'user'}
                  >
                    <Turn
                      message={message}
                      live={busy && message === messages.at(-1)}
                      latest={message === messages.at(-1)}
                      proposals={proposals}
                      model={model}
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
                          provider={providerName(provider, t)}
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
            <MessageScrollerButton className="size-8 border" />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {/* Drawn like the answer, or a screen reader reads its asterisks. */}
        <AnswerMarkdown>{announcement}</AnswerMarkdown>
      </div>
      <Composer
        busy={busy}
        threadId={chat.id}
        onAsk={ask}
        onStop={() => void stop()}
        onStatementSent={statementSent}
        returned={returned}
        providers={providers.data ?? []}
        runner={runner}
        onRunner={setPicked}
      />
    </>
  )
}

/**
 * The thread's head: its title in 15/22/500 and « Supprimer », the one text
 * action the thread offers. Drawn once the list of threads names the thread —
 * the list is where a title lives, and where a thread the server holds is told
 * from one it does not yet (a first question still streaming has no file to
 * delete, and its title is the question already on screen). A deletion is asked in the one confirmation (`ConfirmDestructive`),
 * which names the thread.
 */
function ThreadHead({ threadId }: { threadId: string }) {
  const { t } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [asked, setAsked] = useState(false)
  const threads = useQuery({ queryKey: ['agent-threads'], queryFn: agentApi.agentThreads })
  const remove = useMutation({
    mutationFn: () => agentApi.forgetAgentThread(threadId),
    onSuccess: () => {
      setAsked(false)
      // The thread on screen is gone: an empty one takes its place, and the
      // address that named it is not kept in the history.
      void navigate({ to: '/agent', replace: true })
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['agent-threads'] }),
  })
  const known = threads.data?.find((thread) => thread.id === threadId)
  if (known === undefined) return null
  const title = known.title || t('agent.recent.untitled')

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5 border-b pb-3">
      <h2 className="text-prose font-medium">{title}</h2>
      <button type="button" className={ACT} onClick={() => setAsked(true)}>
        {t('agent.delete')}
      </button>
      <ConfirmDestructive
        open={asked}
        onOpenChange={setAsked}
        title={t('confirm.thread.title')}
        items={[{ key: title, value: f.date(known.updated_at) }]}
        line={t('confirm.thread.line')}
        confirmLabel={t('confirm.delete')}
        pending={remove.isPending}
        error={remove.error ? <Refusal>{remove.error.message}</Refusal> : null}
        onConfirm={() => remove.mutate()}
      />
    </div>
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

/**
 * The empty thread (`Agent-Vide-Refonte.dc.html`): a question as the title, one
 * paragraph on what the agent reads and does — with the profile it knows, as
 * underlined values — and three questions built from the portfolio, each one
 * click, as ruled rows.
 */
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
    <div className="flex flex-col gap-5 pt-12">
      <p className="text-2xl font-semibold">{t('agent.empty.title')}</p>
      <p className="max-w-prose text-muted-foreground">
        {t('agent.empty.lead')} <ProfileLine />
      </p>
      {questions === null ? null : (
        <ul className="flex flex-col">
          {questions.map((question) => (
            <li key={question} className="border-t last:border-b">
              <button
                type="button"
                className="flex min-h-11 w-full items-center justify-between gap-3 py-2.5 text-left text-md hover:[&_svg]:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                onClick={() => onAsk(question)}
              >
                <span>{question}</span>
                <ChevronRight className="size-4 text-border" aria-hidden="true" />
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
  latest,
  proposals,
  model,
}: {
  message: UIMessage
  live: boolean
  /** The thread's last turn: its last events card owns the screen's one filled button. */
  latest: boolean
  proposals: Map<string, ThreadProposal> | undefined
  /** The model the thread runs on, named on the answer; `null` while unread. */
  model: string | null
}) {
  const { t } = useI18n()
  if (message.role === 'user') {
    // No bubble: a label, then the question in the term's rung.
    return (
      <div className="flex flex-col gap-1.5">
        <p className="label">{t('agent.you')}</p>
        <p className="text-lg font-medium whitespace-pre-wrap">{textOf(message)}</p>
      </div>
    )
  }
  const { steps, cards } = stepsAndText(message.parts, proposals)
  return (
    <Message>
      <MessageContent className="gap-3.5">
        <p className="label">
          {model ? t('agent.assistant.model', { model }) : t('agent.assistant')}
        </p>
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
        {cards.map((proposal, index) =>
          'kind' in proposal ? (
            <EventsCard
              key={proposal.id}
              proposal={proposal}
              primary={latest && index === cards.length - 1}
            />
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
