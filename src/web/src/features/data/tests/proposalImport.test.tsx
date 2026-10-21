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
import { aLedgerPayload, aReceipt, ledgerEvents } from '@/test/factories'
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
})
