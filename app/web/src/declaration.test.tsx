/**
 * The declaration of the accounts (#729, ADR-0013, ADR-0002, ADR-0020), at the
 * one seam: the whole app in jsdom, HTTP the only faked edge.
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

function renderDeclaration(
  accounts = anAccountsPayload(),
  events: LedgerEvent[] = ledgerEvents(),
) {
  server.use(
    http.get(ROUTES.accounts, () => HttpResponse.json(accounts)),
    http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(events))),
  )
  return renderApp({ url: '/donnees' })
}

function declaration() {
  return screen.getByRole('table', { name: 'Vos comptes' })
}

function rowsOf(table: HTMLElement) {
  return within(table).getAllByRole('row').slice(1)
}

function rowNamed(name: string) {
  return within(declaration()).getByText(name).closest('tr') as HTMLElement
}

describe('the same form as the ledger, not a second one', () => {
  it('sits under the ledger, on the tab of what the user declared', async () => {
    renderDeclaration()
    await waitFor(() => expect(declaration()).toBeInTheDocument())

    expect(
      within(declaration())
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent?.trim()),
    ).toEqual(['Compte', 'Type', 'Événements', 'Déclaré', 'Suppression'])
  })

  it('has no padlock column, and the affordance is the row’s own name', async () => {
    const { user } = renderDeclaration()
    await waitFor(() => expect(declaration()).toBeInTheDocument())

    // The ledger's rule to the letter: read-only per row rendered 285 identical
    // locks on 285 rows, and nothing replaces it because the provenance column
    // already discriminates.
    for (const absent of ['Lecture seule', 'Verrou', 'Devise', 'Modifier']) {
      expect(
        within(declaration()).queryByRole('columnheader', { name: absent }),
      ).not.toBeInTheDocument()
    }
    expect(screen.queryByText('🔒')).not.toBeInTheDocument()

    // `Beta` came from a file: it is text, and there is nothing to press on it.
    expect(within(rowNamed('Beta')).queryByRole('button')).not.toBeInTheDocument()
    expect(rowNamed('Beta')).toHaveTextContent('Par un fichier importé')

    // `Gamma` was declared here: its name opens the panel, never an inline row.
    expect(within(declaration()).queryAllByRole('textbox')).toHaveLength(0)
    await user.click(within(rowNamed('Gamma')).getByRole('button', { name: 'Gamma' }))
    const panel = await screen.findByRole('dialog')
    expect(panel).toHaveAttribute('data-slot', 'sheet-content')
    expect(within(panel).getByLabelText('Type')).toHaveValue('CTO')
  })

  it('does not offer the identifier for editing: it is what the events name', async () => {
    const { user } = renderDeclaration()
    await waitFor(() => expect(declaration()).toBeInTheDocument())
    await user.click(within(rowNamed('Gamma')).getByRole('button', { name: 'Gamma' }))

    const panel = await screen.findByRole('dialog')
    expect(within(panel).queryByLabelText('Identifiant')).not.toBeInTheDocument()
    expect(panel).toHaveTextContent(/ne peut donc pas changer/)
  })
})

describe('the form loses `currency`', () => {
  it('offers an identifier, a type and a name, and no currency of any kind', async () => {
    const { user } = renderDeclaration()
    await waitFor(() => expect(declaration()).toBeInTheDocument())
    await user.click(await screen.findByRole('button', { name: 'Déclarer un compte' }))

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
    const { user } = renderDeclaration()
    await waitFor(() => expect(declaration()).toBeInTheDocument())
    await user.click(await screen.findByRole('button', { name: 'Déclarer un compte' }))

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
    expect(await within(declaration()).findByText('Delta')).toBeInTheDocument()
  })
})

describe('a removal that cannot happen is absent and names its reason', () => {
  it('counts the events that name it rather than offering a button', async () => {
    renderDeclaration()
    await waitFor(() => expect(declaration()).toBeInTheDocument())

    // The four events of the fixture all name `alpha`.
    const alpha = rowNamed('Alpha')
    expect(alpha).toHaveTextContent('4 événements nomment ce compte')
    expect(within(alpha).queryByRole('button', { name: 'Supprimer' })).not.toBeInTheDocument()

    // A file's row names its own repair, and it is not the same one.
    expect(rowNamed('Beta')).toHaveTextContent(/oubliez cet import/)
    expect(
      within(rowNamed('Beta')).queryByRole('button', { name: 'Supprimer' }),
    ).not.toBeInTheDocument()
  })

  it('offers it on a row declared here that nothing names', async () => {
    const { user } = renderDeclaration()
    await waitFor(() => expect(declaration()).toBeInTheDocument())

    const remove = within(rowNamed('Gamma')).getByRole('button', { name: 'Supprimer' })
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

    await user.click(remove)
    await waitFor(() =>
      expect(within(declaration()).queryByText('Gamma')).not.toBeInTheDocument(),
    )
  })
})

describe('`default` in this table, under the name the accounts page uses', () => {
  it('appears as soon as it carries events, on an install that declared nothing', async () => {
    renderDeclaration(noAccountsDeclared(), [
      anEvent({ account: DEFAULT_ACCOUNT_ID }),
      anEvent({ account: DEFAULT_ACCOUNT_ID, date: '2026-01-12' }),
    ])
    await waitFor(() => expect(declaration()).toBeInTheDocument())

    // `Non affecté` — one `lib/accounts.ts` function, read by this block and by
    // the accounts page, so two pages cannot name one thing two ways.
    const row = rowNamed('Non affecté')
    expect(row).toHaveTextContent(DEFAULT_ACCOUNT_ID)
    expect(row).toHaveTextContent('2')
    expect(row).toHaveTextContent(/le compte que toute installation possède/)
    expect(within(row).queryByRole('button', { name: 'Supprimer' })).not.toBeInTheDocument()
  })

  it('can be renamed here, which is the only place it can', async () => {
    const { user } = renderDeclaration(noAccountsDeclared(), [
      anEvent({ account: DEFAULT_ACCOUNT_ID }),
    ])
    await waitFor(() => expect(declaration()).toBeInTheDocument())

    let patched: unknown = null
    await user.click(within(rowNamed('Non affecté')).getByRole('button', { name: 'Non affecté' }))
    const panel = await screen.findByRole('dialog')
    // Both seeded columns open **empty**: neither `Default account` nor `OTHER`
    // is a value the reader typed, and handing one back had them typing `PEA`
    // into `OTHER` and saving `OTHERPEA`.
    expect(within(panel).getByLabelText('Type')).toHaveValue('')
    expect(within(panel).getByLabelText('Nom')).toHaveValue('')
    await user.type(within(panel).getByLabelText('Type'), 'PEA')
    await user.type(within(panel).getByLabelText('Nom'), 'Mon PEA')

    // **The body the server can actually produce**, and it is the whole of this
    // case: `declared` stays `false` — renaming the row every install owns
    // declares nothing beyond it — and the renamed row is *in* the list, because
    // `/api/accounts` serves it there (#729). Answering `{declared: true,
    // accounts: [default]}` instead is a payload no store yields, and it is what
    // let this assertion pass while the real screen re-drew `Non affecté` over a
    // store that said `Mon PEA`.
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
    expect(await within(declaration()).findByText('Mon PEA')).toBeInTheDocument()
    expect(within(declaration()).queryByText('Non affecté')).not.toBeInTheDocument()
    expect(rowNamed('Mon PEA')).toHaveTextContent(DEFAULT_ACCOUNT_ID)
    expect(patched).toMatchObject({ label: 'Mon PEA', type: 'PEA' })

    // **And the form on this same tab calls it the same thing.** Nothing is
    // declared, so the account field is a sentence rather than a `<select>` —
    // and that sentence read the catalogue while the table read the store, so
    // one account wore two names on one screen, one gesture after the rename.
    await user.click(await screen.findByRole('button', { name: 'Saisir un événement' }))
    await user.click(await screen.findByRole('radio', { name: 'Versement' }))
    const form = await screen.findByRole('dialog')
    expect(within(form).getByText('Mon PEA')).toBeInTheDocument()
    expect(within(form).queryByText('Non affecté')).not.toBeInTheDocument()
  })

  it('renames it without demanding a type it already has', async () => {
    // The type is required where the store requires it — a declaration — and a
    // blank on an edit is the label's own case: `update_account` keeps what is
    // there. Refusing here made *renaming* the seeded row, the one gesture this
    // panel exists for at N = 1, conditional on answering a second question.
    const { user } = renderDeclaration(noAccountsDeclared(), [])
    await waitFor(() => expect(declaration()).toBeInTheDocument())

    let patched: unknown = null
    server.use(
      http.patch(accountPath(DEFAULT_ACCOUNT_ID), async ({ request }) => {
        patched = await request.json()
        return HttpResponse.json(theSeededAccount({ label: 'Mon PEA' }))
      }),
      http.get(ROUTES.accounts, () => HttpResponse.json(noAccountsDeclared({ label: 'Mon PEA' }))),
    )

    await user.click(within(rowNamed('Non affecté')).getByRole('button', { name: 'Non affecté' }))
    const panel = await screen.findByRole('dialog')
    await user.type(within(panel).getByLabelText('Nom'), 'Mon PEA')
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer ce compte' }))

    expect(await within(declaration()).findByText('Mon PEA')).toBeInTheDocument()
    expect(patched).toEqual({ type: '', label: 'Mon PEA' })
  })

  it('is named the same way in the create form’s account list', async () => {
    // The resource puts the seeded row in the list whenever an event names it, so
    // the event form is a second surface rendering that row — and two surfaces
    // naming one account two ways is what the shared function forbids.
    const { user } = renderDeclaration(
      anAccountsPayload([anAccount({ id: 'alpha', label: 'Alpha' }), theSeededAccount()]),
      [anEvent({ account: DEFAULT_ACCOUNT_ID })],
    )
    await waitFor(() => expect(declaration()).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Saisir un événement' }))
    await user.click(await screen.findByRole('radio', { name: 'Versement' }))

    const options = within(screen.getByRole('dialog'))
      .getByLabelText('Compte')
      .querySelectorAll('option')
    expect([...options].map((option) => option.textContent)).toContain('Non affecté')
    expect([...options].map((option) => option.textContent)).not.toContain('Default account')
  })

  it('renders neither the label nor the type the seed wrote', async () => {
    // Both are the server's own English about a row nobody declared (ADR-0024,
    // ADR-0016), and the origin column owes a third answer for the same reason:
    // read as *a file or the app*, it credited the owner with a declaration they
    // never made — on the screen where it is the only row there is.
    renderDeclaration(noAccountsDeclared(), [])
    await waitFor(() => expect(declaration()).toBeInTheDocument())

    const row = rowNamed('Non affecté')
    expect(row).not.toHaveTextContent('Default account')
    expect(row).not.toHaveTextContent('OTHER')
    expect(row).toHaveTextContent('Par l’installation elle-même')
  })
})

describe('the block exists at every N', () => {
  it('is there at N = 1, where the accounts page leaves the navigation', async () => {
    // A comparison of one term is not a comparison, and that is the *page*'s
    // argument. The declaration is the only place `default` can be renamed or
    // replaced, so removing it at N = 1 would lock in precisely the owner the
    // reassignment exists to free.
    renderDeclaration(anAccountsPayload([anAccount({ id: 'alpha', label: 'Alpha' })]))
    await waitFor(() => expect(declaration()).toBeInTheDocument())
    expect(rowsOf(declaration())).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Déclarer un compte' })).toBeInTheDocument()
  })

  it('is there with a declaration and no event recorded under it yet', async () => {
    // An install that imported an accounts file and nothing else still has
    // accounts to name, so the block that renames them cannot be what the empty
    // ledger hides. The ledger's own zero state is untouched beside it.
    renderDeclaration(anAccountsPayload(), [])
    expect(await screen.findByRole('region', { name: 'Déposer un fichier' })).toBeInTheDocument()
    await waitFor(() => expect(declaration()).toBeInTheDocument())
    expect(rowsOf(declaration())).toHaveLength(3)
    expect(screen.queryByRole('table', { name: 'Vos événements' })).not.toBeInTheDocument()
  })

  it('exists on the true first run, which is N = 1 and not N = 0', async () => {
    // The screen the block used to render as nothing at all. ADR-0013 gives every
    // install one account, so *nothing declared and nothing recorded* is N = 1 —
    // and the block carries the **only** *« Déclarer un compte »* in the product.
    // Absent, it left the install with a page and no file unable to declare a
    // first account at all, which is the half of #698 that exists for it, and
    // locked it into the one account nothing can reassign.
    renderDeclaration(noAccountsDeclared(), [])
    // The ledger's own zero state is untouched beside it: two entrances of equal
    // weight, and the declaration is not a third one.
    expect(await screen.findByRole('region', { name: 'Déposer un fichier' })).toBeInTheDocument()
    await waitFor(() => expect(declaration()).toBeInTheDocument())
    expect(rowsOf(declaration())).toHaveLength(1)
    expect(rowNamed('Non affecté')).toHaveTextContent(DEFAULT_ACCOUNT_ID)
    expect(screen.queryByRole('table', { name: 'Vos événements' })).not.toBeInTheDocument()

    // And it is reachable: the declaration form opens from here, with no file
    // written anywhere.
    expect(screen.getByRole('button', { name: 'Déclarer un compte' })).toBeInTheDocument()
  })

  it('is absent while the accounts read has not landed, and claims nothing', async () => {
    // The one meaning an empty table has left: `/api/accounts` never serves an
    // empty list, so *no row* is *nothing has arrived* and never a state of the
    // declaration — and a table of one row growing to four under the reader's
    // eyes is the flash #718 refused a skeleton over.
    server.use(
      http.get(ROUTES.accounts, () => new Promise(() => {})),
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
    )
    renderApp({ url: '/donnees' })

    expect(await screen.findByRole('table', { name: 'Vos événements' })).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Vos comptes' })).not.toBeInTheDocument()
  })
})

describe('the create form on an install that has declared nothing', () => {
  it('records without asking for a choice there is nothing to make', async () => {
    // The state #764 measured and deferred here: the form used to refuse before
    // a request left. The rule is #698's — a blank account means `default` until
    // something is declared — and the front reflects it.
    const { user } = renderDeclaration(noAccountsDeclared(), [
      anEvent({ account: DEFAULT_ACCOUNT_ID }),
    ])
    await waitFor(() => expect(declaration()).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Saisir un événement' }))
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

    // The tab's band names the cause once, and the declaration is not rendered
    // as an install that declared nothing.
    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    expect(screen.queryByRole('table', { name: 'Vos comptes' })).not.toBeInTheDocument()

    // **And the ledger is still there.** Its own read answered — `GET /api/events`
    // comes off process memory and has no `503` (#764) — so masking it here would
    // take the 285 events, the filters and the only button that opens the form
    // away for a fault they read no ledger about. A band over a page that still
    // has everything to show is #718's white screen arrived from the other side.
    expect(screen.getByRole('table', { name: 'Vos événements' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saisir un événement' })).toBeInTheDocument()
  })
})
