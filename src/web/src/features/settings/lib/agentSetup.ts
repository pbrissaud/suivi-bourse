/**
 * Switching the agent on, in four steps (#1115) — the rules, without React.
 *
 * The server holds the configuration and the key (#1114); the setup sends the
 * form as **one candidate, tested before anything is stored** (#1269): a key
 * the provider refused is never kept, and a failed test leaves the working
 * configuration as it was. So what this module decides is **what the candidate
 * holds**, and when *Tester* and *Activer* may be pressed.
 *
 * A key belongs to the provider and the address it was typed for: the server
 * uses the stored one only for those (#1197), so the screen stops offering it
 * as soon as the draft's differ, and asks for a new one.
 *
 * And one rule the server now enforces: **a passed test that changes the
 * provider, its key or its address switches the agent off**, since what was
 * switched on is no longer what is stored. It goes back on with *Activer
 * l’agent*.
 */
import type { AgentCandidate, AgentConfig, AgentProvider } from '@/features/agent/lib/api'

/** In the order the first step offers them. */
export const AGENT_PROVIDERS: readonly AgentProvider[] = [
  'anthropic',
  'openai',
  'openai_compatible',
  'ollama',
]

/** `agent.KEY_REQUIRED`, `KEY_REFUSED`, `BASE_URL_REQUIRED`, mirrored. */
export const keyRequired = (provider: AgentProvider) =>
  provider === 'anthropic' || provider === 'openai'
export const keyRefused = (provider: AgentProvider) => provider === 'ollama'
export const addressRequired = (provider: AgentProvider) =>
  provider === 'openai_compatible' || provider === 'ollama'

/** Where each provider hands out a key — *Où la trouver*. */
export const KEY_PAGE: Partial<Record<AgentProvider, string>> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
}

/** The address Ollama listens on, on the machine it runs on. */
export const OLLAMA_ADDRESS = 'http://localhost:11434'

const HTTP_URL = /^https?:\/\/\S+$/

/** What the reader has typed or chosen; the key is never prefilled. */
export interface AgentDraft {
  provider: AgentProvider | null
  key: string
  baseUrl: string
}

export function draftOf(config: AgentConfig): AgentDraft {
  return { provider: config.provider, key: '', baseUrl: config.base_url ?? '' }
}

/** The address the draft stores: `null` for a provider that takes none. */
const addressOf = (draft: AgentDraft) =>
  draft.provider !== null && addressRequired(draft.provider) ? draft.baseUrl.trim() : null

/** Whether the stored key survives the draft: same provider, same address. */
export function storedKeyApplies(stored: AgentConfig, draft: AgentDraft): boolean {
  return (
    stored.key.set && stored.provider === draft.provider && stored.base_url === addressOf(draft)
  )
}

/** Whether *Tester la connexion* has what a test needs. */
export function canTest(stored: AgentConfig, draft: AgentDraft): boolean {
  const { provider } = draft
  if (provider === null) return false
  if (keyRequired(provider) && draft.key.trim() === '' && !storedKeyApplies(stored, draft)) {
    return false
  }
  return !addressRequired(provider) || HTTP_URL.test(draft.baseUrl.trim())
}

/**
 * What *Tester la connexion* sends: the provider, its address, and the key
 * when one was typed. Without one the server uses the stored key, for the
 * provider and the address it was stored for.
 */
export function candidateOf(draft: AgentDraft): AgentCandidate {
  const { provider } = draft
  if (provider === null) return {}
  const key = keyRefused(provider) ? '' : draft.key.trim()
  return { provider, base_url: addressOf(draft), ...(key !== '' ? { key } : {}) }
}

/** *Activer* is pressable once a test passed for this draft and a model is chosen. */
export function canActivate(tested: boolean, model: string): boolean {
  return tested && model !== ''
}
