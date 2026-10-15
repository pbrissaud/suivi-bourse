/**
 * The agent's page (#1117, #1196), the whole app in jsdom.
 *
 * **Every conversation is scripted** with `@shadcn/helpers/ai-sdk`: its
 * `chat.transport()` stands in for the HTTP transport at the one seam the
 * page asks (`agentSeam`), so no model, no key and no `/api/agent/chat` are needed —
 * the rest (the config read, the positions, the threads) is HTTP faked by msw
 * as everywhere else.
 */
import { createChat } from '@shadcn/helpers/ai-sdk'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentSeam, httpTransport } from '@/features/agent/lib/agentChat'
import type { AgentConfig } from '@/features/agent/lib/api'
import { ROUTES } from '@/lib/api'
import fr from '@/i18n/fr.json'
import { anAgentConfig } from '@/test/factories'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

type Script = ReturnType<typeof createChat>

const QUESTION = 'Si je vends mes Zeta Alpha, combien je paie ?'

function switchedOn(overrides: Partial<AgentConfig> = {}) {
  server.use(
    // A turn that ends reads the list again; a test that lists none says so.
    http.get(ROUTES.agentThreads, () => HttpResponse.json([])),
    http.get(ROUTES.agentConfig, () =>
      HttpResponse.json(
        anAgentConfig({
          enabled: true,
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          key: { set: true, last4: 'wxyz', set_at: null },
          ...overrides,
        }),
      ),
    ),
  )
}

