/**
 * A setting the agent proposed (#1628, #1629): the card reads its stored state,
 * and only the owner's press decides it.
 */
import { screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { SettingProposal } from '@/features/agent/lib/settingProposals'
import { aProvider } from '@/features/agent/tests/agentFixtures'
import { ROUTES } from '@/lib/api'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const ID = 'c'.repeat(32)
const AT = '2026-11-22T09:00:00+00:00'
const CHANGE = 'log_level: info → debug'

function aProposal(status: SettingProposal['status']): SettingProposal {
  return {
    id: ID,
    key: 'log_level',
    value: 'DEBUG',
    previous: 'INFO',
    doc: null,
    status,
    created_at: AT,
    decided_at: status === 'ready' || status === 'expired' ? null : AT,
  }
}

/** The agent switched on, and a stored thread whose one answer proposed a setting. */
function threadWithProposal(proposal: SettingProposal) {
  server.use(
    http.get(ROUTES.agentThreads, () => HttpResponse.json([])),
    http.get(ROUTES.agentConfig, () => HttpResponse.json({ enabled: true, reasoning: 'low' })),
    http.get(ROUTES.agentProviders, () => HttpResponse.json([aProvider()])),
    http.get(ROUTES.agentThread, () =>
      HttpResponse.json({
        id: 't1',
        title: 't1',
        messages: [
          { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Passe en debug.' }] },
          {
            id: 'a',
            role: 'assistant',
            parts: [
              {
                type: 'tool-propose_setting',
                toolCallId: 'p1',
                state: 'output-available',
                input: { key: 'log_level', value: 'DEBUG' },
                output: {
                  proposal_id: ID,
                  key: 'log_level',
                  value: 'DEBUG',
                  previous: 'INFO',
                  status: 'ready',
                },
              },
              { type: 'text', text: 'À confirmer.' },
            ],
          },
        ],
      }),
    ),
    http.get(ROUTES.configProposals, () => HttpResponse.json({ proposals: [proposal] })),
  )
}

async function openPage() {
  setViewportWidth(1024)
  const view = renderApp({ url: '/agent/t1' })
  await screen.findByRole('heading', { level: 1, name: 'Agent' })
  return { ...view, main: screen.getByRole('main') }
}

describe('the setting proposal card', () => {
  it('names the change lower-case, says it lasts until the restart, and offers both answers', async () => {
    threadWithProposal(aProposal('ready'))
    const { main } = await openPage()

    expect(await within(main).findByText(`Changer ce réglage : ${CHANGE}`)).toBeInTheDocument()
    expect(
      within(main).getByText('Le niveau de journalisation dure jusqu’au prochain redémarrage.'),
    ).toBeInTheDocument()
    expect(within(main).getByRole('button', { name: 'Confirmer' })).toBeInTheDocument()
    expect(within(main).getByRole('button', { name: 'Ignorer' })).toBeInTheDocument()
  })

  it('says a stored setting as it is stored, under the registry’s own line', async () => {
    const doc = 'Poll cadence, in seconds, of a symbol whose market is REGULAR.'
    threadWithProposal({
      ...aProposal('ready'),
      key: 'regular_interval',
      previous: 120,
      value: 300,
      doc,
    })
    const { main } = await openPage()

    expect(
      await within(main).findByText('Changer ce réglage : regular_interval: 120 → 300'),
    ).toBeInTheDocument()
    expect(within(main).getByText(doc)).toBeInTheDocument()
    expect(within(main).queryByText(/prochain redémarrage/)).not.toBeInTheDocument()
  })

  it('names a followed fund by its ticker, and no fund as a word', async () => {
    threadWithProposal({
      ...aProposal('ready'),
      key: 'benchmark_symbols',
      previous: [],
      value: ['CW8.PA', 'CSPX.AS'],
      doc: 'The reference ETFs followed.',
    })
    const { main } = await openPage()

    expect(
      await within(main).findByText(
        'Changer ce réglage : benchmark_symbols: aucun → CW8.PA, CSPX.AS',
      ),
    ).toBeInTheDocument()
  })

  for (const [answer, route, status, line] of [
    ['Confirmer', ROUTES.configProposalConfirm, 'merged', 'Appliqué'],
    ['Ignorer', ROUTES.configProposalIgnore, 'ignored', 'Ignoré'],
  ] as const) {
    it(`${answer} posts to its route, and the card reads ${line} after`, async () => {
      threadWithProposal(aProposal('ready'))
      const hit: string[] = []
      server.use(
        http.post(route, ({ params }) => {
          hit.push(String(params.id))
          return HttpResponse.json({ proposal: aProposal(status) })
        }),
      )
      const { user, main } = await openPage()

      const button = await within(main).findByRole('button', { name: answer })
      // What the server holds once decided.
      threadWithProposal(aProposal(status))
      await user.click(button)

      expect(await within(main).findByText(line)).toBeInTheDocument()
      expect(hit).toEqual([ID])
      expect(within(main).queryByRole('button', { name: 'Confirmer' })).not.toBeInTheDocument()
      expect(within(main).queryByRole('button', { name: 'Ignorer' })).not.toBeInTheDocument()
    })
  }

  it('reads an applied proposal back as one line, without buttons', async () => {
    threadWithProposal(aProposal('merged'))
    const { main } = await openPage()

    const said = await within(main).findByText('Appliqué')
    expect(said.closest('p')).toHaveTextContent(`${CHANGE} · Appliqué`)
    expect(within(main).queryByRole('button', { name: 'Confirmer' })).not.toBeInTheDocument()
  })

  it('says a refusal in the server’s words and keeps the buttons', async () => {
    threadWithProposal(aProposal('ready'))
    server.use(
      http.post(ROUTES.configProposalConfirm, () =>
        HttpResponse.json(
          {
            type: '/problems/conflict',
            title: 'Conflict',
            status: 409,
            detail: 'this proposal has expired',
          },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user, main } = await openPage()

    await user.click(await within(main).findByRole('button', { name: 'Confirmer' }))

    expect(await within(main).findByRole('alert')).toHaveTextContent('this proposal has expired')
    expect(within(main).getByRole('button', { name: 'Confirmer' })).toBeInTheDocument()
  })
})

describe('the read of a long thread', () => {
  it('asks in batches the server takes, and keeps every proposal', async () => {
    const { IDS_PER_READ, settingProposalsApi } = await import(
      '@/features/agent/lib/settingProposals'
    )
    const asked: number[] = []
    server.use(
      http.get(ROUTES.configProposals, ({ request }) => {
        const ids = new URL(request.url).searchParams.get('ids')?.split(',') ?? []
        asked.push(ids.length)
        return HttpResponse.json({
          proposals: ids.map((id) => ({ ...aProposal('ready'), id })),
        })
      }),
    )
    const ids = Array.from({ length: IDS_PER_READ + 1 }, (_, i) => i.toString(16).padStart(32, '0'))

    const read = await settingProposalsApi.proposals(ids)

    expect(asked).toEqual([IDS_PER_READ, 1])
    expect(read.proposals.map((p) => p.id)).toEqual(ids)
  })
})
