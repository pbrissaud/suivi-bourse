/**
 * Réaffecter, jamais refuser (#725, #793, ADR-0013, ADR-0006, ADR-0028), at the
 * one seam: the whole app in jsdom, HTTP the only faked edge.
 *
 * **The state under test cannot be reached on the real portfolio.** Its 285
 * events all name an account, so `default` is nowhere in it and every case below
 * is invisible there — which is why `unassignedLedger()` exists and why the
 * ticket makes fabricating it an obligation rather than a convenience. What it
 * guards is an install that ran a month before declaring anything: the blank
 * `account` column meant `default` at the instant those rows were imported
 * (#698), and the seeded row then carries a history its owner never created.
 *
 * Both renderings live on `/accounts` since ADR-0028: the box rides inside the
 * first declaration, and the standing offer sits in the **seeded account's own
 * detail**, whose events it is about.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { accountReassignmentPath, ROUTES, type AccountsResponse, type LedgerEvent } from '@/lib/api'
import {
  aLedgerPayload,
  anAccount,
  anAccountsPayload,
  ledgerEvents,
  noAccountsDeclared,
  theSeededAccount,
  unassignedLedger,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

/** The seeded row is in the payload whenever an event names it — as here. */
function declaredBesideTheSeed(...ids: string[]): AccountsResponse {
  return anAccountsPayload(
    [theSeededAccount(), ...ids.map((id) => anAccount({ id, label: id.toUpperCase() }))],
    true,
  )
}

function renderAccounts(
  accounts: AccountsResponse,
  events: LedgerEvent[] = unassignedLedger(),
  url = '/accounts',
) {
  server.use(
    http.get(ROUTES.accounts, () => HttpResponse.json(accounts)),
    http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(events))),
  )
  return renderApp({ url })
}

function rail() {
  return screen.findByRole('list', { name: 'Vos comptes' })
}

const OFFER = 'Des événements affectés à aucun compte'
const REASSIGN = 'Affecter ces événements à un compte'

