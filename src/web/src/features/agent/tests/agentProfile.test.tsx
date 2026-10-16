/**
 * The investor's profile on the agent's page (#1116): a proposal card read in
 * its stored state, and the chips of what the owner confirmed.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { factLabel, type Profile, type Proposal } from '@/features/agent/lib/profile'
import { ROUTES } from '@/lib/api'
import { formatMessage } from '@/lib/i18n'
import { anAgentConfig } from '@/test/factories'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const ID = 'a'.repeat(32)
const CONFIRMED = '2026-10-12T09:00:00+00:00'

function switchedOn(profile: Profile = { facts: {}, projects: [] }) {
  const writes: { method: string; path: string; body: unknown }[] = []
  let current = profile
  server.use(
    http.get(ROUTES.agentThreads, () => HttpResponse.json([])),
    http.get(ROUTES.agentConfig, () =>
      HttpResponse.json(
        anAgentConfig({ enabled: true, provider: 'anthropic', model: 'claude-sonnet-5-5' }),
      ),
    ),
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

async function openPage(url = '/agent/t1') {
  setViewportWidth(1024)
  const view = renderApp({ url })
  await screen.findByRole('heading', { level: 1, name: 'Agent' })
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

    expect(await within(main).findByText(/^Je note : TMI 30\s% \?$/)).toBeInTheDocument()
    expect(asked).toEqual([ID])
    threadWithProposal(aProposal('merged'))
    await user.click(within(main).getByRole('button', { name: 'Confirmer' }))

    expect(await within(main).findByText('Noté')).toBeInTheDocument()
    expect(confirmed).toBe(true)
    expect(within(main).queryByRole('button', { name: 'Confirmer' })).not.toBeInTheDocument()
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

      expect(await within(main).findByText(line)).toBeInTheDocument()
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
      await within(main).findByText(/^Je note : revenu de 54\s321,00\s€ \?$/),
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
    expect(within(main).queryByText(/Je note/)).not.toBeInTheDocument()
    expect(asked).toEqual([])
  })

  it('falls back to the tool line for a proposal the server does not know', async () => {
    switchedOn()
    threadWithProposal(null)
    const { main } = await openPage()

    expect(
      await within(main).findByText('Proposition d’un fait pour votre profil.'),
    ).toBeInTheDocument()
    expect(within(main).queryByText(/Je note/)).not.toBeInTheDocument()
  })
})

describe('the profile chips (13A)', () => {
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
  }

  it('draws nothing when no fact is declared', async () => {
    switchedOn()
    const { main } = await openPage('/agent')
    await within(main).findByRole('textbox', { name: 'Votre question' })
    expect(within(main).queryByRole('list', { name: 'Votre profil' })).not.toBeInTheDocument()
  })

  it('shows four chips and +2, the income not sent, and +2 opens all six', async () => {
    switchedOn(full)
    const { user, main } = await openPage('/agent')

    const chips = await within(main).findByRole('list', { name: 'Votre profil' })
    expect(
      within(chips)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'Revenu · non envoyé',
      expect.stringMatching(/^TMI 30\s%$/),
      'Équilibré',
      'Maison · 2028',
      '+2',
    ])
    await user.click(within(chips).getByRole('button', { name: 'Tout votre profil (+2)' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('button', { name: 'Oublier' })).toHaveLength(6)
    expect(within(dialog).getByText('Voilier · 2040')).toBeInTheDocument()
  })

  it('edits a fact in its popover, and the chip shows the new value', async () => {
    const writes = switchedOn({ facts: { marginal_rate: full.facts.marginal_rate }, projects: [] })
    const { user, main } = await openPage('/agent')

    const chips = await within(main).findByRole('list', { name: 'Votre profil' })
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

  it('forgets a fact at once, and its chip goes', async () => {
    const writes = switchedOn({
      facts: { income: full.facts.income, risk_tolerance: full.facts.risk_tolerance },
      projects: [],
    })
    const { user, main } = await openPage('/agent')

    const chips = await within(main).findByRole('list', { name: 'Votre profil' })
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
