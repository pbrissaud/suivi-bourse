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
    await user.click(within(block).getByRole('radio', { name: /Anthropic/ }))
    await user.type(within(block).getByLabelText('Clé d’API'), 'test-key-0123456789abcd')
    await user.click(within(block).getByRole('button', { name: 'Tester la connexion' }))

    const dialog = await screen.findByRole('dialog', { name: 'Entrez votre code' })
    await user.type(within(dialog).getByRole('textbox'), '123456')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    expect(within(block).getByLabelText('Clé d’API')).toHaveValue('test-key-0123456789abcd')
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

describe('the Accès block', () => {
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
    const block = await screen.findByRole('region', { name: 'Accès' })
    const toggle = within(block).getByRole('switch', { name: 'Code d’accès' })
    expect(toggle).not.toBeChecked()
    expect(
      within(block).getByText('Sans code, toute personne sur votre réseau ouvre l’app.'),
    ).toBeInTheDocument()

    await user.click(toggle)
    // Only once the card's action succeeds.
    expect(toggle).not.toBeChecked()
    await user.type(within(block).getByLabelText('Nouveau code'), '246810')
    await user.type(within(block).getByLabelText('Confirmez le code'), '246811')
    await user.click(within(block).getByRole('button', { name: 'Activer le code' }))
    expect(within(block).getByRole('alert')).toHaveTextContent('Les deux codes diffèrent.')

    await user.clear(within(block).getByLabelText('Confirmez le code'))
    await user.type(within(block).getByLabelText('Confirmez le code'), '246810')
    await user.click(within(block).getByRole('button', { name: 'Activer le code' }))

    expect(await within(block).findByText('tok-shown-once')).toBeInTheDocument()
    expect(within(block).getByText('Il ne sera plus affiché.')).toBeInTheDocument()
    expect(toggle).toBeChecked()
    await user.keyboard('{Escape}')
    expect(within(block).getByText('tok-shown-once')).toBeInTheDocument()

    await user.click(within(block).getByRole('button', { name: 'J’ai copié le jeton' }))
    expect(within(block).queryByText('tok-shown-once')).not.toBeInTheDocument()
    expect(within(block).getByText(/^Jeton MCP · créé le 16/)).toBeInTheDocument()
    expect(await screen.findByText('Code activé')).toBeInTheDocument()
  })

  it('refuses to turn the code off with a wrong current code', async () => {
    server.use(
      http.get(ROUTES.authStatus, () =>
        HttpResponse.json({ enabled: true, authenticated: true, token_created_at: null }),
      ),
      http.post(ROUTES.authDisable, () => refused(403)),
    )
    const { user } = renderApp({ url: '/settings' })
    const block = await screen.findByRole('region', { name: 'Accès' })
    const toggle = within(block).getByRole('switch', { name: 'Code d’accès' })
    expect(toggle).toBeChecked()

    await user.click(toggle)
    await user.type(within(block).getByLabelText('Code actuel'), '999999')
    await user.click(within(block).getByRole('button', { name: 'Désactiver le code' }))

    expect(await within(block).findByRole('alert')).toHaveTextContent('Code actuel incorrect.')
    expect(toggle).toBeChecked()
    // Escape closes the card.
    await user.keyboard('{Escape}')
    expect(within(block).queryByLabelText('Code actuel')).not.toBeInTheDocument()
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
    const block = await screen.findByRole('region', { name: 'Accès' })

    await user.click(within(block).getByRole('button', { name: 'Se déconnecter' }))

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
