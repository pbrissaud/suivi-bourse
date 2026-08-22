/**
 * The declaration of the accounts (#729, #793, ADR-0013, ADR-0002, ADR-0028), at
 * the one seam: the whole app in jsdom, HTTP the only faked edge.
 *
 * It lives on `/comptes` since ADR-0028 — with the page that reads the accounts
 * — and the removal came with it, out of a table cell and into the panel, where
 * its three refusals are the prose they always were.
 *
 * Every case below names the reading it prevents, and two of them are the
 * measurements the ticket rests on:
 *
 *  - **a removal present and refused** — the interface's obligation is the
 *    opposite of the API's, so it is absent and names its reason;
 *  - **an onboarding form that cannot record anything** — measured on the dev
 *    stack at #764: with nothing declared, `GET /api/accounts` answered `[]`,
 *    the `<select>` was empty and the save was refused before a request left, on
 *    exactly the install ADR-0005 wrote the form for.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { DEFAULT_ACCOUNT_ID } from '@/lib/accounts'
import { accountPath, ROUTES, type LedgerEvent } from '@/lib/api'
import {
  aFileAccount,
  aLedgerPayload,
  anAccount,
  anAccountsPayload,
  anEvent,
  ledgerEvents,
  noAccountsDeclared,
  theSeededAccount,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

function renderAccounts(
  accounts = anAccountsPayload(),
  events: LedgerEvent[] = ledgerEvents(),
  url = '/comptes',
) {
  server.use(
    http.get(ROUTES.accounts, () => HttpResponse.json(accounts)),
    http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(events))),
  )
  return renderApp({ url })
}

function rail() {
  return screen.getByRole('list', { name: 'Vos comptes' })
}

/** The detail of one account — a landmark named by the account it is about. */
function detail(name: string) {
  return screen.findByRole('region', { name })
}

/** Open one account's panel: its detail, then its name, which is the affordance. */
async function openPanel(user: ReturnType<typeof renderApp>['user'], name: string) {
  await user.click(within(await screen.findByRole('list', { name: 'Vos comptes' })).getByRole(
    'link',
    { name: new RegExp(name) },
  ))
  const opened = await detail(name)
  await user.click(within(opened).getByRole('button', { name }))
  return screen.findByRole('dialog')
}

describe('the same form as the ledger, not a second one', () => {
  it('makes the account’s own name the affordance, and nothing else', async () => {
    const { user } = renderAccounts()
    await detail('Alpha')

    // The ledger's rule to the letter: read-only per row rendered 285 identical
    // locks on 285 rows, and nothing replaces it.
    for (const absent of ['Lecture seule', 'Verrou', 'Devise', 'Modifier']) {
      expect(screen.queryByRole('button', { name: absent })).not.toBeInTheDocument()
    }
    expect(screen.queryByText('🔒')).not.toBeInTheDocument()

    // `Beta` came from a file: what a file declared is corrected in the file, so
    // its name is text — and the sentence beside it says so, because an
    // affordance that is absent names its reason.
    await user.click(within(rail()).getByRole('link', { name: /Beta/ }))
    const beta = await detail('Beta')
    expect(within(beta).queryByRole('button', { name: 'Beta' })).not.toBeInTheDocument()
    expect(beta).toHaveTextContent(/Déclaré par un fichier importé/)

    // `Gamma` was declared here: its name opens the panel.
    const panel = await openPanel(user, 'Gamma')
    expect(panel).toHaveAttribute('data-slot', 'sheet-content')
    expect(within(panel).getByLabelText('Type')).toHaveValue('CTO')
  })

  it('does not offer the identifier for editing: it is what the events name', async () => {
    const { user } = renderAccounts()
    const panel = await openPanel(user, 'Gamma')

    expect(within(panel).queryByLabelText('Identifiant')).not.toBeInTheDocument()
    expect(panel).toHaveTextContent(/ne peut donc pas changer/)
  })
})

