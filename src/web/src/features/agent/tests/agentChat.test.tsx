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

import type { UIMessage } from 'ai'

import { agentSeam, httpTransport, pendingAnswer } from '@/features/agent/lib/agentChat'
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

/** The error chunk of a provider's failed turn, as the server writes it (#1269). */
const refusedTurn = (reason: string) =>
  JSON.stringify({ error: 'Anthropic: overloaded_error', provider: 'Anthropic', reason })

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
      '/settings#agent',
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

    const sentence = await within(main).findByText('Simulation d’une vente et de son impôt.')
    expect(sentence.closest('[data-slot=trace-line]')).toHaveAttribute('data-status', 'running')
    // One thing moves at a time: the running call, not the waiting line too.
    expect(within(main).queryByText(fr['agent.waiting'])).not.toBeInTheDocument()
    expect(within(main).getByRole('button', { name: 'Arrêter' })).toBeInTheDocument()
    expect(within(main).queryByRole('button', { name: 'Envoyer' })).not.toBeInTheDocument()

    expect(await within(main).findByText('La vente laisserait 812,50 €.')).toBeInTheDocument()
    expect(within(main).getByRole('button', { name: 'Envoyer' })).toBeInTheDocument()
  })

  it('shimmers the running call, and stops when the turn is stopped mid-call', async () => {
    switchedOn()
    scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer.tool('simulate_sale', { input: {} }).sleep(5000).output({})
        }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    const sentence = await within(main).findByText('Simulation d’une vente et de son impôt.')
    const line = sentence.closest('[data-slot=trace-line]') as HTMLElement
    expect(line).toHaveAttribute('data-status', 'running')
    await user.click(within(main).getByRole('button', { name: 'Arrêter' }))
    // The answer never comes: the line says so rather than shimmering on.
    await within(main).findByRole('button', { name: 'Envoyer' })
    expect(
      within(main)
        .getByText('Simulation d’une vente et de son impôt.')
        .closest('[data-slot=trace-line]'),
    ).toHaveAttribute('data-status', 'error')
  })

  it('says a provider error in its words, keeps the message, and offers Réessayer', async () => {
    switchedOn()
    const sent = scripted(createChat().user(QUESTION).error(refusedTurn('overloaded')))
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    const alert = await within(main).findByRole('alert')
    expect(alert).toHaveTextContent('Anthropic est momentanément indisponible')
    await user.click(within(alert).getByRole('button', { name: 'Message brut (Anthropic)' }))
    expect(alert).toHaveTextContent('overloaded_error')
    expect(within(main).getByText(QUESTION)).toBeInTheDocument()

    await user.click(within(alert).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(2))
    // The question again, as a new turn, and on screen once.
    expect(sent.mock.calls[1][0].parts).toEqual([{ type: 'text', text: QUESTION }])
    expect(await within(main).findByRole('alert')).toBeInTheDocument()
    expect(within(main).getAllByText(QUESTION)).toHaveLength(1)
  })

  it('says a failure that is not the provider’s as it came, with Réessayer and no settings link', async () => {
    switchedOn()
    scripted(createChat().user(QUESTION).error("The agent: 'a bug'"))
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    const alert = await within(main).findByRole('alert')
    expect(alert).toHaveTextContent("The agent: 'a bug'")
    expect(within(alert).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
    expect(within(alert).queryByRole('link')).not.toBeInTheDocument()
  })

  it('says a retired model in a sentence, with the raw message folded and a link to the agent settings', async () => {
    switchedOn()
    scripted(createChat().user(QUESTION).error(refusedTurn('model')))
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    const alert = await within(main).findByRole('alert')
    expect(alert).toHaveTextContent(
      'Anthropic ne propose plus ce modèle : testez la connexion pour en choisir un autre.',
    )
    expect(within(alert).queryByText('overloaded_error')).not.toBeInTheDocument()
    expect(
      within(alert).getByRole('link', { name: 'Ouvrir les réglages de l’agent' }),
    ).toHaveAttribute('href', '/settings#agent')
    expect(within(alert).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })

  it('says a quota refusal with a link to the agent settings', async () => {
    switchedOn()
    scripted(createChat().user(QUESTION).error(refusedTurn('quota')))
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    const alert = await within(main).findByRole('alert')
    expect(alert).toHaveTextContent('Anthropic refuse faute de crédit')
    expect(
      within(alert).getByRole('link', { name: 'Ouvrir les réglages de l’agent' }),
    ).toBeInTheDocument()
  })

  it('offers no settings link for a refusal Settings cannot mend', async () => {
    switchedOn()
    scripted(createChat().user(QUESTION).error(refusedTurn('rate_limit')))
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    const alert = await within(main).findByRole('alert')
    expect(alert).toHaveTextContent('Anthropic limite le nombre de requêtes')
    expect(within(alert).queryByRole('link')).not.toBeInTheDocument()
  })

  it('names the model by its display name, and by its id when it has none', async () => {
    switchedOn({ model_name: 'Claude Sonnet 5.5' })
    const { main } = await openPage()
    expect(await within(main).findByText(/Anthropic · Claude Sonnet 5\.5/)).toBeInTheDocument()
  })

  it('names the model by its id when it has no display name', async () => {
    switchedOn({ model_name: null })
    const { main } = await openPage()
    expect(await within(main).findByText(/Anthropic · claude-sonnet-5-5/)).toBeInTheDocument()
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
  it('show the plain sentence, and the raw call behind its chevron', async () => {
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

    const trigger = within(main).getByRole('button', { name: 'Lecture de vos positions.' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const line = trigger.closest('[data-slot=trace-collapsible]') as HTMLElement
    expect(line).toHaveTextContent('list_positions({})')
    expect(line).toHaveTextContent('"positions": []')
    // Coloured once shiki has loaded the JSON grammar, on the first opening.
    await waitFor(() => expect(line.querySelector('[style*="--shiki-light"]')).not.toBeNull())
    // A tool the page has no sentence for is named, never hidden.
    expect(within(main).getByText('Appel de l’outil get_dividends.')).toBeInTheDocument()
  })

  it('round a float to six figures in the raw output, and leave an integer whole', async () => {
    switchedOn()
    scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer
            .tool('simulate_sale', { input: {} })
            .output({ net: 16626.385821235686, quantity: 1234567, lines: [{ pru: 1.23456789 }] })
          writer.text('Fini.', { mode: 'instant' })
        }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)
    await within(main).findAllByText('Fini.')

    const trigger = within(main).getByRole('button', {
      name: 'Simulation d’une vente et de son impôt.',
    })
    await user.click(trigger)
    const line = trigger.closest('[data-slot=trace-collapsible]') as HTMLElement
    expect(line).toHaveTextContent('"net": 16626.4')
    expect(line).not.toHaveTextContent('16626.385')
    // Seven digits, kept whole: an integer is a count, never rounded.
    expect(line).toHaveTextContent('"quantity": 1234567')
    expect(line).toHaveTextContent('"pru": 1.23457')
  })
})

describe('the answer', () => {
  it('draws its Markdown, and keeps neither a link nor a heading of its own', async () => {
    switchedOn()
    scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer.text(
            '## Vue\n\n**Gain** total de `gain_absolu` :\n\n- PEA\n- [CTO](https://example.com)\n\n![Courbe](https://example.com/x.png?d=secret)\n\n<b>brut</b>',
            { mode: 'instant' },
          )
        }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    // The conversation, not the region announcing it once more.
    const log = main.querySelector('[role="log"]') as HTMLElement
    const strong = await within(log).findByText('Gain')
    expect(strong.tagName).toBe('STRONG')
    expect(within(main).queryByText(/\*\*/)).toBeNull()
    expect(
      within(log)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['PEA', 'CTO'])
    // The page has one outline, and an address in an answer is not followed.
    expect(within(main).queryByRole('heading', { name: 'Vue' })).toBeNull()
    expect(within(main).queryByRole('link', { name: 'CTO' })).toBeNull()
    // Nor is an image fetched: its URL would carry whatever the model put in it.
    expect(main.querySelector('img')).toBeNull()
    expect(within(log).getByText('Courbe')).toBeInTheDocument()
    // Raw HTML is not drawn either.
    expect(log.querySelector('b')).toBeNull()
    expect(within(log).getByText(/total de gain_absolu/)).toBeInTheDocument()
  })

  it('draws a table in a scroll box, an ordered list, and a code block as plain text', async () => {
    switchedOn()
    scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer.text(
            '# Bilan\n\n| Compte | Gain |\n| --- | --- |\n| PEA | 12 € |\n\n1. un\n2. deux\n\n```\nnet_proceeds\n```',
            { mode: 'instant' },
          )
        }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    const log = main.querySelector('[role="log"]') as HTMLElement
    const table = await within(log).findByRole('table')
    expect(table.parentElement).toHaveClass('overflow-x-auto')
    expect(within(table).getByRole('columnheader', { name: 'Compte' })).toBeInTheDocument()
    expect(within(table).getByRole('cell', { name: '12 €' })).toBeInTheDocument()
    const ordered = log.querySelector('ol') as HTMLElement
    expect(
      within(ordered)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['un', 'deux'])
    expect(log.querySelector('pre, code')).toBeNull()
    expect(within(log).getByText('net_proceeds').tagName).toBe('P')
    expect(within(main).queryByRole('heading', { name: 'Bilan' })).toBeNull()
  })

  it('announces the answer drawn, not its Markdown', async () => {
    switchedOn()
    scripted(createChat().user(QUESTION).assistant('**Gain** de 12 €.'))
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    const live = main.querySelector('[aria-live="polite"]') as HTMLElement
    await waitFor(() => expect(live).toHaveTextContent('Gain de 12 €.'))
    expect(live.textContent).not.toContain('**')
    expect(within(live).getByText('Gain').tagName).toBe('STRONG')
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
    // Asked in the row, naming the thread, with the harmless answer focused.
    expect(
      within(column).getByText('Supprimer ce fil ? La conversation est effacée.'),
    ).toBeInTheDocument()
    expect(within(column).getByText('Vendre Zeta')).toBeInTheDocument()
    expect(within(column).getByRole('button', { name: 'Le garder' })).toHaveFocus()
    expect(deleted).toEqual([])
    await user.click(within(column).getByRole('button', { name: 'Supprimer' }))
    await waitFor(() => expect(deleted).toEqual(['t1']))
    // The thread on screen was the one deleted: an empty one takes its place.
    expect(await within(main).findByText(/Posez une question/)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/agent')
    expect(router.history.length).toBe(before)
  })

  it('keeps the menu open on Escape under 1 024 px, closing only the question', async () => {
    switchedOn()
    const { deleted } = storedThreads()
    const { user, main } = await openPage('/agent', 1023)
    await user.click(await within(main).findByRole('button', { name: 'Fils récents' }))
    const menu = await screen.findByRole('dialog')

    await user.click(
      await within(menu).findByRole('button', { name: 'Supprimer le fil « Vendre Zeta »' }),
    )
    expect(within(menu).getByRole('button', { name: 'Le garder' })).toHaveFocus()
    await user.keyboard('{Escape}')

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(menu).queryByRole('button', { name: 'Le garder' })).toBeNull()
    expect(deleted).toEqual([])
  })

  it('keeps a thread on Le garder or Escape, and gives focus back to its bin', async () => {
    switchedOn()
    const { deleted } = storedThreads()
    const { user, main } = await openPage()
    const column = await within(main).findByRole('navigation', { name: 'Fils récents' })
    const bin = await within(column).findByRole('button', {
      name: 'Supprimer le fil « Vendre Zeta »',
    })

    await user.click(bin)
    await user.click(within(column).getByRole('button', { name: 'Le garder' }))
    await waitFor(() =>
      expect(
        within(column).getByRole('button', { name: 'Supprimer le fil « Vendre Zeta »' }),
      ).toHaveFocus(),
    )

    await user.click(
      within(column).getByRole('button', { name: 'Supprimer le fil « Vendre Zeta »' }),
    )
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(
        within(column).getByRole('button', { name: 'Supprimer le fil « Vendre Zeta »' }),
      ).toHaveFocus(),
    )
    expect(within(column).queryByRole('button', { name: 'Le garder' })).toBeNull()
    expect(deleted).toEqual([])
  })

  it('says a deletion the server refused, and keeps the thread listed', async () => {
    switchedOn()
    storedThreads()
    server.use(
      http.delete(ROUTES.agentThread, () =>
        HttpResponse.json({ error: 'The store is unavailable.' }, { status: 503 }),
      ),
    )
    const { user, main } = await openPage()
    const column = await within(main).findByRole('navigation', { name: 'Fils récents' })

    await user.click(
      await within(column).findByRole('button', { name: 'Supprimer le fil « Vendre Zeta »' }),
    )
    await user.click(within(column).getByRole('button', { name: 'Supprimer' }))
    expect(await within(column).findByRole('status')).toHaveTextContent('The store is unavailable.')
    expect(within(column).getByRole('link', { name: /^Vendre Zeta/ })).toBeInTheDocument()
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
    await within(main).findByText('Simulation d’une vente et de son impôt.')
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
    await within(main).findByText('Simulation d’une vente et de son impôt.')
    const thread = router.state.location.pathname

    await router.navigate({ to: '/' })
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })
    const nav = screen.getByRole('navigation', { name: 'Sections' })
    await user.click(within(nav).getByRole('link', { name: 'Agent' }))

    // Twice once whole: on screen, and in the polite region that announces it (11A).
    expect((await screen.findAllByText('La réponse entière.'))[0]).toBeInTheDocument()
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
    await within(main).findByText('Simulation d’une vente et de son impôt.')
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

  it('is led back to by the ⌘K palette too, not to a new thread (#1196)', async () => {
    switchedOn()
    storedThreads()
    const { user, router } = await openPage('/agent/t1')
    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('searchbox'), 'Agent')
    const pages = await screen.findByRole('list', { name: 'Pages' })
    await user.click(within(pages).getByRole('button', { name: 'Agent' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/agent/t1'))
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

  it('describes the input by its keys', async () => {
    switchedOn()
    const { main } = await openPage()
    expect(
      await within(main).findByRole('textbox', { name: 'Votre question' }),
    ).toHaveAccessibleDescription(fr['agent.input.hint'])
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

// ------------------------------------------------------------------------ //

const assistant = (...parts: UIMessage['parts']): UIMessage => ({
  id: 'a',
  role: 'assistant',
  parts,
})
const tool = (state: 'input-available' | 'output-available') =>
  ({
    type: 'tool-simulate_sale',
    toolCallId: 'c',
    state,
    input: {},
    ...(state === 'output-available' ? { output: {} } : {}),
  }) as UIMessage['parts'][number]

describe('pendingAnswer (#1271)', () => {
  const table: [string, string, UIMessage | undefined, boolean][] = [
    ['the question just sent', 'submitted', assistant(), true],
    ['no assistant message yet', 'streaming', { id: 'u', role: 'user', parts: [] }, true],
    ['no message at all', 'streaming', undefined, true],
    ['a running tool', 'streaming', assistant(tool('input-available')), false],
    ['an answered tool at the tail', 'streaming', assistant(tool('output-available')), true],
    [
      'reasoning at the tail',
      'streaming',
      assistant({ type: 'text', text: 'Début.' }, { type: 'reasoning', text: 'Hmm' }),
      true,
    ],
    ['empty text', 'streaming', assistant({ type: 'text', text: '  ' }), true],
    ['the first word', 'streaming', assistant({ type: 'text', text: 'Bonjour' }), false],
    [
      'text then a tool answered',
      'streaming',
      assistant({ type: 'text', text: 'Un' }, tool('output-available')),
      true,
    ],
    ['a turn that is ready', 'ready', assistant(tool('output-available')), false],
    ['a turn that failed', 'error', assistant(), false],
  ]
  for (const [name, status, last, expected] of table) {
    it(`is ${expected} on ${name}`, () => expect(pendingAnswer(status, last)).toBe(expected))
  }
})

describe('the reasoning of a stored thread (#1191)', () => {
  it('is never drawn', async () => {
    switchedOn()
    server.use(
      http.get(ROUTES.agentThread, ({ params }) =>
        HttpResponse.json({
          id: String(params.id),
          title: 'Revenu',
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              parts: [
                { type: 'reasoning', text: 'Je pèse les options.' },
                { type: 'text', text: 'Voici la réponse.' },
              ],
            },
          ],
        }),
      ),
    )
    const { main } = await openPage('/agent/t1')

    expect(await within(main).findByText('Voici la réponse.')).toBeInTheDocument()
    expect(within(main).queryByText(/Je pèse les options/)).not.toBeInTheDocument()
  })
})

describe('the silence before the answer (#1271)', () => {
  const pending = (main: HTMLElement) =>
    within(main).queryByText(fr['agent.waiting'])?.closest('[data-slot=trace-line]') ?? null

  it('shows the waiting line after the tool answers and while the model thinks, until the first word', async () => {
    switchedOn()
    scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer.tool('simulate_sale', { input: {} }).output({})
          writer.sleep(300).reasoning('Je réfléchis.', { mode: 'instant' })
          writer.sleep(300).text('premier deuxième troisième quatrième dernier', { delayMs: 150 })
        }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    const line = await within(main).findByText(fr['agent.waiting'])
    expect(line.closest('[data-slot=trace-line]')).toHaveAttribute('data-status', 'running')
    // Not a disclosure: no chevron to open.
    expect(line.closest('button')).toBeNull()
    expect(within(main).queryByText('Je réfléchis.')).not.toBeInTheDocument()

    await within(main).findByText(/premier/)
    expect(pending(main)).toBeNull()
    // The first word is on screen while the last is not.
    expect(within(main).queryByText(/dernier/)).not.toBeInTheDocument()
    await waitFor(() => expect(within(main).getByText(/dernier/)).toBeInTheDocument())
  })

  it('drops the waiting line when the reader stops the turn during the text', async () => {
    switchedOn()
    scripted(
      createChat()
        .user(QUESTION)
        .assistant(({ writer }) => {
          writer.text('premier deuxième troisième quatrième dernier', { delayMs: 400 })
        }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)
    await within(main).findByText(/premier/)
    await user.click(within(main).getByRole('button', { name: 'Arrêter' }))

    await within(main).findByRole('button', { name: 'Envoyer' })
    expect(pending(main)).toBeNull()
    // Twice: on screen, and in the polite region that announces it.
    expect(within(main).getAllByText(/premier/)[0]).toBeInTheDocument()
  })
})

// ------------------------------------------------------------------------ //

const FIRST = 'a'.repeat(32)
const SECOND = 'b'.repeat(32)

/** The server's read of the two proposals a turn made, both waiting on the reader. */
function proposalsReady() {
  server.use(
    http.get(ROUTES.profileProposals, () =>
      HttpResponse.json({
        proposals: [
          { id: FIRST, key: 'marginal_rate', value: 0.3, status: 'ready' },
          { id: SECOND, key: 'risk_tolerance', value: 'balanced', status: 'ready' },
        ].map((p) => ({ ...p, created_at: '2026-10-19T09:00:00+00:00', decided_at: null })),
      }),
    ),
  )
}

/** What a scripted turn's writer lets the rest of it say. */
type Writer = {
  text(text: string, options?: { mode?: 'instant'; delayMs?: number }): unknown
  error(errorText: string): unknown
}

/** A turn that proposes two facts before it writes, as the model does. */
function proposingTurn(after: (writer: Writer) => void) {
  return createChat()
    .user(QUESTION)
    .assistant(({ writer }) => {
      writer.tool('propose_profile_fact', {
        input: { key: 'marginal_rate', value: 0.3 },
        output: { proposal_id: FIRST, status: 'ready' },
      })
      writer.tool('propose_profile_fact', {
        input: { key: 'risk_tolerance', value: 'balanced' },
        output: { proposal_id: SECOND, status: 'ready' },
      })
      after(writer)
    })
}

describe('the proposals come under the answer (#1271)', () => {
  const follows = (a: Element, b: Element) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('draws no card while the turn streams, then both under the text in call order, the calls kept in the trace', async () => {
    switchedOn()
    proposalsReady()
    scripted(
      proposingTurn((writer) => {
        writer.text('Rien n’est noté avant votre accord.', { mode: 'instant' })
      }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    await within(main).findByRole('button', { name: 'Envoyer' })
    const confirms = await within(main).findAllByRole('button', { name: 'Confirmer' })
    expect(confirms).toHaveLength(2)
    const answer = within(main).getAllByText('Rien n’est noté avant votre accord.')[0]
    for (const confirm of confirms) expect(follows(answer, confirm)).toBe(true)
    expect(follows(confirms[0], confirms[1])).toBe(true)
    expect(within(main).getAllByText(fr['agent.tool.propose_profile_fact'])).toHaveLength(2)
  })

  it('keeps the cards away from a turn that is still writing', async () => {
    switchedOn()
    proposalsReady()
    scripted(
      proposingTurn((writer) => {
        writer.text('premier deuxième troisième quatrième dernier', { delayMs: 200 })
      }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    await within(main).findByText(/premier/)
    expect(within(main).queryByRole('button', { name: 'Confirmer' })).not.toBeInTheDocument()
  })

  it('puts the error block after the card when a turn fails after its text', async () => {
    switchedOn()
    proposalsReady()
    scripted(
      proposingTurn((writer) => {
        writer.text('Un début de réponse.', { mode: 'instant' })
        writer.error(refusedTurn('overloaded'))
      }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    const retry = await within(main).findByRole('button', { name: 'Réessayer' })
    const confirm = await within(main).findAllByRole('button', { name: 'Confirmer' })
    const text = within(main).getByText('Un début de réponse.')
    expect(follows(text, confirm[0])).toBe(true)
    expect(follows(confirm[1], retry)).toBe(true)
  })

  it('ends the announcement on the facts to confirm, and keeps the log silent', async () => {
    switchedOn()
    proposalsReady()
    scripted(
      proposingTurn((writer) => {
        writer.text('Voici la réponse.', { mode: 'instant' })
      }),
    )
    const { user, main } = await openPage()
    await ask(user, main, QUESTION)

    await waitFor(() =>
      expect(main.querySelector('[aria-live="polite"]')).toHaveTextContent(
        'Voici la réponse. 2 informations à confirmer sous la réponse.',
      ),
    )
    expect(main.querySelector('[role="log"]')).toHaveAttribute('aria-live', 'off')
    const { violations } = await axe.run(main)
    expect(violations).toEqual([])
  })
})

// ------------------------------------------------------------------------ //

/** The server's read of thread `t1`, as a stopped or failed turn leaves it (#1324). */
function readBack(thread: { failed: boolean; messages: UIMessage[] }) {
  server.use(
    http.get(ROUTES.agentThread, ({ params }) =>
      HttpResponse.json({ id: String(params.id), title: 'Fil', ...thread }),
    ),
  )
}

const asked = (text: string): UIMessage => ({
  id: 'u',
  role: 'user',
  parts: [{ type: 'text', text }],
})

describe('a turn that did not complete (#1324)', () => {
  const follows = (a: Element, b: Element) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('draws a call that failed or was cut off as halted, in a mark and in words', async () => {
    switchedOn()
    readBack({
      failed: false,
      messages: [
        asked(QUESTION),
        assistant(
          {
            type: 'tool-simulate_sale',
            toolCallId: 'cut',
            state: 'output-available',
            input: {},
            output: 'The tool call was interrupted before a result was produced.',
            callProviderMetadata: { pydantic_ai: { outcome: 'interrupted' } },
          },
          {
            type: 'tool-list_positions',
            toolCallId: 'broken',
            state: 'output-error',
            input: {},
            errorText: 'boom',
          },
          {
            type: 'tool-list_accounts',
            toolCallId: 'fine',
            state: 'output-available',
            input: {},
            output: {},
          },
        ),
      ],
    })
    const { main } = await openPage('/agent/t1')

    const halted = await within(main).findAllByRole('button', { name: /interrompu$/ })
    expect(halted.map((b) => b.textContent)).toEqual([
      'Simulation d’une vente et de son impôt. interrompu',
      'Lecture de vos positions. interrompu',
    ])
    for (const button of halted) {
      const line = button.querySelector('[data-slot=trace-line]')
      expect(line).toHaveAttribute('data-status', 'error')
      const mark = line?.querySelector('[data-slot=trace-icon]')
      expect(mark).toHaveAttribute('aria-hidden', 'true')
      expect(mark?.querySelector('svg')).not.toBeNull()
    }
    const fine = within(main).getByRole('button', { name: 'Lecture de vos comptes.' })
    expect(fine.querySelector('[data-slot=trace-line]')).not.toHaveAttribute('data-status')
  })

  it('draws a stopped turn’s card after its partial text, as the stream did', async () => {
    switchedOn()
    proposalsReady()
    readBack({
      failed: false,
      messages: [
        asked(QUESTION),
        assistant({
          type: 'tool-propose_profile_fact',
          toolCallId: 'p1',
          state: 'output-available',
          input: { key: 'marginal_rate', value: 0.3 },
          output: { proposal_id: FIRST, status: 'ready' },
        }),
        { ...assistant({ type: 'text', text: 'Je note votre taux' }), id: 'b' },
      ],
    })
    const { main } = await openPage('/agent/t1')

    const card = await within(main).findByRole('button', { name: 'Confirmer' })
    expect(follows(within(main).getByText('Je note votre taux'), card)).toBe(true)
    expect(within(main).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('drops a reloaded failed turn from the page when another question is asked, as the server does', async () => {
    switchedOn()
    readBack({
      failed: true,
      messages: [asked('Question t1 ?'), assistant({ type: 'text', text: 'Un début.' })],
    })
    const sent = scripted(
      createChat()
        .user('Autre chose ?')
        .assistant(({ writer }) => writer.text('Autre réponse.', { mode: 'instant' })),
    )
    const { user, main } = await openPage('/agent/t1')
    await within(main).findByRole('alert')

    await ask(user, main, 'Autre chose ?')

    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1))
    expect(sent.mock.calls[0][0].parts).toEqual([{ type: 'text', text: 'Autre chose ?' }])
    expect(await within(main).findByText('Autre réponse.')).toBeInTheDocument()
    expect(within(main).queryByText('Question t1 ?')).not.toBeInTheDocument()
    expect(within(main).queryByText('Un début.')).not.toBeInTheDocument()
    expect(within(main).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says a reloaded failed turn under its partial answer, and Réessayer asks the question again', async () => {
    switchedOn()
    readBack({
      failed: true,
      messages: [asked('Question t1 ?'), assistant({ type: 'text', text: 'Un début.' })],
    })
    const sent = scripted(
      createChat()
        .user('Question t1 ?')
        .assistant(({ writer }) => writer.text('La réponse entière.', { mode: 'instant' })),
    )
    const { user, main } = await openPage('/agent/t1')

    const alert = await within(main).findByRole('alert')
    expect(alert).toHaveTextContent(fr['agent.failed.reloaded'])
    expect(follows(within(main).getByText('Un début.'), alert)).toBe(true)

    await user.click(within(alert).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1))
    expect(sent.mock.calls[0][0].parts).toEqual([{ type: 'text', text: 'Question t1 ?' }])
    expect(await within(main).findByText('La réponse entière.')).toBeInTheDocument()
    expect(within(main).queryByRole('alert')).not.toBeInTheDocument()
    // The failed turn is replaced, not stacked.
    expect(within(main).queryByText('Un début.')).not.toBeInTheDocument()
    expect(within(main).getAllByText('Question t1 ?')).toHaveLength(1)
  })
})
