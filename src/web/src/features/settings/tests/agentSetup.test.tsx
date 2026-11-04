/**
 * *L’agent* in Settings (#1115, #1279): the switch and the model on their rows,
 * the connection in a Sheet; the whole app in jsdom and HTTP the only faked edge.
 *
 * The rule the ticket asks a test of is the first one: **nothing is stored as
 * the agent's model until Tester la connexion succeeds** — for what is on
 * screen, so an edit after a pass takes it back. And since #1279: **changing
 * the model asks for no key**, and loading the page asks the provider nothing.
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
  // The rows stand on the agent's read: wait for them.
  await within(block).findByRole('switch', { name: 'Agent activé' })
  return { ...rendered, block }
}

/** Opens the provider's sheet from its row, whatever the row's button says. */
async function openSheet() {
  const rendered = await openAgent()
  await rendered.user.click(
    within(rendered.block).getByRole('button', { name: /^(Configurer|Changer)$/ }),
  )
  const sheet = await screen.findByRole('dialog', { name: 'Le fournisseur de l’agent' })
  return { ...rendered, sheet }
}

const enabled = (block: HTMLElement) => within(block).getByRole('switch', { name: 'Agent activé' })
const testButton = (sheet: HTMLElement) =>
  within(sheet).getByRole('button', { name: 'Tester la connexion' })
const saveButton = (sheet: HTMLElement) =>
  within(sheet).getByRole('button', { name: 'Enregistrer' })

const configured = (overrides: Partial<AgentConfig> = {}) =>
  anAgentConfig({
    provider: 'anthropic',
    model: 'claude-x',
    model_name: 'Claude X',
    key: { set: true, last4: 'abcd', set_at: null },
    ...overrides,
  })

