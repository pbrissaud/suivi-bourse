/**
 * The analyst panel (#1117), the whole app in jsdom.
 *
 * **Every conversation is scripted** with `@shadcn/helpers/ai-sdk`: its
 * `chat.transport()` stands in for the HTTP transport at the one seam the
 * panel asks (`analystSeam`), so no model, no key and no `/agent` are needed —
 * the rest (the config read, the positions, the threads) is HTTP faked by msw
 * as everywhere else.
 */
import { createChat } from '@shadcn/helpers/ai-sdk'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { analystSeam } from '@/lib/analyst'
import { THREAD_STORAGE_KEY } from '@/lib/analystPanel'
import { type AgentConfig, ROUTES } from '@/lib/api'
import { anAgentConfig } from '@/test/factories'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

type Script = ReturnType<typeof createChat>

const QUESTION = 'Si je vends mes Zeta Alpha, combien je paie ?'

function switchedOn(overrides: Partial<AgentConfig> = {}) {
  server.use(
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

/** Every `Chat` the panel builds streams `script`, at no delay. */
function scripted(script: Script) {
  const sent = vi.fn()
  vi.spyOn(analystSeam, 'transport').mockImplementation(() => {
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

async function openPanel(width = 1440) {
  setViewportWidth(width)
  const view = renderApp()
  await view.user.click(await screen.findByRole('button', { name: 'Analyste' }))
  const panel = await screen.findByRole('complementary', { name: 'Analyste' })
  return { ...view, panel }
}

async function ask(user: ReturnType<typeof renderApp>['user'], panel: HTMLElement, text: string) {
  await user.type(within(panel).getByRole('textbox', { name: 'Votre question' }), text)
  await user.click(within(panel).getByRole('button', { name: 'Envoyer' }))
}

// ------------------------------------------------------------------------ //

describe('the states (4A)', () => {
  it('is off: the button stays, the panel says what to connect', async () => {
    const { panel } = await openPanel()
    expect(
      await within(panel).findByText(
        'Branchez un modèle pour poser des questions sur votre portefeuille',
      ),
    ).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Configurer' })).toHaveAttribute(
      'href',
      '/settings',
    )
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('offers three questions built from the portfolio on an empty thread, each one click', async () => {
    switchedOn()
    const { user, panel } = await openPanel()
    const offered = await within(panel).findAllByRole('button', { name: /\?$/ })
    expect(offered).toHaveLength(3)
    // The largest held line of the fixture, by value: 10 × 130 against
    // 4 × 100 (converted) and 600 carried at cost.
    expect(offered[0]).toHaveAccessibleName(/Zeta Alpha/)

    const question = offered[1].textContent ?? ''
    const sent = scripted(createChat().user(question).assistant('Oui, chaque mois.'))
    // The panel was built before the spy: a new thread picks the script up.
    await user.click(within(panel).getByRole('button', { name: 'Nouveau fil' }))
    await user.click((await within(panel).findAllByRole('button', { name: /\?$/ }))[1])

    expect(await within(panel).findByText('Oui, chaque mois.')).toBeInTheDocument()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(within(panel).queryAllByRole('button', { name: /\?$/ })).toHaveLength(0)
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
    const { user, panel } = await openPanel()
    await ask(user, panel, QUESTION)

    expect(await within(panel).findByText('Simulation en cours…')).toBeInTheDocument()
    expect(within(panel).getByText('Simulation d’une vente, impôts et frais compris.'))
    expect(within(panel).getByRole('button', { name: 'Arrêter' })).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Envoyer' })).not.toBeInTheDocument()

    expect(await within(panel).findByText('La vente laisserait 812,50 €.')).toBeInTheDocument()
    expect(within(panel).queryByText('Simulation en cours…')).not.toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Envoyer' })).toBeInTheDocument()
  })

  it('says a provider error in its words, keeps the message, and offers Réessayer', async () => {
    switchedOn()
    const sent = scripted(createChat().user(QUESTION).error('Anthropic: invalid x-api-key'))
    const { user, panel } = await openPanel()
    await ask(user, panel, QUESTION)

    const alert = await within(panel).findByRole('alert')
    expect(alert).toHaveTextContent('Anthropic: invalid x-api-key')
    expect(within(panel).getByText(QUESTION)).toBeInTheDocument()

    await user.click(within(alert).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(2))
    // The question again, as a new turn, and on screen once.
    expect(sent.mock.calls[1][0].parts).toEqual([{ type: 'text', text: QUESTION }])
    expect(await within(panel).findByRole('alert')).toBeInTheDocument()
    expect(within(panel).getAllByText(QUESTION)).toHaveLength(1)
  })

  it('marks Ollama experimental next to the model', async () => {
    switchedOn({ provider: 'ollama', model: 'qwen3:8b', base_url: 'http://ollama:11434' })
    const { panel } = await openPanel()
    expect(await within(panel).findByText('expérimental')).toBeInTheDocument()
    expect(within(panel).getByText(/Ollama · qwen3:8b/)).toBeInTheDocument()
  })

  it('names no experimental chip for a hosted provider', async () => {
    switchedOn()
    const { panel } = await openPanel()
    expect(await within(panel).findByText(/Anthropic · claude-sonnet-5-5/)).toBeInTheDocument()
    expect(within(panel).queryByText('expérimental')).not.toBeInTheDocument()
  })

  it('refuses an image or a PDF before anything is sent', async () => {
    switchedOn()
    const sent = scripted(createChat())
    const { panel } = await openPanel()
    const field = await within(panel).findByRole('textbox', { name: 'Votre question' })

    for (const file of [
      new File(['x'], 'releve.png', { type: 'image/png' }),
      new File(['x'], 'releve.pdf', { type: 'application/pdf' }),
    ]) {
      fireEvent.paste(field, { clipboardData: { files: [file], getData: () => '' } })
      const alert = await within(panel).findByRole('alert')
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
    const { user, panel } = await openPanel()
    await ask(user, panel, QUESTION)

    expect(
      await within(panel).findByText('Cette conversation ne sera pas gardée.'),
    ).toBeInTheDocument()
    expect(within(panel).getByText('Une réponse.')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument()
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
    const { user, panel } = await openPanel()
    await ask(user, panel, QUESTION)
    await within(panel).findByText('Fini.')

    const line = within(panel).getByText('Lecture de vos positions.').closest('details')
    expect(line).not.toBeNull()
    expect(line).not.toHaveAttribute('open')
    await user.click(within(line as HTMLElement).getByText('détail'))
    expect(line).toHaveAttribute('open')
    expect(line).toHaveTextContent('list_positions({})')
    expect(line).toHaveTextContent('"positions": []')
    // A tool this panel has no sentence for is named, never hidden.
    expect(within(panel).getByText('Appel de l’outil get_dividends.')).toBeInTheDocument()
  })
})

describe('the threads (12A)', () => {
  it('lists the recent ones, opens one, and deletes one', async () => {
    switchedOn()
    const deleted: string[] = []
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
      http.get(ROUTES.agentThread, ({ params }) =>
        HttpResponse.json({
          id: String(params.id),
          title: 'Vendre Zeta',
          messages: [
            { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Vendre Zeta ?' }] },
            {
              id: 'a1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Voici la simulation.' }],
            },
          ],
        }),
      ),
      http.delete(ROUTES.agentThread, ({ params }) => {
        deleted.push(String(params.id))
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { user, panel } = await openPanel()

    await user.click(within(panel).getByRole('button', { name: 'Fils récents' }))
    const list = await screen.findByRole('dialog')
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    await user.click(within(list).getByRole('button', { name: /^Vendre Zeta/ }))
    expect(await within(panel).findByText('Voici la simulation.')).toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: 'Fils récents' }))
    await user.click(
      await screen.findByRole('button', { name: 'Supprimer le fil « Vendre Zeta »' }),
    )
    await waitFor(() => expect(deleted).toEqual(['t1']))
    // The thread on screen was the one deleted: an empty one takes its place.
    expect(await within(panel).findByText(/Posez une question/)).toBeInTheDocument()
  })

  it('reads the thread this browser remembers back on the first opening', async () => {
    switchedOn()
    window.localStorage.setItem(THREAD_STORAGE_KEY, 't9')
    server.use(
      http.get(ROUTES.agentThread, ({ params }) =>
        HttpResponse.json({
          id: String(params.id),
          title: 'Hier',
          messages: [
            { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hier ?' }] },
            { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Réponse d’hier.' }] },
          ],
        }),
      ),
    )
    const { panel } = await openPanel()
    expect(await within(panel).findByText('Réponse d’hier.')).toBeInTheDocument()
  })

  it('starts an empty thread, silently, when the remembered one is gone', async () => {
    switchedOn()
    window.localStorage.setItem(THREAD_STORAGE_KEY, 'gone')
    server.use(
      http.get(ROUTES.agentThread, () =>
        HttpResponse.json({ error: 'No conversation has this id.' }, { status: 404 }),
      ),
    )
    const { panel } = await openPanel()
    expect(await within(panel).findByText(/Posez une question/)).toBeInTheDocument()
    expect(within(panel).queryByRole('alert')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(THREAD_STORAGE_KEY)).toBeNull()
  })

  it('keeps the remembered thread when the server cannot be reached', async () => {
    switchedOn()
    window.localStorage.setItem(THREAD_STORAGE_KEY, 'kept')
    server.use(http.get(ROUTES.agentThread, () => HttpResponse.error()))
    const { panel } = await openPanel()
    expect(await within(panel).findByText(/Posez une question/)).toBeInTheDocument()
    expect(window.localStorage.getItem(THREAD_STORAGE_KEY)).toBe('kept')
  })

  it('shows the thread asked for last, whatever order the reads land in', async () => {
    switchedOn()
    server.use(
      http.get(ROUTES.agentThreads, () =>
        HttpResponse.json([
          { id: 'slow', title: 'Lent', created_at: null, updated_at: null },
          { id: 'fast', title: 'Rapide', created_at: null, updated_at: null },
        ]),
      ),
      http.get(ROUTES.agentThread, async ({ params }) => {
        const id = String(params.id)
        if (id === 'slow') await new Promise((done) => setTimeout(done, 300))
        return HttpResponse.json({
          id,
          title: id,
          messages: [
            { id: `a-${id}`, role: 'assistant', parts: [{ type: 'text', text: `Fil ${id}.` }] },
          ],
        })
      }),
    )
    const { user, panel } = await openPanel()
    const recent = () => user.click(within(panel).getByRole('button', { name: 'Fils récents' }))

    await recent()
    await user.click(await screen.findByRole('button', { name: /^Lent/ }))
    await recent()
    await user.click(await screen.findByRole('button', { name: /^Rapide/ }))

    expect(await within(panel).findByText('Fil fast.')).toBeInTheDocument()
    await new Promise((done) => setTimeout(done, 400))
    expect(within(panel).getByText('Fil fast.')).toBeInTheDocument()
    expect(within(panel).queryByText('Fil slow.')).not.toBeInTheDocument()
  })

  it('keeps the thread when the panel is closed and opened again', async () => {
    switchedOn()
    scripted(createChat().user(QUESTION).assistant('Gardé.'))
    const { user, panel } = await openPanel()
    await ask(user, panel, QUESTION)
    await within(panel).findByText('Gardé.')

    await user.click(within(panel).getByRole('button', { name: 'Fermer l’analyste' }))
    expect(screen.queryByRole('complementary', { name: 'Analyste' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Analyste' }))
    const again = await screen.findByRole('complementary', { name: 'Analyste' })
    expect(within(again).getByText('Gardé.')).toBeInTheDocument()
  })
})

describe('the layouts (10A)', () => {
  it('docks beside the page from 1 440 px, outside main and outside any dialog', async () => {
    switchedOn()
    const { panel } = await openPanel(1440)
    expect(panel.closest('main')).toBeNull()
    expect(panel.closest('[role="dialog"]')).toBeNull()
    expect(panel).toHaveClass('w-[380px]')
    // The page is still there beside it.
    expect(screen.getByRole('main')).toBeInTheDocument()
  })

  it('lies over the page as a right sheet from 768 to 1 439 px', async () => {
    switchedOn()
    const { panel } = await openPanel(1024)
    const sheet = panel.closest('[role="dialog"]')
    expect(sheet).not.toBeNull()
    expect(sheet).toHaveClass('w-[380px]')
    expect(within(panel).getByRole('button', { name: 'Fermer l’analyste' })).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Retour' })).not.toBeInTheDocument()
  })

  it('takes the whole screen under 768 px, with a back button', async () => {
    switchedOn()
    const { user, panel } = await openPanel(390)
    const sheet = panel.closest('[role="dialog"]')
    expect(sheet).toHaveClass('w-full')
    expect(
      within(panel).queryByRole('button', { name: 'Fermer l’analyste' }),
    ).not.toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Retour' }))
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Analyste' })).not.toBeInTheDocument(),
    )
  })

  it('hands its own element to the lists it portals in sheet mode', async () => {
    switchedOn()
    server.use(http.get(ROUTES.agentThreads, () => HttpResponse.json([])))
    const { user, panel } = await openPanel(1024)
    await user.click(within(panel).getByRole('button', { name: 'Fils récents' }))
    const list = await screen.findByText('Aucune conversation gardée pour l’instant.')
    expect(panel.closest('[role="dialog"]')?.contains(list)).toBe(true)
  })
})

describe('accessibility (11A)', () => {
  it('opens and closes on ⌘/Ctrl + J, focus to the input and back to the button', async () => {
    switchedOn()
    setViewportWidth(1440)
    const { user } = renderApp()
    const button = await screen.findByRole('button', { name: 'Analyste' })

    await user.keyboard('{Control>}j{/Control}')
    const panel = await screen.findByRole('complementary', { name: 'Analyste' })
    const field = await within(panel).findByRole('textbox', { name: 'Votre question' })
    await waitFor(() => expect(field).toHaveFocus())

    await user.keyboard('{Meta>}j{/Meta}')
    expect(screen.queryByRole('complementary', { name: 'Analyste' })).not.toBeInTheDocument()
    await waitFor(() => expect(button).toHaveFocus())
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
    const { user, panel } = await openPanel()
    const live = panel.querySelector('[aria-live="polite"]') as HTMLElement
    expect(live).toHaveTextContent('')
    await ask(user, panel, QUESTION)

    await waitFor(() => expect(live).toHaveTextContent('Réponse en cours'))
    await waitFor(() => expect(live).toHaveTextContent('Voici la réponse entière.'))
    // The streamed log itself is silenced: only the region above speaks.
    expect(panel.querySelector('[role="log"]')).toHaveAttribute('aria-live', 'off')
  })

  it('keeps every control of the panel at 44 px or more', async () => {
    switchedOn()
    const { panel } = await openPanel()
    await within(panel).findAllByRole('button', { name: /\?$/ })
    for (const button of within(panel).getAllByRole('button')) {
      expect(button.className, button.textContent ?? '').toMatch(/\b(?:size-11|min-h-11)\b/)
    }
  })

  for (const ground of ['light', 'dark'] as const) {
    it(`gives axe nothing to report on the panel, ${ground}`, async () => {
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
      const { user, panel } = await openPanel()
      expect(document.documentElement.classList.contains('dark')).toBe(ground === 'dark')
      await ask(user, panel, QUESTION)
      await within(panel).findByText('Réponse.')

      // jsdom draws nothing, so contrast is not axe's to measure here: the
      // CIF line and the secondary text are `--muted-foreground` on `--muted`,
      // whose 4.5:1 on both grounds `themeCut.test.ts` asserts.
      const results = await axe.run(panel, { rules: { 'color-contrast': { enabled: false } } })
      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
    })
  }

  it('keeps the CIF line under the input in every state', async () => {
    switchedOn()
    const { panel } = await openPanel()
    const cif = await within(panel).findByText(
      'Simulations à partir de vos données déclarées, pas un conseil en investissement.',
    )
    const field = within(panel).getByRole('textbox', { name: 'Votre question' })
    expect(field.compareDocumentPosition(cif) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(cif).toHaveClass('text-muted-foreground')
  })
})
