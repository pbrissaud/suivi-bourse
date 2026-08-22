/**
 * **Import et export** (#728, ADR-0020, ADR-0015), at the one seam: the whole
 * app in jsdom, HTTP the only faked edge.
 *
 * Every case below names the reading it prevents, and the first of them is the
 * decision taken against the interview — rendered, three consecutive rows of the
 * ledger carried three identical red *« Oublier cet import (214) »* buttons, and
 * somebody deletes 214 events believing they are removing one.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES, type Account, type ImportRecord, type LedgerEvent } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  anAccount,
  anAccountsPayload,
  anEvent,
  aFileAccount,
  anImport,
  anImportsPayload,
  aLedgerPayload,
  aTypedEvent,
  defaultImports,
  ledgerEvents,
  theSeededAccount,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

function renderImports({
  events = ledgerEvents(),
  imports = defaultImports(),
  accounts = undefined as Account[] | undefined,
  declared = true,
}: {
  events?: LedgerEvent[]
  imports?: ImportRecord[]
  accounts?: Account[]
  declared?: boolean
} = {}) {
  server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(events))))
  server.use(http.get(ROUTES.imports, () => HttpResponse.json(anImportsPayload(imports))))
  if (accounts) {
    server.use(http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload(accounts, declared))))
  }
  return renderApp({ url: '/donnees' })
}

function block() {
  return screen.getByRole('table', { name: 'Import et export' })
}

function ledger() {
  return screen.getByRole('table', { name: 'Vos événements' })
}

/** The export is a menu since #794: its entries exist once it is open. */
async function openExport(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Exporter' }))
  return screen.findByRole('menu')
}

function rowFor(file: string) {
  return within(block())
    .getAllByRole('row')
    .find((row) => (row.textContent ?? '').includes(file)) as HTMLElement
}

describe('the gesture belongs to the source, never to a row', () => {
  it('offers no forget button anywhere in the ledger', async () => {
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // The criterion, tested: the subject of the gesture is the file, and
    // repeating it per row makes it read as a row gesture.
    expect(within(ledger()).queryByRole('button', { name: /Oublier/ })).not.toBeInTheDocument()
    // One per **source** and not one per row: four events, two files, two
    // buttons. On the real portfolio that is 285 rows against two.
    expect(within(ledger()).getAllByRole('row').slice(1)).toHaveLength(4)
    expect(screen.getAllByRole('button', { name: 'Oublier cet import' })).toHaveLength(2)
  })

  it('makes the provenance a link that marks its source in the block', async () => {
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const provenance = within(ledger()).getAllByRole('button', {
      name: /zeta-events_2\.csv/,
    })[0]
    await user.click(provenance)

    const marked = rowFor('zeta-events_2.csv')
    expect(marked).toHaveAttribute('aria-current', 'true')
    expect(marked).toHaveTextContent('D’où vient la ligne que vous suiviez.')
    // The other source is not marked: one line has one source.
    expect(rowFor('zeta-accounts.csv')).not.toHaveAttribute('aria-current')
  })
})

describe('the list of imports', () => {
  it('is five columns, and the file is a name and never a path', async () => {
    renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())

    expect(
      within(block())
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent?.trim()),
    ).toEqual(['Fichier', 'Nature', 'Importé le', 'Lignes', 'Révocation'])
    // A name, never a path — the store is the truth, and the folder it was
    // dropped in is not the reader's business here.
    const files = within(block())
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].textContent ?? '')
    expect(files).toContain('zeta-events_2.csv')
    expect(files.every((name) => !name.includes('/'))).toBe(true)
  })

  it('puts the accounts sources first, then sorts on the name', async () => {
    // Not a rendering choice: `event.account` references `account(id)`, so this
    // is the order the foreign key imposes on an import.
    renderImports({
      imports: [
        anImport({ id: 1, filename: 'b-events.csv', kind: 'events' }),
        anImport({ id: 2, filename: 'a-events.csv', kind: 'events' }),
        anImport({ id: 3, filename: 'z-accounts.csv', kind: 'accounts', events: 0 }),
      ],
    })
    await waitFor(() => expect(block()).toBeInTheDocument())

    const files = within(block())
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].textContent)
    expect(files).toEqual(['z-accounts.csv', 'a-events.csv', 'b-events.csv'])
  })

  it('never shows the fingerprint, and never whether the file is still on disk', async () => {
    renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())

    // Nobody reads a hexadecimal, and the store is the truth: the drop folder is
    // an optional read-only bind, so *not found* would be a permanent false
    // defect on every install without one.
    expect(block().textContent).not.toContain('9f2b7c1d4e6a8b0c')
    for (const absent of ['Empreinte', 'Introuvable', 'Présent', 'Chemin']) {
      expect(within(block()).queryByText(absent)).not.toBeInTheDocument()
    }
  })
})

