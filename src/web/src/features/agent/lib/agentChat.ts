/**
 * The agent's pure half (#1117): the transport `useChat` posts
 * through, the sentence each tool is read in, what an error says, and the
 * three questions an empty thread offers.
 *
 * **The transport is a seam, and the only one.** The page never builds its
 * own: it asks {@link agentSeam}, which the browser answers with an HTTP
 * transport to `/api/agent/chat` and a test answers with a scripted conversation
 * (`@shadcn/helpers/ai-sdk`) — no model, no key, the rest of the app as it
 * ships.
 */
import { DefaultChatTransport, getToolName, isToolUIPart } from 'ai'
import type { ChatTransport, DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai'

import type { Position } from '@/features/shares/lib/api'
import { authFetch, ROUTES } from '@/lib/api'
import { SessionEnded } from '@/lib/session'
import type { MessageKey } from '@/lib/i18n'

/**
 * The HTTP transport. **Only the last message travels**: the server reads the
 * history from the thread's file and uses the last user message alone
 * (#1114), so sending the rest would cost bytes against its 256 KB cap and
 * change nothing.
 */
export function httpTransport(): ChatTransport<UIMessage> {
  return new DefaultChatTransport<UIMessage>({
    api: ROUTES.agentChat,
    // A 401 opens the code dialog (`authFetch`) and is thrown by name, so the
    // page can hand the refused question back to the input.
    fetch: async (input, init) => {
      const response = await authFetch(input, init)
      if (response.status === 401) throw new SessionEnded()
      return response
    },
    // No `page` (#1196): the agent is a page of its own now, and reads the
    // portfolio through its tools rather than off the reader's location.
    prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => ({
      body: { id, trigger, messageId, messages: messages.slice(-1) },
    }),
  })
}

export const agentSeam = {
  transport: (): ChatTransport<UIMessage> => httpTransport(),
}

/** The tools the MCP server serves (`mcp_server.build_server`), in plain words. */
const TOOL_SENTENCES: Record<string, MessageKey> = {
  list_positions: 'agent.tool.list_positions',
  get_portfolio_totals: 'agent.tool.get_portfolio_totals',
  get_portfolio_history: 'agent.tool.get_portfolio_history',
  list_accounts: 'agent.tool.list_accounts',
  list_events: 'agent.tool.list_events',
  get_investment_rhythm: 'agent.tool.get_investment_rhythm',
  get_benchmark_comparison: 'agent.tool.get_benchmark_comparison',
  simulate_sale: 'agent.tool.simulate_sale',
  get_profile: 'agent.tool.get_profile',
  propose_profile_fact: 'agent.tool.propose_profile_fact',
}

/** The sentence a tool call is shown as; a tool this list does not know is named. */
export function toolSentence(name: string): { key: MessageKey; values?: { name: string } } {
  const key = TOOL_SENTENCES[name]
  return key ? { key } : { key: 'agent.tool.other', values: { name } }
}

export type AgentToolPart = ToolUIPart | DynamicToolUIPart

export function toolParts(message: UIMessage): AgentToolPart[] {
  return message.parts.filter(isToolUIPart)
}

export { getToolName, isToolUIPart }

/** A tool still waiting on its result. */
export function toolRunning(part: AgentToolPart): boolean {
  return part.state === 'input-streaming' || part.state === 'input-available'
}

/**
 * Is a live turn between two things the page draws (#1271)? Between a tool's
 * answer and the first word, the model reads, thinks (reasoning is not drawn)
 * or writes its proposals, and nothing moved for 4 to 13 s. True from the
 * question sent until a running tool, or the answer's first word, is on screen.
 * `last`: the thread's last message.
 */
export function pendingAnswer(status: string, last: UIMessage | undefined): boolean {
  if (status !== 'submitted' && status !== 'streaming') return false
  if (status === 'submitted' || last?.role !== 'assistant') return true
  if (toolParts(last).some(toolRunning)) return false
  // The tail, not any earlier text: after « Je regarde. » and an answered tool
  // the page stands still while the model reads the result, which is the gap.
  const tail = last.parts
    .filter((p) => p.type === 'text' || p.type === 'reasoning' || isToolUIPart(p))
    .at(-1)
  return !(tail?.type === 'text' && tail.text.trim() !== '')
}

/** The text of a message, its text parts joined. */
export function textOf(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()
}

/**
 * What the server said, out of whatever the SDK wrapped it in. A refusal
 * before the stream (`409`, `500`) arrives as the response body, which the
 * agent's routes write as `{"error": "…"}`; a failure during it is the
 * error chunk's text, already a sentence.
 */
export function errorSentence(error: Error): string {
  const text = error.message
  try {
    const said = (JSON.parse(text) as { error?: unknown }).error
    if (typeof said === 'string') return said
  } catch {
    // Already a sentence.
  }
  return text
}

/**
 * A failed turn that is the provider's (#1269): the error chunk's text is then
 * a JSON object holding the provider's label, the `reason` the page translates
 * and the message as the provider said it (`Anthropic: …`, which is stripped of
 * its prefix here). `null` for anything else, said as {@link errorSentence}.
 */
export function turnRefusal(
  error: Error,
): { provider: string; reason: string; said: string } | null {
  try {
    const body = JSON.parse(error.message) as Record<string, unknown>
    const { error: said, provider, reason } = body
    if (typeof said !== 'string' || typeof provider !== 'string' || typeof reason !== 'string') {
      return null
    }
    return {
      provider,
      reason,
      said: said.startsWith(`${provider}: `) ? said.slice(provider.length + 2) : said,
    }
  } catch {
    return null
  }
}

/**
 * The server's own words when a thread file cannot be written
 * (`agent_routes.NOT_SAVED`): the answer may stand, the conversation will not.
 */
const NOT_SAVED = 'The conversation could not be saved'

export function threadNotWritable(error: Error | undefined): boolean {
  return error !== undefined && errorSentence(error).startsWith(NOT_SAVED)
}

/** Files a text-only model cannot read: refused before anything is sent. */
export function unreadableFiles(files: Iterable<File>): boolean {
  for (const file of files) {
    if (file.type.startsWith('image/') || file.type === 'application/pdf') return true
  }
  return false
}

/** An example question, as a catalogue key and the values it takes. */
export interface ExampleQuestion {
  key: MessageKey
  values?: Record<string, string>
}

/**
 * Three questions built from the portfolio: the largest held line, sold;
 * the rhythm; and what one account would cost to empty. A portfolio with
 * nothing held asks the general ones instead, never a question about a title
 * that is not there.
 */
export function exampleQuestions(
  positions: readonly Position[],
  labelOf: (account: string) => string,
): ExampleQuestion[] {
  const held = positions
    .filter((p) => p.quantity > 0)
    .map((p) => ({
      position: p,
      // `converted` is a unit price; `cost_basis` is already the line's whole cost.
      weight: p.converted ? p.converted.value * p.quantity : p.cost_basis,
    }))
    .sort((a, b) => b.weight - a.weight)
  const largest = held[0]?.position
  if (largest === undefined) {
    return [
      { key: 'agent.example.totals' },
      { key: 'agent.example.rhythm' },
      { key: 'agent.example.events' },
    ]
  }
  const name = largest.name ?? largest.symbol
  const account = held.find((h) => h.position.account !== largest.account)?.position.account
  return [
    { key: 'agent.example.sell', values: { name, account: labelOf(largest.account) } },
    { key: 'agent.example.rhythm' },
    account === undefined
      ? { key: 'agent.example.totals' }
      : { key: 'agent.example.account', values: { account: labelOf(account) } },
  ]
}
