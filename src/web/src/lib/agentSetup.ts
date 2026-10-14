/**
 * Switching the agent on, in four steps (#1115) — the rules, without React.
 *
 * The server holds the configuration and the key (#1114); the setup only
 * writes them, then asks the server to test what it stored. So what this module
 * decides is **which writes put the form in the store, in an order the server
 * takes each of**, and when *Tester* and *Activer* may be pressed.
 *
 * Two rules come from `agent.check` on the server and are mirrored here so the
 * writes never meet them:
 *
 *  - Ollama takes no key: a stored key is forgotten **before** the provider
 *    changes, or the change is refused;
 *  - a key belongs to the provider it was typed for: switching provider with no
 *    new key forgets the old one, rather than sending an Anthropic key to a
 *    gateway.
 *
 * And one of the setup's own: **any change to the provider, its key or its
 * address switches the agent off**, since what was tested is no longer what
 * is stored. It goes back on with *Activer*, after a new test.
 */
import type { AgentConfig, AgentConfigDraft, AgentProvider } from '@/lib/api'

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

/** One write, in the order {@link setupWrites} lists them. */
export type SetupWrite =
  | { kind: 'forgetKey' }
  | { kind: 'config'; body: AgentConfigDraft }
  | { kind: 'key'; key: string }

/** Whether the stored key may stand for the draft's provider. */
function storedKeyApplies(stored: AgentConfig, provider: AgentProvider): boolean {
  return stored.key.set && stored.provider === provider && !keyRefused(provider)
}

/** Whether *Tester la connexion* has what a test needs. */
export function canTest(stored: AgentConfig, draft: AgentDraft): boolean {
  const { provider } = draft
  if (provider === null) return false
  if (keyRequired(provider) && draft.key.trim() === '' && !storedKeyApplies(stored, provider)) {
    return false
  }
  return !addressRequired(provider) || HTTP_URL.test(draft.baseUrl.trim())
}

/** The writes that put `draft` in the store, each one taken by the server. */
export function setupWrites(stored: AgentConfig, draft: AgentDraft): SetupWrite[] {
  const provider = draft.provider
  if (provider === null) return []
  const key = keyRefused(provider) ? '' : draft.key.trim()
  const baseUrl = addressRequired(provider) ? draft.baseUrl.trim() : null
  const switched = provider !== stored.provider
  const writes: SetupWrite[] = []

  if (stored.key.set && (keyRefused(provider) || (switched && key === ''))) {
    writes.push({ kind: 'forgetKey' })
  }
  const body: AgentConfigDraft = {}
  if (switched) body.provider = provider
  if (baseUrl !== stored.base_url) body.base_url = baseUrl
  const changed = Object.keys(body).length > 0 || key !== ''
  if (changed && stored.enabled) body.enabled = false
  if (Object.keys(body).length > 0) writes.push({ kind: 'config', body })
  if (key !== '') writes.push({ kind: 'key', key })
  return writes
}

/** *Activer* is pressable once a test passed for this draft and a model is chosen. */
export function canActivate(tested: boolean, model: string): boolean {
  return tested && model !== ''
}
