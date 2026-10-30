/**
 * **Giving the agent a broker statement** (#1120): the box that asks before the
 * text leaves, the files it takes and the ones it still refuses.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { anAgentConfig } from '@/test/factories'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const ID = 'e'.repeat(32)

function switchedOn() {
  server.use(
    http.get(ROUTES.agentThreads, () => HttpResponse.json([])),
    http.get(ROUTES.agentConfig, () =>
      HttpResponse.json(
        anAgentConfig({
          enabled: true,
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          key: { set: true, last4: 'wxyz', set_at: null },
        }),
      ),
    ),
  )
}

async function openPage() {
  setViewportWidth(1024)
  const view = renderApp({ url: '/agent' })
  await screen.findByRole('heading', { level: 1, name: 'Agent' })
  return { ...view, main: screen.getByRole('main') }
}

const STATEMENT = 'AMUNDI MSCI WORLD  12  512,40'

describe('giving the agent a statement (#1120)', () => {
  it('names the provider, asks for an account, and sends once confirmed', async () => {
    switchedOn()
    const posted: unknown[] = []
    let reread = 0
    server.use(
      http.post(ROUTES.agentStatements, async ({ request }) => {
        posted.push(await request.json())
        return HttpResponse.json(
          {
            proposal: {
              id: ID,
              kind: 'events',
              title: 'Relevé texte collé',
              status: 'ready',
              count: 0,
              events: [],
              created_at: '2026-10-30T09:00:00+00:00',
              decided_at: null,
            },
            thread_id: 'x',
          },
          { status: 201 },
        )
      }),
      http.get(ROUTES.agentThread, () => {
        reread += 1
        return HttpResponse.json({
          id: 'x',
          title: 'x',
          failed: false,
          messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Relevé donné.' }] }],
        })
      }),
    )
    const { user, main } = await openPage()

    await user.click(await within(main).findByRole('button', { name: 'Donner un relevé' }))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(
        'Ce relevé sera envoyé à Anthropic (claude-sonnet-5-5). Rien n’est inscrit avant votre revue.',
      ),
    ).toBeInTheDocument()
    const send = within(dialog).getByRole('button', { name: 'Envoyer' })
    expect(send).toBeDisabled()

    await user.type(within(dialog).getByRole('textbox', { name: 'Texte du relevé' }), STATEMENT)
    expect(send).toBeDisabled() // no account, no send
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Compte du relevé' }),
      'beta',
    )
    expect(send).toBeEnabled()
    await user.click(send)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(posted).toEqual([
      {
        thread_id: expect.any(String),
        account: 'beta',
        provider: 'anthropic',
        name: 'texte collé',
        text: STATEMENT,
      },
    ])
    await waitFor(() => expect(reread).toBe(1))
  })

  it('says the server’s sentence and keeps the box open when the statement is refused', async () => {
    switchedOn()
    server.use(
      http.post(ROUTES.agentStatements, () =>
        HttpResponse.json({ error: 'Anthropic: invalid x-api-key' }, { status: 502 }),
      ),
    )
    const { user, main } = await openPage()
    await user.click(await within(main).findByRole('button', { name: 'Donner un relevé' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox', { name: 'Texte du relevé' }), STATEMENT)
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Compte du relevé' }),
      'beta',
    )

    await user.click(within(dialog).getByRole('button', { name: 'Envoyer' }))

    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      'Anthropic: invalid x-api-key',
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('counts the characters and refuses past 50 000 before anything is sent', async () => {
    switchedOn()
    let posted = false
    server.use(
      http.post(ROUTES.agentStatements, () => {
        posted = true
        return HttpResponse.json({}, { status: 201 })
      }),
    )
    const { user, main } = await openPage()
    await user.click(await within(main).findByRole('button', { name: 'Donner un relevé' }))
    const dialog = await screen.findByRole('dialog')
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Compte du relevé' }),
      'beta',
    )
    const field = within(dialog).getByRole('textbox', { name: 'Texte du relevé' })

    fireEvent.change(field, { target: { value: 'x'.repeat(50_000) } })
    expect(within(dialog).getByText(/50\s?000 \/ 50\s?000 caractères/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Envoyer' })).toBeEnabled()

    fireEvent.change(field, { target: { value: 'x'.repeat(50_001) } })
    expect(within(dialog).getByText(/dépasse 50\s?000 caractères/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Envoyer' })).toBeDisabled()
    expect(posted).toBe(false)
  })

  it('opens the box on a dropped .csv, with its text, and still refuses a PDF', async () => {
    switchedOn()
    let posted = false
    server.use(
      http.post(ROUTES.agentStatements, () => {
        posted = true
        return HttpResponse.json({}, { status: 201 })
      }),
    )
    const { main } = await openPage()
    const field = await within(main).findByRole('textbox', { name: 'Votre question' })

    fireEvent.drop(field, {
      dataTransfer: { files: [new File(['a;b\n1;2'], 'releve.pdf', { type: 'application/pdf' })] },
    })
    expect(await within(main).findByRole('alert')).toHaveTextContent('releve.pdf')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.drop(field, {
      dataTransfer: { files: [new File([STATEMENT], 'releve.csv', { type: 'text/csv' })] },
    })
    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: 'Texte du relevé' })).toHaveValue(
        STATEMENT,
      ),
    )
    expect(posted).toBe(false)
  })
})