/** Every `Chat` the page builds streams `script`, at no delay. */
function scripted(script: Script) {
  const sent = vi.fn()
  vi.spyOn(agentSeam, 'transport').mockImplementation(() => {
    const transport = script.transport({ delayMs: 0 })
    return {
      ...transport,
      sendMessages: (options) => {
        sent(options.messages.at(-1))
        return transport.sendMessages(options)
      },
      reconnectToStream: (options) => transport.reconnectToStream(options),
    }
  })
  return sent
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function openPage(url = '/agent', width = 1024) {
  setViewportWidth(width)
  const view = renderApp({ url })
  await screen.findByRole('heading', { level: 1, name: 'Agent' })
  return { ...view, main: screen.getByRole('main') }
}

async function ask(user: ReturnType<typeof renderApp>['user'], main: HTMLElement, text: string) {
  await user.type(await within(main).findByRole('textbox', { name: 'Votre question' }), text)
  await user.click(within(main).getByRole('button', { name: 'Envoyer' }))
}

// ------------------------------------------------------------------------ //

describe('the states (4A)', () => {
  it('is off: the page says what to connect', async () => {
    const { main } = await openPage()
    expect(
      await within(main).findByText(
        'Branchez un modèle pour poser des questions sur votre portefeuille',
      ),
    ).toBeInTheDocument()
    expect(within(main).getByRole('link', { name: 'Configurer' })).toHaveAttribute(
      'href',
      '/settings',
    )
    expect(within(main).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('offers three questions built from the portfolio on an empty thread, each one click', async () => {
    switchedOn()
    const sent = scripted(
      createChat().user(fr['agent.example.rhythm']).assistant('Oui, chaque mois.'),
    )
    const { user, main } = await openPage()
    const offered = await within(main).findAllByRole('button', { name: /\?$/ })
    expect(offered).toHaveLength(3)
    // The largest held line of the fixture, by value: 10 × 130 against
    // 4 × 100 (converted) and 600 carried at cost.
    expect(offered[0]).toHaveAccessibleName(/Zeta Alpha/)

    expect(offered[1]).toHaveTextContent(fr['agent.example.rhythm'])
    await user.click(offered[1])

    expect((await within(main).findAllByText('Oui, chaque mois.'))[0]).toBeInTheDocument()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(within(main).queryAllByRole('button', { name: /\?$/ })).toHaveLength(0)
  })

  it('waits on the running tool, streams, and offers Arrêter instead of Envoyer', async () => {
    switchedOn()
    scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer
            .tool('simulate_sale', { input: { account: 'cto', symbol: 'ZA', quantity: 4 } })
            .sleep(300)
            .output({ net_proceeds: 812.5 })
          writer.text('La vente laisserait 812,50 €.', { mode: 'instant' })
        }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    expect(await within(main).findByText('Simulation en cours…')).toBeInTheDocument()
    expect(within(main).getByText('Simulation d’une vente, impôts et frais compris.'))
    expect(within(main).getByRole('button', { name: 'Arrêter' })).toBeInTheDocument()
    expect(within(main).queryByRole('button', { name: 'Envoyer' })).not.toBeInTheDocument()

    expect(await within(main).findByText('La vente laisserait 812,50 €.')).toBeInTheDocument()
    expect(within(main).queryByText('Simulation en cours…')).not.toBeInTheDocument()
    expect(within(main).getByRole('button', { name: 'Envoyer' })).toBeInTheDocument()
  })

  it('says a provider error in its words, keeps the message, and offers Réessayer', async () => {
    switchedOn()
    const sent = scripted(createChat().user(QUESTION).error('Anthropic: invalid x-api-key'))
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    const alert = await within(main).findByRole('alert')
    expect(alert).toHaveTextContent('Anthropic: invalid x-api-key')
    expect(within(main).getByText(QUESTION)).toBeInTheDocument()

    await user.click(within(alert).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(2))
    // The question again, as a new turn, and on screen once.
    expect(sent.mock.calls[1][0].parts).toEqual([{ type: 'text', text: QUESTION }])
    expect(await within(main).findByRole('alert')).toBeInTheDocument()
    expect(within(main).getAllByText(QUESTION)).toHaveLength(1)
  })

  it('marks Ollama experimental next to the model', async () => {
    switchedOn({ provider: 'ollama', model: 'qwen3:8b', base_url: 'http://ollama:11434' })
    const { main } = await openPage()
    expect(await within(main).findByText('expérimental')).toBeInTheDocument()
    expect(within(main).getByText(/Ollama · qwen3:8b/)).toBeInTheDocument()
  })

  it('names no experimental chip for a hosted provider', async () => {
    switchedOn()
    const { main } = await openPage()
    expect(await within(main).findByText(/Anthropic · claude-sonnet-5-5/)).toBeInTheDocument()
    expect(within(main).queryByText('expérimental')).not.toBeInTheDocument()
  })

  it('refuses an image or a PDF before anything is sent', async () => {
    switchedOn()
    const sent = scripted(createChat())
    const { main } = await openPage()
    const field = await within(main).findByRole('textbox', { name: 'Votre question' })

    for (const file of [
      new File(['x'], 'releve.png', { type: 'image/png' }),
      new File(['x'], 'releve.pdf', { type: 'application/pdf' }),
    ]) {
      fireEvent.paste(field, { clipboardData: { files: [file], getData: () => '' } })
      const alert = await within(main).findByRole('alert')
      expect(alert).toHaveTextContent(file.name)
      expect(alert).toHaveTextContent('Ce modèle ne lit pas les images. Collez le texte ou un CSV.')
    }
    expect(sent).not.toHaveBeenCalled()
  })

  it('says when the thread cannot be kept, and still shows the answer', async () => {
    switchedOn()
    scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer.text('Une réponse.', { mode: 'instant' })
          writer.error('The conversation could not be saved: Read-only file system')
        }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    expect(
      await within(main).findByText('Cette conversation ne sera pas gardée.'),
    ).toBeInTheDocument()
    expect(within(main).getByText('Une réponse.')).toBeInTheDocument()
    expect(within(main).queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument()
  })
})

describe('the tool lines (2A)', () => {
  it('show the plain sentence, and the raw call behind détail', async () => {
    switchedOn()
    scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer.tool('list_positions', { input: {} }).output({ positions: [] })
          writer.tool('get_dividends', { input: { year: 2026 } }).output({ total: 0 })
          writer.text('Fini.', { mode: 'instant' })
        }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)
    await within(main).findAllByText('Fini.')

    const line = within(main).getByText('Lecture de vos positions.').closest('details')
    expect(line).not.toBeNull()
    expect(line).not.toHaveAttribute('open')
    await user.click(within(line as HTMLElement).getByText('détail'))
    expect(line).toHaveAttribute('open')
    expect(line).toHaveTextContent('list_positions({})')
    expect(line).toHaveTextContent('"positions": []')
    // A tool the page has no sentence for is named, never hidden.
    expect(within(main).getByText('Appel de l’outil get_dividends.')).toBeInTheDocument()
  })
})

/** The stored threads `t1` and `t2`, each one question and its answer. */
function storedThreads() {
  const deleted: string[] = []
  const read: string[] = []
  server.use(
    http.get(ROUTES.agentThreads, () =>
      HttpResponse.json([
        {
          id: 't2',
          title: 'Mon rythme',
          created_at: '2026-10-12T09:00:00Z',
          updated_at: '2026-10-12T09:01:00Z',
        },
        {
          id: 't1',
          title: 'Vendre Zeta',
          created_at: '2026-10-11T09:00:00Z',
          updated_at: '2026-10-11T09:01:00Z',
        },
      ]),
    ),
    http.get(ROUTES.agentThread, ({ params }) => {
      const id = String(params.id)
      read.push(id)
      if (id !== 't1' && id !== 't2') {
        return HttpResponse.json({ error: 'No conversation has this id.' }, { status: 404 })
      }
      return HttpResponse.json({
        id,
        title: id,
        messages: [
          { id: `u-${id}`, role: 'user', parts: [{ type: 'text', text: `Question ${id} ?` }] },
          { id: `a-${id}`, role: 'assistant', parts: [{ type: 'text', text: `Fil ${id}.` }] },
        ],
      })
    }),
    http.delete(ROUTES.agentThread, ({ params }) => {
      deleted.push(String(params.id))
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return { deleted, read }
}

describe('the threads (12A)', () => {
  it('lists the recent ones in the column, opens one, and deletes one', async () => {
    switchedOn()
    const { deleted } = storedThreads()
    const { user, main, router } = await openPage()

    const column = await within(main).findByRole('navigation', { name: 'Fils récents' })
    expect(await within(column).findAllByRole('listitem')).toHaveLength(2)
    await user.click(within(column).getByRole('link', { name: /^Vendre Zeta/ }))
    expect(await within(main).findByText('Fil t1.')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/agent/t1')
    expect(within(column).getByRole('link', { name: /^Vendre Zeta/ })).toHaveAttribute(
      'aria-current',
      'page',
    )

    const before = router.history.length
    await user.click(
      within(column).getByRole('button', { name: 'Supprimer le fil « Vendre Zeta »' }),
    )
    await waitFor(() => expect(deleted).toEqual(['t1']))
    // The thread on screen was the one deleted: an empty one takes its place.
    expect(await within(main).findByText(/Posez une question/)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/agent')
    expect(router.history.length).toBe(before)
  })

  it('shows the thread asked for last, whatever order the reads land in', async () => {
    switchedOn()
    // The slow read is held until the fast one has been asked for, so the
    // order is the test's and not the runner's.
    let release = () => {}
    const held = new Promise<void>((done) => {
      release = done
    })
    server.use(
      http.get(ROUTES.agentThreads, () =>
        HttpResponse.json([
          { id: 'slow', title: 'Lent', created_at: null, updated_at: null },
          { id: 'fast', title: 'Rapide', created_at: null, updated_at: null },
        ]),
      ),
      http.get(ROUTES.agentThread, async ({ params }) => {
        const id = String(params.id)
        if (id === 'slow') await held
        return HttpResponse.json({
          id,
          title: id,
          messages: [
            { id: `a-${id}`, role: 'assistant', parts: [{ type: 'text', text: `Fil ${id}.` }] },
          ],
        })
      }),
    )
    const { user, main } = await openPage()

    await user.click(await within(main).findByRole('link', { name: /^Lent/ }))
    await user.click(within(main).getByRole('link', { name: /^Rapide/ }))

    expect(await within(main).findByText('Fil fast.')).toBeInTheDocument()
    release()
    await new Promise((done) => setTimeout(done, 100))
    expect(within(main).getByText('Fil fast.')).toBeInTheDocument()
    expect(within(main).queryByText('Fil slow.')).not.toBeInTheDocument()
  })
})

describe('the address (#1196)', () => {
  it('gives a new thread its address on the first question, in place of /agent', async () => {
    switchedOn()
    server.use(http.get(ROUTES.agentThreads, () => HttpResponse.json([])))
    scripted(createChat().user(QUESTION).assistant('Réponse.'))
    const { user, main, router } = await openPage()
    const before = router.history.length

    await ask(user, main, QUESTION)
    await within(main).findAllByText('Réponse.')

    expect(router.state.location.pathname).toMatch(/^\/agent\/[^/]+$/)
    expect(router.history.length).toBe(before)
  })

  it('pushes a thread opened from the list, so Back returns to the previous one', async () => {
    switchedOn()
    storedThreads()
    const { user, main, router } = await openPage('/agent/t1')
    expect(await within(main).findByText('Fil t1.')).toBeInTheDocument()

    await user.click(await within(main).findByRole('link', { name: /^Mon rythme/ }))
    expect(await within(main).findByText('Fil t2.')).toBeInTheDocument()

    router.history.back()
    expect(await within(main).findByText('Fil t1.')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/agent/t1')
  })

  it('says an unknown thread is gone, offers a new one, and keeps the address', async () => {
    switchedOn()
    storedThreads()
    const { user, main, router } = await openPage('/agent/nope')

    expect(await within(main).findByRole('alert')).toHaveTextContent('No conversation has this id.')
    expect(router.state.location.pathname).toBe('/agent/nope')
    expect(within(main).queryByRole('textbox')).not.toBeInTheDocument()

    const fresh = within(main)
      .getAllByRole('link', { name: 'Nouveau fil' })
      .find((link) => link.closest('nav') === null) as HTMLElement
    await user.click(fresh)
    expect(await within(main).findByText(/Posez une question/)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/agent')
  })

  it('keeps a stream going while the reader is elsewhere, and sends nothing twice', async () => {
    switchedOn()
    server.use(http.get(ROUTES.agentThreads, () => HttpResponse.json([])))
    const read = vi.fn()
    server.use(
      http.get(ROUTES.agentThread, () => {
        read()
        return HttpResponse.json({ error: 'No conversation has this id.' }, { status: 404 })
      }),
    )
    const sent = scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer.tool('simulate_sale', { input: {} }).sleep(300).output({})
          writer.text('La réponse entière.', { mode: 'instant' })
        }),
    )
    const { user, main, router } = await openPage()
    await ask(user, main, QUESTION)
    await within(main).findByText('Simulation en cours…')
    const thread = router.state.location.pathname

    await router.navigate({ to: '/' })
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })
    await new Promise((done) => setTimeout(done, 400))
    await router.navigate({ to: thread })

    expect(await screen.findByText('La réponse entière.')).toBeInTheDocument()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
  })

  it('reads a thread again on Réessayer once the server is back', async () => {
    switchedOn()
    let down = true
    server.use(
      http.get(ROUTES.agentThread, ({ params }) =>
        down
          ? HttpResponse.json({ error: 'The store is unavailable.' }, { status: 503 })
          : HttpResponse.json({
              id: String(params.id),
              title: 'Revenu',
              messages: [
                { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Fil revenu.' }] },
              ],
            }),
      ),
    )
    const { user, main, router } = await openPage('/agent/t1')
    expect(await within(main).findByRole('alert')).toHaveTextContent('The store is unavailable.')

    down = false
    await user.click(within(main).getByRole('button', { name: 'Réessayer' }))
    expect(await within(main).findByText('Fil revenu.')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/agent/t1')
  })

  it('drops a failed read when Back returns to the thread on screen', async () => {
    switchedOn()
    const { read } = storedThreads()
    const { main, router } = await openPage('/agent/t1')
    expect(await within(main).findByText('Fil t1.')).toBeInTheDocument()

    await router.navigate({ to: '/agent/$threadId', params: { threadId: 'gone' } })
    expect(await within(main).findByRole('alert')).toHaveTextContent('No conversation has this id.')

    router.history.back()
    expect(await within(main).findByText('Fil t1.')).toBeInTheDocument()
    expect(within(main).queryByRole('alert')).not.toBeInTheDocument()
    // The thread on screen is kept, not read again (a stream would be stopped).
    await new Promise((done) => setTimeout(done, 50))
    expect(read).toEqual(['t1', 'gone'])
  })

  it('leads the navigation entry back to the thread, so the stream survives it', async () => {
    switchedOn()
    server.use(http.get(ROUTES.agentThreads, () => HttpResponse.json([])))
    const sent = scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer.tool('simulate_sale', { input: {} }).sleep(300).output({})
          writer.text('La réponse entière.', { mode: 'instant' })
        }),
    )
    const { user, main, router } = await openPage()
    await ask(user, main, QUESTION)
    await within(main).findByText('Simulation en cours…')
    const thread = router.state.location.pathname

    await router.navigate({ to: '/' })
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    await user.click(within(nav).getByRole('link', { name: 'Agent' }))

    expect(await screen.findByText('La réponse entière.')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(thread)
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('refreshes the thread list when a turn ends while the reader is elsewhere', async () => {
    switchedOn()
    let listed = 0
    server.use(
      http.get(ROUTES.agentThreads, () => {
        listed += 1
        return HttpResponse.json([])
      }),
    )
    scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer.tool('simulate_sale', { input: {} }).sleep(300).output({})
          writer.text('Fini ailleurs.', { mode: 'instant' })
        }),
    )
    const { user, main, router, queryClient } = await openPage()
    // The app's own freshness (`main.tsx`): coming back alone refetches nothing.
    queryClient.setQueryDefaults(['agent-threads'], { staleTime: 30_000 })
    await within(main).findByRole('navigation', { name: 'Fils récents' })
    await ask(user, main, QUESTION)
    await within(main).findByText('Simulation en cours…')
    const thread = router.state.location.pathname

    await router.navigate({ to: '/' })
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })
    await new Promise((done) => setTimeout(done, 500))
    const before = listed
    await router.navigate({ to: thread })

    expect(await screen.findByText('Fini ailleurs.')).toBeInTheDocument()
    await waitFor(() => expect(listed).toBeGreaterThan(before))
  })

  it('sends no page with a turn', async () => {
    const bodies: unknown[] = []
    server.use(
      http.post(ROUTES.agentChat, async ({ request }) => {
        bodies.push(await request.json())
        return new HttpResponse(null, { status: 500 })
      }),
    )
    const transport = httpTransport()
    await transport
      .sendMessages({
        chatId: 'k1',
        messageId: undefined,
        trigger: 'submit-message',
        abortSignal: undefined,
        messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: QUESTION }] }],
      })
      .catch(() => {})
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty('page')
    expect(bodies[0]).toMatchObject({ id: 'k1', trigger: 'submit-message' })
  })
})

