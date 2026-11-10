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
    http.get(ROUTES.authStatus, () => HttpResponse.json({ enabled: true, authenticated: false })),
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

const code = () => screen.getByRole('textbox', { name: 'Code d’accès' })

describe('the boot', () => {
  it('draws the PIN screen and nothing of the app, then the app once the code is right', async () => {
    const tries = locked()
    const { user } = renderApp({ url: '/settings' })

    expect(await screen.findByRole('heading', { level: 1, name: 'Code d’accès' })).toBeVisible()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(document.title).toBe('Code · SuiviBourse')
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    await waitFor(() => expect(code()).toHaveFocus())

    // No plane, no button: the code is sent at the sixth digit.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('SB_RESET_AUTH=1')).not.toBeInTheDocument()
    await user.type(code(), '123456')

    expect(await screen.findByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible()
    expect(tries).toEqual(['123456'])
  })

  it('clears a wrong code and says the last free try before the wait', async () => {
    let left = 2
    locked(() => refused(401, { remaining: --left }))
    const { user } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Code d’accès' })

    await user.type(code(), '000000')
    expect(await screen.findByRole('alert')).toHaveTextContent('Code incorrect · dernier essai')
    expect(code()).toHaveValue('')

    await user.type(code(), '000000')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/^Code incorrect$/))
  })

  it('counts down a throttled wait with the slots disabled', async () => {
    locked(() => refused(429, { retry_after: 28 }))
    const { user } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Code d’accès' })

    await user.type(code(), '000000')

    // Announced once in the status region, drawn with the clock in mono, and the
    // reset the server owes a forgotten code is named.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Trop d’essais · réessayez dans 0:28'),
    )
    expect(code()).toBeDisabled()
    expect(screen.getByText('0:28')).toHaveClass('fig')
    expect(screen.getByText('SB_RESET_AUTH=1')).toBeInTheDocument()
  })

  it('says an unreadable status and offers to ask again', async () => {
    let fail = true
    server.use(
      http.get(ROUTES.authStatus, () =>
        fail
          ? HttpResponse.json({ status: 503 }, { status: 503 })
          : HttpResponse.json({ enabled: false, authenticated: false }),
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

    const dialog = await screen.findByRole('dialog', { name: 'Code d’accès' })
    expect(within(dialog).getByText(/Votre session a pris fin/)).toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Code d’accès' })).toBeInTheDocument()
    // The page behind is out of sight and of the accessibility tree, not just covered.
    expect(screen.queryByRole('heading', { level: 1, name: 'Réglages' })).not.toBeInTheDocument()

    await user.type(within(dialog).getByRole('textbox'), '123456')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByRole('region', { name: 'Agent' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible()
    expect(reads).toBe(2)
  })

  it('keeps what was typed through a refused write, and does not send it again', async () => {
    let writes = 0
    server.use(
      http.post(ROUTES.agentProviderTest, () => {
        writes += 1
        return refused(401)
      }),
      http.post(ROUTES.authPin, () => signedIn()),
    )
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Agent' })
    await user.click(await within(block).findByRole('button', { name: 'Ajouter un fournisseur' }))
    const sheet = await screen.findByRole('dialog', { name: 'Ajouter un fournisseur' })
    await user.type(within(sheet).getByLabelText('Clé API'), 'test-key-0123456789abcd')
    await user.click(within(sheet).getByRole('button', { name: 'Tester' }))

    const dialog = await screen.findByRole('dialog', { name: 'Code d’accès' })
    await user.type(within(dialog).getByRole('textbox'), '123456')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Code d’accès' })).not.toBeInTheDocument(),
    )

    // The sheet is still open, and holds what was typed.
    expect(within(sheet).getByLabelText('Clé API')).toHaveValue('test-key-0123456789abcd')
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

    expect(await screen.findByRole('dialog', { name: 'Code d’accès' })).toBeInTheDocument()
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
      http.get(ROUTES.authStatus, () => HttpResponse.json({ enabled, authenticated: enabled })),
      http.post(ROUTES.authEnable, async ({ request }) => {
        const { pin } = (await request.json()) as { pin: string }
        if (pin !== '246810') return refused(400)
        enabled = true
        return HttpResponse.json({ enabled: true })
      }),
    )
  }

  it('states that no code is set, and asks the new code twice', async () => {
    pinOff()
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })
    const enable = await within(block).findByRole('button', { name: 'Activer le code' })
    expect(within(block).getByText('Désactivé')).toBeInTheDocument()
    // Off, no auto-lock and no tokens: both exist only with a code.
    expect(within(block).queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(within(block).queryByText('Jetons d’accès', { exact: false })).not.toBeInTheDocument()

    await user.click(enable)
    const dialog = await screen.findByRole('dialog', { name: 'Activer le code' })
    await user.type(within(dialog).getByLabelText('Nouveau code'), '246810')
    await user.type(within(dialog).getByLabelText('Confirmez le code'), '246811')
    await user.click(within(dialog).getByRole('button', { name: 'Activer le code' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Les deux codes diffèrent.')

    // The confirmation starts over and has the focus: what is typed next is
    // the whole of it, and the first entry is left alone.
    expect(within(dialog).getByLabelText('Confirmez le code')).toHaveValue('')
    expect(within(dialog).getByLabelText('Confirmez le code')).toHaveFocus()
    expect(within(dialog).getByLabelText('Nouveau code')).toHaveValue('246810')
    await user.keyboard('246810')
    await user.click(within(dialog).getByRole('button', { name: 'Activer le code' }))

    expect(await screen.findByText('Code activé')).toBeInTheDocument()
    // No token is made by enabling: the list is empty, and « Créer un jeton » is its way on.
    expect(await within(block).findByRole('button', { name: 'Créer un jeton' })).toBeVisible()
    expect(within(block).getByRole('radio', { name: '30 jours' })).toBeChecked()
  })

  function pinOn(lifetime: () => Response | Promise<Response>) {
    const sent: unknown[] = []
    server.use(
      http.get(ROUTES.authStatus, () =>
        HttpResponse.json({ enabled: true, authenticated: true, session_seconds: 2592000 }),
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
    const group = await within(block).findByRole('radiogroup', { name: 'Verrouillage automatique' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((one) => one.textContent),
    ).toEqual(['15 min', '1 h', '1 jour', '7 jours', '30 jours'])
    expect(within(group).getByRole('radio', { name: '30 jours' })).toBeChecked()

    await user.click(within(group).getByRole('radio', { name: '15 min' }))

    expect(await within(block).findByText('✓ Enregistré')).toBeInTheDocument()
    expect(sent).toEqual([{ seconds: 900 }])
    expect(within(group).getByRole('radio', { name: '15 min' })).toBeChecked()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says a refused auto-lock on its row', async () => {
    pinOn(() => refused(503))
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })
    const group = await within(block).findByRole('radiogroup', { name: 'Verrouillage automatique' })

    await user.click(within(group).getByRole('radio', { name: '1 h' }))

    expect(
      await within(block).findByText(
        'Non enregistré : Vos données sont illisibles pour l’instant. L’application tourne, mais son magasin ne répond pas.',
      ),
    ).toBeInTheDocument()
    // The row goes back to what the server holds.
    await waitFor(() =>
      expect(within(group).getByRole('radio', { name: '30 jours' })).toBeChecked(),
    )
  })

  it('opens the code dialog when the session lapsed under the auto-lock row', async () => {
    pinOn(() => refused(401))
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })
    const group = await within(block).findByRole('radiogroup', { name: 'Verrouillage automatique' })

    await user.click(within(group).getByRole('radio', { name: '1 h' }))

    expect(await screen.findByRole('dialog', { name: 'Code d’accès' })).toBeInTheDocument()
    expect(
      within(block).getByText(
        'Non enregistré : la session a pris fin, entrez le code puis choisissez à nouveau.',
      ),
    ).toBeInTheDocument()
  })

  it('refuses to turn the code off with a wrong current code, in an alertdialog', async () => {
    server.use(
      http.get(ROUTES.authStatus, () => HttpResponse.json({ enabled: true, authenticated: true })),
      http.post(ROUTES.authDisable, () => refused(403)),
    )
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })
    const off = await within(block).findByRole('button', { name: 'Désactiver' })

    await user.click(off)
    const dialog = await screen.findByRole('alertdialog', { name: 'Désactiver le code d’accès ?' })
    await user.type(within(dialog).getByLabelText('Code actuel'), '999999')
    await user.click(within(dialog).getByRole('button', { name: 'Désactiver' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Code actuel incorrect.')
    // Escape closes the dialog, and gives the focus back to the button.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await waitFor(() => expect(off).toHaveFocus())
  })

  it('says since when the code is on', async () => {
    server.use(
      http.get(ROUTES.authStatus, () =>
        HttpResponse.json({
          enabled: true,
          authenticated: true,
          enabled_since: '2026-11-02T09:14:00+00:00',
        }),
      ),
    )
    renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Sécurité' })

    expect(await within(block).findByText('Actif depuis le 2 nov. 2026')).toBeInTheDocument()
  })

  it('changes the code in a dialog, and gives the focus back to its row', async () => {
    let sent: unknown = null
    server.use(
      http.get(ROUTES.authStatus, () => HttpResponse.json({ enabled: true, authenticated: true })),
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
})

describe('the sidebar', () => {
  it('offers « Verrouiller » beside Réglages only while a code is set, and locks', async () => {
    const off = renderApp()
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByRole('button', { name: 'Verrouiller' })).not.toBeInTheDocument()
    off.unmount()

    let loggedOut = false
    server.use(
      http.get(ROUTES.authStatus, () => HttpResponse.json({ enabled: true, authenticated: true })),
      http.post(ROUTES.authLogout, () => {
        loggedOut = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user } = renderApp()
    await screen.findByRole('heading', { level: 1 })
    await user.click(await screen.findByRole('button', { name: 'Verrouiller' }))

    await waitFor(() => expect(loggedOut).toBe(true))
    expect(await screen.findByRole('heading', { level: 1, name: 'Code d’accès' })).toBeVisible()
    // The lock screen holds none of the page that was behind it.
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument()
  })
})

describe('the palette', () => {
  it('offers to sign out only while a code is set', async () => {
    const { user, unmount } = renderApp()
    await screen.findByRole('heading', { level: 1 })
    await user.keyboard('{Control>}k{/Control}')
    const palette = await screen.findByRole('dialog')
    expect(within(palette).queryByText('Verrouiller')).not.toBeInTheDocument()
    unmount()

    server.use(
      http.get(ROUTES.authStatus, () => HttpResponse.json({ enabled: true, authenticated: true })),
    )
    const again = renderApp()
    await screen.findByRole('heading', { level: 1 })
    await again.user.keyboard('{Control>}k{/Control}')
    expect(await within(await screen.findByRole('dialog')).findByText('Verrouiller')).toBeVisible()
  })
})
