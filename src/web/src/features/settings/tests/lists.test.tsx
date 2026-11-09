/**
 * The lists inside Settings: access tokens, agent providers and notification
 * channels — ruled rows, a side panel to make or change one, a confirmation to
 * remove one.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { type AccessToken, type AgentProvider, type NotificationChannel, ROUTES } from '@/lib/api'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const token = (overrides: Partial<AccessToken> = {}): AccessToken => ({
  id: 't1',
  label: 'Claude Desktop',
  scopes: ['mcp'],
  prefix: 'a1b2c3d4',
  lifetime: '1y',
  created_at: '2026-11-01T08:00:00+00:00',
  expires_at: '2027-11-01T08:00:00+00:00',
  last_used_at: null,
  ...overrides,
})

const provider = (overrides: Partial<AgentProvider> = {}): AgentProvider => ({
  id: 'p1',
  label: null,
  kind: 'anthropic',
  base_url: null,
  default_model: 'claude-sonnet-4-5',
  is_default: true,
  last_test_at: null,
  key: { set: true, last4: '9f2a', set_at: '2026-11-01T08:00:00+00:00' },
  privacy: { local: false, fr: '', en: '' },
  ...overrides,
})

const channel = (overrides: Partial<NotificationChannel> = {}): NotificationChannel => ({
  id: 'c1',
  kind: 'ntfy',
  target: 'https://ntfy.sh/suivi',
  options: {},
  scopes: ['late_price', 'job_failed'],
  enabled: true,
  has_secret: false,
  secret_last4: null,
  available: true,
  created_at: '2026-11-01T08:00:00+00:00',
  ...overrides,
})

const withCode = () =>
  server.use(
    http.get(ROUTES.authStatus, () =>
      HttpResponse.json({ enabled: true, authenticated: true, session_seconds: 2592000 }),
    ),
  )

describe('the access tokens', () => {
  it('lists each with its scope, its public prefix and its last use, Régénérer and Révoquer', async () => {
    withCode()
    server.use(
      http.get(ROUTES.tokens, () =>
        HttpResponse.json({
          tokens: [
            token(),
            token({
              id: 't2',
              label: 'Script',
              scopes: ['api'],
              last_used_at: '2026-11-03T08:00:00+00:00',
            }),
          ],
        }),
      ),
    )
    renderApp({ url: '/settings' })

    const list = await screen.findByRole('list', { name: /Jetons d’accès/ })
    await within(list).findByText('Script')
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Claude Desktop')
    expect(rows[0]).toHaveTextContent('MCP · sb_a1b2c3d4… · jamais utilisé')
    expect(rows[1]).toHaveTextContent('API · sb_a1b2c3d4… · utilisé le 3 nov. 2026')
    expect(within(rows[0]).getByRole('button', { name: 'Régénérer Claude Desktop' })).toBeVisible()
    expect(within(rows[0]).getByRole('button', { name: 'Révoquer Claude Desktop' })).toBeVisible()
  })

  it('makes a token, shows its secret once with the two snippets, and closes on « J’ai copié le jeton »', async () => {
    withCode()
    let sent: unknown = null
    server.use(
      http.post(ROUTES.tokens, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(
          {
            token: token({ label: 'Script', scopes: ['api', 'mcp'] }),
            secret: 'jeton-de-test',
          },
          { status: 201 },
        )
      }),
    )
    const { user } = renderApp({ url: '/settings' })

    await user.click(await screen.findByRole('button', { name: 'Créer un jeton' }))
    const sheet = await screen.findByRole('dialog', { name: 'Créer un jeton d’accès' })
    const create = within(sheet).getByRole('button', { name: 'Créer le jeton' })
    expect(create).toBeDisabled()
    await user.type(within(sheet).getByLabelText('Libellé'), 'Script')
    await user.click(within(sheet).getByRole('radio', { name: 'Jamais' }))
    await user.click(create)

    await waitFor(() =>
      expect(sent).toEqual({ label: 'Script', scopes: ['api', 'mcp'], expires: 'never' }),
    )
    const shown = await screen.findByRole('dialog', { name: 'Votre jeton d’accès' })
    expect(within(shown).getByText('jeton-de-test')).toBeInTheDocument()
    expect(
      within(shown).getByText('Il ne sera plus affiché. Perdu, il se régénère depuis Réglages.'),
    ).toBeInTheDocument()
    expect(shown).toHaveTextContent(`Authorization: Bearer jeton-de-test`)
    expect(shown).toHaveTextContent(`${window.location.origin}/api/positions`)

    await user.click(within(shown).getByRole('button', { name: 'J’ai copié le jeton' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByText('jeton-de-test')).not.toBeInTheDocument()
  })

  it('revokes through the confirmation', async () => {
    withCode()
    const removed: string[] = []
    server.use(
      http.get(ROUTES.tokens, () => HttpResponse.json({ tokens: [token()] })),
      http.delete(ROUTES.token, ({ params }) => {
        removed.push(String(params.id))
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderApp({ url: '/settings' })

    await user.click(await screen.findByRole('button', { name: 'Révoquer Claude Desktop' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Révoquer Claude Desktop ?' })
    expect(confirm).toHaveTextContent('Immédiat.')
    await user.click(within(confirm).getByRole('button', { name: 'Révoquer' }))

    await waitFor(() => expect(removed).toEqual(['t1']))
  })

  it('regenerates through the confirmation, and shows the new secret once', async () => {
    withCode()
    server.use(
      http.get(ROUTES.tokens, () => HttpResponse.json({ tokens: [token()] })),
      http.post(ROUTES.tokenRegenerate, () =>
        HttpResponse.json({ token: token(), secret: 'jeton-de-test-neuf' }),
      ),
    )
    const { user } = renderApp({ url: '/settings' })

    await user.click(await screen.findByRole('button', { name: 'Régénérer Claude Desktop' }))
    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: 'Régénérer' }))

    const shown = await screen.findByRole('dialog', { name: 'Votre jeton d’accès' })
    expect(within(shown).getByText('jeton-de-test-neuf')).toBeInTheDocument()
  })
})

describe('the providers', () => {
  it('lists them with « Par défaut » and one « Modifier » each', async () => {
    server.use(
      http.get(ROUTES.agentProviders, () =>
        HttpResponse.json([provider(), provider({ id: 'p2', kind: 'ollama', is_default: false })]),
      ),
    )
    renderApp({ url: '/settings' })

    const list = await screen.findByRole('list', { name: 'Fournisseurs' })
    const rows = await within(list).findAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Anthropic')
    expect(rows[0]).toHaveTextContent('Par défaut')
    expect(rows[1]).toHaveTextContent('Ollama')
    expect(rows[1]).not.toHaveTextContent('Par défaut')
    expect(within(list).getByRole('button', { name: 'Ajouter un fournisseur' })).toBeVisible()
  })

  it('tests a new provider, picks the preselected model, and saves it as the default', async () => {
    const bodies: unknown[] = []
    server.use(
      http.post(ROUTES.agentProviderTest, () =>
        HttpResponse.json({
          models: [
            { id: 'claude-a', name: 'Claude A' },
            { id: 'claude-b', name: 'Claude B' },
          ],
          preselected: 'claude-b',
          elapsed_ms: 1200,
        }),
      ),
      http.post(ROUTES.agentProviders, async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json(provider(), { status: 201 })
      }),
    )
    const { user } = renderApp({ url: '/settings' })

    await user.click(await screen.findByRole('button', { name: 'Ajouter un fournisseur' }))
    const sheet = await screen.findByRole('dialog', { name: 'Ajouter un fournisseur' })
    expect(
      within(sheet).getByText(/Vos lignes, vos comptes et votre grand livre sont envoyés/),
    ).toBeInTheDocument()
    await user.type(within(sheet).getByLabelText('Clé API'), 'test-key-example')
    await user.click(within(sheet).getByRole('button', { name: 'Tester' }))

    expect(
      await within(sheet).findByText(/Répond en 1,2 s · 2 modèles disponibles/),
    ).toBeInTheDocument()
    expect(within(sheet).getByLabelText('Modèle')).toHaveValue('claude-b')
    await user.click(within(sheet).getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() =>
      expect(bodies).toEqual([
        {
          kind: 'anthropic',
          base_url: null,
          key: 'test-key-example',
          label: null,
          default_model: 'claude-b',
        },
      ]),
    )
  })

  it('says Ollama keeps everything on this server, and asks no key', async () => {
    const { user } = renderApp({ url: '/settings' })

    await user.click(await screen.findByRole('button', { name: 'Ajouter un fournisseur' }))
    const sheet = await screen.findByRole('dialog', { name: 'Ajouter un fournisseur' })
    await user.click(within(sheet).getByRole('tab', { name: 'Ollama' }))

    expect(within(sheet).getByText('Tout reste sur ce serveur.')).toBeInTheDocument()
    expect(within(sheet).queryByLabelText('Clé API')).not.toBeInTheDocument()
    expect(within(sheet).getByLabelText('Adresse du service')).toHaveValue('http://localhost:11434')
  })

  it('deletes a provider through the confirmation', async () => {
    const removed: string[] = []
    server.use(
      http.get(ROUTES.agentProviders, () => HttpResponse.json([provider()])),
      http.delete(ROUTES.agentProvider, ({ params }) => {
        removed.push(String(params.id))
        return HttpResponse.json({ id: 'p1', removed: true, disabled: false })
      }),
    )
    const { user } = renderApp({ url: '/settings' })

    await user.click(await screen.findByRole('button', { name: 'Modifier Anthropic' }))
    const sheet = await screen.findByRole('dialog', { name: 'Anthropic' })
    await user.click(within(sheet).getByRole('button', { name: 'Supprimer ce fournisseur' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm).toHaveTextContent('Irréversible.')
    await user.click(within(confirm).getByRole('button', { name: 'Supprimer' }))

    await waitFor(() => expect(removed).toEqual(['p1']))
  })

  it('disables the agent switch until a provider exists, and says why', async () => {
    server.use(http.get(ROUTES.agentProviders, () => HttpResponse.json([])))
    renderApp({ url: '/settings' })

    expect(await screen.findByRole('switch', { name: 'Agent activé' })).toBeDisabled()
    expect(screen.getByText('Ajoutez d’abord un fournisseur')).toBeInTheDocument()
  })

  it('saves the agent switch on change and the reasoning level', async () => {
    const writes: unknown[] = []
    server.use(
      http.get(ROUTES.agentProviders, () => HttpResponse.json([provider()])),
      http.get(ROUTES.agentConfig, () =>
        HttpResponse.json({ enabled: false, reasoning: 'medium' }),
      ),
      http.put(ROUTES.agentConfig, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        writes.push(body)
        return HttpResponse.json({ enabled: false, reasoning: 'medium', ...body })
      }),
    )
    const { user } = renderApp({ url: '/settings' })

    await user.click(await screen.findByRole('switch', { name: 'Agent activé' }))
    await waitFor(() => expect(writes).toEqual([{ enabled: true }]))
    await user.click(screen.getByRole('radio', { name: 'Longue' }))
    await waitFor(() => expect(writes).toEqual([{ enabled: true }, { reasoning: 'high' }]))
  })
})

describe('the notification channels', () => {
  it('lists each with its address and the notices it carries, Tester and Modifier', async () => {
    server.use(http.get(ROUTES.notificationChannels, () => HttpResponse.json([channel()])))
    renderApp({ url: '/settings' })

    const list = await screen.findByRole('list', { name: 'Canaux' })
    const row = (await within(list).findAllByRole('listitem'))[0]
    expect(row).toHaveTextContent('ntfy')
    expect(row).toHaveTextContent('https://ntfy.sh/suivi')
    expect(row).toHaveTextContent('Cours en retard, Erreurs')
    expect(within(row).getByRole('button', { name: 'Tester ntfy' })).toBeVisible()
    expect(within(row).getByRole('button', { name: 'Modifier ntfy' })).toBeVisible()
  })

  it('tests a channel, and says a refusal', async () => {
    let refuse = false
    let calls = 0
    server.use(
      http.get(ROUTES.notificationChannels, () => HttpResponse.json([channel()])),
      http.post(ROUTES.notificationChannelTest, () =>
        (calls += 1) && refuse
          ? HttpResponse.json(
              { type: '/problems/channel-refused', title: 'Refused', status: 502 },
              { status: 502, headers: { 'Content-Type': 'application/problem+json' } },
            )
          : HttpResponse.json({ ok: true }),
      ),
    )
    const { user } = renderApp({ url: '/settings' })

    await user.click(await screen.findByRole('button', { name: 'Tester ntfy' }))
    expect(await screen.findByText('Message de test envoyé')).toBeInTheDocument()

    refuse = true
    await user.click(screen.getByRole('button', { name: 'Tester ntfy' }))
    await waitFor(() => expect(calls).toBe(2))
  })

  it('adds an e-mail channel with its server, and sends the secret only when typed', async () => {
    const bodies: unknown[] = []
    server.use(
      http.post(ROUTES.notificationChannels, async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json(channel({ kind: 'email' }), { status: 201 })
      }),
    )
    const { user } = renderApp({ url: '/settings' })

    await user.click(await screen.findByRole('button', { name: /Ajouter un canal/ }))
    const sheet = await screen.findByRole('dialog', { name: 'Ajouter un canal' })
    await user.click(within(sheet).getByRole('tab', { name: 'E-mail' }))
    await user.type(within(sheet).getByLabelText('Destinataire'), 'paul@example.org')
    await user.type(within(sheet).getByLabelText('Serveur SMTP'), 'smtp.example.org')
    await user.type(within(sheet).getByLabelText('Expéditeur'), 'bourse@example.org')
    await user.click(within(sheet).getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({
      kind: 'email',
      target: 'paul@example.org',
      options: { host: 'smtp.example.org', sender: 'bourse@example.org', starttls: true },
      scopes: ['late_price', 'update_available', 'job_failed'],
    })
    expect(bodies[0]).not.toHaveProperty('secret')
  })

  it('removes a channel through the confirmation', async () => {
    const removed: string[] = []
    server.use(
      http.get(ROUTES.notificationChannels, () => HttpResponse.json([channel()])),
      http.delete(ROUTES.notificationChannel, ({ params }) => {
        removed.push(String(params.id))
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderApp({ url: '/settings' })

    await user.click(await screen.findByRole('button', { name: 'Modifier ntfy' }))
    const sheet = await screen.findByRole('dialog', { name: 'ntfy' })
    await user.click(within(sheet).getByRole('button', { name: 'Supprimer ce canal' }))
    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: 'Supprimer' }))

    await waitFor(() => expect(removed).toEqual(['c1']))
  })
})
