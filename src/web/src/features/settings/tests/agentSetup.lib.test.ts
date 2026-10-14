import { describe, expect, it } from 'vitest'

import {
  canActivate,
  canTest,
  setupWrites,
  storedKeyApplies,
} from '@/features/settings/lib/agentSetup'
import { anAgentConfig } from '@/test/factories'

const stored = anAgentConfig({
  enabled: true,
  provider: 'anthropic',
  model: 'claude-x',
  key: { set: true, last4: 'abcd', set_at: null },
})

describe('the writes that put the form in the store', () => {
  it('writes nothing when nothing changed, so a re-test leaves the agent on', () => {
    expect(setupWrites(stored, { provider: 'anthropic', key: '', baseUrl: '' })).toEqual([])
  })

  it('switches the agent off before a new key is kept', () => {
    expect(
      setupWrites(stored, { provider: 'anthropic', key: ' new-key-1234 ', baseUrl: '' }),
    ).toEqual([
      { kind: 'config', body: { enabled: false } },
      { kind: 'key', key: 'new-key-1234' },
    ])
  })

  it('never carries a key across providers', () => {
    expect(
      setupWrites(stored, {
        provider: 'openai_compatible',
        key: '',
        baseUrl: 'http://litellm:4000',
      }),
    ).toEqual([
      {
        kind: 'config',
        body: { provider: 'openai_compatible', base_url: 'http://litellm:4000', enabled: false },
      },
    ])
  })

  it('clears an address the new provider refuses', () => {
    const ollama = anAgentConfig({ provider: 'ollama', base_url: 'http://ollama:11434' })
    expect(setupWrites(ollama, { provider: 'openai', key: 'sk-key-1234', baseUrl: '' })).toEqual([
      { kind: 'config', body: { provider: 'openai', base_url: null } },
      { kind: 'key', key: 'sk-key-1234' },
    ])
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
