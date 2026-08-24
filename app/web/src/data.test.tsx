/**
 * The data page (#723, ADR-0020, ADR-0005), at the one seam: the whole app in
 * jsdom, HTTP the only faked edge.
 *
 * Every case below names the reading it prevents, and three of them are
 * measurements taken on the 285 real events rather than opinions:
 *
 *  - **285 padlocks on 285 rows** — the per-row read-only marker, refuted by
 *    being rendered;
 *  - **278 labels out of 285**, median 36 characters, and no symbol at all on a
 *    transfer — which is why the identity column is not `Titre`;
 *  - **nineteen identical purchases of the same ETF**, where the label is the
 *    only discriminant a row owns — which is why the search is not a
 *    convenience.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aLedgerPayload,
  aLongLedger,
  anAccountsPayload,
  anEvent,
  anImport,
  anImportsPayload,
  aTypedEvent,
  importedOnly,
  ledgerEvents,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'
import type { LedgerEvent } from '@/lib/api'

function renderData(events: LedgerEvent[] = ledgerEvents(), url = '/donnees') {
  server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(events))))
  return renderApp({ url })
}

function ledger() {
  return screen.getByRole('table', { name: 'Vos événements' })
}

function columnNames(table: HTMLElement) {
  return within(table)
    .getAllByRole('columnheader')
    .map((cell) => cell.textContent?.trim())
}

function rowsOf(table: HTMLElement) {
  // The header row is a `row` too; the body's are what carries the ledger.
  return within(table).getAllByRole('row').slice(1)
}

async function openTheForm(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Saisir un événement' }))
  return screen.getByRole('radiogroup', { name: 'Ce qui s’est passé' })
}

describe('the three tabs under one route', () => {
  it('names them by what you declared, what the app has to say and what it is', async () => {
    renderData()

    // A tab is not a page: the product's cut at four pages holds. What the
    // three names are is ADR-0030's: the ledger and its provenance, the
    // notices, and ADR-0014's boot test transposed to the render.
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Le grand livre',
      'Les avis',
      'L’installation',
    ])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('table', { name: 'Vos événements' })).toBeInTheDocument()
  })

  it('lands on the ledger for a hash that names no tab, inherited names included', async () => {
    // A lookup table written as an object literal answers `#toString` with an
    // inherited **function**, which is truthy — and a function handed to
    // `useState` is called as an initialiser, which took the route down.
    renderData(ledgerEvents(), '/donnees#toString')

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Le grand livre' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    )
    expect(await screen.findByRole('table', { name: 'Vos événements' })).toBeInTheDocument()
  })

  it('opens the tab the hash names, the notices included', async () => {
    // The hash is what makes the links that point here arrive somewhere — the
    // status dot, and the currency band's own gesture. Read, never written.
    renderData(ledgerEvents(), '/donnees#notices')

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Les avis/ })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    )
  })
})

describe('the columns of the ledger', () => {
  it('are the eight, plus the provenance, in that order', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(columnNames(ledger())).toEqual([
      'Date',
      'Type',
      'De quoi il s’agit',
      'Quantité',
      'Prix unitaire',
      'Frais',
      'Montant',
      'Compte',
      'Provenance',
    ])
  })

  it('has no `Nom`, and no padlock column of any kind', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // `Nom` is an attribute of the security, not of each of its 285 events. And
    // read-only per row rendered 285 identical locks on 285 rows: a marker that
    // does not discriminate is noise however correct it is.
    for (const absent of ['Nom', 'Symbole', 'Notes', 'Lecture seule', 'Verrou']) {
      expect(within(ledger()).queryByRole('columnheader', { name: absent })).not.toBeInTheDocument()
    }
    expect(screen.queryByText('🔒')).not.toBeInTheDocument()
  })

  it('puts the ticker first and the label second, and the label alone on a transfer', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const share = within(ledger()).getAllByText('ZZA')[0].closest('tr') as HTMLElement
    expect(share).toHaveTextContent(/ZZA/)
    expect(share).toHaveTextContent(/Ordre au marché, exécution partielle/)

    // `Apple Pay Top up` on the real portfolio: there is no symbol at all, so
    // the label *is* the identity — one column doing the work for both families.
    const cash = within(ledger())
      .getByText('Virement entrant depuis le compte courant')
      .closest('tr') as HTMLElement
    expect(cash).toHaveTextContent('Versement')
    expect(within(cash).queryByText('ZZA')).not.toBeInTheDocument()
  })

  it('renders the provenance as a label and never as an address', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // The file's name and its line. Never a path, never its presence on disk —
    // the drop folder is an optional bind, so *not found* would be a permanent
    // false defect. Since #728 the label leads to its source; what it must never
    // carry is the gesture, which lives once where its subject is.
    expect(within(ledger()).getAllByText('zeta-events_2.csv · l. 118')).toHaveLength(1)
    expect(within(ledger()).queryAllByRole('link')).toHaveLength(0)
    expect(within(ledger()).queryByRole('button', { name: /oublier/i })).not.toBeInTheDocument()
  })

  it('sorts by date descending, and numbers no page', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // A ledger is opened to check what has just happened. The table reveals by
    // packets since ADR-0031, but « page 4 sur 6 » is still nowhere: a place in
    // a sequence means nothing on an axis of dates, which is why what the
    // control below the table counts is **rows**.
    expect(rowsOf(ledger())).toHaveLength(4)
    expect(
      rowsOf(ledger()).map((row) => within(row).getAllByRole('cell')[0].textContent),
    ).toEqual(['10 févr. 2026', '12 janv. 2026', '5 janv. 2026', '24 déc. 2025'])
    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/page \d+/i)).not.toBeInTheDocument()
  })

  it('says a row typed in the app was entered by hand, and never with a dash', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // The em dash is refused here by ADR-0016: it means *there is nothing to
    // compute*, and there is something — the row was typed here, which is the
    // fact the padlock column was trying to carry 285 times.
    const typed = within(ledger()).getByText('ZZC').closest('tr') as HTMLElement
    const cells = within(typed).getAllByRole('cell')
    expect(cells[cells.length - 1]).toHaveTextContent('Saisie manuelle')
    // The dashes elsewhere on that row are ADR-0016's own — a grant raises no
    // question of a fee — and it is the provenance cell that must not carry one.
    expect(cells[cells.length - 1]).not.toHaveTextContent('—')
  })
})

describe('the reduction, which is what pays for no pagination', () => {
  it('searches the label, the only discriminant two identical purchases have', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // Two purchases of ZZA, same account, same amounts to a euro: searching the
    // ticker cannot separate them and the label can.
    await user.type(screen.getByLabelText('Rechercher'), 'programme')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))
    expect(ledger()).toHaveTextContent('Versement programmé mensuel')

    // Accents folded: a French label is searched as it is heard.
    await user.clear(screen.getByLabelText('Rechercher'))
    await user.type(screen.getByLabelText('Rechercher'), 'execution')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))
  })

  it('lays the six types out as chips, the one in force pressed', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const types = screen.getByRole('group', { name: 'Type' })

    // A `<select>` collapsed to `Tous` said the absence of a reduction and
    // nothing else: the vocabulary of the ledger was behind a menu.
    expect(within(types).getAllByRole('button').map((chip) => chip.textContent)).toEqual([
      'Tous les types',
      'Achat',
      'Vente',
      'Attribution',
      'Dividende',
      'Versement',
      'Retrait',
    ])
    expect(within(types).getByRole('button', { name: 'Tous les types' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    expect(screen.getByText('4 événements')).toBeInTheDocument()
    await user.click(within(types).getByRole('button', { name: 'Versement' }))

    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))
    // The chip states what it retains, and the count follows the reduction.
    expect(within(types).getByRole('button', { name: 'Versement' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText('1 événement')).toBeInTheDocument()

    // And it offers the way out, which is the chip beside it.
    await user.click(within(types).getByRole('button', { name: 'Tous les types' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
    expect(screen.getByText('4 événements')).toBeInTheDocument()
  })

  it('offers account chips only where there are two accounts to tell apart', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // ADR-0013 seeds an account that is never removed, so an install naming one
    // would get a group with a single option beside its own exit: a filter that
    // cannot filter, which is the defect a column that cannot discriminate is.
    expect(screen.queryByRole('group', { name: 'Compte' })).not.toBeInTheDocument()

    const two = [...ledgerEvents(), anEvent({ date: '2026-02-11', account: 'beta', source_row: 12 })]
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(two))))
    await user.click(screen.getByRole('tab', { name: /L’installation/ }))
    await user.click(screen.getByRole('tab', { name: 'Le grand livre' }))

    const accounts = await screen.findByRole('group', { name: 'Compte' })
    expect(within(accounts).getAllByRole('button').map((chip) => chip.textContent)).toEqual([
      'Tous les comptes',
      // The order the ledger names them in, which is the sorted table's own.
      'beta',
      'alpha',
    ])

    await user.click(within(accounts).getByRole('button', { name: 'beta' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))
    expect(screen.getByText('1 événement')).toBeInTheDocument()
  })

  it('reduces to a period, names the interval on a chip, and lets it go', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // Two fields and no chip while nothing is in force: the days are not a
    // vocabulary to lay out, so there is nothing to press until a bound exists.
    const period = screen.getByRole('group', { name: 'Période' })
    expect(within(period).queryAllByRole('button')).toHaveLength(0)

    // `fireEvent` and not `user.type`: a date field takes its value whole, and
    // jsdom sanitises anything it cannot parse to an empty string before any
    // code sees it — which is exactly the trap `parseDay` exists for.
    fireEvent.change(screen.getByLabelText('Du'), { target: { value: '2025-12-24' } })
    fireEvent.change(screen.getByLabelText('Au'), { target: { value: '2026-01-12' } })

    // Both bounds retain the day they name: the 24th and the 12th are in, and
    // a half-open reading would have dropped one of the three rows.
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))
    expect(screen.getByText('3 événements')).toBeInTheDocument()

    const chip = within(period).getByRole('button', {
      name: 'Du 24 déc. 2025 au 12 janv. 2026',
    })
    expect(chip).toHaveAttribute('aria-pressed', 'true')

    // A table shorter than the reader's ledger always has, on screen, the
    // sentence that says why and the control that undoes it.
    await user.click(chip)
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
    expect(within(period).queryAllByRole('button')).toHaveLength(0)
  })

  it('takes one bound alone, which is an interval open on the other side', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Du'), { target: { value: '2026-01-06' } })

    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    // Read out as what it is — *everything since that day* — rather than as
    // half of a pair the reader forgot to fill in.
    expect(
      within(screen.getByRole('group', { name: 'Période' })).getByRole('button', {
        name: 'Depuis le 6 janv. 2026',
      }),
    ).toBeInTheDocument()
  })

  it('carries the period on the export’s own address', async () => {
    // What travels is the *question*, never the rows: the importable form
    // belongs to `events/export.py`, and the two names are the server's.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Du'), { target: { value: '2026-01-01' } })
    fireEvent.change(screen.getByLabelText('Au'), { target: { value: '2026-12-31' } })
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))

    let asked: string | null = null
    server.use(
      http.get(ROUTES.exportEvents, ({ request }) => {
        asked = new URL(request.url).search
        return new HttpResponse('date\n', {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="suivi-bourse-selection.csv"',
          },
        })
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Exporter' }))
    await user.click(await screen.findByRole('menuitem', { name: /La sélection filtrée/ }))

    await waitFor(() => expect(asked).toBe('?since=2026-01-01&until=2026-12-31'))
  })

  it('takes the period from the address, and gives it back when it is released', async () => {
    // A reduced ledger has an address, and since #810 the period is one of its
    // dimensions: a reader who reloads on an extract of a year keeps it.
    const { user, router } = renderData(ledgerEvents(), '/donnees?since=2026-01-06')
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    const period = screen.getByRole('group', { name: 'Période' })
    expect(screen.getByLabelText('Du')).toHaveValue('2026-01-06')

    await user.click(within(period).getByRole('button', { name: 'Depuis le 6 janv. 2026' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
    // The address stopped describing the table, so it stops being one — a
    // reload restoring a reduction the reader has just lifted is the defect.
    expect(router.state.location.search).toEqual({})
  })

  it('says nothing matches rather than showing an empty table', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.type(screen.getByLabelText('Rechercher'), 'zzzz')
    expect(await screen.findByText('Aucun événement ne correspond')).toBeInTheDocument()
    // Named, since #729: the declaration is a second table on this tab, and it
    // is not reduced by a search over the ledger. What the assertion is about is
    // that the *ledger* is replaced rather than left empty.
    expect(screen.queryByRole('table', { name: 'Vos événements' })).not.toBeInTheDocument()
  })
})

describe('the ledger reveals by packets, and only the first flight is silent', () => {
  it('draws forty of a hundred and seventy-six, and says so without a spinner', async () => {
    renderData(aLongLedger(176))
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // Forty rows, and the sentence under them counts rows the app **already
    // holds**: `GET /api/events` answered once, from the published snapshot in
    // process memory, and handed back the ledger entire.
    expect(rowsOf(ledger())).toHaveLength(40)
    expect(screen.getByText('40 sur 176 affichés')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Afficher la suite' })).toBeInTheDocument()
    // The end is not said before the last row has arrived.
    expect(screen.queryByText(/Fin du grand livre/)).not.toBeInTheDocument()
    // And there is no wait to dress, so nothing dresses one.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('adds forty per gesture, and says the end at the last row', async () => {
    const { user } = renderData(aLongLedger(85))
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Afficher la suite' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(80))
    expect(screen.getByText('80 sur 85 affichés')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Afficher la suite' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(85))
    // The control goes with the rows it was promising: there are none left.
    expect(screen.queryByRole('button', { name: 'Afficher la suite' })).not.toBeInTheDocument()
    expect(screen.getByText('Fin du grand livre · 85 événements')).toBeInTheDocument()
  })

  it('says the end straight away on a ledger shorter than one packet', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(rowsOf(ledger())).toHaveLength(4)
    expect(screen.getByText('Fin du grand livre · 4 événements')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Afficher la suite' })).not.toBeInTheDocument()
  })

  it('counts the reduction and not the store, and starts it over when a chip moves', async () => {
    const mixed = [
      ...aLongLedger(120),
      ...Array.from({ length: 3 }, (_, index) =>
        anEvent({
          date: `2025-06-0${index + 1}`,
          event_type: 'DEPOSIT',
          symbol: null,
          name: null,
          notes: `Virement ${index + 1}`,
          quantity: null,
          unit_price: null,
          amount: 100,
          source_row: 200 + index,
        }),
      ),
    ]
    const { user } = renderData(mixed)
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Afficher la suite' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(80))

    // The chips are a reduction, so both sentences are true of what survives
    // them — and the budget starts over, or a reader asking a question would
    // get every row answering it at once.
    const types = screen.getByRole('group', { name: 'Type' })
    await user.click(within(types).getByRole('button', { name: 'Achat' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(40))
    expect(screen.getByText('40 sur 120 affichés')).toBeInTheDocument()
    expect(screen.getByText('120 événements')).toBeInTheDocument()

    await user.click(within(types).getByRole('button', { name: 'Versement' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))
    expect(screen.getByText('Fin du grand livre · 3 événements')).toBeInTheDocument()
  })
})

describe('a reduction in force always has the chip that releases it', () => {
  it('keeps the account chip after the import that named that account is forgotten', async () => {
    // The ledger is what names the accounts, and the ledger changes under the
    // reader: forgetting the file that carried every `beta` row takes `beta` out
    // of the list while the filter still holds it. With the group gone the table
    // is simply shorter than it should be, with nothing on screen saying why or
    // how to get the rest back — #724's defect, arrived from the other side.
    const withBeta = [
      ...ledgerEvents(),
      anEvent({ date: '2026-02-11', account: 'beta', source_row: 12 }),
    ]
    server.use(
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(withBeta))),
      http.get(ROUTES.imports, () => HttpResponse.json(anImportsPayload([anImport({ events: 4 })]))),
      http.delete(ROUTES.importSource, () => {
        // The re-read that follows the revocation: `beta` is named by nothing.
        server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))))
        return HttpResponse.json({ id: 1, events_removed: 4 })
      }),
    )
    const { user } = renderApp({ url: '/donnees' })
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const accounts = screen.getByRole('group', { name: 'Compte' })
    await user.click(within(accounts).getByRole('button', { name: 'beta' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))

    await user.click(
      within(screen.getByRole('table', { name: 'Import et export' })).getByRole('button', {
        name: 'Oublier cet import',
      }),
    )
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Oublier cet import' }),
    )

    // The reduction survives the re-read, so the way out has to survive it too.
    const after = await screen.findByRole('group', { name: 'Compte' })
    expect(within(after).getByRole('button', { name: 'beta' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await user.click(within(after).getByRole('button', { name: 'Tous les comptes' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
  })

  it('does not drop the reader on the floor when the last packet takes the button', async () => {
    const { user } = renderData(aLongLedger(50))
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const more = screen.getByRole('button', { name: 'Afficher la suite' })
    more.focus()
    await user.click(more)

    // The control the reader just pressed is gone with the rows it promised. A
    // focus left on `<body>` loses a keyboard reader their place in fifty rows,
    // so the region that replaced it takes the focus — and it is polite, which
    // is what makes forty rows arriving a change with a sound.
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(50))
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toHaveTextContent('Fin du grand livre · 50 événements')
    expect(document.activeElement).toHaveAttribute('aria-live', 'polite')
  })
})

describe('deleting the reduction, which is what replaces forgetting an import', () => {
  it('is not offered while nothing is reduced, nor while nothing is retained', async () => {
    // With no chip pressed the reduction is the **whole ledger**, so the button
    // would read *delete everything* in the clothes of *delete this year* —
    // told apart by a count the reader has to read first. Emptying the ledger
    // stays possible, by reducing on something that covers it.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(screen.queryByRole('button', { name: /Supprimer ces/ })).not.toBeInTheDocument()

    // And a reduction that retains nothing has a subject and no rows: *delete
    // these 0 events* beside *no event matches* is the same button saying two
    // things at once.
    await user.type(screen.getByLabelText('Rechercher'), 'zzzz')
    expect(await screen.findByText('Aucun événement ne correspond')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Supprimer ces/ })).not.toBeInTheDocument()
  })

  it('names the reduction and counts its rows before destroying anything', async () => {
    // Never a bare *are you sure*: the rule #794 wrote when three consecutive
    // rows showed three identical red buttons — the reader has to read the
    // **subject** of what they are destroying, and here the subject is the
    // dimensions in force rather than a file name.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const types = screen.getByRole('group', { name: 'Type' })
    await user.click(within(types).getByRole('button', { name: 'Achat' }))
    fireEvent.change(screen.getByLabelText('Du'), { target: { value: '2026-01-01' } })
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))

    await user.click(screen.getByRole('button', { name: 'Supprimer ces 2 événements' }))

    const box = await screen.findByRole('dialog')
    expect(within(box).getByRole('heading', { name: 'Supprimer 2 événements ?' })).toBeInTheDocument()
    // Both dimensions, each in the vocabulary its own chip carries — and the
    // period reads the interval the chip reads, out of the same sentence.
    expect(within(box).getByText('Type Achat')).toBeInTheDocument()
    expect(within(box).getByText('Depuis le 1 janv. 2026')).toBeInTheDocument()
  })

  it('sends the reduction’s own five parameters, and says what actually left', async () => {
    // What travels is the *question*, never a list of rows: the reduction is
    // applied against the store, not against the snapshot this table drew.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    let asked: string | null = null
    server.use(
      http.delete(ROUTES.events, ({ request }) => {
        asked = new URL(request.url).search
        // The re-read that follows: the two purchases are gone from the store.
        server.use(
          http.get(ROUTES.events, () =>
            HttpResponse.json(aLedgerPayload(ledgerEvents().slice(2))),
          ),
        )
        return HttpResponse.json({ events_removed: 2 })
      }),
    )

    const types = screen.getByRole('group', { name: 'Type' })
    await user.click(within(types).getByRole('button', { name: 'Achat' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: 'Supprimer ces 2 événements' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Les supprimer' }),
    )

    await waitFor(() => expect(asked).toBe('?type=BUY'))
    // The count in the receipt is the **server's** — what left — where the one
    // in the box was the table's, what the reduction retained. Two counts,
    // deliberately, and only the second is a fact about the store.
    expect(await screen.findByText('2 événements supprimés.')).toBeInTheDocument()
  })

  it('keeps the box open on a refusal and says it in the reader’s language', async () => {
    // A `422` the reader could not foresee — a client that lost its query
    // string, or a reduction that emptied itself between the render and the
    // click. The sentence is read by `problem.type`, never by the English
    // `detail` the server wrote for a log (ADR-0024).
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    server.use(
      http.delete(ROUTES.events, () =>
        HttpResponse.json(
          { status: 422, type: PROBLEM_TYPES.badRequest, title: 'Invalid parameter' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )

    const types = screen.getByRole('group', { name: 'Type' })
    await user.click(within(types).getByRole('button', { name: 'Achat' }))
    await user.click(await screen.findByRole('button', { name: 'Supprimer ces 2 événements' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Les supprimer' }),
    )

    const box = await screen.findByRole('dialog')
    expect(await within(box).findByRole('status')).toHaveTextContent(
      'L’application a refusé la requête faite par cette page.',
    )
    // The box stays open on the failure — everything behind the overlay is
    // `aria-hidden`, so a band on the page would be a sentence nobody can read
    // — and it still names the reduction it was opened on.
    expect(within(box).getByRole('heading', { name: 'Supprimer 2 événements ?' })).toBeInTheDocument()
  })
})

describe('the editor, and where it does not appear', () => {
  it('never appears on an install that has only ever imported', async () => {
    // The real portfolio exactly: 285 imported rows, 0 typed. The read-only
    // rule needs no column to state itself — a row carrying a provenance came
    // from a file, and its own name is not pressable.
    renderData(importedOnly())
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // The one thing a row of that install carries is its provenance (#728),
    // which leads to its source and edits nothing.
    const pressable = within(ledger()).getAllByRole('button')
    expect(pressable.map((button) => button.textContent)).toEqual([
      'zeta-events_2.csv · l. 118',
      'zeta-events_2.csv · l. 96',
      'zeta-events_2.csv · l. 71',
    ])
  })

  it('opens on a row that carries no provenance, prefilled and shaped for its type', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(within(ledger()).getByRole('button', { name: 'ZZC' }))

    // A grant: a quantity, an optional price, and no fee field at all.
    expect(await screen.findByLabelText('Quantité')).toHaveValue('2')
    expect(screen.getByRole('radio', { name: 'Attribution' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.queryByLabelText('Frais')).not.toBeInTheDocument()
  })
})

describe('the create form, which is the onboarding', () => {
  it('asks the type first, with six labels that state their effect', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const types = await openTheForm(user)

    expect(within(types).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      'Achat',
      'Vente',
      'Attribution',
      'Dividende',
      'Versement',
      'Retrait',
    ])
    // Six codes are a decoding exercise at the exact moment nothing is there to
    // decode them against.
    for (const code of ['BUY', 'SELL', 'GRANT', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL']) {
      expect(within(types).queryByRole('radio', { name: code })).not.toBeInTheDocument()
    }
    // And nothing else is on screen until the question is answered.
    expect(screen.queryByLabelText('Date')).not.toBeInTheDocument()
  })

  it('changes shape with the type, which a row edited in place cannot', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)

    await user.click(screen.getByRole('radio', { name: 'Achat' }))
    expect(await screen.findByLabelText('Ticker')).toBeInTheDocument()
    expect(screen.getByLabelText('Quantité')).toBeInTheDocument()
    expect(screen.getByLabelText('Prix unitaire')).toBeInTheDocument()
    expect(screen.getByLabelText('Frais')).toBeInTheDocument()
    expect(screen.queryByLabelText('Montant')).not.toBeInTheDocument()

    // A transfer names no security at all — not a missing one, none.
    await user.click(screen.getByRole('radio', { name: 'Versement' }))
    expect(await screen.findByLabelText('Montant')).toBeInTheDocument()
    expect(screen.getByLabelText('Frais')).toBeInTheDocument()
    expect(screen.queryByLabelText('Ticker')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Quantité')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Prix unitaire')).not.toBeInTheDocument()

    // A dividend: an amount and a fee, on a security.
    await user.click(screen.getByRole('radio', { name: 'Dividende' }))
    expect(await screen.findByLabelText('Ticker')).toBeInTheDocument()
    expect(screen.getByLabelText('Montant')).toBeInTheDocument()
    expect(screen.queryByLabelText('Quantité')).not.toBeInTheDocument()
  })

  it('lives in a lateral panel and never turns a row into a form', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    // The table is a table and stays one: no input ever appears inside it.
    expect(within(ledger()).queryAllByRole('textbox')).toHaveLength(0)

    await openTheForm(user)
    const panel = screen.getByRole('dialog')
    expect(panel).toHaveAttribute('data-slot', 'sheet-content')
    expect(within(panel).getByRole('radiogroup', { name: 'Ce qui s’est passé' })).toBeInTheDocument()
  })

  it('carries the two icons of the page, and the table carries none', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // Zero in a table — the rule of the page (#684 D7).
    expect(within(ledger()).queryAllByRole('button', { name: /^Ce que veut dire/ })).toHaveLength(0)

    await openTheForm(user)
    await user.click(screen.getByRole('radio', { name: 'Attribution' }))

    const bubbles = await screen.findAllByRole('button', { name: /^Ce que veut dire/ })
    expect(bubbles.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Ce que veut dire Date',
      'Ce que veut dire Prix unitaire',
    ])

    // On the date, the sentence arrives while it can still change a behaviour.
    await user.click(bubbles[0])
    expect(await screen.findByText(/à partir des dates de vos événements/)).toBeInTheDocument()
  })

  it('says what an empty grant price means, where the reader is leaving it empty', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('radio', { name: 'Attribution' }))

    // A purchase's price is required, a grant's is not — and its emptiness is a
    // statement rather than a blank.
    const panel = screen.getByRole('dialog')
    const label = await within(panel).findByText('Prix unitaire')
    expect(label.parentElement).toHaveTextContent('facultatif')
    await user.click(screen.getByRole('button', { name: 'Ce que veut dire Prix unitaire' }))
    expect(await screen.findByText(/dilution/)).toBeInTheDocument()
    expect(screen.getByText(/vos versements et dans votre base de coût/)).toBeInTheDocument()
  })

  it('records the event and puts it in the ledger', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)

    await user.click(screen.getByRole('radio', { name: 'Versement' }))
    // A date input takes its value whole — typing into one is the browser's own
    // widget, not a sequence of characters.
    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-02-20' } })
    await user.selectOptions(screen.getByLabelText('Compte'), 'alpha')
    // A decimal comma is what a French reader types, and `<input type="number">`
    // discards it as silently as a date input discards a malformed day.
    await user.type(screen.getByLabelText('Montant'), '250,50')
    await user.type(screen.getByLabelText('Libellé'), 'Virement de février')

    server.use(
      http.get(ROUTES.events, () =>
        HttpResponse.json(
          aLedgerPayload([
            ...ledgerEvents(),
            aTypedEvent({
              id: 'e5',
              date: '2026-02-20',
              event_type: 'DEPOSIT',
              symbol: null,
              notes: 'Virement de février',
              quantity: null,
              unit_price: null,
              fee: null,
              amount: 250.5,
            }),
          ]),
        ),
      ),
    )

    await user.click(screen.getByRole('button', { name: 'Enregistrer cet événement' }))
    expect(await screen.findByText('Virement de février')).toBeInTheDocument()
  })

  it('never silently discards a date it cannot read', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('radio', { name: 'Versement' }))
    await user.type(await screen.findByLabelText('Montant'), '250')

    // `31/02/2026` is what a reader types where the widget degrades to text, and
    // the field hands back an **empty string** for it — which one line later is
    // indistinguishable from *left blank*. The form says so beside the field and
    // records nothing, rather than posting an event with no date.
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '31/02/2026' } })
    await user.click(screen.getByRole('button', { name: 'Enregistrer cet événement' }))

    expect(await screen.findByText(/Sans date lisible, rien n’est enregistré/)).toBeInTheDocument()
    expect(screen.getByLabelText('Date')).toHaveAttribute('aria-invalid', 'true')
    // The panel is still open, and no row joined the ledger.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('names a number it cannot read rather than sending a hole', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('radio', { name: 'Versement' }))

    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-02-20' } })
    await user.type(screen.getByLabelText('Montant'), 'deux cents')
    await user.click(screen.getByRole('button', { name: 'Enregistrer cet événement' }))
    expect(await screen.findByText('Ce n’est pas un nombre.')).toBeInTheDocument()
  })
})

describe('the ledger at zero', () => {
  it('offers two entries of equal weight, and no empty table', async () => {
    const { user } = renderData([])

    // Not an empty table with a small button over it: dropping a file and
    // typing a first event are two entrances to the same room, and the second
    // one *is* the onboarding since manual mode died (ADR-0005).
    const file = await screen.findByRole('region', { name: 'Importer un fichier' })
    const manual = screen.getByRole('region', { name: 'Saisir un premier événement' })
    expect(file).toBeInTheDocument()
    expect(manual).toBeInTheDocument()
    // Named, since #729: what this criterion refuses is *the ledger* rendered as
    // an empty table with a small button over it. The declaration of the
    // accounts is a table of its own, it is not empty, and it replaces nothing
    // here — the install of this fixture has three declared accounts to name.
    expect(screen.queryByRole('table', { name: 'Vos événements' })).not.toBeInTheDocument()

    // **Both entrances are gestures now** (#811): the file one is a real target
    // rather than the name of a folder, so the pair is two doors and not a
    // door beside an instruction.
    expect(within(file).getByLabelText('Choisir un fichier')).toBeInTheDocument()

    // Neither entry is the recommended one.
    const action = within(manual).getByRole('button', { name: 'Saisir un événement' })
    expect(action).toHaveAttribute('data-variant', 'outline')

    await user.click(action)
    expect(await screen.findByRole('radiogroup', { name: 'Ce qui s’est passé' })).toBeInTheDocument()
  })
})

describe('the page’s own read', () => {
  it('names an unreadable store instead of showing an empty ledger', async () => {
    // `/api/runtime` answers from process memory and never opens the store, so
    // the shell's banner is silent on exactly this failure.
    server.use(
      problemHandler(ROUTES.events, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp({ url: '/donnees' })

    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    // And *the store is unreadable* does not read as *you have recorded
    // nothing*: the two ways in are not offered here.
    expect(screen.queryByRole('region', { name: 'Déposer un fichier' })).not.toBeInTheDocument()
  })
})

describe('the page in English', () => {
  it('renders whole, with the six types named by their effect', async () => {
    server.use(
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload())),
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload())),
    )
    renderApp({ url: '/donnees', browserLanguages: ['en-GB'] })

    const table = await screen.findByRole('table', { name: 'Your events' })
    expect(columnNames(table)).toEqual([
      'Date',
      'Type',
      'What it is',
      'Quantity',
      'Unit price',
      'Fee',
      'Amount',
      'Account',
      'Provenance',
    ])
    // `Free shares`, `Cash in`, `Cash out` — the effect, not the six codes at a
    // difference of case.
    expect(within(table).getByText('Cash in')).toBeInTheDocument()
    expect(within(table).getByText('Free shares')).toBeInTheDocument()
    // The reveal speaks English too, and the English is the source (ADR-0024).
    expect(screen.getByRole('group', { name: 'Type' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All types' })).toBeInTheDocument()
    expect(screen.getByText('The end of the ledger · 4 events')).toBeInTheDocument()
    expect(within(table).getByText('Entered by hand')).toBeInTheDocument()
  })
})
