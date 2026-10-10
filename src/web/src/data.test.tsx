/**
 * The data page (#723), at the one seam: the whole app in
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
  aPriceAt,
  aPriceSeries,
  anAccountsPayload,
  anEvent,
  aTypedEvent,
  ledgerEvents,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'
import type { LedgerEvent } from '@/lib/api'

function renderData(events: LedgerEvent[] = ledgerEvents(), url = '/ledger') {
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

describe('one route, one thing', () => {
  it('has no tab bar at all, and renders the ledger', async () => {
    renderData()

    // **Three, then two, then none** (#829, #830): the
    // notices left for the panel behind the bell, the installation left for
    // `/settings`, and a bar holding a choice of one is not a bar.
    expect(await screen.findByRole('table', { name: 'Vos événements' })).toBeInTheDocument()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Grand livre' }),
    ).toBeInTheDocument()
  })

  it('renders the ledger for a hash that used to name a tab, and for any other', async () => {
    // `#installation` was an *address* on a tab and it is a path now, so a
    // bookmark taken on the old hash lands on the ledger — which is what every
    // hash but that one already did. `#toString` is in the same case and it is
    // the one that took the route down: a lookup table written as an object
    // literal answers it with an inherited **function**, which is truthy, and a
    // function handed to `useState` is called as an initialiser.
    for (const hash of ['#installation', '#toString']) {
      const view = renderData(ledgerEvents(), `/ledger${hash}`)
      expect(await screen.findByRole('table', { name: 'Vos événements' })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Le magasin' })).not.toBeInTheDocument()
      view.unmount()
    }
  })
})

describe('the columns of the ledger', () => {
  it('are the eight, and there is no ninth', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // `Provenance` was the ninth and it left with its subject (#816): there is no source to name and no revocation to lead to. What
    // closes the row since #834 is not a column of that family either — it is
    // the row's **removal**, a control named for the reader who cannot see the
    // icon in it.
    expect(columnNames(ledger())).toEqual([
      // The checkbox ticking every filtered row (#1113): a control, no text.
      '',
      'Date',
      'Type',
      'De quoi il s’agit',
      'Quantité',
      'Prix unitaire',
      'Frais',
      'Montant',
      'Compte',
      'Supprimer cet événement',
    ])
  })

  it('has no `Nom`, no padlock column and no provenance of any kind', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // `Nom` is an attribute of the security, not of each of its 285 events. And
    // read-only per row rendered 285 identical locks on 285 rows: a marker that
    // does not discriminate is noise however correct it is — which is now true
    // of the provenance too, every row having the same nothing to say about it.
    for (const absent of ['Nom', 'Symbole', 'Notes', 'Lecture seule', 'Verrou', 'Provenance']) {
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

  it('names no file anywhere, and leads to no source', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // What was *« zeta-events_2.csv · l. 118 »*, a label leading to the file's
    // revocation, is nothing at all (#816): a row that came out of a file is a
    // row, so there is no name to render and no gesture to lead to.
    expect(within(ledger()).queryByText(/zeta-events_2\.csv/)).not.toBeInTheDocument()
    expect(within(ledger()).queryAllByRole('link')).toHaveLength(0)
    expect(within(ledger()).queryByRole('button', { name: /oublier/i })).not.toBeInTheDocument()
  })

  it('sorts by date descending, and numbers no page', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // A ledger is opened to check what has just happened.
    expect(rowsOf(ledger())).toHaveLength(4)
    expect(rowsOf(ledger()).map((row) => within(row).getAllByRole('cell')[1].textContent)).toEqual([
      '10 févr. 2026',
      '12 janv. 2026',
      '5 janv. 2026',
      '24 déc. 2025',
    ])
    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/page \d+/i)).not.toBeInTheDocument()
  })

  it('ends on the account, which is the last thing a row says about itself', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // The cell that used to close a row said *« Saisie manuelle »* or named a
    // file; both halves went with the population they told apart (#816).
    const row = within(ledger()).getByText('ZZC').closest('tr') as HTMLElement
    const cells = within(row).getAllByRole('cell')
    // The last cell is the removal since #834 — a gesture, not a fact about the
    // row — so what closes what the row *says* is the one before it.
    expect(cells[cells.length - 2]).toHaveTextContent('alpha')
    expect(cells[cells.length - 2]).not.toHaveTextContent('—')
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

  it('lays the six types out as facets, each carrying what it would leave', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const types = screen.getByRole('group', { name: 'Type' })

    // A `<select>` collapsed to `Tous` said the absence of a reduction and
    // nothing else: the vocabulary of the ledger was behind a menu. Since #834
    // each option also says **what pressing it would leave**, which is the
    // question a ledger is opened with — and an option retaining nothing stays
    // on screen, because *no sale ever* is a fact about the reader's ledger.
    expect(
      within(types)
        .getAllByRole('button')
        .map((facet) => facet.getAttribute('aria-label')),
    ).toEqual([
      'Tous les types · 4 événements',
      'Achat · 2 événements',
      'Vente · 0 événement',
      'Attribution · 1 événement',
      'Dividende · 0 événement',
      'Versement · 1 événement',
      'Retrait · 0 événement',
    ])
    expect(within(types).getByRole('button', { name: /^Tous les types/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    expect(screen.getByText('4 événements')).toBeInTheDocument()
    await user.click(within(types).getByRole('button', { name: /^Versement/ }))

    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))
    // The facet states what it retains, and the count follows the reduction —
    // saying, since #834, that it *is* one.
    expect(within(types).getByRole('button', { name: /^Versement/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText('1 événement filtré')).toBeInTheDocument()

    // And it offers the way out, which is the option beside it.
    await user.click(within(types).getByRole('button', { name: /^Tous les types/ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
    expect(screen.getByText('4 événements')).toBeInTheDocument()
  })

  it('counts every facet with its own axis excluded, which is what a facet is', async () => {
    // **The criterion** (#834). The number beside *Achat* is *what is left if I
    // press Achat*, so the type facets do not move when a type is pressed — the
    // account, the period and the search do apply, and the axis being counted
    // does not. Counted off the rows on screen instead, five of the six would
    // read zero the instant one was chosen, and the panel would be answering a
    // question nobody asks.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const types = screen.getByRole('group', { name: 'Type' })
    const period = screen.getByRole('group', { name: 'Période' })
    expect(
      within(period)
        .getAllByRole('button')
        .map((facet) => facet.getAttribute('aria-label')),
    ).toEqual(['Toutes · 4 événements', '2026 · 3 événements', '2025 · 1 événement'])

    await user.click(within(types).getByRole('button', { name: /^Achat/ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))

    // Its own axis: unmoved, every option still counting the ledger.
    expect(
      within(types)
        .getAllByRole('button')
        .map((facet) => facet.getAttribute('aria-label')),
    ).toEqual([
      'Tous les types · 4 événements',
      'Achat · 2 événements',
      'Vente · 0 événement',
      'Attribution · 1 événement',
      'Dividende · 0 événement',
      'Versement · 1 événement',
      'Retrait · 0 événement',
    ])
    // The other axis: reduced by the type in force, down to the two purchases.
    expect(
      within(period)
        .getAllByRole('button')
        .map((facet) => facet.getAttribute('aria-label')),
    ).toEqual(['Toutes · 2 événements', '2026 · 2 événements', '2025 · 0 événement'])
  })

  it('offers account chips only where there are two accounts to tell apart', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(screen.queryByRole('group', { name: 'Compte' })).not.toBeInTheDocument()

    const two = [...ledgerEvents(), anEvent({ id: '12', date: '2026-02-11', account: 'beta' })]
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(two))))
    await user.click(screen.getByRole('link', { name: 'Réglages' }))
    await user.click(screen.getByRole('link', { name: 'Grand livre' }))

    const accounts = await screen.findByRole('group', { name: 'Compte' })
    expect(
      within(accounts)
        .getAllByRole('button')
        .map((facet) => facet.getAttribute('aria-label')),
    ).toEqual([
      'Tous les comptes · 5 événements',
      // The order the ledger names them in, which is the sorted table's own.
      'beta · 1 événement',
      'alpha · 4 événements',
    ])

    await user.click(within(accounts).getByRole('button', { name: /^beta/ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))
    expect(screen.getByText('1 événement filtré')).toBeInTheDocument()
  })

  it('reduces to a period, names the interval on a pastille, and lets it go', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // No pastille while nothing is in force: what is on screen is the panel's
    // own vocabulary, and there is nothing to let go of yet.
    expect(screen.queryByRole('group', { name: 'Filtres actifs' })).not.toBeInTheDocument()

    // `fireEvent` and not `user.type`: a date field takes its value whole, and
    // jsdom sanitises anything it cannot parse to an empty string before any
    // code sees it — which is exactly the trap `parseDay` exists for.
    fireEvent.change(screen.getByLabelText('Du'), { target: { value: '2025-12-24' } })
    fireEvent.change(screen.getByLabelText('Au'), { target: { value: '2026-01-12' } })

    // Both bounds retain the day they name: the 24th and the 12th are in, and
    // a half-open reading would have dropped one of the three rows.
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))
    expect(screen.getByText('3 événements filtrés')).toBeInTheDocument()

    const chips = screen.getByRole('group', { name: 'Filtres actifs' })
    const chip = within(chips).getByRole('button', {
      name: 'Retirer ce filtre : Du 24 déc. 2025 au 12 janv. 2026',
    })

    // A table shorter than the reader's ledger always has, on screen, the
    // sentence that says why and the control that undoes it.
    await user.click(chip)
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
    expect(screen.queryByRole('group', { name: 'Filtres actifs' })).not.toBeInTheDocument()
  })

  it('takes one bound alone, which is an interval open on the other side', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Du'), { target: { value: '2026-01-06' } })

    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    // Read out as what it is — *everything since that day* — rather than as
    // half of a pair the reader forgot to fill in.
    expect(
      within(screen.getByRole('group', { name: 'Filtres actifs' })).getByRole('button', {
        name: 'Retirer ce filtre : Depuis le 6 janv. 2026',
      }),
    ).toBeInTheDocument()
  })

  it('presses a year, then a month of it, and the months exist only then', async () => {
    // **The period is one axis with three controls** (#834): the years are the
    // vocabulary, and the months appear only once the period fits inside a
    // year — which is the state pressing a year puts the reader in.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    expect(screen.queryByRole('group', { name: 'Mois' })).not.toBeInTheDocument()

    await user.click(
      within(screen.getByRole('group', { name: 'Période' })).getByRole('button', {
        name: /^2026/,
      }),
    )
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))

    const months = await screen.findByRole('group', { name: 'Mois' })
    expect(within(months).getAllByRole('button')).toHaveLength(12)
    expect(within(months).getByRole('button', { name: 'janv. · 2 événements' })).toBeInTheDocument()

    await user.click(within(months).getByRole('button', { name: /^janv\./ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    // The pastille names the month the two bounds spell, and the year it
    // belongs to is still the one in force in the panel.
    expect(
      within(screen.getByRole('group', { name: 'Filtres actifs' })).getByRole('button', {
        name: 'Retirer ce filtre : Du 1ᵉʳ janv. 2026 au 31 janv. 2026',
      }),
    ).toBeInTheDocument()

    // Pressing the month in force goes back **up** to its year, which is where
    // the reader came from, rather than releasing the period whole.
    await user.click(within(months).getByRole('button', { name: /^janv\./ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))
  })

  it('folds the panel under 768 px, and the control says whether it is open', async () => {
    // The fold itself is two classes and jsdom lays nothing out, so what is
    // asserted here is the **control**: it exists, it says it is closed, and it
    // opens. The pair of classes that makes it a fold below `md` and nothing at
    // all above is held on the source, in `contentWidth.test.ts`.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const toggle = screen.getByRole('button', { name: 'Afficher les filtres' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(await screen.findByRole('button', { name: 'Masquer les filtres' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
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
    const { user, router } = renderData(ledgerEvents(), '/ledger?since=2026-01-06')
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    const chips = screen.getByRole('group', { name: 'Filtres actifs' })
    expect(screen.getByLabelText('Du')).toHaveValue('2026-01-06')

    await user.click(
      within(chips).getByRole('button', { name: 'Retirer ce filtre : Depuis le 6 janv. 2026' }),
    )
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
          id: String(200 + index),
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
    await user.click(within(types).getByRole('button', { name: /^Achat/ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(40))
    expect(screen.getByText('40 sur 120 affichés')).toBeInTheDocument()
    expect(screen.getByText('120 événements filtrés')).toBeInTheDocument()

    await user.click(within(types).getByRole('button', { name: /^Versement/ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))
    // **Of the reduction, never of the store** (#834): *the end of
    // the ledger* said over three rows out of a hundred and twenty-three is the
    // sentence that record refuses by name.
    expect(screen.getByText('Fin des résultats · 3 événements')).toBeInTheDocument()
    expect(screen.queryByText(/Fin du grand livre/)).not.toBeInTheDocument()
  })
})

describe('a reduction in force always has the chip that releases it', () => {
  it('keeps the account chip after the rows naming that account are deleted', async () => {
    // The ledger is what names the accounts, and the ledger changes under the
    // reader: deleting every `beta` row takes `beta` out of the list while the
    // filter still holds it. With the group gone the table is simply shorter
    // than it should be, with nothing on screen saying why or how to get the
    // rest back — #724's defect, arrived from the other side.
    //
    // The gesture was *forget this import* until #816; it is the deletion on
    // the reduction now, which is a **better** subject for this
    // case: the rows that leave are exactly the rows the chip retains.
    const withBeta = [...ledgerEvents(), anEvent({ id: '12', date: '2026-02-11', account: 'beta' })]
    server.use(
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(withBeta))),
      http.delete(ROUTES.events, () => {
        // The re-read that follows the write: `beta` is named by nothing.
        server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))))
        return HttpResponse.json({ events_removed: 1 })
      }),
    )
    const { user } = renderApp({ url: '/ledger' })
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const accounts = screen.getByRole('group', { name: 'Compte' })
    await user.click(within(accounts).getByRole('button', { name: /^beta/ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))

    await user.click(within(rowsOf(ledger())[0]).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Supprimer l’événement sélectionné' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Les supprimer' }),
    )

    // The reduction survives the re-read, so the way out has to survive it too.
    const after = await screen.findByRole('group', { name: 'Compte' })
    expect(within(after).getByRole('button', { name: /^beta/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await user.click(within(after).getByRole('button', { name: /^Tous les comptes/ }))
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

describe('deleting the ticked rows (#1113)', () => {
  function rowBox(table: HTMLElement, index: number) {
    return within(rowsOf(table)[index]).getByRole('checkbox')
  }

  it('is offered disabled with nothing ticked, and no string on the page says “réduction”', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Supprimer la sélection' })).toBeDisabled()
    expect(document.body.textContent).not.toMatch(/réduction/i)

    // The reduced wordings only render under a filter.
    const types = screen.getByRole('group', { name: 'Type' })
    await user.click(within(types).getByRole('button', { name: /^Achat/ }))
    expect(await screen.findByText('2 événements filtrés')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/réduction/i)
  })

  it('sends the ticked ids in a body, says what left, and clears the selection', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    let asked: { search: string; body: unknown } | null = null
    server.use(
      http.delete(ROUTES.events, async ({ request }) => {
        asked = { search: new URL(request.url).search, body: await request.json() }
        return HttpResponse.json({ events_removed: 2 })
      }),
    )

    await user.click(rowBox(ledger(), 0))
    await user.click(rowBox(ledger(), 2))
    await user.click(
      screen.getByRole('button', { name: 'Supprimer les 2 événements sélectionnés' }),
    )

    const box = await screen.findByRole('dialog')
    expect(
      within(box).getByRole('heading', { name: 'Supprimer les 2 événements sélectionnés ?' }),
    ).toBeInTheDocument()
    await user.click(within(box).getByRole('button', { name: 'Les supprimer' }))

    await waitFor(() => expect(asked).toEqual({ search: '', body: { ids: ['1', '3'] } }))
    expect(await screen.findByText('2 événements supprimés.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Supprimer la sélection' })).toBeDisabled()
  })

  it('keeps the selection and deletes nothing when the box is cancelled', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    let deleted = false
    server.use(
      http.delete(ROUTES.events, () => {
        deleted = true
        return HttpResponse.json({ events_removed: 1 })
      }),
    )

    await user.click(rowBox(ledger(), 1))
    await user.click(screen.getByRole('button', { name: 'Supprimer l’événement sélectionné' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Les garder' }),
    )

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(deleted).toBe(false)
    expect(rowBox(ledger(), 1)).toBeChecked()
  })

  it('does not open the editor from a checkbox, and still does from the row', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(rowBox(ledger(), 0))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(within(rowsOf(ledger())[0]).getAllByRole('cell')[1])
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('renders the header indeterminate on a partial selection', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const header = screen.getByRole('checkbox', { name: 'Sélectionner les 4 événements filtrés' })
    await user.click(rowBox(ledger(), 0))
    expect(header).toHaveAttribute('data-state', 'indeterminate')
  })

  it('ticks every filtered row from the header, the ones not revealed yet included', async () => {
    const mixed = [
      ...aLongLedger(120),
      anEvent({ id: '200', date: '2025-06-01', event_type: 'DEPOSIT', symbol: null }),
    ]
    const { user } = renderData(mixed)
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const types = screen.getByRole('group', { name: 'Type' })
    await user.click(within(types).getByRole('button', { name: /^Achat/ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(40))

    await user.click(
      screen.getByRole('checkbox', { name: 'Sélectionner les 120 événements filtrés' }),
    )
    expect(
      screen.getByRole('button', { name: 'Supprimer les 120 événements sélectionnés' }),
    ).toBeEnabled()

    // Revealing more shows the new rows already ticked.
    await user.click(screen.getByRole('button', { name: 'Afficher la suite' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(80))
    expect(rowBox(ledger(), 79)).toBeChecked()
  })

  it('drops a ticked row a filter hides from the count, and ticks it again when lifted', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(rowBox(ledger(), 0))
    await user.click(rowBox(ledger(), 2))
    expect(
      screen.getByRole('button', { name: 'Supprimer les 2 événements sélectionnés' }),
    ).toBeEnabled()

    // Row 2 is the deposit; filtering on purchases hides it.
    const types = screen.getByRole('group', { name: 'Type' })
    await user.click(within(types).getByRole('button', { name: /^Achat/ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    expect(screen.getByRole('button', { name: 'Supprimer l’événement sélectionné' })).toBeEnabled()

    // Cancelled here: what is sent is checked in the next case.
    await user.click(within(types).getByRole('button', { name: /^Tous les types/ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
    expect(rowBox(ledger(), 2)).toBeChecked()
    expect(
      screen.getByRole('button', { name: 'Supprimer les 2 événements sélectionnés' }),
    ).toBeEnabled()
  })

  it('never sends an id a filter hides, and reads the header off the shown rows', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    let asked: unknown = null
    server.use(
      http.delete(ROUTES.events, async ({ request }) => {
        asked = await request.json()
        return HttpResponse.json({ events_removed: 1 })
      }),
    )

    await user.click(rowBox(ledger(), 2))
    const types = screen.getByRole('group', { name: 'Type' })
    await user.click(within(types).getByRole('button', { name: /^Achat/ }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    // The deposit is ticked but hidden: nothing shown is ticked.
    expect(
      screen.getByRole('checkbox', { name: 'Sélectionner les 2 événements filtrés' }),
    ).toHaveAttribute('data-state', 'unchecked')

    await user.click(rowBox(ledger(), 0))
    await user.click(screen.getByRole('button', { name: 'Supprimer l’événement sélectionné' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Les supprimer' }),
    )
    await waitFor(() => expect(asked).toEqual({ ids: ['1'] }))
  })

  it('says “filtered” and never “reduction” under a filter, in English too', async () => {
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload())))
    const { user } = renderApp({ url: '/ledger', browserLanguages: ['en-GB'] })
    await screen.findByRole('table', { name: 'Your events' })

    expect(screen.getByRole('button', { name: 'Delete the selection' })).toBeDisabled()
    const types = screen.getByRole('group', { name: 'Type' })
    await user.click(within(types).getByRole('button', { name: /^Buy/ }))
    expect(await screen.findByText('2 filtered events')).toBeInTheDocument()
    expect(screen.getByText('End of the results · 2 events')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/reduction/i)
  })

  it('empties the ledger through the header, with no box of its own', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    let asked: unknown = null
    server.use(
      http.delete(ROUTES.events, async ({ request }) => {
        asked = await request.json()
        return HttpResponse.json({ events_removed: 4 })
      }),
    )

    await user.click(
      screen.getByRole('checkbox', { name: 'Sélectionner les 4 événements filtrés' }),
    )
    await user.click(
      screen.getByRole('button', { name: 'Supprimer les 4 événements sélectionnés' }),
    )
    const box = await screen.findByRole('dialog')
    expect(within(box).queryByText(/Vider le grand livre/)).not.toBeInTheDocument()
    await user.click(within(box).getByRole('button', { name: 'Les supprimer' }))

    await waitFor(() => expect(asked).toEqual({ ids: ['1', '2', '3', 'typed-1'] }))
  })

  it('keeps the box open on a refusal and says it in the reader’s language', async () => {
    // A `422` the reader could not foresee — a client that lost its body. The
    // sentence is read by `problem.type`, never by the English `detail` the
    // server wrote for a log.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    server.use(
      http.delete(ROUTES.events, () =>
        HttpResponse.json(
          { status: 422, type: PROBLEM_TYPES.badRequest, title: 'Invalid request' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )

    await user.click(rowBox(ledger(), 0))
    await user.click(rowBox(ledger(), 1))
    await user.click(
      screen.getByRole('button', { name: 'Supprimer les 2 événements sélectionnés' }),
    )
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Les supprimer' }),
    )

    const box = await screen.findByRole('dialog')
    expect(await within(box).findByRole('status')).toHaveTextContent(
      'L’application a refusé la requête faite par cette page.',
    )
    // The box stays open on the failure — everything behind the overlay is
    // `aria-hidden`, so a refusal rendered on the page behind it would be a
    // sentence nobody can read — and it still counts the selection it was
    // opened on.
    expect(
      within(box).getByRole('heading', { name: 'Supprimer les 2 événements sélectionnés ?' }),
    ).toBeInTheDocument()
  })

  it('says a withdrawal a later sale rests on in its own words (#824)', async () => {
    // A selection can take the purchases away and leave the sales — and that is
    // **not** the news a file that oversells is: what is refused here is a
    // withdrawal, and what it would break is elsewhere in the ledger. The
    // server names the gesture, because no payload distinguishes the two, and
    // the catalogue holds a sentence for each.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    server.use(
      http.delete(ROUTES.events, () =>
        HttpResponse.json(
          {
            status: 409,
            type: PROBLEM_TYPES.unreplayableLedger,
            title: 'Ledger does not replay',
            detail: 'Cannot sell 10.0 shares of AAPL (only 0.0 owned) on 2026-02-10',
            gesture: 'remove',
            symbol: 'AAPL',
            wanted: 10,
            owned: 0,
            day: '2026-02-10',
          },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )

    await user.click(rowBox(ledger(), 0))
    await user.click(rowBox(ledger(), 1))
    await user.click(
      screen.getByRole('button', { name: 'Supprimer les 2 événements sélectionnés' }),
    )
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Les supprimer' }),
    )

    const box = await screen.findByRole('dialog')
    expect(await within(box).findByRole('status')).toHaveTextContent(
      'L’application a refusé et n’a rien retiré : une vente postérieure de AAPL repose ' +
        'dessus — elle vend 10 parts, et il n’en resterait que 0.',
    )
    expect(within(box).queryByText(/Cannot sell/)).not.toBeInTheDocument()
  })
})

describe('the editor, and where it does not appear', () => {
  it('appears on every row of an install that has only ever imported', async () => {
    // **The ticket's criterion** (#816, story 13). The real portfolio exactly —
    // 285 rows that came out of a file, 0 typed — and every one of them is now
    // correctable: the read-only population is gone with the mount that
    // justified it, so the row's own name is pressable everywhere.
    renderData(ledgerEvents().map((event) => ({ ...event })))
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const rows = within(ledger()).getAllByRole('row').slice(1)
    for (const row of rows) {
      expect(within(row).getAllByRole('button').length).toBeGreaterThan(0)
    }
  })

  it('opens on a row, prefilled and shaped for its type', async () => {
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

  it('opens on a click anywhere on the row, the name staying the keyboard’s way in', async () => {
    // **The criterion** (#834): the row is the target, which is the shares
    // table's own gesture one page over. The button on the name is not a
    // duplicate — it is the one thing a reader tabbing through the table can
    // reach — and the two land on the same panel.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const row = within(ledger()).getByText('ZZC').closest('tr') as HTMLElement
    await user.click(within(row).getAllByRole('cell')[1])

    expect(await screen.findByLabelText('Quantité')).toHaveValue('2')
    expect(screen.getByRole('radio', { name: 'Attribution' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })
})

describe('a row is removed at the unit', () => {
  it('names the row in the box, and never asks *are you sure* on its own', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const row = within(ledger()).getByText('ZZC').closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Supprimer cet événement' }))

    const box = await screen.findByRole('dialog')
    expect(
      within(box).getByRole('heading', { name: 'Supprimer cet événement ?' }),
    ).toBeInTheDocument()
    // What names a row is what the row shows — its type, its identity, its day
    // — and never its key: a ledger row has no address.
    expect(within(box).getByText(/Attribution · ZZC · 24 déc\. 2025/)).toBeInTheDocument()
    // The editor did not open underneath it: the gesture on the cell stops
    // where it was made.
    expect(screen.queryByRole('radiogroup', { name: 'Ce qui s’est passé' })).not.toBeInTheDocument()
  })

  it('sends the row’s own key and says what left', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    let asked: string | null = null
    server.use(
      http.delete(`${ROUTES.events}/:id`, ({ params, request }) => {
        asked = String(params.id)
        void request
        server.use(
          http.get(ROUTES.events, () =>
            HttpResponse.json(aLedgerPayload(ledgerEvents().slice(0, 3))),
          ),
        )
        return HttpResponse.json({ id: asked, removed: true })
      }),
    )

    const row = within(ledger()).getByText('ZZC').closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Supprimer cet événement' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Supprimer cet événement',
      }),
    )

    await waitFor(() => expect(asked).toBe('typed-1'))
    expect(await screen.findByText('1 événement supprimé.')).toBeInTheDocument()
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))
  })

  it('keeps the box open on a refusal and says it in the reader’s language', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    server.use(
      http.delete(`${ROUTES.events}/:id`, () =>
        HttpResponse.json(
          {
            status: 409,
            type: PROBLEM_TYPES.unreplayableLedger,
            title: 'Ledger does not replay',
            gesture: 'remove',
            symbol: 'ZZC',
            wanted: 2,
            owned: 0,
            day: '2026-02-10',
          },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )

    const row = within(ledger()).getByText('ZZC').closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Supprimer cet événement' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Supprimer cet événement',
      }),
    )

    const box = await screen.findByRole('dialog')
    expect(await within(box).findByRole('status')).toHaveTextContent(/une vente postérieure de ZZC/)
    expect(
      within(box).getByRole('heading', { name: 'Supprimer cet événement ?' }),
    ).toBeInTheDocument()
  })

  it('says the row left the ledger elsewhere, and re-reads it under the reader', async () => {
    // **#785's criterion, on the reachable half.** The list is 30 s old and the
    // row it shows was deleted in another tab; the `404` that comes back is not
    // *this does not exist* — a sentence that contradicts what the reader is
    // looking at — but *it was deleted elsewhere*. And the ledger is re-read on
    // the failure, so the phantom row is gone the moment the box comes down.
    let gone = false
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    server.use(
      http.get(ROUTES.events, () =>
        HttpResponse.json(aLedgerPayload(gone ? ledgerEvents().slice(0, 3) : ledgerEvents())),
      ),
      http.delete(`${ROUTES.events}/:id`, () => {
        gone = true
        return HttpResponse.json(
          { status: 404, type: PROBLEM_TYPES.entryGone, title: 'Event no longer in the ledger' },
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
        )
      }),
    )

    const row = within(ledger()).getByText('ZZC').closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Supprimer cet événement' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Supprimer cet événement',
      }),
    )

    const box = await screen.findByRole('dialog')
    expect(await within(box).findByRole('status')).toHaveTextContent(
      'Cet événement n’est plus dans le grand livre : il a été supprimé ailleurs, ' +
        'et rien n’a été modifié ici.',
    )
    // Not the generic sentence, which is the whole point of the second key.
    expect(within(box).queryByText(/n’existe pas/)).not.toBeInTheDocument()

    // The table is `aria-hidden` under the overlay, so what the re-read bought
    // is read where the reader reads it: the box comes down on a ledger that
    // no longer shows the row it was about.
    await user.click(within(box).getByRole('button', { name: 'Le garder' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))
  })
})

describe('the create form, which is the onboarding', () => {
  it('asks the type first, with six labels that state their effect', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const types = await openTheForm(user)

    expect(
      within(types)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['Achat', 'Vente', 'Attribution', 'Dividende', 'Versement', 'Retrait'])
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
    expect(
      within(panel).getByRole('radiogroup', { name: 'Ce qui s’est passé' }),
    ).toBeInTheDocument()
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
    expect(await screen.findByText(/calculés à partir de ces dates/)).toBeInTheDocument()
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
    expect(await screen.findByText(/ajoute seulement des titres/)).toBeInTheDocument()
    expect(screen.getByText(/vos versements et dans votre base de coût/)).toBeInTheDocument()
  })

  it('suggests the grant price off the closest close, and names the day it came from', async () => {
    // #1007: the price was typed blind on the day the event was recorded, and
    // the consequence — the whole account out of the benchmark — surfaced five
    // years later on another page. The figure arrives, and it says where from:
    // the fixture answers 2026-02-27 for a grant dated the 28th, because a
    // grant dated a day nobody quoted is priced off the day before.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('radio', { name: 'Attribution' }))

    fireEvent.change(await screen.findByLabelText('Date'), {
      target: { value: '2026-02-28' },
    })
    await user.type(screen.getByLabelText('Ticker'), 'ZZA')

    const price = screen.getByLabelText('Prix unitaire')
    await waitFor(() => expect(price).toHaveValue('126'))
    expect(screen.getByText(/cours de clôture du 27 févr\. 2026/)).toBeInTheDocument()

    // **Cleared is cleared.** The emptiness of this field is a declaration —
    // *the award cost me nothing* — so a suggestion that walked back in would
    // overwrite the one answer the owner is the only one who can give.
    await user.clear(price)
    expect(price).toHaveValue('')
    await waitFor(() => expect(screen.queryByText(/cours de clôture du/)).not.toBeInTheDocument())
    expect(price).toHaveValue('')
  })

  it('offers the close at the currency\u2019s precision, not the store\u2019s float32', async () => {
    // #1033: `/api/prices/FDJU.PA?at=2021-07-01` answers `49.27000045776367`,
    // which is the right answer on the wire — the chart reads the same route.
    // In this field it is a figure bound for the cost basis, the XIRR and the
    // tax assiette, offered to a reader invited to accept it or clear it, never
    // to correct it. Sixteen digits are exactly the shape nobody re-reads.
    server.use(
      http.get(ROUTES.prices, ({ params, request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.get('at')
            ? aPriceAt({ symbol: String(params.symbol), price: 49.27000045776367 })
            : aPriceSeries({ symbol: String(params.symbol) }),
        ),
      ),
    )

    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('radio', { name: 'Attribution' }))

    fireEvent.change(await screen.findByLabelText('Date'), {
      target: { value: '2026-02-28' },
    })
    await user.type(screen.getByLabelText('Ticker'), 'ZZA')

    const price = screen.getByLabelText('Prix unitaire')
    await waitFor(() => expect(price).toHaveValue('49.27'))
    // And the day still belongs to what is in the field: the caption is a claim
    // about the value offered, so it has to survive the rounding of it.
    expect(screen.getByText(/cours de cl\u00f4ture du 27 f\u00e9vr\. 2026/)).toBeInTheDocument()
  })

  it('leaves a stored price as it was declared, decimals and all', async () => {
    // The edit path is **not** rounded (#1033). `unit_price` holds what somebody
    // declared — typed here, or read out of a mounted file where four decimals
    // is a price and not an artefact — and a figure trimmed on open is a figure
    // the next save rewrites without the reader touching the field.
    const precise = aTypedEvent({
      id: 'g2',
      event_type: 'GRANT',
      date: '2026-02-28',
      symbol: 'ZZA',
      quantity: 5,
      unit_price: 40.1234,
      amount: null,
      fee: null,
    })
    const { user } = renderData([precise])
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(within(ledger()).getByRole('button', { name: 'ZZA' }))
    await waitFor(() => expect(screen.getByLabelText('Prix unitaire')).toHaveValue('40.1234'))
  })

  it('takes its own suggestion back when the security changes under it', async () => {
    // The figure and the ticker have to be about the same security. A
    // suggestion that stayed put while the symbol moved would leave one
    // company's close under another's name — in a field that lands in the cost
    // basis, which is the silent wrong price this ticket is about.
    server.use(
      http.get(ROUTES.prices, ({ params, request }) => {
        const at = new URL(request.url).searchParams.get('at')
        if (!at) return HttpResponse.json(aPriceSeries({ symbol: String(params.symbol) }))
        // `ZZA` is quoted; nothing was ever scraped for `ZZQ`.
        return HttpResponse.json(
          params.symbol === 'ZZA'
            ? aPriceAt({ symbol: 'ZZA' })
            : aPriceAt({ symbol: String(params.symbol), day: null, price: null }),
        )
      }),
    )

    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('radio', { name: 'Attribution' }))

    fireEvent.change(await screen.findByLabelText('Date'), {
      target: { value: '2026-02-28' },
    })
    const ticker = screen.getByLabelText('Ticker')
    await user.type(ticker, 'ZZA')
    await waitFor(() => expect(screen.getByLabelText('Prix unitaire')).toHaveValue('126'))

    await user.clear(ticker)
    await user.type(ticker, 'ZZQ')
    await waitFor(() => expect(screen.getByLabelText('Prix unitaire')).toHaveValue(''))
    expect(screen.queryByText(/cours de clôture du/)).not.toBeInTheDocument()
  })

  it('suggests nothing on a purchase, whose price is the money that left', async () => {
    // A close is what the market said; a purchase's unit price is what the
    // account paid, fees and slippage and all. Suggesting one for the other
    // would be a figure nobody transacted at, in a required field.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('radio', { name: 'Achat' }))

    fireEvent.change(await screen.findByLabelText('Date'), {
      target: { value: '2026-02-28' },
    })
    await user.type(screen.getByLabelText('Ticker'), 'ZZA')

    await waitFor(() => expect(screen.getByLabelText('Quantité')).toHaveValue(''))
    expect(screen.getByLabelText('Prix unitaire')).toHaveValue('')
    expect(screen.queryByText(/cours de clôture du/)).not.toBeInTheDocument()
  })

  it('leaves a grant already priced alone, and says nothing about a figure it did not put there', async () => {
    // Correcting a row is not re-asking the question: the owner's own figure
    // stands, and the day caption is a claim about *the field's* value — under
    // somebody else's number it would be a precise untruth.
    const priced = aTypedEvent({
      id: 'g1',
      event_type: 'GRANT',
      date: '2026-02-28',
      symbol: 'ZZA',
      quantity: 5,
      unit_price: 40,
      amount: null,
      fee: null,
    })
    const { user } = renderData([priced])
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(within(ledger()).getByRole('button', { name: 'ZZA' }))

    const price = await screen.findByLabelText('Prix unitaire')
    await waitFor(() => expect(price).toHaveValue('40'))
    expect(screen.queryByText(/cours de clôture du/)).not.toBeInTheDocument()
  })

  it('says a corrected row left the ledger elsewhere, in the panel that holds it', async () => {
    // The same news, on the other gesture that addresses a row by its key
    // (#785): *corriger* rewrites what the reader was looking at, so a `404`
    // here means the row went — not that the address was never anything.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    let gone = false
    server.use(
      http.get(ROUTES.events, () =>
        HttpResponse.json(aLedgerPayload(gone ? ledgerEvents().slice(0, 3) : ledgerEvents())),
      ),
      http.patch(`${ROUTES.events}/:id`, () => {
        gone = true
        return HttpResponse.json(
          { status: 404, type: PROBLEM_TYPES.entryGone, title: 'Event no longer in the ledger' },
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
        )
      }),
    )

    await user.click(within(ledger()).getByRole('button', { name: 'ZZC' }))
    expect(await screen.findByLabelText('Quantité')).toHaveValue('2')
    await user.click(screen.getByRole('button', { name: 'Enregistrer cet événement' }))

    const panel = screen.getByRole('dialog')
    expect(await within(panel).findByRole('status')).toHaveTextContent(
      'Cet événement n’est plus dans le grand livre : il a été supprimé ailleurs, ' +
        'et rien n’a été modifié ici.',
    )
    // The panel stays open holding what was typed — the reader has not lost it.
    expect(screen.getByLabelText('Quantité')).toHaveValue('2')

    // **Every way out of the panel forgets it**, and the cancel button is the
    // one a reader actually presses — it closes without going through the
    // sheet's own close, so a reset held there alone would leave the sentence
    // standing on exactly the commonest path.
    await user.click(within(panel).getByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))

    // **The refusal does not outlive its gesture.** The panel is mounted once
    // for every row, so a sentence left standing would be read as being about
    // the next row opened — and *this event is no longer in the ledger* over a
    // row that is perfectly alive is a precise untruth, which is worse than the
    // vague one it replaced.
    const alive = within(ledger()).getByText('Versement programmé mensuel').closest('tr')
    await user.click(within(alive as HTMLElement).getAllByRole('cell')[1])
    expect(await screen.findByLabelText('Quantité')).toHaveValue('3')
    expect(screen.queryByText(/n’est plus dans le grand livre/)).not.toBeInTheDocument()
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
    // one *is* the onboarding since manual mode died.
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
    expect(within(file).getByLabelText('Parcourir…')).toBeInTheDocument()

    // Neither entry is the recommended one.
    const action = within(manual).getByRole('button', { name: 'Saisir un événement' })
    expect(action).toHaveAttribute('data-variant', 'outline')

    await user.click(action)
    expect(
      await screen.findByRole('radiogroup', { name: 'Ce qui s’est passé' }),
    ).toBeInTheDocument()
  })
})

describe('the page’s own read', () => {
  it('names an unreadable store instead of showing an empty ledger', async () => {
    // Said in the journal's own space, as an empty state, and never as a band
    // at the top of the tab (#829).
    server.use(
      problemHandler(ROUTES.events, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp({ url: '/ledger' })

    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.getByText(/son magasin ne répond pas/)).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
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
    renderApp({ url: '/ledger', browserLanguages: ['en-GB'] })

    const table = await screen.findByRole('table', { name: 'Your events' })
    expect(columnNames(table)).toEqual([
      '',
      'Date',
      'Type',
      'What it is',
      'Quantity',
      'Unit price',
      'Fee',
      'Amount',
      'Account',
      'Delete this event',
    ])
    // `Free shares`, `Cash in`, `Cash out` — the effect, not the six codes at a
    // difference of case.
    expect(within(table).getByText('Cash in')).toBeInTheDocument()
    expect(within(table).getByText('Free shares')).toBeInTheDocument()
    // The reveal speaks English too, and the English is the source.
    expect(screen.getByRole('group', { name: 'Type' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All types · 4 events' })).toBeInTheDocument()
    expect(screen.getByText('The end of the ledger · 4 events')).toBeInTheDocument()
  })
})

// --------------------------------------------------------------------------- //
// The ticker field suggests what the ledger already names (#1036)
// --------------------------------------------------------------------------- //

/** La liste des suggestions, une fois quelque chose tapé dans le champ Titre. */
function suggestions() {
  return screen.getByRole('listbox', { name: 'Titres que vous détenez ou avez détenus' })
}

