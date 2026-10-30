/**
 * **The agent's proposal in the import preview** (#1119): `/ledger?proposal=<id>`
 * opens the window the files open, *Importer* merges through the app, and the
 * rows it wrote are marked for a moment.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { aDuplicateRow, aLedgerPayload, aReceipt, ledgerEvents } from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const ID = 'd'.repeat(32)

const receipt = (status: string) => ({
  ...aReceipt({
    filename: 'Achat CW8',
    rows: 1,
    written: 1,
    accounts: ['beta'],
    symbols: ['CW8.PA'],
  }),
  file_accounts: [{ name: 'beta', rows: 1 }],
  files: [{ filename: 'Achat CW8', rows: 1, period: { from: '2026-03-03', to: '2026-03-03' } }],
  proposal: { id: ID, title: 'Achat CW8', status },
})

function stale() {
  return HttpResponse.json(
    {
      type: PROBLEM_TYPES.proposalStale,
      title: 'Proposal is stale',
      status: 409,
      detail: 'Le grand livre a changé depuis cette proposition.',
    },
    { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
  )
}

describe('the proposal as the import preview’s source (#1119)', () => {
  it('opens the preview on the proposal, merges, closes and marks the written rows', async () => {
    const seen: string[] = []
    server.use(
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
      http.post(ROUTES.agentProposalPreview, ({ params }) => {
        seen.push(`preview ${String(params.id)}`)
        return HttpResponse.json(receipt('ready'))
      }),
      http.post(ROUTES.agentProposalMerge, ({ params }) => {
        seen.push(`merge ${String(params.id)}`)
        return HttpResponse.json({ ...receipt('merged'), written_ids: ['2'] }, { status: 201 })
      }),
    )
    const { user } = renderApp({ url: `/ledger?proposal=${ID}` })

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Ce que cet import ferait')).toBeInTheDocument()
    expect(within(dialog).getByText('Achat CW8')).toBeInTheDocument()
    expect(within(dialog).getByText(/Proposé par l’agent/)).toBeInTheDocument()
    expect(seen).toEqual([`preview ${ID}`])

    await user.click(await within(dialog).findByRole('button', { name: 'Importer' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(seen).toEqual([`preview ${ID}`, `merge ${ID}`])
    const table = await screen.findByRole('table', { name: 'Vos événements' })
    const marked = within(table)
      .getAllByRole('row')
      .filter((row) => row.hasAttribute('data-fresh'))
    expect(marked).toHaveLength(1)
  })

  it('lists every proposed line in the window, notes and fee included', async () => {
    const line = (day: string, notes: string | null) => ({
      date: day,
      event_type: 'BUY',
      account: 'beta',
      symbol: 'CW8.PA',
      quantity: 10,
      unit_price: 512,
      fee: 1.5,
      amount: null,
      notes,
    })
    const events = Array.from({ length: 12 }, (_, i) =>
      line(`2026-03-${String(i + 1).padStart(2, '0')}`, i === 11 ? 'Ordre du 12' : null),
    )
    server.use(
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
      http.post(ROUTES.agentProposalPreview, () => HttpResponse.json(receipt('ready'))),
      http.get(ROUTES.agentProposals, () =>
        HttpResponse.json({
          proposals: [
            {
              id: ID,
              kind: 'events',
              title: 'Achat CW8',
              status: 'ready',
              count: 12,
              events,
              created_at: '2026-10-21T09:00:00+00:00',
              decided_at: null,
            },
          ],
        }),
      ),
    )
    renderApp({ url: `/ledger?proposal=${ID}` })

    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Les 12 événements proposés')).toBeInTheDocument()
    expect(within(dialog).getByText(/Ordre du 12/)).toBeInTheDocument()
    expect(within(dialog).getAllByText(/frais 1,50/)).toHaveLength(12)
  })

  it('writes a repeated line whole unless told otherwise, and says so to the server', async () => {
    const urls: string[] = []
    const repeated = {
      ...receipt('ready'),
      rows: 2,
      written: 1,
      duplicates: 1,
      duplicate_rows: [aDuplicateRow({ duplicate_of: null, repeat_of: 0 })],
    }
    server.use(
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
      http.post(ROUTES.agentProposalPreview, ({ request }) => {
        urls.push(`preview ${new URL(request.url).search}`)
        return HttpResponse.json(repeated)
      }),
      http.post(ROUTES.agentProposalMerge, ({ request }) => {
        urls.push(`merge ${new URL(request.url).search}`)
        return HttpResponse.json({ ...receipt('merged'), written_ids: [] }, { status: 201 })
      }),
    )
    const { user } = renderApp({ url: `/ledger?proposal=${ID}` })

    await user.click(await screen.findByRole('button', { name: 'Importer' }))

    await waitFor(() => expect(urls).toContain('merge ?write_repeat=0'))
    // The census read carries none; the reading of what would be written does.
    expect(urls).toContain('preview ')
    expect(urls).toContain('preview ?write_repeat=0')
  })

  it('closes on the stale sentence when the ledger moved under the button', async () => {
    server.use(
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
      http.post(ROUTES.agentProposalPreview, () => HttpResponse.json(receipt('ready'))),
      http.post(ROUTES.agentProposalMerge, () => stale()),
    )
    const { user } = renderApp({ url: `/ledger?proposal=${ID}` })

    await user.click(await screen.findByRole('button', { name: 'Importer' }))

    expect(
      await screen.findByText(
        'Le grand livre a changé depuis cette proposition : rien n’a été écrit.',
      ),
    ).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(
      within(screen.getByRole('table', { name: 'Vos événements' }))
        .getAllByRole('row')
        .some((row) => row.hasAttribute('data-fresh')),
    ).toBe(false)
  })

  it('closes at once when the preview itself meets a stale proposal', async () => {
    server.use(
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
      http.post(ROUTES.agentProposalPreview, () => stale()),
    )
    renderApp({ url: `/ledger?proposal=${ID}` })

    expect(
      await screen.findByText(
        'Le grand livre a changé depuis cette proposition : rien n’a été écrit.',
      ),
    ).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('opens nothing without a proposal in the address', async () => {
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))))
    renderApp({ url: '/ledger' })

    await screen.findByRole('table', { name: 'Vos événements' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  describe('a broker statement (#1120)', () => {
    const gap = (price: number | null, marks: string[], source: string | null) => ({
      date: '2026-06-30',
      event_type: 'BUY',
      account: 'beta',
      symbol: 'CW8.PA',
      quantity: 2,
      unit_price: price,
      fee: null,
      amount: null,
      notes: null,
      marks,
      price_source: source,
      n: 1,
    })
    const facts = {
      kind: 'positions',
      as_of: '2026-06-30',
      dropped: 1,
      unresolved: [] as { n: number; name: string; isin: string | null }[],
      pending_held: 0,
      total_check: null as unknown,
    }
    const statement = (overrides: Record<string, unknown> = {}, lines: unknown[] = []) => ({
      ...receipt('ready'),
      statement: { ...facts, lines, ...overrides },
    })

    it('prefills the price of a gap, sends the one typed with the next preview and the merge', async () => {
      const bodies: unknown[] = []
      server.use(
        http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
        http.post(ROUTES.agentProposalPreview, async ({ request }) => {
          const body = await request.json()
          bodies.push(['preview', body])
          const typed = (body as { prices?: Record<string, number> }).prices?.['CW8.PA']
          return HttpResponse.json(
            typed === undefined
              ? statement({}, [gap(520, ['statement', 'gap', 'estimated_price'], 'close')])
              : statement({}, [gap(typed, ['statement', 'gap'], 'owner')]),
          )
        }),
        http.post(ROUTES.agentProposalMerge, async ({ request }) => {
          bodies.push(['merge', await request.json()])
          return HttpResponse.json({ ...receipt('merged'), written_ids: ['2'] }, { status: 201 })
        }),
      )
      const { user } = renderApp({ url: `/ledger?proposal=${ID}` })

      const dialog = await screen.findByRole('dialog')
      const price = await within(dialog).findByRole('textbox', { name: 'Prix de CW8.PA' })
      expect(price).toHaveValue('520')
      // The line's own badge, and the label of its price field.
      expect(within(dialog).getAllByText('prix estimé')).toHaveLength(2)
      expect(within(dialog).getByText('1 ligne du relevé n’a pas pu être lue.')).toBeInTheDocument()

      await user.clear(price)
      await user.type(price, '530,5{Enter}')

      await waitFor(() => expect(within(dialog).queryByText('prix estimé')).toBeNull())
      await user.click(within(dialog).getByRole('button', { name: 'Importer' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(bodies).toEqual([
        ['preview', {}],
        ['preview', { prices: { 'CW8.PA': 530.5 } }],
        ['merge', { prices: { 'CW8.PA': 530.5 } }],
      ])
    })

    it('waits for the price when there is no close, and for a title when none was found', async () => {
      server.use(
        http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
        http.post(ROUTES.agentProposalPreview, () =>
          HttpResponse.json(
            statement(
              {
                unresolved: [{ n: 2, name: 'AMUNDI MSCI WORLD', isin: 'FR0010315770' }],
                pending_held: 1,
                total_check: { stated: 48210, read: 45980, gap_pct: -4.6 },
              },
              [gap(null, ['statement', 'gap'], null)],
            ),
          ),
        ),
      )
      renderApp({ url: `/ledger?proposal=${ID}` })

      const dialog = await screen.findByRole('dialog')
      expect(await within(dialog).findByText('prix à saisir')).toBeInTheDocument()
      expect(
        within(dialog).getByText('Titre de « AMUNDI MSCI WORLD » (FR0010315770)', { exact: false }),
      ).toBeInTheDocument()
      expect(within(dialog).getByText(/1 titre détenu attend/)).toBeInTheDocument()
      expect(within(dialog).getByText(/Le relevé annonce 48\s?210,00/)).toBeInTheDocument()
      expect(within(dialog).getByText(/−4,6 %|-4,6 %/)).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Importer' })).toBeDisabled()
    })

    it('sends the ticker chosen for a line, and says when the total cannot be checked', async () => {
      const bodies: unknown[] = []
      server.use(
        http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
        http.post(ROUTES.agentProposalPreview, async ({ request }) => {
          const body = (await request.json()) as { symbols?: Record<string, string> }
          bodies.push(body)
          return HttpResponse.json(
            body.symbols
              ? statement({ total_check: 'unverifiable' }, [
                  gap(512, ['statement', 'gap'], 'statement'),
                ])
              : statement({
                  unresolved: [{ n: 2, name: 'AMUNDI MSCI WORLD', isin: 'FR0010315770' }],
                }),
          )
        }),
      )
      const { user } = renderApp({ url: `/ledger?proposal=${ID}` })
      const dialog = await screen.findByRole('dialog')

      await user.type(await within(dialog).findByRole('combobox'), 'cw8.pa')
      await user.tab()

      expect(await within(dialog).findByText('Total non vérifiable.')).toBeInTheDocument()
      expect(bodies).toEqual([{}, { symbols: { '2': 'cw8.pa' } }])
      expect(within(dialog).getByRole('button', { name: 'Importer' })).toBeEnabled()
    })
  })
})
