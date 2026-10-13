/**
 * The analyst panel's pure half (#1117): the transport `useChat` posts
 * through, the sentence each tool is read in, what an error says, and the
 * three questions an empty thread offers.
 *
 * **The transport is a seam, and the only one.** The panel never builds its
 * own: it asks {@link analystSeam}, which the browser answers with an HTTP
 * transport to `/agent` and a test answers with a scripted conversation
 * (`@shadcn/helpers/ai-sdk`) — no model, no key, the rest of the app as it
 * ships.
 */
import { DefaultChatTransport, getToolName, isToolUIPart } from 'ai'
import type { ChatTransport, DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai'

import { ROUTES, type Position } from '@/lib/api'
import type { MessageKey } from '@/lib/i18n'

/** The panel's three widths (DESIGN.md, Layout). */
export type AnalystLayout = 'docked' | 'sheet' | 'full'

/** From 1 440 px the panel docks beside the page; from 768 it lies over it. */
export const DOCKED_FROM = 1440
export const SHEET_FROM = 768

export function layoutFor(width: number): AnalystLayout {
  if (width >= DOCKED_FROM) return 'docked'
  if (width >= SHEET_FROM) return 'sheet'
  return 'full'
}

/** What `page.route` may hold on the server (`agent._ROUTE`): anything else is left out. */
const ROUTE = /^\/[A-Za-z0-9/_.~%-]{0,199}$/

/**
 * The HTTP transport. **Only the last message travels**: the server reads the
 * history from the thread's file and uses the last user message alone
 * (#1114), so sending the rest would cost bytes against its 256 KB cap and
 * change nothing.
 */
export function httpTransport(): ChatTransport<UIMessage> {
  return new DefaultChatTransport<UIMessage>({
    api: ROUTES.agent,
    prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => {
      const route = window.location.pathname
      return {
        body: {
          id,
          trigger,
          messageId,
          messages: messages.slice(-1),
          ...(ROUTE.test(route) ? { page: { route } } : {}),
        },
      }
    },
  })
}

export const analystSeam = {
  transport: (): ChatTransport<UIMessage> => httpTransport(),
}

/** The tools the MCP server serves (`mcp_server.build_server`), in plain words. */
const TOOL_SENTENCES: Record<string, MessageKey> = {
  list_positions: 'analyst.tool.list_positions',
  get_portfolio_totals: 'analyst.tool.get_portfolio_totals',
  get_portfolio_history: 'analyst.tool.get_portfolio_history',
  list_accounts: 'analyst.tool.list_accounts',
  list_events: 'analyst.tool.list_events',
  get_investment_rhythm: 'analyst.tool.get_investment_rhythm',
  simulate_sale: 'analyst.tool.simulate_sale',
}

/** The sentence a tool call is shown as; a tool this list does not know is named. */
export function toolSentence(name: string): { key: MessageKey; values?: { name: string } } {
  const key = TOOL_SENTENCES[name]
  return key ? { key } : { key: 'analyst.tool.other', values: { name } }
}

export type AnalystToolPart = ToolUIPart | DynamicToolUIPart

export function toolParts(message: UIMessage): AnalystToolPart[] {
  return message.parts.filter(isToolUIPart)
}

export { getToolName, isToolUIPart }

/** A tool still waiting on its result. */
export function toolRunning(part: AnalystToolPart): boolean {
  return part.state === 'input-streaming' || part.state === 'input-available'
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
 * analyst's routes write as `{"error": "…"}`; a failure during it is the
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
      { key: 'analyst.example.totals' },
      { key: 'analyst.example.rhythm' },
      { key: 'analyst.example.events' },
    ]
  }
  const name = largest.name ?? largest.symbol
  const account = held.find((h) => h.position.account !== largest.account)?.position.account
  return [
    { key: 'analyst.example.sell', values: { name, account: labelOf(largest.account) } },
    { key: 'analyst.example.rhythm' },
    account === undefined
      ? { key: 'analyst.example.totals' }
      : { key: 'analyst.example.account', values: { account: labelOf(account) } },
  ]
}
