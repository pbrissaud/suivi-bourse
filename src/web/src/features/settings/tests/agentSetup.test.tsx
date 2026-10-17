/**
 * *L’agent* in Settings (#1115): switching it on in four steps, the whole
 * app in jsdom and HTTP the only faked edge.
 *
 * The rule the ticket asks a test of is the first one: **The switch stays
 * disabled until Tester la connexion succeeds** — for what is on screen, so an
 * edit after a pass takes it back.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type {
  AgentCandidate,
  AgentConfig,
  AgentConfigDraft,
  AgentTestResult,
} from '@/features/agent/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { anAgentConfig } from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const KEY = 'test-key-0123456789abcd'

/** The server's answer to a passed test: the models, and what it now stores. */
const passes = (candidate: AgentCandidate, row: AgentConfig) =>
  HttpResponse.json({
    provider: candidate.provider,
    models: [
      { id: 'claude-new', name: 'Claude New' },
      { id: 'claude-old', name: 'Claude Old' },
    ],
    preselected: 'claude-new',
    config: {
      ...row,
      provider: candidate.provider ?? row.provider,
      base_url: candidate.base_url ?? null,
      enabled: false,
      key: candidate.key ? { set: true, last4: candidate.key.slice(-4), set_at: null } : row.key,
    },
  })

/** A refusal as the server answers it: 502, the provider's words in `detail`. */
const refuses = (reason: string, detail = 'Anthropic: invalid x-api-key') =>
  HttpResponse.json(
    {
      type: PROBLEM_TYPES.providerRefused,
      title: 'Provider refused',
      status: 502,
      detail,
      provider: 'Anthropic',
      reason,
    },
    { status: 502, headers: { 'Content-Type': 'application/problem+json' } },
  )

/** A provider and a store, faked together; every write is kept, in order. */
function provider(
  test: (candidate: AgentCandidate, row: AgentConfig) => Response | Promise<Response> = passes,
  initial: AgentConfig = anAgentConfig(),
) {
  let row = initial
  const writes: [string, unknown][] = []
  server.use(
    http.get(ROUTES.agentConfig, () => HttpResponse.json(row)),
    http.put(ROUTES.agentConfig, async ({ request }) => {
      const body = (await request.json()) as AgentConfigDraft
      writes.push(['config', body])
      row = { ...row, ...body }
      return HttpResponse.json(row)
    }),
    http.post(ROUTES.agentTest, async ({ request }) => {
      const candidate = (await request.json()) as AgentCandidate
      writes.push(['test', candidate])
      const answer = await test(candidate, row)
      // Only a pass is stored, as the server does.
      if (answer.ok) row = ((await answer.clone().json()) as AgentTestResult).config
      return answer
    }),
  )
  return writes
}

async function openAgent() {
  const rendered = renderApp({ url: '/settings' })
  const block = await screen.findByRole('region', { name: 'L’agent' })
  return { ...rendered, block }
}

const activate = (block: HTMLElement) =>
  within(block).getByRole('switch', { name: 'Activer l’agent' })
const testButton = (block: HTMLElement) =>
  within(block).getByRole('button', { name: 'Tester la connexion' })

