/**
 * A bug report the agent drafted (#1630): the card previews what the link
 * carries, and only a link to this repository's new issue draws one.
 */
import { screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { aProvider } from '@/features/agent/tests/agentFixtures'
import { ROUTES } from '@/lib/api'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const QUERY = 'title=Frozen%20price&body=%23%23%20Steps%0AThe%20price%20stays%20still.'
const URL_OK = `https://github.com/pbrissaud/suivi-bourse/issues/new?${QUERY}`

/** A stored thread whose answer drafted a report, opened in English. */
async function openThread(url: string, before: object[] = []) {
  server.use(
    http.get(ROUTES.agentThreads, () => HttpResponse.json([])),
    http.get(ROUTES.agentConfig, () => HttpResponse.json({ enabled: true, reasoning: 'low' })),
    http.get(ROUTES.agentProviders, () => HttpResponse.json([aProvider()])),
    http.get(ROUTES.agentThread, () =>
      HttpResponse.json({
        id: 't1',
        title: 't1',
        messages: [
          { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Report this.' }] },
          {
            id: 'a',
            role: 'assistant',
            parts: [
              ...before,
              {
                type: 'tool-draft_bug_report',
                toolCallId: 'b1',
                state: 'output-available',
                input: { title: 'Frozen price', description: 'x' },
                output: { url, note: 'n' },
              },
              { type: 'text', text: 'Here is the draft.' },
            ],
          },
        ],
      }),
    ),
  )
  setViewportWidth(1024)
  renderApp({ url: '/agent/t1', browserLanguages: ['en-US'] })
  const main = await screen.findByRole('main')
  await within(main).findByText('Here is the draft.')
  return main
}

describe('the bug report card', () => {
  it('shows the title, the body as plain text, and the link, with no button', async () => {
    const main = await openThread(URL_OK)

    const link = within(main).getByRole('link', { name: 'Open on GitHub' })
    expect(link).toHaveAttribute('href', URL_OK)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    const card = within(link.parentElement as HTMLElement)
    expect(card.getByText('Frozen price')).toBeInTheDocument()
    expect(card.getByText(/## Steps\s+The price stays still\./)).toBeInTheDocument()
    expect(card.queryByRole('button')).not.toBeInTheDocument()
    // The call keeps its trace line.
    expect(within(main).getByText('Drafting a bug report.')).toBeInTheDocument()
  })

  it('draws no card for a link to another host', async () => {
    const main = await openThread(`https://evil.test/pbrissaud/suivi-bourse/issues/new?${QUERY}`)

    expect(within(main).getByText('Drafting a bug report.')).toBeInTheDocument()
    expect(within(main).queryByRole('link', { name: 'Open on GitHub' })).not.toBeInTheDocument()
  })

  it('leaves the filled button to the events proposed before it', async () => {
    const id = 'b'.repeat(32)
    server.use(
      http.post(ROUTES.agentProposalPreview, () =>
        HttpResponse.json({ written: 1, duplicates: 0, duplicate_rows: [] }),
      ),
      http.get(ROUTES.agentProposals, () =>
        HttpResponse.json({
          proposals: [
            {
              id,
              kind: 'events',
              title: 'Buy CW8',
              status: 'ready',
              count: 1,
              events: [
                {
                  date: '2026-03-03',
                  event_type: 'BUY',
                  account: 'cto',
                  symbol: 'CW8.PA',
                  quantity: 10,
                  unit_price: 512,
                  fee: null,
                  amount: null,
                  notes: null,
                },
              ],
              created_at: '2026-11-22T09:00:00+00:00',
              decided_at: null,
            },
          ],
        }),
      ),
    )
    const main = await openThread(URL_OK, [
      {
        type: 'tool-propose_events',
        toolCallId: 'p1',
        state: 'output-available',
        input: {},
        output: { proposal_id: id, status: 'ready' },
      },
    ])

    const add = await within(main).findByRole('button', { name: /^Add 1 event/ })
    expect(add).toHaveAttribute('data-variant', 'primary')
    expect(within(main).getByRole('link', { name: 'Open on GitHub' })).toBeInTheDocument()
  })
})