/** Ses entrées, dans l'ordre où elles sont dessinées. */
function lines() {
  return within(suggestions()).getAllByRole('option')
}

/** Le panneau ouvert sur un achat, et son champ Titre. */
async function openOnABuy(user: ReturnType<typeof renderApp>['user']) {
  await openTheForm(user)
  await user.click(screen.getByRole('radio', { name: 'Achat' }))
  return screen.getByLabelText('Ticker')
}

describe('le champ Titre suggère', () => {
  it('offers the titles the ledger names, ticker first and name beside it', async () => {
    // The fixture's ledger names two securities and one cash movement. The
    // movement names no security, so it is not a title.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')

    const lines = within(suggestions()).getAllByRole('option')
    expect(lines.map((line) => line.textContent)).toEqual(['ZZAZeta Alpha', 'ZZCZeta Gamma'])
  })

  it('is drawn inside the panel, where the wheel still works', async () => {
    // A modal sheet cancels the wheel everywhere but its own content, so a list
    // portalled to the body would scroll on the keyboard and nowhere else.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')

    expect(screen.getByRole('dialog')).toContainElement(suggestions())
  })

  it('leaves Entrée to the form until an arrow key says otherwise', async () => {
    // The gesture this product already had: type a ticker, press enter, the
    // event is recorded. A pre-highlighted line would turn that reflex into
    // *record the line I happen to be over*.
    let recorded: unknown = null
    server.use(
      http.post(ROUTES.events, async ({ request }) => {
        recorded = await request.json()
        return HttpResponse.json(aTypedEvent({ id: 'created' }), { status: 201 })
      }),
    )
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-02-20' } })
    await user.selectOptions(screen.getByLabelText('Compte'), 'alpha')
    await user.type(screen.getByLabelText('Quantité'), '3')
    await user.type(screen.getByLabelText('Prix unitaire'), '120')
    await user.type(field, 'ZZQ')
    await user.type(field, '{Enter}')

    await waitFor(() => expect(recorded).not.toBeNull())
    expect(recorded).toMatchObject({ symbol: 'ZZQ', event_type: 'BUY' })
  })

  it('takes Entrée for itself once an arrow key has chosen a line', async () => {
    let recorded: unknown = null
    server.use(
      http.post(ROUTES.events, async ({ request }) => {
        recorded = await request.json()
        return HttpResponse.json(aTypedEvent({ id: 'created' }), { status: 201 })
      }),
    )
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')
    await user.keyboard('{ArrowDown}')
    expect(within(suggestions()).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')

    expect(field).toHaveValue('ZZA')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    // The panel is still open and nothing was written: Entrée chose, it did not
    // record.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(recorded).toBeNull()
  })

  it('does not inherit the active line when the list is reopened', async () => {
    // Le troisième des trois tests de R7, et celui qui tient la garde : si
    // l'index survivait à une fermeture, `Entrée` sur une liste rouverte
    // choisirait une ligne que personne n'a désignée — l'accident que la
    // décision « aucune ligne pré-active » existe pour rendre impossible.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')
    await user.keyboard('{ArrowDown}')
    expect(field).toHaveAttribute('aria-activedescendant')
    await user.keyboard('{Escape}')

    await user.type(field, 'a')
    expect(suggestions()).toBeInTheDocument()
    expect(field).not.toHaveAttribute('aria-activedescendant')
    expect(
      within(suggestions())
        .getAllByRole('option')
        .filter((line) => line.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(0)
  })

  it('keeps the caret in the field when a line is clicked', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zzc')
    await user.click(within(suggestions()).getAllByRole('option')[0] as HTMLElement)

    expect(field).toHaveValue('ZZC')
    expect(field).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('closes on Échap without closing the panel, and keeps what was typed', async () => {
    // Radix registers its escape handler for the highest layer only, so the
    // open list takes the key and the sheet underneath keeps it.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')
    expect(suggestions()).toBeInTheDocument()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(field).toHaveValue('zz')
  })

  it('offers to record a ticker nobody has ever held, which is the normal case', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'NVDA')

    const only = within(suggestions()).getAllByRole('option')
    expect(only).toHaveLength(1)
    expect(only[0]).toHaveTextContent('Utiliser « NVDA »')
    await user.click(only[0] as HTMLElement)
    expect(field).toHaveValue('NVDA')
  })

  it('says nothing at all while the ledger has not answered', async () => {
    // #775, dans le seul endroit où cette liste peut le rompre : *aucun titre ne
    // correspond* est une affirmation sur le portefeuille du lecteur, et une
    // lecture en vol ne l'a pas faite.
    //
    // L'état est atteignable : la barre qui porte *Saisir un événement* attend
    // `events.data`, mais `?open=event` — armé par la palette ⌘K et par la carte
    // du premier lancement — ouvre le panneau au montage, et `Ledger.tsx` monte
    // le formulaire hors du bloc qui attend la lecture.
    server.use(http.get(ROUTES.events, () => new Promise<never>(() => {})))
    const { user } = renderApp({ url: '/ledger?open=event' })

    await screen.findByRole('dialog')
    await user.click(screen.getByRole('radio', { name: 'Achat' }))
    const field = screen.getByLabelText('Ticker')
    await user.type(field, 'NVDA')

    // Ni liste, ni entrée « utiliser », ni phrase de quasi-collision : trois
    // façons de parler d'un portefeuille que personne n'a encore lu.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/Utiliser/)).not.toBeInTheDocument()
    expect(screen.queryByText(/nomme déjà/)).not.toBeInTheDocument()
    // Et le champ reste un champ : la valeur libre est saisissable.
    expect(field).toHaveValue('NVDA')
    await user.keyboard('{ArrowDown}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('names the ticker a near miss will be recorded under, and refuses nothing', async () => {
    // The server folds a symbol's case (#1068), so `zza` joins the position
    // already held as `ZZA` — and the sentence says so before the save.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zza')
    // **Les deux filets, au même instant.** La liste est ouverte sur `ZZA` et
    // l'occulte : c'est voulu (Issue 5). Elle parle pendant la frappe, la phrase
    // parle une fois la liste refermée, curseur vers *Enregistrer*.
    expect(suggestions()).toBeInTheDocument()
    expect(screen.getByText(/nomme déjà ZZA/)).toBeInTheDocument()
    // Named, never refused: the value stands and the save is not withheld.
    expect(field).toHaveValue('zza')
    expect(screen.getByRole('button', { name: 'Enregistrer cet événement' })).toBeEnabled()

    await user.clear(field)
    await user.type(field, 'ZZQ')
    expect(screen.queryByText(/nomme déjà/)).not.toBeInTheDocument()
  })

  it('offers a title the ledger has sold out of, which is half the perimeter', async () => {
    // The whole reason the perimeter is the ledger and not the held positions:
    // a security bought and sold in full is still a security this reader has
    // recorded, and a dividend or a correction on it is an ordinary gesture.
    const { user } = renderData([
      anEvent({ id: 'b1', date: '2025-06-02', symbol: 'ZZD', name: 'Zeta Delta', quantity: 10 }),
      anEvent({
        id: 's1',
        date: '2025-09-09',
        event_type: 'SELL',
        symbol: 'ZZD',
        name: 'Zeta Delta',
        quantity: 10,
      }),
    ])
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zzd')

    expect(within(suggestions()).getAllByRole('option')).toHaveLength(1)
    expect(within(suggestions()).getAllByRole('option')[0]).toHaveTextContent('ZZDZeta Delta')
  })

  it('arms the grant price on a ticker chosen from the list, as on a typed one', async () => {
    // #1007 reads `draft.symbol`, and choosing a line writes exactly that. The
    // criterion is the ticket's own: the suggestion must not become a thing
    // only typing can reach.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('radio', { name: 'Attribution' }))

    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-02-28' } })
    const field = screen.getByLabelText('Ticker')
    await user.type(field, 'zza')
    await user.keyboard('{ArrowDown}{Enter}')

    expect(field).toHaveValue('ZZA')
    await waitFor(() => expect(screen.getByLabelText('Prix unitaire')).toHaveValue('126'))
    expect(screen.getByText(/cours de clôture du 27 févr\. 2026/)).toBeInTheDocument()
  })

  it('serves the same list on the four types that name a security', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)

    for (const type of ['Achat', 'Vente', 'Attribution', 'Dividende']) {
      await user.click(screen.getByRole('radio', { name: type }))
      const field = screen.getByLabelText('Ticker')
      await user.clear(field)
      await user.type(field, 'zzc')
      expect(within(suggestions()).getAllByRole('option')).toHaveLength(1)
      await user.keyboard('{Escape}')
    }
  })
})

// --------------------------------------------------------------------------- //
// The same field, at the keyboard and under the pointer (#1036)
// --------------------------------------------------------------------------- //

describe('le champ Titre se conduit', () => {
  it('opens on the arrow alone, and the empty query is *everything you own*', async () => {
    // `matchesQuery` answers true to an empty needle, which is what makes the
    // list *what you hold* before it is *what you typed*. Nothing here has been
    // typed at all: the arrow is the whole gesture.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    field.focus()
    await user.keyboard('{ArrowDown}')

    expect(lines().map((line) => line.textContent)).toEqual(['ZZAZeta Alpha', 'ZZCZeta Gamma'])
    expect(lines()[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('opens nothing at all when the ledger names no security', async () => {
    // A ledger of cash movements has no title, and an empty field asks for no
    // creation either — so there is no line to draw and the arrow answers with
    // silence rather than with an empty box.
    const { user } = renderData([
      anEvent({
        id: 'cash',
        date: '2026-01-05',
        event_type: 'DEPOSIT',
        symbol: null,
        name: null,
        notes: 'Virement entrant',
        quantity: null,
        unit_price: null,
        fee: null,
        amount: 500,
      }),
    ])
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    field.focus()
    await user.keyboard('{ArrowDown}{ArrowUp}')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('walks the list around, up from nothing landing on the last line', async () => {
    // The index is a ring and `null` is a place in it, not an absence of one:
    // the first `ArrowUp` means *the last line*, which is what a reader
    // reaching for the bottom of a two-line list actually does.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')
    await user.keyboard('{ArrowUp}')
    expect(lines()[1]).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowDown}')
    expect(lines()[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}')
    expect(lines()[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('jumps to the ends with Origine and Fin', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')
    await user.keyboard('{End}')
    expect(lines()[1]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(lines()[0]).toHaveAttribute('aria-selected', 'true')
    // The field is what carries the caret, so the key that moved the active
    // line must not also have moved the text.
    expect(field).toHaveValue('zz')
  })

  it('gives Entrée back to the form as soon as something is typed again', async () => {
    // The line stops being chosen the instant the query changes underneath it:
    // otherwise `Entrée` would record `ZZA` over a reader who went on typing
    // `zza`, which is a different ticker and the reader's to record.
    let recorded: unknown = null
    server.use(
      http.post(ROUTES.events, async ({ request }) => {
        recorded = await request.json()
        return HttpResponse.json(aTypedEvent({ id: 'created' }), { status: 201 })
      }),
    )
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-02-20' } })
    await user.selectOptions(screen.getByLabelText('Compte'), 'alpha')
    await user.type(screen.getByLabelText('Quantité'), '3')
    await user.type(screen.getByLabelText('Prix unitaire'), '120')
    await user.type(field, 'zz')
    await user.keyboard('{ArrowDown}')
    await user.type(field, 'a')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(recorded).not.toBeNull())
    expect(recorded).toMatchObject({ symbol: 'zza' })
  })

  it('closes on Tabulation without choosing the line under the eye', async () => {
    // Leaving the field is not answering it: what was typed stands, and the
    // highlighted line is dropped with the list.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')
    await user.keyboard('{ArrowDown}')
    await user.tab()

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(field).toHaveValue('zz')
    expect(field).not.toHaveFocus()
  })

  it('moves the one highlight under the pointer rather than painting a second', async () => {
    // What the eye follows and what `aria-activedescendant` names have to be
    // the same line, or the keyboard and the mouse are pointing at two.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')
    await user.keyboard('{ArrowDown}')
    await user.hover(lines()[1] as HTMLElement)

    expect(lines().filter((line) => line.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    expect(lines()[1]).toHaveAttribute('aria-selected', 'true')
    expect(field).toHaveAttribute('aria-activedescendant', lines()[1]?.id)
  })

  it('stays open when the caret is put back in the field', async () => {
    // There is no trigger here — the anchor *is* the field — so radix counts a
    // click on it as a click outside its layer. Without the exemption, reaching
    // for the caret closes the list the reader was reading.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')
    await user.click(field)

    expect(suggestions()).toBeInTheDocument()
  })

  it('says nothing about a collision with the very ticker that was typed', async () => {
    // `ZZA` **is** `ZZA`. The sentence is about the near miss that opens a
    // second position, so the exact spelling of a held security has to be the
    // one case it stays quiet on — otherwise it fires on every ticker in the
    // portfolio and stops being read.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'ZZA')

    expect(screen.queryByText(/nomme déjà/)).not.toBeInTheDocument()
    expect(lines()[0]).toHaveTextContent('ZZAZeta Alpha')
  })

  it('attaches the collision sentence to the field it is about', async () => {
    // It is a remark beside a value nothing refuses, so the only way a screen
    // reader meets it at all is as the field's description.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zza')

    expect(field).toHaveAccessibleDescription(/nomme déjà ZZA/)
  })

  it('opens on a row already recorded without accusing it of anything', async () => {
    // The panel is the same one for a correction, and the row's own ticker is
    // in the field before a key is pressed: no list opens on a value nobody
    // typed, and the near-miss sentence has no near miss to name.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(within(ledger()).getByRole('button', { name: 'ZZC' }))

    expect(await screen.findByLabelText('Ticker')).toHaveValue('ZZC')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/nomme déjà/)).not.toBeInTheDocument()
  })

  it('says the three sentences in English too', async () => {
    // The keys carry a placeholder each, and a catalogue can hold the key with
    // the wrong name inside it — `{type}` for `{typed}` — without the parity
    // guard noticing. Rendering them is what closes that.
    server.use(
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload())),
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload())),
    )
    const { user } = renderApp({ url: '/ledger', browserLanguages: ['en-GB'] })

    await screen.findByRole('table', { name: 'Your events' })
    await user.click(await screen.findByRole('button', { name: 'Enter an event' }))
    await user.click(screen.getByRole('radio', { name: 'Buy' }))
    const field = screen.getByLabelText('Ticker')

    await user.type(field, 'zza')
    expect(
      screen.getByRole('listbox', { name: 'Securities you hold or have held' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Your ledger already names ZZA/)).toBeInTheDocument()

    await user.clear(field)
    await user.type(field, 'NVDA')
    expect(screen.getByRole('option', { name: 'Use “NVDA”' })).toBeInTheDocument()
  })
})