describe('the form loses `currency`', () => {
  it('offers an identifier, a type and a name, and no currency of any kind', async () => {
    const { user } = renderAccounts()
    await detail('Alpha')
    await user.click(screen.getByRole('button', { name: 'Déclarer un compte' }))

    const panel = await screen.findByRole('dialog')
    expect(within(panel).getByLabelText('Identifiant')).toBeInTheDocument()
    expect(within(panel).getByLabelText('Type')).toBeInTheDocument()
    expect(within(panel).getByLabelText('Nom')).toBeInTheDocument()

    // ADR-0002 deleted `Account.currency` rather than guarding it: two currency
    // levels and not three, so *a EUR account holding a USD security* has no
    // referent. The page built during the prototype still carried the field.
    for (const absent of ['Devise', 'Currency', 'Devise du compte']) {
      expect(within(panel).queryByLabelText(absent)).not.toBeInTheDocument()
    }
    expect(panel).toHaveTextContent(/n’a pas de devise propre/)
  })

  it('declares the account and takes the panel away', async () => {
    const { user } = renderAccounts()
    await detail('Alpha')
    await user.click(screen.getByRole('button', { name: 'Déclarer un compte' }))

    const panel = await screen.findByRole('dialog')
    await user.type(within(panel).getByLabelText('Identifiant'), 'delta')
    await user.type(within(panel).getByLabelText('Type'), 'CTO')
    await user.type(within(panel).getByLabelText('Nom'), 'Delta')

    server.use(
      http.get(ROUTES.accounts, () =>
        HttpResponse.json(
          anAccountsPayload([
            ...anAccountsPayload().accounts,
            anAccount({ id: 'delta', label: 'Delta', type: 'CTO' }),
          ]),
        ),
      ),
    )

    await user.click(within(panel).getByRole('button', { name: 'Déclarer ce compte' }))
    expect(await within(rail()).findByRole('link', { name: /Delta/ })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('a removal that cannot happen is absent and names its reason', () => {
  it('gives each of the three refusals the room a table cell never gave it', async () => {
    const { user } = renderAccounts(
      anAccountsPayload([...anAccountsPayload().accounts, theSeededAccount()]),
    )

    // The four events of the fixture all name `alpha`.
    const alpha = await openPanel(user, 'Alpha')
    const removal = within(alpha).getByRole('region', { name: 'Supprimer ce compte' })
    expect(removal).toHaveTextContent('4 événements nomment ce compte')
    expect(removal).toHaveTextContent(/nommerait alors quelque chose qui n’existe pas/)
    expect(within(removal).queryByRole('button', { name: 'Supprimer' })).not.toBeInTheDocument()
    await user.click(within(alpha).getByRole('button', { name: 'Annuler' }))

    // The seeded row: renamed, never removed.
    const seeded = await openPanel(user, 'Non affecté')
    expect(within(seeded).getByRole('region', { name: 'Supprimer ce compte' })).toHaveTextContent(
      /le compte que toute installation possède/,
    )
  })

  it('names a file’s own repair, which is not the same one', async () => {
    const { user } = renderAccounts()
    // `Beta` is declared by a file, so its name is not a button — the panel is
    // not reachable at all, and the refusal is the absence of the affordance.
    await user.click(within(await screen.findByRole('list', { name: 'Vos comptes' })).getByRole(
      'link',
      { name: /Beta/ },
    ))
    const beta = await detail('Beta')
    expect(within(beta).queryByRole('button', { name: 'Beta' })).not.toBeInTheDocument()
    expect(beta).toHaveTextContent(/corrigez le fichier et redéposez-le, ou oubliez son import/)
  })

  it('offers it on an account declared here that nothing names', async () => {
    const { user } = renderAccounts()
    const panel = await openPanel(user, 'Gamma')

    const removal = within(panel).getByRole('region', { name: 'Supprimer ce compte' })
    expect(removal).toHaveTextContent(/Rien ne nomme ce compte/)

    server.use(
      http.get(ROUTES.accounts, () =>
        HttpResponse.json(
          anAccountsPayload([
            anAccount({ id: 'alpha', label: 'Alpha' }),
            aFileAccount({ id: 'beta', label: 'Beta' }),
          ]),
        ),
      ),
    )

    await user.click(within(removal).getByRole('button', { name: 'Supprimer' }))
    await waitFor(() =>
      expect(within(rail()).queryByRole('link', { name: /Gamma/ })).not.toBeInTheDocument(),
    )
  })

  it('offers nothing at all while the ledger has not landed', async () => {
    // The count a refusal is made of comes off the ledger, so a removal offered
    // before it lands offers a gesture the server is about to refuse.
    server.use(http.get(ROUTES.events, () => new Promise<never>(() => {})))
    const { user } = renderApp({ url: '/comptes' })
    const panel = await openPanel(user, 'Alpha')

    expect(
      within(panel).queryByRole('region', { name: 'Supprimer ce compte' }),
    ).not.toBeInTheDocument()
    // And the rest of the panel is there: the account is renameable whatever the
    // ledger says.
    expect(within(panel).getByLabelText('Nom')).toBeInTheDocument()
  })
})

describe('`default` on this page, under the name the catalogue gives it', () => {
  it('appears as soon as it carries events, on an install that declared nothing', async () => {
    renderAccounts(noAccountsDeclared(), [
      anEvent({ account: DEFAULT_ACCOUNT_ID }),
      anEvent({ account: DEFAULT_ACCOUNT_ID, date: '2026-01-12' }),
    ])

    // `Non affecté` — one `lib/accounts.ts` function, read by the rail and by
    // the detail, so two surfaces cannot name one thing two ways. Neither the
    // label nor the type the seed wrote ever crosses the screen: both are the
    // server's own English about a row nobody declared.
    const opened = await detail('Non affecté')
    expect(within(rail()).getByRole('link', { name: /Non affecté/ })).toBeInTheDocument()
    // The id is on screen where it is not the name: it is what every event
    // names and what a file's `account` column has to spell.
    expect(opened).toHaveTextContent(DEFAULT_ACCOUNT_ID)
    expect(screen.queryByText('Default account')).not.toBeInTheDocument()
    expect(screen.queryByText('OTHER')).not.toBeInTheDocument()
  })

  it('can be renamed here, which is the only place it can', async () => {
    const { user } = renderAccounts(noAccountsDeclared(), [anEvent({ account: DEFAULT_ACCOUNT_ID })])

    let patched: unknown = null
    const panel = await openPanel(user, 'Non affecté')
    // Both seeded columns open **empty**: neither `Default account` nor `OTHER`
    // is a value the reader typed, and handing one back had them typing `PEA`
    // into `OTHER` and saving `OTHERPEA`.
    expect(within(panel).getByLabelText('Type')).toHaveValue('')
    expect(within(panel).getByLabelText('Nom')).toHaveValue('')
    await user.type(within(panel).getByLabelText('Type'), 'PEA')
    await user.type(within(panel).getByLabelText('Nom'), 'Mon PEA')

    // **The body the server can actually produce**: `declared` stays `false` —
    // renaming the row every install owns declares nothing beyond it — and the
    // renamed row is *in* the list, because `/api/accounts` serves it there.
    server.use(
      http.patch(accountPath(DEFAULT_ACCOUNT_ID), async ({ request }) => {
        patched = await request.json()
        return HttpResponse.json(theSeededAccount({ label: 'Mon PEA', type: 'PEA' }))
      }),
      http.get(ROUTES.accounts, () =>
        HttpResponse.json(noAccountsDeclared({ label: 'Mon PEA', type: 'PEA' })),
      ),
    )

    await user.click(within(panel).getByRole('button', { name: 'Enregistrer ce compte' }))
    // The name given wins, and the id it is addressed by does not move.
    expect(await within(rail()).findByRole('link', { name: /Mon PEA/ })).toBeInTheDocument()
    expect(within(rail()).queryByRole('link', { name: /Non affecté/ })).not.toBeInTheDocument()
    expect(await detail('Mon PEA')).toHaveTextContent(DEFAULT_ACCOUNT_ID)
    expect(patched).toMatchObject({ label: 'Mon PEA', type: 'PEA' })
  })

  it('renames it without demanding a type it already has', async () => {
    // The type is required where the store requires it — a declaration — and a
    // blank on an edit is the label's own case: `update_account` keeps what is
    // there. Refusing here made *renaming* the seeded row, the one gesture this
    // panel exists for at N = 1, conditional on answering a second question.
    const { user } = renderAccounts(noAccountsDeclared(), [])
    const panel = await openPanel(user, 'Non affecté')

    let patched: unknown = null
    server.use(
      http.patch(accountPath(DEFAULT_ACCOUNT_ID), async ({ request }) => {
        patched = await request.json()
        return HttpResponse.json(theSeededAccount({ label: 'Mon PEA' }))
      }),
      http.get(ROUTES.accounts, () => HttpResponse.json(noAccountsDeclared({ label: 'Mon PEA' }))),
    )

    await user.type(within(panel).getByLabelText('Nom'), 'Mon PEA')
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer ce compte' }))

    expect(await within(rail()).findByRole('link', { name: /Mon PEA/ })).toBeInTheDocument()
    expect(patched).toEqual({ type: '', label: 'Mon PEA' })
  })

  it('is named the same way in the ledger’s create form, one page over', async () => {
    // The resource puts the seeded row in the list whenever an event names it, so
    // the event form is a second surface rendering that row — and two surfaces
    // naming one account two ways is what the shared function forbids.
    const { user } = renderAccounts(
      anAccountsPayload([anAccount({ id: 'alpha', label: 'Alpha' }), theSeededAccount()]),
      [anEvent({ account: DEFAULT_ACCOUNT_ID })],
      '/donnees',
    )

    await user.click(await screen.findByRole('button', { name: 'Saisir un événement' }))
    await user.click(await screen.findByRole('radio', { name: 'Versement' }))

    const options = within(screen.getByRole('dialog'))
      .getByLabelText('Compte')
      .querySelectorAll('option')
    expect([...options].map((option) => option.textContent)).toContain('Non affecté')
    expect([...options].map((option) => option.textContent)).not.toContain('Default account')
  })
})

describe('the declaration is reachable at every N', () => {
  it('is there at N = 1, which is what the true first run is', async () => {
    // ADR-0013 gives every install one account, so *nothing declared and nothing
    // recorded* is N = 1 — and this page carries the **only** *« Déclarer un
    // compte »* in the product. Absent, it left the install with a page and no
    // file unable to declare a first account at all.
    renderAccounts(noAccountsDeclared(), [])

    expect(await detail('Non affecté')).toBeInTheDocument()
    expect(within(rail()).getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Déclarer un compte' })).toBeInTheDocument()
  })

  it('is there with a declaration and no event recorded under it yet', async () => {
    renderAccounts(anAccountsPayload(), [])

    await detail('Alpha')
    expect(within(rail()).getAllByRole('link')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Déclarer un compte' })).toBeInTheDocument()
  })

  it('is absent while the accounts read has not landed, and claims nothing', async () => {
    // `/api/accounts` never serves an empty list, so *no rail* is *nothing has
    // arrived* and never a state of the declaration.
    server.use(http.get(ROUTES.accounts, () => new Promise<never>(() => {})))
    renderApp({ url: '/comptes' })

    await screen.findByRole('heading', { level: 1, name: 'Comptes' })
    expect(screen.queryByRole('list', { name: 'Vos comptes' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Déclarer un compte' })).not.toBeInTheDocument()
  })
})

describe('the create form on an install that has declared nothing', () => {
  it('records without asking for a choice there is nothing to make', async () => {
    // The state #764 measured and deferred here: the form used to refuse before
    // a request left. The rule is #698's — a blank account means `default` until
    // something is declared — and the front reflects it.
    const { user } = renderAccounts(
      noAccountsDeclared(),
      [anEvent({ account: DEFAULT_ACCOUNT_ID })],
      '/donnees',
    )

    await user.click(await screen.findByRole('button', { name: 'Saisir un événement' }))
    await user.click(await screen.findByRole('radio', { name: 'Versement' }))
    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-02-20' } })
    await user.type(screen.getByLabelText('Montant'), '250')
    await user.type(screen.getByLabelText('Libellé'), 'Virement de février')

    const panel = screen.getByRole('dialog')
    // No empty list to choose from: the account is stated, not asked.
    expect(within(panel).queryByLabelText('Compte')).not.toBeInTheDocument()
    expect(panel).toHaveTextContent('Non affecté')

    let sent: unknown = null
    server.use(
      http.post(ROUTES.events, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(
          { ...anEvent({ account: DEFAULT_ACCOUNT_ID }), id: 'typed-9' },
          { status: 201 },
        )
      }),
      http.get(ROUTES.events, () =>
        HttpResponse.json(
          aLedgerPayload([
            anEvent({ account: DEFAULT_ACCOUNT_ID }),
            anEvent({
              account: DEFAULT_ACCOUNT_ID,
              date: '2026-02-20',
              event_type: 'DEPOSIT',
              symbol: null,
              notes: 'Virement de février',
              quantity: null,
              unit_price: null,
              fee: null,
              amount: 250,
            }),
          ]),
        ),
      ),
    )

    await user.click(within(panel).getByRole('button', { name: 'Enregistrer cet événement' }))
    expect(await screen.findByText('Virement de février')).toBeInTheDocument()
    // The blank travels as a blank: the server resolves it at the write, where
    // the file road resolves its own empty cell (#698).
    expect((sent as { account: string }).account).toBe('')
  })

  it('does not render a read in flight, or one that failed, as a missing answer', async () => {
    // Three states, three repairs, and only one of them is the reader's. A
    // required-field refusal over an empty control says the reader forgot
    // something, which is false in both of the other two.
    server.use(
      http.get(ROUTES.accounts, () =>
        HttpResponse.json(
          { status: 503, type: '/problems/storage-unavailable', title: 'storage unavailable' },
          { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    renderApp({ url: '/donnees' })

    // The tab's band names the cause once — and **the ledger is still there**.
    // Its own read answered (`GET /api/events` comes off process memory and has
    // no `503`), so masking it would take the events, the filters and the only
    // button that opens the form away for a fault they read no ledger about.
    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    expect(screen.getByRole('table', { name: 'Vos événements' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saisir un événement' })).toBeInTheDocument()
  })
})