describe('the agent section', () => {
  it('is off by default: the switch is disabled and « Configurer » leads', async () => {
    const writes = provider()
    const { block } = await openAgent()

    expect(enabled(block)).toBeDisabled()
    expect(enabled(block)).not.toBeChecked()
    expect(within(block).getByText('Aucun fournisseur configuré.')).toBeInTheDocument()
    expect(within(block).getByRole('button', { name: 'Configurer' })).toBeInTheDocument()
    expect(within(block).queryByRole('combobox', { name: 'Modèle' })).not.toBeInTheDocument()
    expect(writes).toEqual([])
  })

  it('keeps every control out of the gutter', async () => {
    provider(undefined, configured())
    const { block } = await openAgent()
    const gutter = block.querySelector('header') as HTMLElement

    expect(within(gutter).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(gutter).queryByRole('button')).not.toBeInTheDocument()
  })

  it('switches off and on from its first row, and says so there', async () => {
    const writes = provider(undefined, configured({ enabled: true }))
    const { user, block } = await openAgent()

    await user.click(enabled(block))

    await waitFor(() => expect(enabled(block)).not.toBeChecked())
    expect(await within(block).findByRole('status')).toHaveTextContent('✓ Enregistré')
    expect(writes).toEqual([['config', { enabled: false }]])
  })

  it('says a refused switch on its row', async () => {
    provider(undefined, configured())
    server.use(
      http.put(ROUTES.agentConfig, () =>
        HttpResponse.json(
          { status: 422, title: 'refused' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user, block } = await openAgent()

    await user.click(enabled(block))

    expect(await within(block).findByRole('alert')).toHaveTextContent('Non enregistré :')
    await waitFor(() => expect(enabled(block)).not.toBeChecked())
  })

  it('never shows the stored key, only its last four', async () => {
    provider(undefined, configured({ enabled: true }))
    const { block } = await openAgent()

    expect(within(block).getByText('Anthropic · clé …abcd')).toBeInTheDocument()
    expect(within(block).queryByText(/test-key/)).not.toBeInTheDocument()
  })
})

describe('the provider sheet', () => {
  it('stores nothing until the test passes, and sends one candidate', async () => {
    const writes = provider()
    const { user, sheet } = await openSheet()

    expect(testButton(sheet)).toBeDisabled()
    expect(saveButton(sheet)).toBeDisabled()

    await user.click(within(sheet).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(sheet).getByLabelText('Clé d’API'), KEY)
    expect(saveButton(sheet)).toBeDisabled()

    await user.click(testButton(sheet))

    expect(
      await within(sheet).findByText('Anthropic répond : 2 modèles disponibles.'),
    ).toBeInTheDocument()
    expect(saveButton(sheet)).toBeEnabled()
    // One test carrying the candidate — and nothing saved yet.
    expect(writes).toEqual([['test', { provider: 'anthropic', base_url: null, key: KEY }]])
  })

  it('sends the provider, the key and the address in one test, and nothing else', async () => {
    const writes = provider()
    const { user, sheet } = await openSheet()
    await user.click(within(sheet).getByRole('radio', { name: /passerelle/i }))
    await user.type(within(sheet).getByLabelText('Adresse'), 'http://litellm:4000')
    await user.type(within(sheet).getByLabelText(/Clé d’API/), KEY)
    await user.click(testButton(sheet))
    await within(sheet).findByLabelText('Modèle')

    expect(writes).toEqual([
      ['test', { provider: 'openai_compatible', base_url: 'http://litellm:4000', key: KEY }],
    ])
  })

  it('offers the provider’s models, preselects one, and the first save switches the agent on', async () => {
    const writes = provider()
    const { user, block, sheet } = await openSheet()
    await user.click(within(sheet).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(sheet).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(sheet))

    const model = await within(sheet).findByLabelText('Modèle')
    expect(model).toHaveValue('claude-new')
    expect(
      within(model)
        .getAllByRole('option')
        .map((one) => one.textContent),
    ).toEqual(['Claude New (claude-new)', 'Claude Old (claude-old)'])
    await user.selectOptions(model, 'claude-old')
    await user.click(saveButton(sheet))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes.at(-1)).toEqual([
      'config',
      { model: 'claude-old', model_name: 'Claude Old', enabled: true },
    ])
    expect(await screen.findByText('Fournisseur enregistré : Claude Old')).toBeInTheDocument()
    expect(enabled(block)).toBeChecked()
    expect(within(block).getByRole('combobox', { name: 'Modèle' })).toHaveTextContent('Claude Old')
  })

  it('leaves an agent that was off off when it saves another provider', async () => {
    const writes = provider(undefined, configured())
    const { user, block, sheet } = await openSheet()
    // The stored key is enough to test again.
    expect(testButton(sheet)).toBeEnabled()
    await user.click(testButton(sheet))
    await within(sheet).findByLabelText('Modèle')
    await user.click(saveButton(sheet))

    await waitFor(() =>
      expect(writes.at(-1)).toEqual(['config', { model: 'claude-new', model_name: 'Claude New' }]),
    )
    expect(enabled(block)).not.toBeChecked()
  })

  it('puts an agent that was on back on, after a test switched it off', async () => {
    const writes = provider(undefined, configured({ enabled: true }))
    const { user, sheet } = await openSheet()
    await user.click(testButton(sheet))
    await within(sheet).findByLabelText('Modèle')
    await user.click(saveButton(sheet))

    await waitFor(() =>
      expect(writes.at(-1)).toEqual([
        'config',
        { model: 'claude-new', model_name: 'Claude New', enabled: true },
      ]),
    )
  })

  it('says a refused key in a sentence, keeps the raw message folded, and saves nothing', async () => {
    const writes = provider(() => refuses('key'))
    const { user, sheet } = await openSheet()
    await user.click(within(sheet).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(sheet).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(sheet))

    const alert = await within(sheet).findByRole('alert')
    expect(alert).toHaveTextContent(
      'Anthropic refuse cette clé : vérifiez qu’elle est complète et toujours active.',
    )
    expect(within(sheet).queryByText('invalid x-api-key')).not.toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: 'Message brut (Anthropic)' }))
    expect(within(sheet).getByText('invalid x-api-key')).toBeVisible()
    expect(within(sheet).queryByText(/garder la clé/)).not.toBeInTheDocument()
    expect(saveButton(sheet)).toBeDisabled()
    expect(writes.filter(([kind]) => kind === 'config')).toEqual([])
  })

  it('says a configuration changed during the test as such, and keeps what was typed', async () => {
    provider(() =>
      HttpResponse.json(
        { type: PROBLEM_TYPES.conflict, title: 'Conflict', status: 409, detail: 'changed' },
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    )
    const { user, sheet } = await openSheet()
    await user.click(within(sheet).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(sheet).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(sheet))

    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'La configuration de l’agent a changé pendant le test : testez de nouveau.',
    )
    expect(within(sheet).getByLabelText('Clé d’API')).toHaveValue(KEY)
  })

  it('drops the answer of a test the reader edited the form under', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    provider(async (candidate, row) => {
      await gate
      return passes(candidate, row)
    })
    const { user, sheet } = await openSheet()
    await user.click(within(sheet).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(sheet).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(sheet))
    // Edited while the provider is still answering.
    await user.type(within(sheet).getByLabelText('Clé d’API'), 'x')
    release()

    await waitFor(() => expect(within(sheet).getByLabelText('Clé d’API')).toHaveValue(`${KEY}x`))
    expect(within(sheet).queryByLabelText('Modèle')).not.toBeInTheDocument()
    expect(saveButton(sheet)).toBeDisabled()
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
    const { user, sheet } = await openSheet()
    await user.click(within(sheet).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(sheet).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(sheet))

    expect(await within(sheet).findByRole('alert')).toHaveTextContent(sentence)
  })

  it('keeps the stored provider after a failed test on another one', async () => {
    provider(() => refuses('key', 'OpenAI: invalid key'), configured())
    const { user, block, sheet } = await openSheet()

    await user.click(within(sheet).getByRole('radio', { name: /modèles GPT/ }))
    await user.type(within(sheet).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(sheet))

    await within(sheet).findByRole('alert')
    expect(saveButton(sheet)).toBeDisabled()
    await user.click(within(sheet).getByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(within(block).getByText('Anthropic · clé …abcd')).toBeInTheDocument()
    expect(enabled(block)).toBeEnabled()
  })

  it('takes the pass back when the key is edited after it', async () => {
    provider()
    const { user, sheet } = await openSheet()
    await user.click(within(sheet).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(sheet).getByLabelText('Clé d’API'), KEY)
    await user.click(testButton(sheet))
    await within(sheet).findByLabelText('Modèle')
    expect(saveButton(sheet)).toBeEnabled()

    await user.type(within(sheet).getByLabelText('Clé d’API'), 'x')

    expect(saveButton(sheet)).toBeDisabled()
    expect(within(sheet).queryByLabelText('Modèle')).not.toBeInTheDocument()
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
      configured(),
    )
    const { user, sheet } = await openSheet()
    await user.click(within(sheet).getByRole('radio', { name: /Ollama/ }))

    expect(within(sheet).queryByLabelText(/Clé d’API/)).not.toBeInTheDocument()
    expect(within(sheet).getByLabelText('Adresse')).toHaveValue('http://localhost:11434')
    await user.click(testButton(sheet))

    expect(
      await within(sheet).findByText(
        'Ollama sur cette machine répond, mais ne propose aucun modèle.',
      ),
    ).toBeInTheDocument()
    expect(saveButton(sheet)).toBeDisabled()
    expect(writes).toEqual([['test', { provider: 'ollama', base_url: 'http://localhost:11434' }]])
  })

  it('shows the stored key by its last four, and offers to keep it', async () => {
    provider(undefined, configured({ enabled: true }))
    const { sheet } = await openSheet()

    expect(within(sheet).getByLabelText('Clé d’API')).toHaveValue('')
    expect(within(sheet).getByLabelText('Clé d’API')).toHaveAttribute('placeholder', '…abcd')
    expect(within(sheet).getByText('Laissez vide pour garder la clé …abcd.')).toBeInTheDocument()
    expect(testButton(sheet)).toBeEnabled()
  })

  it('asks for the key again once the address changes', async () => {
    provider(
      undefined,
      configured({ provider: 'openai_compatible', base_url: 'http://litellm:4000' }),
    )
    const { user, sheet } = await openSheet()
    const key = within(sheet).getByLabelText(/Clé d’API/)
    expect(key).toHaveAttribute('placeholder', '…abcd')

    await user.type(within(sheet).getByLabelText('Adresse'), '/v1')

    expect(key).not.toHaveAttribute('placeholder')
  })

  it('starts again from the store at every opening', async () => {
    provider(undefined, configured())
    const { user, block, sheet } = await openSheet()
    await user.type(within(sheet).getByLabelText('Clé d’API'), KEY)
    await user.click(within(sheet).getByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(within(block).getByRole('button', { name: 'Changer' }))
    const again = await screen.findByRole('dialog')
    expect(within(again).getByLabelText('Clé d’API')).toHaveValue('')
  })

  it('gives the focus back to « Changer » when it closes', async () => {
    provider(undefined, configured())
    const { user, block } = await openSheet()

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() =>
      expect(within(block).getByRole('button', { name: 'Changer' })).toHaveFocus(),
    )
  })
})