describe('the first declaration carries the reassignment', () => {
  it('offers it in the same gesture, checked by default', async () => {
    const { user } = renderAccounts(noAccountsDeclared())
    await rail()

    let sent: unknown = null
    server.use(
      http.post(ROUTES.accounts, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(anAccount({ id: 'pea' }), { status: 201 })
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Déclarer un compte' }))
    const panel = await screen.findByRole('dialog')
    // The count is the reader's own, and it is on the box rather than in a
    // paragraph beside it: what is being agreed to is what is written on it.
    const box = within(panel).getByRole('checkbox', {
      name: /Lui affecter les 3 événements qui ne nomment aucun compte/,
    })
    expect(box).toBeChecked()

    await user.type(within(panel).getByLabelText('Identifiant'), 'pea')
    await user.type(within(panel).getByLabelText('Type'), 'PEA')
    await user.click(within(panel).getByRole('button', { name: 'Déclarer ce compte' }))

    // **One request**, which is what *dans le même geste* means: the declaration
    // and the move are not two gestures a reader can be interrupted between.
    await waitFor(() => expect(sent).toEqual({ id: 'pea', type: 'PEA', label: 'pea', reassign: true }))
  })

  it('is never a refusal, and unchecking still declares', async () => {
    // Refusing is the trap this ticket is named after: it locks the owner out of
    // the one action that repairs their state. So the box is an offer, and the
    // declaration goes through without it.
    const { user } = renderAccounts(noAccountsDeclared())
    await rail()

    let sent: unknown = null
    server.use(
      http.post(ROUTES.accounts, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(anAccount({ id: 'pea' }), { status: 201 })
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Déclarer un compte' }))
    const panel = await screen.findByRole('dialog')
    await user.click(within(panel).getByRole('checkbox'))
    await user.type(within(panel).getByLabelText('Identifiant'), 'pea')
    await user.type(within(panel).getByLabelText('Type'), 'PEA')
    await user.click(within(panel).getByRole('button', { name: 'Déclarer ce compte' }))

    await waitFor(() => expect(sent).toEqual({ id: 'pea', type: 'PEA', label: 'pea' }))
  })

  it('asks nothing about the row its owner has already named', async () => {
    // Renaming the seeded row **is** the declaration, on an install with a page
    // and no file (#729) — so its events name the account their owner named, and
    // a pre-ticked box on a second declaration would move them off it.
    const { user } = renderAccounts(noAccountsDeclared({ label: 'Mon PEA' }))
    await rail()

    expect(screen.queryByText(OFFER)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: REASSIGN })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Déclarer un compte' }))
    const panel = await screen.findByRole('dialog')
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('asks nothing where there is nothing to move', async () => {
    // The real portfolio's own shape: every event names an account, so no box
    // and no block. The constraint is unobservable there, deliberately.
    const { user } = renderAccounts(noAccountsDeclared(), ledgerEvents())
    await rail()

    expect(screen.queryByText(OFFER)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Déclarer un compte' }))
    const panel = await screen.findByRole('dialog')
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument()
  })
})

describe('and it stands on its own once something is declared', () => {
  /** The offer lives in the seeded account's own detail — its events, its page. */
  async function openTheSeed(user: ReturnType<typeof renderApp>['user']) {
    await user.click(within(await rail()).getByRole('link', { name: /Non affecté/ }))
    return screen.findByRole('region', { name: 'Non affecté' })
  }

  it('appears where a file declared, with no gesture in the app at all', async () => {
    // The other road (#698): an accounts source declares as much as the form
    // does, and the event file beside it is refused for the blank column it was
    // right to carry — leaving its rows under the seeded account with nothing on
    // any page able to move them. This block is that gesture.
    const { user } = renderAccounts(declaredBesideTheSeed('pea', 'cto'))
    const seed = await openTheSeed(user)

    const block = within(seed).getByRole('region', { name: OFFER })
    expect(block).toHaveTextContent('3 événements ont été enregistrés')
  })

  it('is not on any other account’s detail', async () => {
    // Its subject is *this* account's events: rendered beside `PEA`'s figures it
    // would be an offer to move events that account never carried.
    const { user } = renderAccounts(declaredBesideTheSeed('pea'))
    await user.click(within(await rail()).getByRole('link', { name: /PEA/ }))

    const pea = await screen.findByRole('region', { name: 'PEA' })
    expect(within(pea).queryByRole('region', { name: OFFER })).not.toBeInTheDocument()
  })

  it('moves them onto the account chosen, and never one event at a time', async () => {
    // **No correspondence layer** (ADR-0006): what crosses the wire is one
    // target id, never a `default → pea` map beside the events — which would be
    // a second truth about the account an event names.
    const { user } = renderAccounts(declaredBesideTheSeed('pea', 'cto'))
    const seed = await openTheSeed(user)

    let posted = 0
    server.use(
      http.post(accountReassignmentPath('cto'), () => {
        posted += 1
        return HttpResponse.json({ account: 'cto', reassigned: 3 })
      }),
    )

    // One control for the whole population, not one per row: three events are
    // under this account and there is a single target to choose.
    const block = within(seed).getByRole('region', { name: OFFER })
    expect(within(block).getAllByRole('combobox')).toHaveLength(1)
    await user.selectOptions(within(block).getByLabelText('Les affecter à'), 'cto')
    await user.click(within(block).getByRole('button', { name: 'Affecter ces événements' }))

    await waitFor(() => expect(posted).toBe(1))
  })

  it('does not ask a question whose answer is already known', async () => {
    // One declared account: a select of one entry is a question with one answer,
    // and the gesture is one click.
    const { user } = renderAccounts(declaredBesideTheSeed('pea'))
    const seed = await openTheSeed(user)

    let posted = 0
    server.use(
      http.post(accountReassignmentPath('pea'), () => {
        posted += 1
        return HttpResponse.json({ account: 'pea', reassigned: 3 })
      }),
    )

    const block = within(seed).getByRole('region', { name: OFFER })
    expect(within(block).queryByText('Choisir un compte')).not.toBeInTheDocument()
    await user.click(within(block).getByRole('button', { name: 'Affecter ces événements' }))

    await waitFor(() => expect(posted).toBe(1))
  })

  it('leaves the screen once the window is spent', async () => {
    const { user } = renderAccounts(declaredBesideTheSeed('pea'), ledgerEvents())
    const seed = await openTheSeed(user)

    expect(seed).not.toHaveTextContent(OFFER)
  })
})

describe('the link from the unassigned line lands on the gesture', () => {
  it('leads to the offer itself, not to the page it lives on', async () => {
    // The link owes its reader the **gesture** (#725), and since ADR-0028 that
    // gesture is one click away on this very page rather than on another one.
    const { user } = renderAccounts(declaredBesideTheSeed('pea'))
    await rail()

    const link = screen.getByRole('link', { name: REASSIGN })
    expect(link).toHaveAttribute('href', '/accounts?account=default')
    await user.click(link)

    const seed = await screen.findByRole('region', { name: 'Non affecté' })
    expect(within(seed).getByRole('region', { name: OFFER })).toBeInTheDocument()
  })

  it('opens the declaration where the gesture *is* the first declaration', async () => {
    // Nothing declared: the offer has no target to name, so it rides inside the
    // panel — and there is nowhere to lead to. A button, not a link.
    const { user } = renderAccounts(noAccountsDeclared())
    await rail()

    expect(screen.queryByRole('link', { name: REASSIGN })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: REASSIGN }))

    const panel = await screen.findByRole('dialog')
    expect(within(panel).getByRole('checkbox')).toBeChecked()
  })

  it('is offered by neither rendering where there is nothing to move', async () => {
    renderAccounts(declaredBesideTheSeed('pea'), ledgerEvents())
    await rail()

    expect(screen.queryByRole('link', { name: REASSIGN })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: REASSIGN })).not.toBeInTheDocument()
  })
})
