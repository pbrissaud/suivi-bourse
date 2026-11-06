/**
 * The PIN on the front (#1203): the boot, the screen, the dialog a session that
 * ended opens, and the *Accès* block. HTTP is the faked edge, as everywhere.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { anAgentConfig } from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const PROBLEM = { 'Content-Type': 'application/problem+json' }

function locked(signIn: () => Response | Promise<Response> = () => signedIn()) {
  const tries: string[] = []
  server.use(
    http.get(ROUTES.authStatus, () =>
      HttpResponse.json({ enabled: true, authenticated: false, token_created_at: null }),
    ),
    http.post(ROUTES.authPin, async ({ request }) => {
      tries.push(((await request.json()) as { pin: string }).pin)
      return signIn()
    }),
  )
  return tries
}

function signedIn() {
  return HttpResponse.json({ enabled: true, authenticated: true })
}

function refused(status: number, members: Record<string, unknown> = {}) {
  return HttpResponse.json(
    { type: '/problems/auth', title: 'Refused', status, ...members },
    { status, headers: PROBLEM },
  )
}

const code = () => screen.getByRole('textbox', { name: 'Entrez votre code' })

describe('the boot', () => {
  it('draws the PIN screen and nothing of the app, then the app once the code is right', async () => {
    const tries = locked()
    const { user } = renderApp({ url: '/settings' })

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Entrez votre code' }),
    ).toBeVisible()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(document.title).toBe('Code · SuiviBourse')
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    await waitFor(() => expect(code()).toHaveFocus())

    // Sent at the sixth digit, without a press on the button.
    await user.type(code(), '123456')

    expect(await screen.findByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible()
    expect(tries).toEqual(['123456'])
  })

  it('clears a wrong code and says the last free try before the wait', async () => {
    let left = 2
    locked(() => refused(401, { remaining: --left }))
    const { user } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Entrez votre code' })

    await user.type(code(), '000000')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Code incorrect. Dernier essai avant une attente de 30 s.',
    )
    expect(code()).toHaveValue('')

    await user.type(code(), '000000')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/^Code incorrect\.$/))
  })

  it('counts down a throttled wait with the slots disabled', async () => {
    locked(() => refused(429, { retry_after: 28 }))
    const { user } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Entrez votre code' })

    await user.type(code(), '000000')

    // Drawn, and announced once in the status region beside it.
    expect(await screen.findAllByText('Trop d’essais. Réessayez dans 0:28.')).toHaveLength(2)
    expect(code()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Déverrouiller' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Trop d’essais. Réessayez dans 0:28.')
  })

  it('says an unreadable status and offers to ask again', async () => {
    let fail = true
    server.use(
      http.get(ROUTES.authStatus, () =>
        fail
          ? HttpResponse.json({ status: 503 }, { status: 503 })
          : HttpResponse.json({ enabled: false, authenticated: false, token_created_at: null }),
      ),
    )
    const { user } = renderApp({ url: '/settings' })

    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Réessayer' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible()
  })
})

describe('a session that ends under the page', () => {
  it('opens the dialog once on a refused read, and asks the read again after the code', async () => {
    let session = false
    let reads = 0
    server.use(
      http.get(ROUTES.agentConfig, () => {
        reads += 1
        return session ? HttpResponse.json(anAgentConfig()) : refused(401)
      }),
      http.post(ROUTES.authPin, () => {
        session = true
        return signedIn()
      }),
    )
    const { user } = renderApp({ url: '/settings' })

    const dialog = await screen.findByRole('dialog', { name: 'Entrez votre code' })
    expect(within(dialog).getByText(/Votre session a pris fin/)).toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Entrez votre code' })).toBeInTheDocument()

    await user.type(within(dialog).getByRole('textbox'), '123456')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByRole('region', { name: 'L’agent' })).toBeInTheDocument()
    expect(reads).toBe(2)
  })

  it('keeps what was typed through a refused write, and does not send it again', async () => {
    let writes = 0
    server.use(
      http.post(ROUTES.agentTest, () => {
        writes += 1
        return refused(401)
      }),
      http.post(ROUTES.authPin, () => signedIn()),
    )
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'L’agent' })
    await user.click(await within(block).findByRole('button', { name: 'Configurer' }))
    const sheet = await screen.findByRole('dialog', { name: 'Le fournisseur de l’agent' })
    await user.click(within(sheet).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(sheet).getByLabelText('Clé d’API'), 'test-key-0123456789abcd')
    await user.click(within(sheet).getByRole('button', { name: 'Tester la connexion' }))

    const dialog = await screen.findByRole('dialog', { name: 'Entrez votre code' })
    await user.type(within(dialog).getByRole('textbox'), '123456')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Entrez votre code' })).not.toBeInTheDocument(),
    )

    // The sheet is still open, and holds what was typed.
    expect(within(sheet).getByLabelText('Clé d’API')).toHaveValue('test-key-0123456789abcd')
    expect(writes).toBe(1)
  })

  it('hands a refused question back to the agent’s input', async () => {
    server.use(
      http.get(ROUTES.agentThreads, () => HttpResponse.json([])),
      http.get(ROUTES.agentConfig, () =>
        HttpResponse.json(
          anAgentConfig({ enabled: true, provider: 'anthropic', model: 'claude-sonnet-5-5' }),
        ),
      ),
      http.post(ROUTES.agentChat, () => refused(401)),
    )
    const { user } = renderApp({ url: '/agent' })
    const input = await screen.findByRole('textbox', { name: 'Votre question' })
    await user.type(input, 'Combien vaut mon PEA ?')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))

    expect(await screen.findByRole('dialog', { name: 'Entrez votre code' })).toBeInTheDocument()
    // Behind the modal, so out of the accessibility tree: found by its label.
    await waitFor(() =>
      expect(screen.getByLabelText('Votre question')).toHaveValue('Combien vaut mon PEA ?'),
    )
  })
})

describe('the Sécurité section', () => {
  function pinOff() {
    let enabled = false
    server.use(
      http.get(ROUTES.authStatus, () =>
        HttpResponse.json({ enabled, authenticated: enabled, token_created_at: null }),
      ),
      http.post(ROUTES.authEnable, async ({ request }) => {
        const { pin } = (await request.json()) as { pin: string }
        if (pin !== '246810') return refused(400)
        enabled = true
        return HttpResponse.json({
          token: 'tok-shown-once',
          token_created_at: '2026-10-16T08:00:00+00:00',
        })
      }),
    )
  }

  it('says what no code means, asks the new code twice, and shows the token once', async () => {
    pinOff()
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })
    const toggle = await within(block).findByRole('switch', { name: 'Demander un code' })
    expect(toggle).not.toBeChecked()
    expect(
      within(block).getByText('Sans code, toute personne sur votre réseau ouvre l’app.'),
    ).toBeInTheDocument()
    // Off, the section is that one row.
    expect(within(block).queryByRole('button')).not.toBeInTheDocument()
    expect(within(block).queryByRole('combobox')).not.toBeInTheDocument()

    await user.click(toggle)
    // Only once the dialog's action succeeds.
    expect(toggle).not.toBeChecked()
    const dialog = await screen.findByRole('dialog', { name: 'Activer le code' })
    await user.type(within(dialog).getByLabelText('Nouveau code'), '246810')
    await user.type(within(dialog).getByLabelText('Confirmez le code'), '246811')
    await user.click(within(dialog).getByRole('button', { name: 'Activer le code' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Les deux codes diffèrent.')

    await user.clear(within(dialog).getByLabelText('Confirmez le code'))
    await user.type(within(dialog).getByLabelText('Confirmez le code'), '246810')
    await user.click(within(dialog).getByRole('button', { name: 'Activer le code' }))

    const shown = await screen.findByRole('dialog', { name: 'Votre jeton d’accès' })
    expect(within(shown).getByText('tok-shown-once')).toBeInTheDocument()
    expect(
      within(shown).getByText(
        `curl -H "Authorization: Bearer tok-shown-once" ${window.location.origin}/api/positions`,
      ),
    ).toBeInTheDocument()
    expect(within(shown).getByText('Il ne sera plus affiché.')).toBeInTheDocument()
    expect(within(shown).queryByRole('button', { name: 'Fermer' })).not.toBeInTheDocument()
    expect(toggle).toBeChecked()
    await user.keyboard('{Escape}')
    expect(within(shown).getByText('tok-shown-once')).toBeInTheDocument()

    await user.click(within(shown).getByRole('button', { name: 'J’ai copié le jeton' }))
    await waitFor(() => expect(screen.queryByText('tok-shown-once')).not.toBeInTheDocument())
    expect(
      within(block).getByText(/^MCP et API, Authorization: Bearer … · créé le 16/),
    ).toBeInTheDocument()
    expect(await screen.findByText('Code activé')).toBeInTheDocument()
    // Just enabled, the lifetime is the default.
    expect(
      within(block).getByRole('combobox', { name: 'Verrouillage automatique' }),
    ).toHaveTextContent('30 jours')
  })

  function pinOn(lifetime: () => Response | Promise<Response>) {
    const sent: unknown[] = []
    server.use(
      http.get(ROUTES.authStatus, () =>
        HttpResponse.json({
          enabled: true,
          authenticated: true,
          token_created_at: null,
          session_seconds: 2592000,
        }),
      ),
      http.post(ROUTES.authLifetime, async ({ request }) => {
        sent.push(await request.json())
        return lifetime()
      }),
    )
    return sent
  }

  it('saves the auto-lock on change, with no dialog', async () => {
    const sent = pinOn(() => HttpResponse.json({ session_seconds: 900 }))
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })
    const lock = await within(block).findByRole('combobox', { name: 'Verrouillage automatique' })
    expect(lock).toHaveTextContent('30 jours')

    await user.click(lock)
    expect(screen.getAllByRole('option').map((one) => one.textContent)).toEqual([
      '15 minutes',
      '1 heure',
      '1 jour',
      '7 jours',
      '30 jours',
    ])
    await user.click(screen.getByRole('option', { name: '15 minutes' }))

    expect(await within(block).findByText('✓ Enregistré')).toBeInTheDocument()
    expect(sent).toEqual([{ seconds: 900 }])
    expect(lock).toHaveTextContent('15 minutes')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says a refused auto-lock on its row', async () => {
    pinOn(() => refused(503))
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })
    const lock = await within(block).findByRole('combobox', { name: 'Verrouillage automatique' })

    await user.click(lock)
    await user.click(screen.getByRole('option', { name: '1 heure' }))

    expect(
      await within(block).findByText(
        'Non enregistré : Vos données sont illisibles pour l’instant. L’application tourne, mais son magasin ne répond pas.',
      ),
    ).toBeInTheDocument()
    // The row goes back to what the server holds.
    await waitFor(() => expect(lock).toHaveTextContent('30 jours'))
  })

  it('opens the code dialog when the session lapsed under the auto-lock row', async () => {
    pinOn(() => refused(401))
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })
    const lock = await within(block).findByRole('combobox', { name: 'Verrouillage automatique' })

    await user.click(lock)
    await user.click(screen.getByRole('option', { name: '1 heure' }))

    expect(await screen.findByRole('dialog', { name: 'Entrez votre code' })).toBeInTheDocument()
    expect(
      within(block).getByText(
        'Non enregistré : la session a pris fin, entrez le code puis choisissez à nouveau.',
      ),
    ).toBeInTheDocument()
  })

  it('refuses to turn the code off with a wrong current code, in an alertdialog', async () => {
    server.use(
      http.get(ROUTES.authStatus, () =>
        HttpResponse.json({ enabled: true, authenticated: true, token_created_at: null }),
      ),
      http.post(ROUTES.authDisable, () => refused(403)),
    )
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })
    const toggle = await within(block).findByRole('switch', { name: 'Demander un code' })
    expect(toggle).toBeChecked()

    await user.click(toggle)
    const dialog = await screen.findByRole('alertdialog', { name: 'Désactiver le code' })
    await user.type(within(dialog).getByLabelText('Code actuel'), '999999')
    await user.click(within(dialog).getByRole('button', { name: 'Désactiver le code' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Code actuel incorrect.')
    expect(toggle).toBeChecked()
    // Escape closes the dialog, and gives the focus back to the switch.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await waitFor(() => expect(toggle).toHaveFocus())
  })

  it('changes the code in a dialog, and gives the focus back to its row', async () => {
    let sent: unknown = null
    server.use(
      http.get(ROUTES.authStatus, () =>
        HttpResponse.json({ enabled: true, authenticated: true, token_created_at: null }),
      ),
      http.post(ROUTES.authChange, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json({ enabled: true })
      }),
    )
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })
    const change = await within(block).findByRole('button', { name: 'Changer le code' })

    await user.click(change)
    const dialog = await screen.findByRole('dialog', { name: 'Changer le code' })
    await user.type(within(dialog).getByLabelText('Code actuel'), '123456')
    await user.type(within(dialog).getByLabelText('Nouveau code'), '654321')
    await user.type(within(dialog).getByLabelText('Confirmez le code'), '654321')
    await user.click(within(dialog).getByRole('button', { name: 'Changer' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(sent).not.toBeNull()
    await waitFor(() => expect(change).toHaveFocus())

    // Opened again, it holds none of the codes typed the first time.
    await user.click(change)
    const again = await screen.findByRole('dialog', { name: 'Changer le code' })
    expect(within(again).getByLabelText('Code actuel')).toHaveValue('')
    expect(within(again).getByLabelText('Nouveau code')).toHaveValue('')
    expect(within(again).getByLabelText('Confirmez le code')).toHaveValue('')
  })

  it('signs this device out back to the PIN screen', async () => {
    let out = false
    server.use(
      http.get(ROUTES.authStatus, () =>
        HttpResponse.json({ enabled: true, authenticated: !out, token_created_at: null }),
      ),
      http.post(ROUTES.authLogout, () => {
        out = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })

    await user.click(await within(block).findByRole('button', { name: 'Se déconnecter' }))

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Entrez votre code' }),
    ).toBeVisible()
    expect(out).toBe(true)
  })
})

describe('the palette', () => {
  it('offers to sign out only while a code is set', async () => {
    const { user, unmount } = renderApp()
    await screen.findByRole('heading', { level: 1 })
    await user.keyboard('{Control>}k{/Control}')
    const palette = await screen.findByRole('dialog')
    expect(within(palette).queryByText('Se déconnecter')).not.toBeInTheDocument()
    unmount()

    server.use(
      http.get(ROUTES.authStatus, () =>
        HttpResponse.json({ enabled: true, authenticated: true, token_created_at: null }),
      ),
    )
    const again = renderApp()
    await screen.findByRole('heading', { level: 1 })
    await again.user.keyboard('{Control>}k{/Control}')
    expect(
      await within(await screen.findByRole('dialog')).findByText('Se déconnecter'),
    ).toBeVisible()
  })
})
