/**
 * The agent: its provider, its key, and its conversations.
 *
 * The types are the contract of #712 §11 for this domain, and the calls go
 * through the transport of `lib/api.ts`, which also holds every path in
 * `ROUTES`: a route renamed still changes that file and the test harness, and
 * no page test.
 */

import type { UIMessage } from 'ai'

import { authFetch, get, ROUTES, send } from '@/lib/api'

/** The four kinds of provider the agent runs on, as `agent.PROVIDERS` names them. */
export type AgentProvider = 'anthropic' | 'openai' | 'openai_compatible' | 'ollama'

/** `GET /api/agent/config`: the key is never on the wire, only its end. */
export interface AgentConfig {
  enabled: boolean
  provider: AgentProvider | null
  model: string | null
  base_url: string | null
  key: { set: boolean; last4: string | null; set_at: string | null }
  /** Present, and `true`, on the one write that switched the agent off. */
  disabled?: boolean
}

/** What `PUT /api/agent/config` takes: any subset of the four fields. */
export interface AgentConfigDraft {
  enabled?: boolean
  provider?: AgentProvider
  model?: string
  base_url?: string | null
}

/** One line of `GET /api/agent/threads`. */
export interface AgentThreadSummary {
  id: string
  /** The first 80 characters of the first question. */
  title: string | null
  created_at: string | null
  updated_at: string | null
}

/** `GET /api/agent/threads/<id>`: the messages as `useChat` holds them. */
export interface AgentThread {
  id: string
  title: string | null
  messages: UIMessage[]
}

export function agentThreadPath(id: string): string {
  return ROUTES.agentThread.replace(':id', encodeURIComponent(id))
}

/**
 * The agent's routes answer `{error}` rather than `problem+json`: they are
 * Starlette's, under `/api/agent/{chat,threads}`, not Flask's. A refusal is
 * thrown as the server's sentence.
 */
async function agentRead<T>(path: string): Promise<T> {
  const response = await authFetch(path, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(await agentError(response))
  return (await response.json()) as T
}

async function agentForget(path: string): Promise<void> {
  const response = await authFetch(path, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(await agentError(response))
}

async function agentError(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const said = (JSON.parse(text) as { error?: unknown }).error
    if (typeof said === 'string') return said
  } catch {
    // Not the agent's shape: a proxy's page, say. Its status is all there is.
  }
  return `HTTP ${response.status}`
}

/** `POST /api/agent/test`: the provider's own list, newest first. */
export interface AgentTestResult {
  provider: AgentProvider
  models: { id: string; name: string }[]
  /** The stored model while the provider still serves it, else its newest. */
  preselected: string | null
}

export const agentApi = {
  agentConfig: () => get<AgentConfig>(ROUTES.agentConfig),
  saveAgentConfig: (draft: AgentConfigDraft) => send<AgentConfig>(ROUTES.agentConfig, 'PUT', draft),
  saveAgentKey: (key: string) => send<AgentConfig>(ROUTES.agentKey, 'PUT', { key }),
  testAgent: () => send<AgentTestResult>(ROUTES.agentTest, 'POST', {}),
  agentThreads: () => agentRead<AgentThreadSummary[]>(ROUTES.agentThreads),
  agentThread: (id: string) => agentRead<AgentThread>(agentThreadPath(id)),
  forgetAgentThread: (id: string) => agentForget(agentThreadPath(id)),
}