describe('the revocation', () => {
  it('counts before the gesture, in events, securities and accounts', async () => {
    const { user } = renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.click(within(rowFor('zeta-events_2.csv')).getByRole('button'))
    const box = await screen.findByRole('dialog')

    expect(box).toHaveTextContent('Oublier zeta-events_2.csv ?')
    // Three imported rows, of which two name `ZZA` and one names no security at
    // all; `ZZC` survives on the typed row, and so does the account.
    expect(box).toHaveTextContent('Retire 3 événements, 1 symbole et 0 compte de la répartition.')
  })

  it('says what re-importing really depends on, and never that it is reversible', async () => {
    const { user } = renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.click(within(rowFor('zeta-events_2.csv')).getByRole('button'))
    const box = await screen.findByRole('dialog')

    expect(box).toHaveTextContent(/Ré-importable si vous avez encore le fichier/)
    // The bind is optional: the app does not know whether the reader still has
    // the file, so neither word may be said.
    expect(box.textContent).not.toMatch(/réversible|annulable/i)
  })

  it('says that forgetting a source of events makes an account removable without touching it', async () => {
    // The ticket's own case: an account **another file** declares, whose events
    // all come from this one.
    const { user } = renderImports({
      events: [
        anEvent({ source_id: 1, account: 'beta', symbol: 'ZZA' }),
        anEvent({ source_id: 1, account: 'beta', symbol: 'ZZB' }),
      ],
      accounts: [anAccount({ id: 'alpha' }), aFileAccount({ id: 'beta', label: 'Beta', source_id: 2 })],
    })
    await waitFor(() => expect(block()).toBeInTheDocument())
    await user.click(within(rowFor('zeta-events_2.csv')).getByRole('button'))

    const box = await screen.findByRole('dialog')
    expect(box).toHaveTextContent(/Plus aucun événement ne nommera Beta/)
    expect(box).toHaveTextContent(/sans que ce geste y touche/)
  })

  it('forgets the source and nothing else, then re-reads the ledger', async () => {
    let forgotten: string | null = null
    server.use(
      http.delete(ROUTES.importSource, ({ params }) => {
        forgotten = String(params.id)
        return HttpResponse.json({ id: Number(params.id), events_removed: 3 })
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.click(within(rowFor('zeta-events_2.csv')).getByRole('button'))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Oublier cet import' }),
    )

    await waitFor(() => expect(forgotten).toBe('1'))
  })

  it('names the refusal on an accounts source an event holds, rather than offering it', async () => {
    // `accounts.delete_account` refuses to retire an account an event names, and
    // the cascade is refused with it. A control the app knows will be refused
    // teaches nothing by being there; the count is what the owner has to act on.
    renderImports({
      events: [anEvent({ source_id: 1, account: 'beta', symbol: 'ZZA' })],
      accounts: [anAccount({ id: 'alpha' }), aFileAccount({ id: 'beta', label: 'Beta', source_id: 2 })],
    })
    await waitFor(() => expect(block()).toBeInTheDocument())

    const row = rowFor('zeta-accounts.csv')
    expect(within(row).queryByRole('button')).not.toBeInTheDocument()
    expect(row).toHaveTextContent('1 événement nomme un compte déclaré par ce fichier')
  })
})

describe('the export', () => {
  it('is total, and offers nothing to narrow it with', async () => {
    const { user } = renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())
    const menu = await openExport(user)

    expect(within(menu).getByRole('menuitem', { name: 'Vos événements' })).toHaveAttribute(
      'href',
      '/api/export/events.csv',
    )
    expect(within(menu).getByRole('menuitem', { name: 'Vos comptes' })).toHaveAttribute(
      'href',
      '/api/export/accounts.csv',
    )
    // The tempting feature, and the one the criterion forbids by name: an export
    // of the current reduction is not a round trip while looking exactly like
    // one.
    expect(
      within(menu).queryByRole('menuitem', { name: /(la sélection|ce filtre|cette vue)/ }),
    ).not.toBeInTheDocument()
    // Two files and not one, said where the choice is made rather than as a
    // paragraph on a page that has stopped explaining its own rules.
    expect(within(menu).getByText(/porte dans une colonne la devise/)).toBeInTheDocument()
  })

  it('does not offer the accounts file on an install that has declared nothing', async () => {
    // The seeded row is not a declaration (ADR-0013): the file would be a header
    // with no rows under it, and v4's loader refuses the whole directory over
    // it — which is the round trip this export exists for.
    const { user } = renderImports({ accounts: [theSeededAccount()], declared: false })
    const menu = await openExport(user)

    expect(within(menu).getByRole('menuitem', { name: 'Vos événements' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Vos comptes' })).not.toBeInTheDocument()
  })

  it('lives in the band, which holds the drop zone and the sources with it', async () => {
    renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())

    // One band above the table (#794, ADR-0030): the zone, the menu and the
    // files. Getting one's data out is a question of files, not of the ledger.
    const band = screen.getByRole('region', { name: 'Import et export' })
    expect(within(band).getByText(/Déposez un \.csv ou un \.xlsx/)).toBeInTheDocument()
    expect(within(band).getByRole('button', { name: 'Exporter' })).toBeInTheDocument()
    expect(within(band).getByRole('table', { name: 'Import et export' })).toBeInTheDocument()
  })

  it('puts the band above the ledger it describes', async () => {
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const band = screen.getByRole('region', { name: 'Import et export' })
    expect(band.compareDocumentPosition(ledger()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('a read that has not landed', () => {
  it('states no verdict about a source while the declaration is in flight', async () => {
    // The declaration is what the verdict rests on: read as *nothing is
    // declared*, a source whose accounts an event holds offers the gesture the
    // server answers a `409` to, and its box states *« Retire 0 compte
    // déclaré »* — both said on a silence. No net can catch it, the same words
    // being on screen once the read lands.
    server.use(http.get(ROUTES.accounts, () => new Promise<never>(() => {})))
    server.use(
      http.get(ROUTES.events, () =>
        HttpResponse.json(aLedgerPayload([anEvent({ source_id: 1, account: 'beta' })])),
      ),
    )
    renderApp({ url: '/donnees' })
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // The list is withheld with the read it rests on; what the ledger alone owns
    // — the events file — is not, which is #777's notch rather than a whole
    // block waiting.
    expect(screen.queryByRole('table', { name: 'Import et export' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Oublier cet import' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Exporter' })).toBeInTheDocument()
  })

  it('leads nowhere from a provenance while the list of sources is in flight', async () => {
    // A label that marked a block nobody can see is a click that does nothing.
    // It stays the plain label it has always been, which is the same rule as the
    // block rendering nothing at all while its own read is in flight (ADR-0026).
    server.use(http.get(ROUTES.imports, () => new Promise<never>(() => {})))
    renderApp({ url: '/donnees' })
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(within(ledger()).getAllByText(/zeta-events_2\.csv/).length).toBeGreaterThan(0)
    expect(within(ledger()).queryAllByRole('button', { name: /zeta-events_2\.csv/ })).toHaveLength(0)
  })
})

describe('a refusal the reader could not foresee', () => {
  it('is said where the reader is, inside the box that produced it', async () => {
    // The ledger can move between the render and the click, so the gesture the
    // list offered comes back a `409`. The box stays open on it — and everything
    // behind the overlay is `aria-hidden`, so a band in the section is a sentence
    // nobody can read while the only thing on screen is the box.
    server.use(
      http.delete(ROUTES.importSource, () =>
        HttpResponse.json(
          { status: 409, type: PROBLEM_TYPES.conflict, title: 'Conflict' },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.click(within(rowFor('zeta-events_2.csv')).getByRole('button'))
    const box = await screen.findByRole('dialog')
    await user.click(within(box).getByRole('button', { name: 'Oublier cet import' }))

    expect(await within(box).findByRole('status')).toBeInTheDocument()
    expect(box).toBeInTheDocument()

    // And it is forgotten with the box that carried it: a refusal about one
    // source, shown over another, is a sentence about the wrong file.
    await user.click(within(box).getByRole('button', { name: 'Le garder' }))
    await user.click(within(rowFor('zeta-accounts.csv')).getByRole('button'))
    const next = await screen.findByRole('dialog')
    expect(within(next).queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('an install that has imported nothing', () => {
  it('renders no list, and still hands back what was typed', async () => {
    const { user } = renderImports({ events: [aTypedEvent({ id: 'typed-1' })], imports: [] })
    const menu = await openExport(user)
    expect(within(menu).getByRole('menuitem', { name: 'Vos événements' })).toBeInTheDocument()

    expect(screen.queryByRole('table', { name: 'Import et export' })).not.toBeInTheDocument()
  })

  it('says where to drop a file once, never beside the empty state that says it', async () => {
    // An install with a source on record and no event — an accounts file, or
    // every import forgotten — is where the band and the ledger's own empty
    // state would each carry the instruction.
    renderImports({ events: [], accounts: [anAccount({ id: 'zeta' })] })
    await screen.findByText('Déposer un fichier')

    // The band is there — it has a source to forget — and the instruction is
    // said once, by the entry of the empty state and not by the band.
    const band = screen.getByRole('region', { name: 'Import et export' })
    expect(within(band).queryByText(/Déposez un \.csv ou un \.xlsx/)).not.toBeInTheDocument()
    expect(screen.getAllByText(/Déposez un \.csv ou un \.xlsx/)).toHaveLength(1)
  })

  it('renders no band at all with nothing recorded and nothing declared', async () => {
    // The drop zone is then the empty state's own entry, one line below: the
    // band would say the same thing twice, and a block with nothing in it does
    // not exist.
    renderImports({ events: [], imports: [], accounts: [theSeededAccount()], declared: false })
    await screen.findByText('Déposer un fichier')

    expect(screen.queryByRole('region', { name: 'Import et export' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Exporter' })).not.toBeInTheDocument()
  })
})