describe('the layout (#1196)', () => {
  it('puts the recent threads in a column from 1 024 px', async () => {
    switchedOn()
    storedThreads()
    const { main } = await openPage('/agent', 1024)
    expect(
      await within(main).findByRole('navigation', { name: 'Fils récents' }),
    ).toBeInTheDocument()
    expect(within(main).queryByRole('button', { name: 'Fils récents' })).not.toBeInTheDocument()
  })

  it('keeps them in the header menu at 1 023 px', async () => {
    switchedOn()
    storedThreads()
    const { user, main } = await openPage('/agent', 1023)
    expect(within(main).queryByRole('navigation', { name: 'Fils récents' })).not.toBeInTheDocument()
    await user.click(await within(main).findByRole('button', { name: 'Fils récents' }))
    const list = await screen.findByRole('dialog')
    expect(await within(list).findAllByRole('listitem')).toHaveLength(2)
  })

  it('is an entry of the navigation, current on both of its addresses', async () => {
    for (const url of ['/agent', '/agent/t1']) {
      storedThreads()
      const view = await openPage(url)
      const nav = screen.getByRole('navigation', { name: 'Sections' })
      expect(within(nav).getByRole('link', { name: 'Agent' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      view.unmount()
    }
  })

  it('draws no agent button in the header, and ⌘/Ctrl + J does nothing', async () => {
    switchedOn()
    const { user, router } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })
    expect(screen.queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument()
    await user.keyboard('{Control>}j{/Control}')
    await user.keyboard('{Meta>}j{/Meta}')
    await new Promise((done) => setTimeout(done, 50))
    expect(router.state.location.pathname).toBe('/')
    expect(screen.queryByRole('textbox', { name: 'Votre question' })).not.toBeInTheDocument()
  })

  it('names the document after the page', async () => {
    switchedOn()
    await openPage()
    expect(document.title).toBe('Agent')
  })
})

describe('accessibility (11A)', () => {
  it('puts focus in the input when the page mounts, inside main', async () => {
    switchedOn()
    const { main } = await openPage()
    const field = await within(main).findByRole('textbox', { name: 'Votre question' })
    await waitFor(() => expect(field).toHaveFocus())
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  it('announces Réponse en cours once, and the answer once complete', async () => {
    switchedOn()
    scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer.tool('simulate_sale', { input: {} }).sleep(200).output({})
          writer.text('Voici la réponse entière.')
        }),
    )
    const { user, main } = await openPage()
    await within(main).findByRole('textbox', { name: 'Votre question' })
    const live = main.querySelector('[aria-live="polite"]') as HTMLElement
    expect(live).toHaveTextContent('')
    await ask(user, main, QUESTION)

    await waitFor(() =>
      expect(main.querySelector('[aria-live="polite"]')).toHaveTextContent('Réponse en cours'),
    )
    await waitFor(() =>
      expect(main.querySelector('[aria-live="polite"]')).toHaveTextContent(
        'Voici la réponse entière.',
      ),
    )
    // The streamed log itself is silenced: only the region above speaks.
    expect(main.querySelector('[role="log"]')).toHaveAttribute('aria-live', 'off')
  })

  it('keeps every control of the conversation at 44 px or more', async () => {
    switchedOn()
    storedThreads()
    const { main } = await openPage()
    await within(main).findAllByRole('button', { name: /\?$/ })
    await within(main).findAllByRole('listitem')
    // The page's own controls: the header bar above it is the shell's.
    const page = within(main).getByRole('textbox').closest('section')?.parentElement as HTMLElement
    for (const control of [
      ...within(page).getAllByRole('button'),
      ...within(page).getAllByRole('link'),
    ]) {
      expect(control.className, control.textContent ?? '').toMatch(/\b(?:size-11|min-h-11)\b/)
    }
  })

  for (const ground of ['light', 'dark'] as const) {
    it(`gives axe nothing to report on the page, ${ground}`, async () => {
      window.localStorage.setItem('sb.theme', ground)
      switchedOn()
      scripted(
        createChat()
          .user(QUESTION)
          .assistant(({ writer }) => {
            writer.tool('simulate_sale', { input: {} }).output({})
            writer.text('Réponse.', { mode: 'instant' })
          }),
      )
      server.use(http.get(ROUTES.agentThreads, () => HttpResponse.json([])))
      const { user, main } = await openPage()
      expect(document.documentElement.classList.contains('dark')).toBe(ground === 'dark')
      await ask(user, main, QUESTION)
      await within(main).findAllByText('Réponse.')

      // jsdom draws nothing, so contrast is not axe's to measure here: the
      // CIF line and the secondary text are `--muted-foreground`, whose 4.5:1
      // on both grounds `themeCut.test.ts` asserts.
      const results = await axe.run(main, { rules: { 'color-contrast': { enabled: false } } })
      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
    })
  }

  it('keeps the CIF line under the input in every state', async () => {
    switchedOn()
    const { main } = await openPage()
    const cif = await within(main).findByText(
      'Simulations à partir de vos données déclarées, pas un conseil en investissement.',
    )
    const field = within(main).getByRole('textbox', { name: 'Votre question' })
    expect(field.compareDocumentPosition(cif) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(cif).toHaveClass('text-muted-foreground')
  })
})
