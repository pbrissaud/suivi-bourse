/**
 * What the agent's page reads since providers: the settings (`enabled`,
 * `reasoning`), the providers with the sentence that says where the figures go,
 * and the usage statistics.
 */
import { HttpResponse, http } from 'msw'

import type { AgentProvider, AgentStats } from '@/lib/api'
import { ROUTES } from '@/lib/api'
import { server } from '@/test/server'

export function aProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
  return {
    id: 'p1',
    label: null,
    kind: 'anthropic',
    base_url: null,
    default_model: 'claude-sonnet-5-5',
    is_default: true,
    last_test_at: null,
    key: { set: true, last4: 'wxyz', set_at: null },
    privacy: {
      local: false,
      fr: 'Vos chiffres sont envoyés à Anthropic.',
      en: 'Your figures are sent to Anthropic.',
    },
    ...overrides,
  }
}

/** The agent switched on, on these providers (one by default), with no thread kept. */
export function agentOn(providers: AgentProvider[] = [aProvider()]) {
  server.use(
    // A turn that ends reads the list again; a test that lists none says so.
    http.get(ROUTES.agentThreads, () => HttpResponse.json([])),
    http.get(ROUTES.agentConfig, () => HttpResponse.json({ enabled: true, reasoning: 'low' })),
    http.get(ROUTES.agentProviders, () => HttpResponse.json(providers)),
  )
}

export function aStats(overrides: Partial<AgentStats> = {}): AgentStats {
  return {
    range: 'YTD',
    since: '2026-01-01',
    totals: {
      tokens: 1_000_000,
      input: 930_000,
      output: 70_000,
      cache_read: 710_000,
      fresh: 220_000,
      threads: 23,
      requests: 86,
      tool_calls: 312,
    },
    weeks: [
      { week: '2026-01-05', cache_read: 10_000, fresh: 4_000, output: 1_000 },
      { week: '2026-01-12', cache_read: 0, fresh: 0, output: 0 },
      { week: '2026-02-02', cache_read: 30_000, fresh: 9_000, output: 3_000 },
    ],
    models: [
      {
        model: 'claude-sonnet-5-5',
        provider: 'Anthropic',
        requests: 80,
        tokens: 950_000,
        cache_read: 710_000,
        cache_ratio: 0.74,
      },
      {
        model: 'qwen3:14b',
        provider: 'Ollama',
        requests: 6,
        tokens: 50_000,
        cache_read: 0,
        cache_ratio: null,
      },
    ],
    threads: [
      {
        id: 't1',
        title: 'Dividendes d’octobre',
        last_at: '2026-11-06T08:00:00+00:00',
        requests: 9,
        tokens: 186_000,
      },
    ],
    ...overrides,
  }
}
