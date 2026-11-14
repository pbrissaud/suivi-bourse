/**
 * The ledger events the agent proposed (#1119): the card read in its stored
 * state, five of them, with the marks and the overflow.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { EventsProposal } from '@/features/agent/lib/eventProposals'
import { ROUTES } from '@/lib/api'
import { aProvider } from '@/features/agent/tests/agentFixtures'
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
    fee: null,
    amount: null,
    notes: null,
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
    http.get(ROUTES.agentConfig, () => HttpResponse.json({ enabled: true, reasoning: 'low' })),
    http.get(ROUTES.agentProviders, () => HttpResponse.json([aProvider()])),
    // The import's own dry run: what the ledger would take of the proposal.
    http.post(ROUTES.agentProposalPreview, () =>
      HttpResponse.json({ written: 1, duplicates: 0, duplicate_rows: [] }),
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
  it('lists the lines as ruled rows while ready, and offers to add them', async () => {
    threadWith(() => [aProposal('ready')])
    const { main } = await openPage()

    expect(await within(main).findByText('Achat CW8')).toBeInTheDocument()
    const rows = within(main).getAllByRole('row')
    expect(rows).toHaveLength(2) // the header, and the one line
    expect(within(rows[1]).getByText('Achat')).toBeInTheDocument()
    expect(within(rows[1]).getByText(/CW8\.PA · cto/)).toBeInTheDocument()
    expect(await within(main).findByRole('button', { name: 'Ajouter 1 événement' })).toBeEnabled()
    const review = within(main).getByRole('link', { name: 'Revoir dans le grand livre' })
    expect(review).toHaveAttribute('href', `/ledger?proposal=${ID}`)
    expect(within(main).getByRole('button', { name: 'Ignorer' })).toBeInTheDocument()
  })

  it('marks a line the ledger already holds, unchecked, and adds only the others', async () => {
    const events = [
      aLine({
        event_type: 'DIVIDEND',
        symbol: 'AI.PA',
        quantity: null,
        unit_price: null,
        amount: 18.4,
      }),
      aLine({
        event_type: 'DIVIDEND',
        symbol: 'TTE.PA',
        date: '2026-10-01',
        quantity: null,
        unit_price: null,
        amount: 79.3,
      }),
    ]
    threadWith(() => [aProposal('ready', { events })])
    let merged = 0
    server.use(
      http.post(ROUTES.agentProposalPreview, () =>
        HttpResponse.json({
          written: 1,
          duplicates: 1,
          duplicate_rows: [
            {
              date: '2026-10-01',
              event_type: 'DIVIDEND',
              symbol: 'TTE.PA',
              name: null,
              quantity: null,
              unit_price: null,
              fee: null,
              amount: 79.3,
              notes: null,
              account: 'cto',
              duplicate_of: 'e1',
              repeat_of: null,
              file: 0,
              repeat_of_file: null,
            },
          ],
        }),
      ),
      http.post(ROUTES.agentProposalMerge, () => {
        merged += 1
        return HttpResponse.json({ written: 1, proposal: { id: ID, status: 'merged' } })
      }),
    )
    const { user, main } = await openPage()

    const add = await within(main).findByRole('button', { name: 'Ajouter 1 événement' })
    const boxes = within(main).getAllByRole('checkbox')
    expect(boxes[0]).toBeChecked()
    expect(boxes[1]).not.toBeChecked()
    expect(within(main).getByText('déjà dans le grand livre')).toBeInTheDocument()

    await user.click(add)
    await waitFor(() => expect(merged).toBe(1))
  })

  it('shows the marks, and says “et N autres” past eight lines', async () => {
    const events = [
      aLine({ marks: ['statement'] }),
      aLine({ marks: ['gap'], date: '2026-03-04' }),
      aLine({ marks: ['estimated_price'], date: '2026-03-05' }),
      ...Array.from({ length: 7 }, (_, i) => aLine({ date: `2026-04-0${i + 1}` })),
    ]
    threadWith(() => [aProposal('ready', { events })])
    const { main } = await openPage()

    expect(await within(main).findByText(/extrait du relevé/)).toBeInTheDocument()
    expect(within(main).getByText(/déduit d’un écart/)).toBeInTheDocument()
    expect(within(main).getByText(/prix estimé/)).toBeInTheDocument()
    expect(within(main).getAllByRole('row')).toHaveLength(9) // the header, and eight lines
    expect(within(main).getByText('et 2 autres')).toBeInTheDocument()
  })

  for (const [status, line] of [
    ['merged', /^Ajoutée le /],
    ['ignored', 'Ignorée'],
    ['expired', 'Expirée'],
  ] as const) {
    it(`reads ${status} back as one status line, without buttons`, async () => {
      threadWith(() => [aProposal(status)])
      const { main } = await openPage()

      expect(await within(main).findByText(line)).toBeInTheDocument()
      expect(within(main).queryByRole('link', { name: 'Revoir dans le grand livre' })).toBeNull()
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
    expect(within(main).queryByRole('link', { name: 'Revoir dans le grand livre' })).toBeNull()
    await user.click(within(main).getByRole('button', { name: 'Relancer' }))

    const review = await within(main).findByRole('link', { name: 'Revoir dans le grand livre' })
    expect(review).toHaveAttribute('href', `/ledger?proposal=${NEXT}`)
    expect(within(main).getByText('Achat CW8 (relancé)')).toBeInTheDocument()
  })

  it('says so when the re-proposed card cannot be read, instead of standing as before', async () => {
    threadWith((ids) => {
      if (ids[0] === NEXT) throw new Error('unreadable')
      return [aProposal('stale')]
    })
    server.use(
      http.post(ROUTES.agentProposalRepropose, () =>
        HttpResponse.json({ proposal: aProposal('ready', { id: NEXT }) }),
      ),
    )
    const { user, main } = await openPage()

    await user.click(await within(main).findByRole('button', { name: 'Relancer' }))

    expect(await within(main).findByRole('alert')).toHaveTextContent(
      'La décision n’a pas été enregistrée.',
    )
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

  describe('a broker statement (#1120)', () => {
    const facts = (overrides: Partial<NonNullable<EventsProposal['statement']>> = {}) => ({
      kind: 'positions' as const,
      as_of: '2026-06-30',
      dropped: 0,
      unresolved: [],
      pending_held: 0,
      total_check: null,
      ...overrides,
    })

    it('badges every mark of a line, names a title still to choose, and says what was not read', async () => {
      const events = [
        aLine({ marks: ['statement', 'gap'], n: 1 }),
        aLine({ symbol: null, name: 'AMUNDI MSCI WORLD', isin: 'FR0010315770', n: 2 }),
      ]
      threadWith(() => [
        aProposal('ready', {
          events,
          statement: facts({
            dropped: 2,
            unresolved: [{ n: 2, name: 'AMUNDI MSCI WORLD', isin: 'FR0010315770' }],
          }),
        }),
      ])
      const { main } = await openPage()

      expect(await within(main).findByText(/extrait du relevé/)).toBeInTheDocument()
      expect(within(main).getByText(/déduit d’un écart/)).toBeInTheDocument()
      expect(within(main).getByText(/titre à choisir/)).toBeInTheDocument()
      expect(
        within(main).getByText('2 lignes du relevé n’ont pas pu être lues'),
      ).toBeInTheDocument()
    })

    it('reads the same extraction as the other kind, and shows the new proposal', async () => {
      threadWith((ids) =>
        ids[0] === NEXT
          ? [
              aProposal('ready', {
                id: NEXT,
                title: 'Relevé (opérations)',
                statement: facts({ kind: 'operations' }),
              }),
            ]
          : [aProposal('ready', { statement: facts() })],
      )
      server.use(
        http.post(ROUTES.agentProposalRekind, () =>
          HttpResponse.json({
            proposal: aProposal('ready', {
              id: NEXT,
              title: 'Relevé (opérations)',
              statement: facts({ kind: 'operations' }),
            }),
          }),
        ),
      )
      const { user, main } = await openPage()

      await user.click(
        await within(main).findByRole('button', { name: 'Lire comme relevé d’opérations' }),
      )

      expect(await within(main).findByText('Relevé (opérations)')).toBeInTheDocument()
      expect(
        await within(main).findByRole('button', { name: 'Lire comme relevé de lignes' }),
      ).toBeInTheDocument()
    })

    it('offers no re-reading for a proposal the agent wrote', async () => {
      threadWith(() => [aProposal('ready')])
      const { main } = await openPage()

      await within(main).findByRole('link', { name: 'Revoir dans le grand livre' })
      expect(within(main).queryByRole('button', { name: /Lire comme relevé/ })).toBeNull()
    })
  })
})
