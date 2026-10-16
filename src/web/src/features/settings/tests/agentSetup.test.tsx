/**
 * *L’agent* in Settings (#1115): switching it on in four steps, the whole
 * app in jsdom and HTTP the only faked edge.
 *
 * The rule the ticket asks a test of is the first one: **The switch stays
 * disabled until Tester la connexion succeeds** — for what is on screen, so an
 * edit after a pass takes it back.
 */
import { screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { AgentConfig, AgentConfigDraft } from '@/features/agent/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { anAgentConfig } from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const KEY = 'test-key-0123456789abcd'

/** A provider and a store, faked together; every write is kept, in order. */
function provider(
  test: () => Response | Promise<Response> = () =>
    HttpResponse.json({
      provider: 'anthropic',
      models: [
        { id: 'claude-new', name: 'Claude New' },
        { id: 'claude-old', name: 'Claude Old' },
      ],
      preselected: 'claude-new',
    }),
  initial: AgentConfig = anAgentConfig(),
) {
  let row = initial
  const writes: [string, unknown][] = []
  server.use(
    http.get(ROUTES.agentConfig, () => HttpResponse.json(row)),
    http.put(ROUTES.agentConfig, async ({ request }) => {
      const body = (await request.json()) as AgentConfigDraft
      writes.push(['config', body])
      // A key belongs to its provider and its address (#1197).
      const moved = (['provider', 'base_url'] as const).some(
        (name) => name in body && body[name] !== row[name],
      )
      row = {
        ...row,
        ...body,
        ...(moved ? { key: { set: false, last4: null, set_at: null } } : {}),
      }
      return HttpResponse.json(row)
    }),
    http.put(ROUTES.agentKey, async ({ request }) => {
      const body = (await request.json()) as { key: string }
      writes.push(['key', body.key])
      row = { ...row, key: { set: true, last4: body.key.slice(-4), set_at: null } }
      return HttpResponse.json(row)
    }),
    http.post(ROUTES.agentTest, () => {
      writes.push(['test', null])
      return test()
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
    // The provider, the key, then the test — and nothing switched on yet.
    expect(writes).toEqual([
      ['config', { provider: 'anthropic' }],
      ['key', KEY],
      ['test', null],
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
    await user.click(activate(block))

    expect(await within(block).findByText('Actif : Anthropic, claude-old.')).toBeInTheDocument()
    expect(writes.at(-1)).toEqual(['config', { model: 'claude-old', enabled: true }])
  })

  it('says a failed test in the provider’s own words, and keeps the switch disabled', async () => {
    provider(() =>
      HttpResponse.json(
        {
          type: PROBLEM_TYPES.providerRefused,
          title: 'Provider refused',
          status: 502,
          detail: 'Anthropic: invalid x-api-key',
          provider: 'Anthropic',
          reason: 'refused',
        },
        { status: 502, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    )
    const { user, block } = await openAgent()
    await user.click(within(block).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(block).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(block))

    const alert = await within(block).findByRole('alert')
    expect(alert).toHaveTextContent('Anthropic a refusé la connexion :')
    expect(alert).toHaveTextContent('invalid x-api-key')
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
      () => HttpResponse.json({ provider: 'ollama', models: [], preselected: null }),
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
    expect(writes).toEqual([
      ['config', { provider: 'ollama', base_url: 'http://localhost:11434' }],
      ['test', null],
    ])
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