describe('switching the agent on', () => {
  it('is off by default, and the switch stays disabled until the test passes', async () => {
    const writes = provider()
    const { user, block } = await openAgent()

    expect(within(block).queryByText(/^Actif/)).not.toBeInTheDocument()
    expect(activate(block)).toBeDisabled()
    expect(testButton(block)).toBeDisabled()

    await user.click(within(block).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(block).getByLabelText('Clé d’API'), KEY)
    expect(activate(block)).toBeDisabled()

    await user.click(testButton(block))

    expect(
      await within(block).findByText('Anthropic répond : 2 modèles disponibles.'),
    ).toBeInTheDocument()
    expect(activate(block)).toBeEnabled()
    // One test carrying the candidate — and nothing switched on yet.
    expect(writes).toEqual([['test', { provider: 'anthropic', base_url: null, key: KEY }]])
  })

  it('sends the provider, the key and the address in one test, and nothing else', async () => {
    const writes = provider()
    const { user, block } = await openAgent()
    await user.click(within(block).getByRole('radio', { name: /passerelle/i }))
    await user.type(within(block).getByLabelText('Adresse'), 'http://litellm:4000')
    await user.type(within(block).getByLabelText(/Clé d’API/), KEY)
    await user.click(testButton(block))
    await within(block).findByLabelText('Modèle')

    expect(writes).toEqual([
      ['test', { provider: 'openai_compatible', base_url: 'http://litellm:4000', key: KEY }],
    ])
  })

  it('offers the provider’s models, preselects one, and switches on with it', async () => {
    const writes = provider()
    const { user, block } = await openAgent()
    await user.click(within(block).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(block).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(block))

    const model = await within(block).findByLabelText('Modèle')
    expect(model).toHaveValue('claude-new')
    expect(
      within(model)
        .getAllByRole('option')
        .map((one) => one.textContent),
    ).toEqual(['Claude New (claude-new)', 'Claude Old (claude-old)'])
    await user.selectOptions(model, 'claude-old')
    await user.click(within(block).getByRole('button', { name: 'Activer l’agent' }))

    expect(await within(block).findByText('Actif : Anthropic, Claude Old.')).toBeInTheDocument()
    expect(writes.at(-1)).toEqual([
      'config',
      { model: 'claude-old', model_name: 'Claude Old', enabled: true },
    ])
  })

  it('offers Activer l’agent where Prêt was said, and confirms with a receipt', async () => {
    const writes = provider()
    const { user, block, router } = await openAgent()
    expect(within(block).queryByRole('button', { name: 'Activer l’agent' })).not.toBeInTheDocument()
    await user.click(within(block).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(block).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(block))

    await user.click(await within(block).findByRole('button', { name: 'Activer l’agent' }))

    expect(writes.at(-1)).toEqual([
      'config',
      { model: 'claude-new', model_name: 'Claude New', enabled: true },
    ])
    expect(await screen.findByText('Agent activé : Claude New')).toBeInTheDocument()
    // Switched on: the button gives way to the state.
    expect(within(block).queryByRole('button', { name: 'Activer l’agent' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ouvrir l’agent' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agent'))
  })

  it('confirms switching off with a receipt', async () => {
    provider(
      undefined,
      anAgentConfig({
        provider: 'anthropic',
        model: 'claude-x',
        enabled: true,
        key: { set: true, last4: 'abcd', set_at: null },
      }),
    )
    const { user, block } = await openAgent()

    await user.click(activate(block))

    expect(await screen.findByText('Agent désactivé')).toBeInTheDocument()
  })

  it('shows the model’s name in the active line', async () => {
    provider(
      undefined,
      anAgentConfig({
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        model_name: 'Claude Sonnet 5.5',
        enabled: true,
        key: { set: true, last4: 'abcd', set_at: null },
      }),
    )
    const { block } = await openAgent()

    expect(within(block).getByText('Actif : Anthropic, Claude Sonnet 5.5.')).toBeInTheDocument()
  })

  it('says a refused key in a sentence, keeps the raw message folded, and never says it is saved', async () => {
    provider(() => refuses('key'))
    const { user, block } = await openAgent()
    await user.click(within(block).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(block).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(block))

    const alert = await within(block).findByRole('alert')
    expect(alert).toHaveTextContent(
      'Anthropic refuse cette clé : vérifiez qu’elle est complète et toujours active.',
    )
    expect(within(block).queryByText('invalid x-api-key')).not.toBeInTheDocument()
    await user.click(within(block).getByRole('button', { name: 'Message de Anthropic' }))
    expect(within(block).getByText('invalid x-api-key')).toBeVisible()
    expect(within(block).queryByText(/est enregistrée/)).not.toBeInTheDocument()
    expect(activate(block)).toBeDisabled()
  })

  it.each([
    ['key', 'Anthropic refuse cette clé'],
    ['quota', 'Anthropic refuse faute de crédit'],
    ['rate_limit', 'Anthropic limite le nombre de requêtes'],
    ['address', 'Aucune liste de modèles à cette adresse'],
    ['overloaded', 'Anthropic est momentanément indisponible'],
    ['unreachable', 'Ce serveur ne joint pas Anthropic'],
    ['unreadable', 'Anthropic a répondu, mais pas par une liste de modèles'],
    ['refused', 'Anthropic a refusé la connexion.'],
  ])('translates each refusal reason (%s)', async (reason, sentence) => {
    provider(() => refuses(reason))
    const { user, block } = await openAgent()
    await user.click(within(block).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(block).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(block))

    expect(await within(block).findByRole('alert')).toHaveTextContent(sentence)
  })

  it('does not switch the stored model back on after a failed test on another provider', async () => {
    provider(
      () => refuses('key', 'OpenAI: invalid key'),
      anAgentConfig({
        provider: 'anthropic',
        model: 'claude-x',
        key: { set: true, last4: 'abcd', set_at: null },
      }),
    )
    const { user, block } = await openAgent()
    expect(activate(block)).toBeEnabled()

    await user.click(within(block).getByRole('radio', { name: /modèles GPT/ }))
    await user.type(within(block).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(block))

    await within(block).findByRole('alert')
    expect(activate(block)).toBeDisabled()
  })

  it('takes the pass back when the key is edited after it', async () => {
    provider()
    const { user, block } = await openAgent()
    await user.click(within(block).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(block).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(block))
    await within(block).findByLabelText('Modèle')
    expect(activate(block)).toBeEnabled()

    await user.type(within(block).getByLabelText('Clé d’API'), 'x')

    expect(activate(block)).toBeDisabled()
    expect(within(block).queryByLabelText('Modèle')).not.toBeInTheDocument()
  })

  it('asks Ollama for an address and no key', async () => {
    const writes = provider(
      (candidate, row) =>
        HttpResponse.json({
          provider: 'ollama',
          models: [],
          preselected: null,
          config: { ...row, provider: 'ollama', base_url: candidate.base_url ?? null },
        }),
      anAgentConfig({
        provider: 'anthropic',
        model: 'claude-x',
        key: { set: true, last4: 'abcd', set_at: null },
      }),
    )
    const { user, block } = await openAgent()
    await user.click(within(block).getByRole('radio', { name: /Ollama/ }))

    expect(within(block).queryByLabelText(/Clé d’API/)).not.toBeInTheDocument()
    expect(within(block).getByLabelText('Adresse')).toHaveValue('http://localhost:11434')
    await user.click(testButton(block))

    expect(
      await within(block).findByText(
        'Ollama sur cette machine répond, mais ne propose aucun modèle.',
      ),
    ).toBeInTheDocument()
    expect(activate(block)).toBeDisabled()
    expect(writes).toEqual([['test', { provider: 'ollama', base_url: 'http://localhost:11434' }]])
  })

  it('never shows the stored key, only its last four', async () => {
    provider(
      undefined,
      anAgentConfig({
        provider: 'anthropic',
        model: 'claude-x',
        enabled: true,
        key: { set: true, last4: 'abcd', set_at: null },
      }),
    )
    const { block } = await openAgent()

    expect(within(block).getByText('Actif : Anthropic, claude-x.')).toBeInTheDocument()
    expect(within(block).getByLabelText('Clé d’API')).toHaveValue('')
    expect(within(block).getByLabelText('Clé d’API')).toHaveAttribute('placeholder', '…abcd')
    // A stored key for the chosen provider is enough to test again.
    expect(testButton(block)).toBeEnabled()
  })
  it('asks for the key again once the address changes', async () => {
    provider(
      undefined,
      anAgentConfig({
        provider: 'openai_compatible',
        base_url: 'http://litellm:4000',
        key: { set: true, last4: 'abcd', set_at: null },
      }),
    )
    const { user, block } = await openAgent()
    const key = within(block).getByLabelText(/Clé d’API/)
    expect(key).toHaveAttribute('placeholder', '…abcd')

    await user.type(within(block).getByLabelText('Adresse'), '/v1')

    expect(key).not.toHaveAttribute('placeholder')
  })
})
