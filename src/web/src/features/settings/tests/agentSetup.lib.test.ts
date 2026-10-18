import { describe, expect, it } from 'vitest'

import {
  canActivate,
  candidateOf,
  canTest,
  storedKeyApplies,
} from '@/features/settings/lib/agentSetup'
import { anAgentConfig } from '@/test/factories'

const stored = anAgentConfig({
  enabled: true,
  provider: 'anthropic',
  model: 'claude-x',
  key: { set: true, last4: 'abcd', set_at: null },
})

describe('the candidate a test sends', () => {
  it('holds the provider and the address, and no key when none was typed', () => {
    expect(candidateOf({ provider: 'anthropic', key: '', baseUrl: '' })).toEqual({
      provider: 'anthropic',
      base_url: null,
    })
  })

  it('carries the typed key, trimmed', () => {
    expect(candidateOf({ provider: 'anthropic', key: ' new-key-1234 ', baseUrl: '' })).toEqual({
      provider: 'anthropic',
      base_url: null,
      key: 'new-key-1234',
    })
  })

  it('carries the address only for a provider that takes one', () => {
    expect(
      candidateOf({ provider: 'openai_compatible', key: '', baseUrl: ' http://litellm:4000 ' }),
    ).toEqual({ provider: 'openai_compatible', base_url: 'http://litellm:4000' })
    expect(candidateOf({ provider: 'openai', key: 'sk-key-1234', baseUrl: 'http://x' })).toEqual({
      provider: 'openai',
      base_url: null,
      key: 'sk-key-1234',
    })
  })

  it('never sends a key to a provider that takes none', () => {
    expect(
      candidateOf({ provider: 'ollama', key: 'stray-key', baseUrl: 'http://ollama:11434' }),
    ).toEqual({ provider: 'ollama', base_url: 'http://ollama:11434' })
  })
})

describe('when the two buttons may be pressed', () => {
  it('tests once a provider has what it needs', () => {
    const fresh = anAgentConfig()
    expect(canTest(fresh, { provider: null, key: '', baseUrl: '' })).toBe(false)
    expect(canTest(fresh, { provider: 'openai', key: '', baseUrl: '' })).toBe(false)
    expect(canTest(fresh, { provider: 'openai', key: 'sk-key-1234', baseUrl: '' })).toBe(true)
    expect(canTest(fresh, { provider: 'ollama', key: '', baseUrl: 'ollama' })).toBe(false)
    expect(canTest(fresh, { provider: 'ollama', key: '', baseUrl: 'http://ollama:11434' })).toBe(
      true,
    )
    // The stored key is Anthropic's: it does not stand for OpenAI.
    expect(canTest(stored, { provider: 'openai', key: '', baseUrl: '' })).toBe(false)
  })

  it('asks for the key again once the address changes', () => {
    const gateway = anAgentConfig({
      provider: 'openai_compatible',
      base_url: 'http://litellm:4000',
      key: { set: true, last4: 'abcd', set_at: null },
    })
    const draft = { provider: 'openai_compatible' as const, key: '' }
    expect(storedKeyApplies(gateway, { ...draft, baseUrl: ' http://litellm:4000 ' })).toBe(true)
    expect(storedKeyApplies(gateway, { ...draft, baseUrl: 'http://other:4000' })).toBe(false)
  })

  it('activates only after a passed test, with a model', () => {
    expect(canActivate(false, 'claude-x')).toBe(false)
    expect(canActivate(true, '')).toBe(false)
    expect(canActivate(true, 'claude-x')).toBe(true)
  })
})
