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

/** How hard the analyst thinks, as `agent.THINKING` names the levels (#1191). */
export type AgentThinking = 'low' | 'medium' | 'high'

/** `GET /api/agent/config`: the key is never on the wire, only its end. */
export interface AgentConfig {
  enabled: boolean
  provider: AgentProvider | null
  model: string | null
  /** The name the picker showed when `model` was chosen; `null` until then. */
  model_name: string | null
  base_url: string | null
  thinking: AgentThinking
  key: { set: boolean; last4: string | null; set_at: string | null }
  /** Present, and `true`, on the one write that switched the agent off. */
  disabled?: boolean
}

/** What `PUT /api/agent/config` takes: any subset of the fields. */
export interface AgentConfigDraft {
  enabled?: boolean
  provider?: AgentProvider
  model?: string
  /** Sent with its `model`: a model without a name clears the name. */
  model_name?: string | null
  base_url?: string | null
  thinking?: AgentThinking
}

/** What `POST /api/agent/test` takes: a candidate, kept only if the provider accepts it. */
export interface AgentCandidate {
  provider?: AgentProvider
  base_url?: string | null
  /** Left out, the stored key is used, for the provider and address it was stored for. */
  key?: string
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
  /** The last turn ended on an error: its partial answer is there, the rest is not. */
  failed: boolean
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

/** `POST /api/agent/test`: the provider's own list, newest first, and what is now stored. */
export interface AgentTestResult {
  provider: AgentProvider
  models: { id: string; name: string }[]
  /** The stored model while the provider still serves it, else its newest. */
  preselected: string | null
  config: AgentConfig
}

export const agentApi = {
  agentConfig: () => get<AgentConfig>(ROUTES.agentConfig),
  saveAgentConfig: (draft: AgentConfigDraft) => send<AgentConfig>(ROUTES.agentConfig, 'PUT', draft),
  testAgent: (candidate: AgentCandidate) =>
    send<AgentTestResult>(ROUTES.agentTest, 'POST', candidate),
  agentThreads: () => agentRead<AgentThreadSummary[]>(ROUTES.agentThreads),
  agentThread: (id: string) => agentRead<AgentThread>(agentThreadPath(id)),
  forgetAgentThread: (id: string) => agentForget(agentThreadPath(id)),
}