describe('the model row (#1279)', () => {
  it('asks the provider nothing until the select opens, then once, with no key', async () => {
    const writes = provider(undefined, configured({ enabled: true }))
    const { user, block } = await openAgent()
    const model = within(block).getByRole('combobox', { name: 'Modèle' })
    expect(model).toHaveTextContent('Claude X')
    expect(writes).toEqual([])

    await user.click(model)
    await user.click(await screen.findByRole('option', { name: 'Claude Old' }))

    await waitFor(() =>
      expect(writes).toEqual([
        ['test', {}],
        ['config', { model: 'claude-old', model_name: 'Claude Old' }],
      ]),
    )
    expect(await within(block).findByText('✓ Enregistré')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Clé d’API/)).not.toBeInTheDocument()

    // Asked once: a second opening reads the list it already has.
    await user.click(model)
    await screen.findByRole('option', { name: 'Claude New' })
    expect(writes.filter(([kind]) => kind === 'test')).toHaveLength(1)
  })

  it('says on its row when the provider refuses to list the models', async () => {
    provider(() => refuses('quota'), configured())
    const { user, block } = await openAgent()

    await user.click(within(block).getByRole('combobox', { name: 'Modèle' }))

    expect(await within(block).findByRole('alert')).toHaveTextContent(
      'Anthropic refuse faute de crédit',
    )
  })
})

describe('the thinking level (#1191)', () => {
  it('is written at once and alone, with no test run', async () => {
    const writes = provider(undefined, configured({ enabled: true }))
    const { user, block } = await openAgent()
    const level = within(block).getByRole('combobox', { name: 'Réflexion' })
    expect(level).toHaveTextContent('Légère')

    await user.click(level)
    expect(screen.getAllByRole('option').map((one) => one.textContent)).toEqual([
      'Légère',
      'Moyenne',
      'Approfondie',
    ])
    await user.click(screen.getByRole('option', { name: 'Approfondie' }))

    await waitFor(() => expect(level).toHaveTextContent('Approfondie'))
    expect(writes).toEqual([['config', { thinking: 'high' }]])
    // The agent stays on: the write carried no `enabled`.
    expect(enabled(block)).toBeChecked()
  })

  it('is not offered until a model is stored', async () => {
    provider()
    const { block } = await openAgent()

    expect(within(block).queryByRole('combobox', { name: 'Réflexion' })).not.toBeInTheDocument()
  })
})
