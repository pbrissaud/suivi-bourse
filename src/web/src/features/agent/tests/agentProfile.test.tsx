/**
 * The investor's profile on the agent's page (#1116): a proposal card read in
 * its stored state, and the chips of what the owner confirmed.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { factLabel, type Profile, type Proposal } from '@/features/agent/lib/profile'
import { aProvider } from '@/features/agent/tests/agentFixtures'
import { ROUTES } from '@/lib/api'
import fr from '@/i18n/fr.json'
import { formatMessage } from '@/lib/i18n'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const ID = 'a'.repeat(32)
const CONFIRMED = '2026-10-12T09:00:00+00:00'

function switchedOn(profile: Profile = { facts: {}, projects: [], about: null }) {
  const writes: { method: string; path: string; body: unknown }[] = []
  let current = profile
  server.use(
    http.get(ROUTES.agentThreads, () => HttpResponse.json([])),
    http.get(ROUTES.agentConfig, () => HttpResponse.json({ enabled: true, reasoning: 'low' })),
    http.get(ROUTES.agentProviders, () => HttpResponse.json([aProvider()])),
    http.get(ROUTES.profile, () => HttpResponse.json(current)),
    http.put(ROUTES.profileFact, async ({ params, request }) => {
      const { value } = (await request.json()) as { value: unknown }
      writes.push({ method: 'PUT', path: String(params.key), body: value })
      current = {
        ...current,
        facts: { ...current.facts, [String(params.key)]: { value, confirmed_at: CONFIRMED } },
      }
      return HttpResponse.json(current)
    }),
    http.delete(ROUTES.profileFact, ({ params }) => {
      writes.push({ method: 'DELETE', path: String(params.key), body: null })
      const { [String(params.key)]: _, ...facts } = current.facts
      current = { ...current, facts }
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return writes
}

/** A stored thread whose one answer proposed a fact. */
function threadWithProposal(proposal: Proposal | null, part: Record<string, unknown> = {}) {
  const asked: string[] = []
  server.use(
    http.get(ROUTES.agentThread, () =>
      HttpResponse.json({
        id: 't1',
        title: 't1',
        messages: [
          { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Ma TMI est à 30 %.' }] },
          {
            id: 'a',
            role: 'assistant',
            parts: [
              {
                type: 'tool-propose_profile_fact',
                toolCallId: 'p1',
                state: 'output-available',
                input: { key: 'marginal_rate', value: 0.3 },
                output: { proposal_id: ID, status: 'ready' },
                ...part,
              },
              { type: 'text', text: 'À confirmer.' },
            ],
          },
        ],
      }),
    ),
    http.get(ROUTES.profileProposals, ({ request }) => {
      asked.push(new URL(request.url).searchParams.get('ids') ?? '')
      return HttpResponse.json({ proposals: proposal === null ? [] : [proposal] })
    }),
  )
  return asked
}

function aProposal(status: Proposal['status']): Proposal {
  return {
    id: ID,
    key: 'marginal_rate',
    value: 0.3,
    status,
    created_at: CONFIRMED,
    decided_at: status === 'ready' || status === 'expired' ? null : CONFIRMED,
  }
}

async function openPage(url = '/agent/t1', heading = 'Agent') {
  setViewportWidth(1024)
  const view = renderApp({ url })
  await screen.findByRole('heading', { level: 1, name: heading })
  return { ...view, main: screen.getByRole('main') }
}

describe('factLabel', () => {
  const said = (key: string, value: unknown) => {
    const label = factLabel(key, value, 'fr-FR')
    return formatMessage('fr', label.key, label.values)
  }

  it('reads a rate, a tolerance, a project, and never an income amount', () => {
    expect(said('marginal_rate', 0.3)).toMatch(/^TMI 30\s%$/)
    expect(said('risk_tolerance', 'balanced')).toBe('Équilibré')
    expect(said('project:0123456789ab', { label: 'Maison', target_year: 2028 })).toBe(
      'Maison · 2028',
    )
    expect(said('income', { amount: 54321, currency: 'EUR' })).toBe('Revenu · non envoyé')
  })
})

describe('the proposal card (5A)', () => {
  it('asks while ready, and confirms through the app', async () => {
    switchedOn()
    const asked = threadWithProposal(aProposal('ready'))
    let confirmed = false
    server.use(
      http.post(ROUTES.profileProposalConfirm, () => {
        confirmed = true
        return HttpResponse.json({ proposal: aProposal('merged') })
      }),
    )
    const { user, main } = await openPage()

    expect(await within(main).findByText(/^Retenir pour la suite : TMI 30\s%$/)).toBeInTheDocument()
    expect(asked).toEqual([ID])
    threadWithProposal(aProposal('merged'))
    await user.click(within(main).getByRole('button', { name: 'Confirmer' }))

    expect(await within(main).findByText('Noté')).toBeInTheDocument()
    expect(confirmed).toBe(true)
    expect(within(main).queryByRole('button', { name: 'Confirmer' })).not.toBeInTheDocument()
  })

  it('draws the card after the answer, with the call kept among the tool lines (#1271)', async () => {
    switchedOn()
    threadWithProposal(aProposal('ready'))
    const { main } = await openPage()

    const card = await within(main).findByRole('button', { name: 'Confirmer' })
    const answer = within(main).getAllByText('À confirmer.')[0]
    expect(answer.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(main).getByText(fr['agent.tool.propose_profile_fact'])).toBeInTheDocument()
  })

  for (const [status, line] of [
    ['merged', 'Noté'],
    ['ignored', 'Ignoré'],
    ['expired', 'Expiré'],
  ] as const) {
    it(`reads ${status} back as one status line, without buttons`, async () => {
      switchedOn()
      threadWithProposal(aProposal(status))
      const { main } = await openPage()

      const said = await within(main).findByText(line)
      // A line, not a card: nothing around it carries the frame (#1271).
      expect(said.closest('.rounded-card, .border')).toBeNull()
      expect(within(main).queryByRole('button', { name: 'Confirmer' })).not.toBeInTheDocument()
      expect(within(main).queryByRole('button', { name: 'Ignorer' })).not.toBeInTheDocument()
    })
  }

  it('ignores through the app, and reads Ignoré after', async () => {
    switchedOn()
    threadWithProposal(aProposal('ready'))
    const hit: string[] = []
    server.use(
      http.post(ROUTES.profileProposalConfirm, () => {
        hit.push('confirm')
        return HttpResponse.json({ proposal: aProposal('merged') })
      }),
      http.post(ROUTES.profileProposalIgnore, () => {
        hit.push('ignore')
        return HttpResponse.json({ proposal: aProposal('ignored') })
      }),
    )
    const { user, main } = await openPage()

    const ignore = await within(main).findByRole('button', { name: 'Ignorer' })
    // What the server holds once the proposal is ignored.
    threadWithProposal(aProposal('ignored'))
    await user.click(ignore)

    expect(await within(main).findByText('Ignoré')).toBeInTheDocument()
    expect(hit).toEqual(['ignore'])
  })

  it('says a refusal in the server’s words and keeps the buttons', async () => {
    switchedOn()
    threadWithProposal(aProposal('ready'))
    server.use(
      http.post(ROUTES.profileProposalConfirm, () =>
        HttpResponse.json(
          {
            type: '/problems/not-found',
            title: 'Not found',
            status: 404,
            detail: 'the project this proposal changes is gone',
          },
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user, main } = await openPage()

    await user.click(await within(main).findByRole('button', { name: 'Confirmer' }))

    expect(await within(main).findByRole('alert')).toHaveTextContent(
      'the project this proposal changes is gone',
    )
    expect(within(main).getByRole('button', { name: 'Confirmer' })).toBeInTheDocument()
  })

  it('asks for an income on its amount, which only the model is not sent', async () => {
    switchedOn()
    threadWithProposal({
      ...aProposal('ready'),
      key: 'income',
      value: { amount: 54321, currency: 'EUR' },
    })
    const { main } = await openPage()

    expect(
      await within(main).findByText(/^Retenir pour la suite : revenu de 54\s321,00\s€$/),
    ).toBeInTheDocument()
  })

  it('keeps the failed tool line for a refused proposal', async () => {
    switchedOn()
    const asked = threadWithProposal(null, {
      state: 'output-error',
      output: undefined,
      errorText: 'this fact is refused: the marginal tax rate is a fraction from 0 to 0.6',
    })
    const { main } = await openPage()

    expect(
      await within(main).findByText('Proposition d’un fait pour votre profil.'),
    ).toBeInTheDocument()
    expect(within(main).queryByText(/Retenir pour la suite/)).not.toBeInTheDocument()
    expect(asked).toEqual([])
  })

  it('falls back to the tool line for a proposal the server does not know', async () => {
    switchedOn()
    threadWithProposal(null)
    const { main } = await openPage()

    expect(
      await within(main).findByText('Proposition d’un fait pour votre profil.'),
    ).toBeInTheDocument()
    expect(within(main).queryByText(/Retenir pour la suite/)).not.toBeInTheDocument()
  })
})

const project = (id: string, label: string, year: number) => ({
  id: id.padEnd(12, '0'),
  label,
  target_year: year,
  amount: null,
  confirmed_at: CONFIRMED,
})
const full: Profile = {
  facts: {
    income: { value: { amount: 54321, currency: 'EUR' }, confirmed_at: CONFIRMED },
    marginal_rate: { value: 0.3, confirmed_at: CONFIRMED },
    risk_tolerance: { value: 'balanced', confirmed_at: CONFIRMED },
  },
  projects: [
    project('a', 'Maison', 2028),
    project('b', 'Études', 2032),
    project('c', 'Voilier', 2040),
  ],
  about: null,
}

describe('the profile line (13A)', () => {
  it('draws nothing when no fact is declared', async () => {
    switchedOn()
    const { main } = await openPage('/agent')
    await within(main).findByRole('textbox', { name: 'Votre question' })
    expect(within(main).queryByRole('group', { name: 'Votre profil' })).not.toBeInTheDocument()
  })

  it('shows three values and « 3 autres », the income not sent, and the latter opens all six', async () => {
    switchedOn(full)
    const { user, main } = await openPage('/agent')

    const chips = await within(main).findByRole('group', { name: 'Votre profil' })
    expect(
      within(chips)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'Revenu · non envoyé',
      expect.stringMatching(/^TMI 30\s%$/),
      'Équilibré',
      '3 autres',
    ])
    await user.click(within(chips).getByRole('button', { name: 'Tout votre profil (3 autres)' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('button', { name: 'Oublier' })).toHaveLength(6)
    expect(within(dialog).getByText('Voilier · 2040')).toBeInTheDocument()
  })

  it('edits a fact in its popover, and the line shows the new value', async () => {
    const writes = switchedOn({
      facts: { marginal_rate: full.facts.marginal_rate },
      projects: [],
      about: null,
    })
    const { user, main } = await openPage('/agent')

    const chips = await within(main).findByRole('group', { name: 'Votre profil' })
    await user.click(within(chips).getByRole('button', { name: /^TMI 30/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/^Confirmé le /)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Modifier' }))
    const field = within(dialog).getByRole('spinbutton', { name: 'Taux marginal d’imposition (%)' })
    await user.clear(field)
    await user.type(field, '41')
    await user.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() =>
      expect(writes).toEqual([{ method: 'PUT', path: 'marginal_rate', body: 0.41 }]),
    )
    expect(await within(chips).findByRole('button', { name: /^TMI 41/ })).toBeInTheDocument()
  })

  it('forgets a fact at once, and its value goes', async () => {
    const writes = switchedOn({
      facts: { income: full.facts.income, risk_tolerance: full.facts.risk_tolerance },
      projects: [],
      about: null,
    })
    const { user, main } = await openPage('/agent')

    const chips = await within(main).findByRole('group', { name: 'Votre profil' })
    await user.click(within(chips).getByRole('button', { name: 'Équilibré' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Oublier' }),
    )

    await waitFor(() =>
      expect(within(chips).queryByRole('button', { name: 'Équilibré' })).not.toBeInTheDocument(),
    )
    expect(writes).toEqual([{ method: 'DELETE', path: 'risk_tolerance', body: null }])
    expect(within(chips).getByRole('button', { name: 'Revenu · non envoyé' })).toBeInTheDocument()
  })
})

describe('the memory page (#1619)', () => {
  const balanced: Profile = {
    facts: { risk_tolerance: full.facts.risk_tolerance },
    projects: [],
    about: null,
  }
  /** The list, once the page under the rail's « Mémoire » has it. */
  const memory = () => within(screen.getByRole('main')).findByRole('group', { name: 'Mémoire' })

  it('is reached from the rail, and lists every fact and project with its date', async () => {
    switchedOn(full)
    const { user } = await openPage('/agent')

    const rail = await screen.findByRole('navigation', { name: 'Fils de l’agent' })
    await user.click(within(rail).getByRole('link', { name: 'Mémoire' }))
    await screen.findByRole('heading', { level: 1, name: 'Mémoire' })
    expect(screen.getByRole('link', { name: '← Agent' })).toHaveAttribute('href', '/agent')

    const rows = await within(await memory()).findAllByRole('listitem')
    expect(rows).toHaveLength(6)
    // The income says it is not sent, since no chip names it here.
    expect(rows[0]).toHaveTextContent(/^Revenu · non envoyé · 54\s321,00\s€Confirmé le /)
    expect(within(rows[2]).getByText('Équilibré')).toBeInTheDocument()
    expect(within(rows[2]).getByText(/^Confirmé le .*2026$/)).toBeInTheDocument()
    expect(within(rows[5]).getByText('Voilier · 2040')).toBeInTheDocument()
    for (const row of rows) {
      expect(within(row).getByRole('button', { name: 'Modifier' })).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: 'Oublier' })).toBeInTheDocument()
    }
  })

  it('edits a fact in its row, and the row shows the new value', async () => {
    const writes = switchedOn(balanced)
    const { user } = await openPage('/agent/memory', 'Mémoire')

    const list = await memory()
    await user.click(await within(list).findByRole('button', { name: 'Modifier' }))
    await user.selectOptions(
      within(list).getByRole('combobox', { name: 'Tolérance au risque' }),
      'Prudent',
    )
    await user.click(within(list).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(list).findByText('Prudent')).toBeInTheDocument()
    expect(writes).toEqual([{ method: 'PUT', path: 'risk_tolerance', body: 'prudent' }])
    // Back from the editor, the focus is on the row's *Modifier*.
    expect(within(list).getByRole('button', { name: 'Modifier' })).toHaveFocus()
  })

  it('forgets the last fact, says the profile is empty, and keeps the focus', async () => {
    const writes = switchedOn(balanced)
    const { user } = await openPage('/agent/memory', 'Mémoire')

    const list = await memory()
    await user.click(await within(list).findByRole('button', { name: 'Oublier' }))

    expect(await within(list).findByText(fr['agent.memory.empty'])).toBeInTheDocument()
    expect(within(list).queryByText('Équilibré')).not.toBeInTheDocument()
    expect(writes).toEqual([{ method: 'DELETE', path: 'risk_tolerance', body: null }])
    expect(list).toHaveFocus()
  })

  it('says the agent knows nothing yet when nothing is confirmed', async () => {
    switchedOn()
    await openPage('/agent/memory', 'Mémoire')
    expect(
      await within(await memory()).findByText('L’agent ne sait encore rien de vous.'),
    ).toBeInTheDocument()
  })
})

describe('the proposals still waiting, on the memory page (#1621)', () => {
  const rate = aProposal('ready')
  const tolerance: Proposal = {
    ...rate,
    id: 'b'.repeat(32),
    key: 'risk_tolerance',
    value: 'prudent',
  }
  const memory = () => within(screen.getByRole('main')).findByRole('group', { name: 'Mémoire' })

  /** The server's side of it: a decision takes the proposal off the list, a confirmation writes its fact. */
  function waitingOn(proposals: Proposal[]) {
    const decisions: string[] = []
    let waiting = proposals
    let profile: Profile = { facts: {}, projects: [], about: null }
    const decide = (status: 'merged' | 'ignored') => (id: unknown) => {
      const proposal = waiting.find((p) => p.id === id) as Proposal
      decisions.push(`${status} ${proposal.key}`)
      waiting = waiting.filter((p) => p !== proposal)
      if (status === 'merged')
        profile = {
          ...profile,
          facts: { [proposal.key]: { value: proposal.value, confirmed_at: CONFIRMED } },
        }
      return { proposal: { ...proposal, status, decided_at: CONFIRMED }, profile }
    }
    switchedOn()
    server.use(
      http.get(ROUTES.profile, () => HttpResponse.json(profile)),
      http.get(ROUTES.profileProposals, ({ request }) => {
        // The list is the call without `ids`: with them, it is a thread's read.
        expect(new URL(request.url).searchParams.has('ids')).toBe(false)
        return HttpResponse.json({ proposals: waiting })
      }),
      http.post(ROUTES.profileProposalConfirm, ({ params }) =>
        HttpResponse.json(decide('merged')(params.id)),
      ),
      http.post(ROUTES.profileProposalIgnore, ({ params }) =>
        HttpResponse.json(decide('ignored')(params.id)),
      ),
    )
    return decisions
  }

  it('lists them above the facts, and a confirmed one moves to the facts', async () => {
    const decisions = waitingOn([rate, tolerance])
    const { user } = await openPage('/agent/memory', 'Mémoire')

    const pending = await screen.findByRole('region', { name: 'En attente' })
    const cards = within(pending).getAllByRole('listitem')
    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveTextContent(/^Retenir pour la suite : TMI 30\s%/)
    expect(cards[1]).toHaveTextContent('Retenir pour la suite : Prudent')
    const list = await memory()
    expect(pending.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(within(list).getByText(fr['agent.memory.empty'])).toBeInTheDocument()

    await user.click(within(cards[0]).getByRole('button', { name: 'Confirmer' }))

    expect(await within(list).findByText(/^TMI 30\s%$/)).toBeInTheDocument()
    expect(decisions).toEqual(['merged marginal_rate'])
    expect(within(pending).getAllByRole('listitem')).toHaveLength(1)
    expect(within(pending).queryByText(/TMI/)).not.toBeInTheDocument()
    // The card left with its buttons: the focus is on the facts it joined.
    expect(list).toHaveFocus()
  })

  it('ignores one, which leaves the list and the profile as it was', async () => {
    const decisions = waitingOn([rate])
    const { user } = await openPage('/agent/memory', 'Mémoire')

    const pending = await screen.findByRole('region', { name: 'En attente' })
    await user.click(within(pending).getByRole('button', { name: 'Ignorer' }))

    // The last one takes the heading with it.
    await waitFor(() => expect(pending).not.toBeInTheDocument())
    expect(decisions).toEqual(['ignored marginal_rate'])
    const list = await memory()
    expect(within(list).getByText(fr['agent.memory.empty'])).toBeInTheDocument()
    expect(list).toHaveFocus()
  })

  it('draws no heading when nothing waits', async () => {
    waitingOn([])
    await openPage('/agent/memory', 'Mémoire')
    await within(await memory()).findByText(fr['agent.memory.empty'])
    expect(screen.queryByRole('heading', { name: 'En attente' })).not.toBeInTheDocument()
  })
})
