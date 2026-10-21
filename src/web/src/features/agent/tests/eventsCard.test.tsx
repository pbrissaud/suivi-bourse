/**
 * The ledger events the agent proposed (#1119): the card read in its stored
 * state, five of them, with the marks and the overflow.
 */
import { screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { EventsProposal } from '@/features/agent/lib/eventProposals'
import { ROUTES } from '@/lib/api'
import { anAgentConfig } from '@/test/factories'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const ID = 'b'.repeat(32)
const NEXT = 'c'.repeat(32)
const DECIDED = '2026-10-21T09:00:00+00:00'

type Line = EventsProposal['events'][number]

function aLine(overrides: Partial<Line> = {}): Line {
  return {
    date: '2026-03-03',
    event_type: 'BUY',
    account: 'cto',
    symbol: 'CW8.PA',
    quantity: 10,
    unit_price: 512,
    amount: null,
    ...overrides,
  }
}

function aProposal(
  status: EventsProposal['status'],
  overrides: Partial<EventsProposal> = {},
): EventsProposal {
  const events = overrides.events ?? [aLine()]
  return {
    id: ID,
    kind: 'events',
    title: 'Achat CW8',
    status,
    count: events.length,
    events,
    created_at: DECIDED,
    decided_at: status === 'merged' || status === 'ignored' ? DECIDED : null,
    ...overrides,
  }
}

/** A stored thread whose one answer proposed events, and the state the server reads back. */
function threadWith(read: (ids: string[]) => EventsProposal[]) {
  server.use(
    http.get(ROUTES.agentThreads, () => HttpResponse.json([])),
    http.get(ROUTES.agentConfig, () =>
      HttpResponse.json(
        anAgentConfig({ enabled: true, provider: 'anthropic', model: 'claude-sonnet-5-5' }),
      ),
    ),
    http.get(ROUTES.agentThread, () =>
      HttpResponse.json({
        id: 't1',
        title: 't1',
        messages: [
          { id: 'u', role: 'user', parts: [{ type: 'text', text: 'J’ai acheté 10 CW8.' }] },
          {
            id: 'a',
            role: 'assistant',
            parts: [
              {
                type: 'tool-propose_events',
                toolCallId: 'p1',
                state: 'output-available',
                input: { title: 'Achat CW8', events_json: '[]' },
                output: { proposal_id: ID, status: 'ready' },
              },
              { type: 'text', text: 'À revoir.' },
            ],
          },
        ],
      }),
    ),
    http.get(ROUTES.agentProposals, ({ request }) => {
      const ids = (new URL(request.url).searchParams.get('ids') ?? '').split(',')
      return HttpResponse.json({ proposals: read(ids) })
    }),
  )
}

async function openPage() {
  setViewportWidth(1024)
  const view = renderApp({ url: '/agent/t1' })
  await screen.findByRole('heading', { level: 1, name: 'Agent' })
  return { ...view, main: screen.getByRole('main') }
}

describe('the events card (#1119)', () => {
  it('lists the lines while ready and leads to the ledger’s preview', async () => {
    threadWith(() => [aProposal('ready')])
    const { main } = await openPage()

    expect(await within(main).findByText('Achat CW8')).toBeInTheDocument()
    expect(within(main).getByText(/Achat · CW8\.PA · 10 × 512,00 · cto/)).toBeInTheDocument()
    const review = within(main).getByRole('link', { name: 'Revoir et fusionner' })
    expect(review).toHaveAttribute('href', `/ledger?proposal=${ID}`)
    expect(within(main).getByRole('button', { name: 'Ignorer' })).toBeInTheDocument()
  })

  it('shows the marks, and says “et N autres” past eight lines', async () => {
    const events = [
      aLine({ mark: 'statement' }),
      aLine({ mark: 'gap', date: '2026-03-04' }),
      aLine({ mark: 'estimated_price', date: '2026-03-05' }),
      ...Array.from({ length: 7 }, (_, i) => aLine({ date: `2026-04-0${i + 1}` })),
    ]
    threadWith(() => [aProposal('ready', { events })])
    const { main } = await openPage()

    expect(await within(main).findByText('extrait du relevé')).toBeInTheDocument()
    expect(within(main).getByText('déduit d’un écart')).toBeInTheDocument()
    expect(within(main).getByText('prix estimé')).toBeInTheDocument()
    expect(within(main).getAllByRole('listitem')).toHaveLength(9)
    expect(within(main).getByText('et 2 autres')).toBeInTheDocument()
  })

  for (const [status, line] of [
    ['merged', /^Fusionnée le /],
    ['ignored', 'Ignorée'],
    ['expired', 'Expirée'],
  ] as const) {
    it(`reads ${status} back as one status line, without buttons`, async () => {
      threadWith(() => [aProposal(status)])
      const { main } = await openPage()

      expect(await within(main).findByText(line)).toBeInTheDocument()
      expect(within(main).queryByRole('link', { name: 'Revoir et fusionner' })).toBeNull()
      expect(within(main).queryByRole('button', { name: 'Ignorer' })).toBeNull()
      expect(within(main).queryByRole('button', { name: 'Relancer' })).toBeNull()
    })
  }

  it('ignores through the app', async () => {
    let state: EventsProposal['status'] = 'ready'
    threadWith(() => [aProposal(state)])
    server.use(
      http.post(ROUTES.agentProposalIgnore, () => {
        state = 'ignored'
        return HttpResponse.json({ proposal: aProposal('ignored') })
      }),
    )
    const { user, main } = await openPage()

    await user.click(await within(main).findByRole('button', { name: 'Ignorer' }))

    expect(await within(main).findByText('Ignorée')).toBeInTheDocument()
  })

  it('says stale, and Relancer shows the new proposal in its place', async () => {
    threadWith((ids) =>
      ids[0] === NEXT
        ? [aProposal('ready', { id: NEXT, title: 'Achat CW8 (relancé)' })]
        : [aProposal('stale')],
    )
    server.use(
      http.post(ROUTES.agentProposalRepropose, () =>
        HttpResponse.json({
          proposal: aProposal('ready', { id: NEXT, title: 'Achat CW8 (relancé)' }),
        }),
      ),
    )
    const { user, main } = await openPage()

    expect(
      await within(main).findByText('Le grand livre a changé depuis cette proposition'),
    ).toBeInTheDocument()
    expect(within(main).queryByRole('link', { name: 'Revoir et fusionner' })).toBeNull()
    await user.click(within(main).getByRole('button', { name: 'Relancer' }))

    const review = await within(main).findByRole('link', { name: 'Revoir et fusionner' })
    expect(review).toHaveAttribute('href', `/ledger?proposal=${NEXT}`)
    expect(within(main).getByText('Achat CW8 (relancé)')).toBeInTheDocument()
  })

  it('shows the refusal in the server’s words when the events no longer pass', async () => {
    threadWith(() => [aProposal('stale')])
    server.use(
      http.post(ROUTES.agentProposalRepropose, () =>
        HttpResponse.json(
          {
            type: '/problems/bad-request',
            title: 'Invalid request',
            status: 422,
            detail: 'line 1 (quantity): Cannot sell 5 shares',
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user, main } = await openPage()

    await user.click(await within(main).findByRole('button', { name: 'Relancer' }))

    expect(await within(main).findByRole('alert')).toHaveTextContent(
      'line 1 (quantity): Cannot sell 5 shares',
    )
    expect(within(main).getByRole('button', { name: 'Relancer' })).toBeEnabled()
  })
})
