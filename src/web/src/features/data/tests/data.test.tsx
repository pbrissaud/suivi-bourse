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
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import { EventFigure } from '@/features/data/components/LedgerTable'
import { I18nProvider } from '@/lib/i18n'
import { useIsMobile } from '@/hooks/use-mobile'
import type { LedgerEvent } from '@/features/data/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aLedgerPayload,
  aLongLedger,
  aPriceAt,
  aPriceSeries,
  anAccountsPayload,
  anEvent,
  defaultAccounts,
  anUnaddressableEvent,
  aTypedEvent,
  ledgerEvents,
} from '@/test/factories'
import { expectNoBox } from '@/test/noBox'
import { reachTheEnd } from '@/test/intersection'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

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

type User = ReturnType<typeof renderApp>['user']

/**
 * A filter of the control line, opened: its listbox. A filter is a text button
 * whose name is « Type : Tous les types »; one that is already open is left alone.
 */
async function openMenu(user: User, axis: 'Type' | 'Compte' | 'Période') {
  const open = screen.queryByRole('listbox', { name: axis })
  if (open) return open
  await user.click(screen.getByRole('button', { name: new RegExp(`^${axis} :`) }))
  return screen.findByRole('listbox', { name: axis })
}

/** The options of an open filter, as the reader reads them. */
const optionNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole('option')
    .map((option) => option.textContent)

/** An option of a filter, picked; the list closes, as the product does. */
async function pick(user: User, axis: 'Type' | 'Compte' | 'Période', name: string | RegExp) {
  const list = await openMenu(user, axis)
  await user.click(within(list).getByRole('option', { name }))
}

const pickType = (user: User, name: string | RegExp) => pick(user, 'Type', name)

async function openTheForm(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Saisir un événement' }))
  return screen.getByRole('tablist', { name: 'Ce qui s’est passé' })
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
      expect(screen.queryByRole('heading', { name: 'Installation' })).not.toBeInTheDocument()
      view.unmount()
    }
  })
})

describe('the columns of the ledger', () => {
  it('are the seven, after the one that ticks, and there is no ninth', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // `Provenance` was the ninth and it left with its subject (#816): there is
    // no source to name and no revocation to lead to. The row's removal that
    // closed it since #834 left too (#1264): it lives in the edit sheet.
    expect(columnNames(ledger())).toEqual([
      // The checkbox ticking every filtered row (#1113): a control, no text.
      '',
      'Date',
      'Type',
      'Événement',
      'Quantité',
      'Prix unitaire',
      'Montant',
      'Compte',
    ])
    // The ledger is served newest first: the one sorted column, `foreground` by
    // the table's own rule, with no glyph.
    expect(within(ledger()).getByRole('columnheader', { name: 'Date' })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
  })

  it('hands a grant’s Montant cell to its quantity below 896 px, and to a dash from there (#1355)', async () => {
    renderData([anEvent({ id: 'a', event_type: 'GRANT', quantity: 0.1661 })])
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // jsdom evaluates no container query: the two spans and their classes are the contract.
    const cell = rowsOf(ledger())[0].querySelectorAll('td')[6]
    expect(within(cell).getByText(/×\s0,1661/).parentElement).toHaveClass(
      '@min-[56rem]/ledger:hidden',
    )
    expect(within(cell).getByText('—')).toHaveClass('hidden', '@min-[56rem]/ledger:inline')
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

  it('leads with the name, « TICKER · libellé » under it, and the label alone on a transfer', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const share = within(ledger()).getAllByText('Zeta Alpha')[0].closest('tr') as HTMLElement
    expect(share).toHaveTextContent('ZZA · Ordre au marché, exécution partielle')

    // `Apple Pay Top up` on the real portfolio: there is no symbol at all, so
    // the label *is* the identity — one column doing the work for both families.
    const cash = within(ledger())
      .getByText('Virement entrant depuis le compte courant')
      .closest('tr') as HTMLElement
    expect(cash).toHaveTextContent('Versement')
    expect(cash).not.toHaveTextContent('ZZ')
    expect(cash.querySelectorAll('td')[3].querySelectorAll('span')).toHaveLength(0)
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
    const row = within(ledger()).getByText('Zeta Gamma').closest('tr') as HTMLElement
    const cells = within(row).getAllByRole('cell')
    expect(cells[cells.length - 1]).toHaveTextContent('Alpha')
    expect(cells[cells.length - 1]).not.toHaveTextContent('—')
  })

  it('truncates a label without a ticker to one line and keeps the whole text in its title', async () => {
    const label = `Virement ${'x'.repeat(71)}`
    expect(label).toHaveLength(80)
    renderData([
      anEvent({
        id: '9',
        event_type: 'DEPOSIT',
        symbol: null,
        name: null,
        notes: label,
        quantity: null,
        unit_price: null,
      }),
    ])
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const identity = within(ledger()).getByRole('button', { name: label })
    expect(identity).toHaveTextContent(label)
    expect(identity).toHaveAttribute('title', label)
    expect(identity).toHaveClass('truncate')
  })

  it('puts the ticker and the label on one truncated sub-line under the name', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const sub = within(ledger()).getByTitle('ZZA · Ordre au marché, exécution partielle')
    expect(sub).toHaveClass('truncate', 'text-muted-foreground')
    expect(sub).toHaveAttribute('title', 'ZZA · Ordre au marché, exécution partielle')
  })

  it('writes the date in its medium form, in the table and in the checkbox name', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const row = within(ledger()).getByText('Zeta Gamma').closest('tr') as HTMLElement
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent('24 déc. 2025')
    expect(within(row).getByRole('checkbox')).toHaveAccessibleName(/24 déc\. 2025/)
  })

  it('caps a long account id and keeps it in its title', async () => {
    const account = 'compte-courant-'.repeat(4)
    renderData([anEvent({ account })])
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const chip = within(ledger()).getByText(account)
    expect(chip).toHaveAttribute('title', account)
    expect(chip).toHaveClass('max-w-[calc(12ch+1rem)]', 'truncate')
  })

  it('draws no delete control in the rows', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(
      within(ledger()).queryByRole('button', { name: 'Supprimer cet événement' }),
    ).not.toBeInTheDocument()
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

  it('lays the six types out in the Type filter, and the way back first', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    // Behind a button that shows its value only: nothing of the vocabulary is on
    // the page until it is asked for.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Type : Tous les types' })).toBeInTheDocument()
    const types = await openMenu(user, 'Type')

    expect(optionNames(types)).toEqual([
      'Tous les types',
      'Achat',
      'Vente',
      'Attribution',
      'Dividende',
      'Versement',
      'Retrait',
    ])
    expect(within(types).getByRole('option', { name: 'Tous les types' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    await user.click(within(types).getByRole('option', { name: 'Versement' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))
    // The button wears the value in force, and the list is closed.
    expect(screen.getByRole('button', { name: 'Type : Versement' })).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // And it offers the way out, which is the first option.
    await pickType(user, 'Tous les types')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
  })

  it('offers the account filter only where there are two accounts to tell apart', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(screen.queryByRole('button', { name: /^Compte :/ })).not.toBeInTheDocument()

    const two = [...ledgerEvents(), anEvent({ id: '12', date: '2026-02-11', account: 'beta' })]
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(two))))
    await user.click(screen.getByRole('link', { name: 'Réglages' }))
    await user.click(screen.getByRole('link', { name: 'Grand livre' }))

    const accounts = await openMenu(user, 'Compte')
    // The order the ledger names them in, which is the sorted table's own.
    expect(optionNames(accounts)).toEqual(['Tous les comptes', 'Beta', 'Alpha'])

    await user.click(within(accounts).getByRole('option', { name: 'Beta' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Compte : Beta' })).toBeInTheDocument()
  })

  it('reduces to a year, shows it as the value of the Période filter, and lets it go', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Période : Depuis le début' })).toBeInTheDocument()
    const period = await openMenu(user, 'Période')
    // The years the ledger names, most recent first: no month grid, no field.
    expect(optionNames(period)).toEqual(['Depuis le début', '2026', '2025'])

    await user.click(within(period).getByRole('option', { name: '2025' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Période : 2025' })).toBeInTheDocument()

    await pick(user, 'Période', 'Depuis le début')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
  })

  it('carries the period on the export’s own address', async () => {
    // What travels is the *question*, never the rows: the importable form
    // belongs to `events/export.py`, and the two names are the server's.
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await pick(user, 'Période', '2026')
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

  it('takes an open interval from the address, names it, and gives it back when it is released', async () => {
    // A reduced ledger has an address, and since #810 the period is one of its
    // dimensions: a reader who reloads on an extract keeps it. An interval no
    // year spells is the value of the filter, worded as what it is.
    const { user, router } = renderData(ledgerEvents(), '/ledger?since=2026-01-06')
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    expect(
      screen.getByRole('button', { name: 'Période : Depuis le 6 janv. 2026' }),
    ).toBeInTheDocument()

    await pick(user, 'Période', 'Depuis le début')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
    // The address stopped describing the table, so it stops being one — a
    // reload restoring a reduction the reader has just lifted is the defect.
    expect(router.state.location.search).toEqual({})
  })

  it('says nothing matches rather than showing an empty table', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.type(screen.getByLabelText('Rechercher'), 'zzzz')
    expect(
      await screen.findByText('Aucun événement ne correspond à ces filtres.'),
    ).toBeInTheDocument()
    // Named, since #729: the declaration is a second table on this tab, and it
    // is not reduced by a search over the ledger. What the assertion is about is
    // that the *ledger* is replaced rather than left empty.
    expect(screen.queryByRole('table', { name: 'Vos événements' })).not.toBeInTheDocument()
  })
})

describe('the control line', () => {
  const withDividend = () => [
    ...ledgerEvents(),
    anEvent({
      id: '20',
      date: '2026-03-01',
      event_type: 'DIVIDEND',
      quantity: null,
      unit_price: null,
      fee: 0,
      amount: 5,
    }),
  ]

  it('renders no side panel, and the table is the page’s only column', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(screen.queryByRole('complementary', { name: 'Filtres' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /les filtres/ })).not.toBeInTheDocument()
    // The table is not a track of a grid: nothing sits beside it. It sits on
    // the page's background, with no plane and no frame (#1273).
    const table = ledger().closest('[data-slot="table-container"]')?.parentElement as HTMLElement
    expect(table.parentElement?.className).not.toMatch(/\bgrid\b/)
    expectNoBox()
    expect(ledger().closest('[data-slot="table-container"]')?.className).not.toMatch(/border/)
  })

  it('shows the value in force in foreground, and the others muted', async () => {
    const { user } = renderData(withDividend())
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const idle = screen.getByRole('button', { name: 'Type : Tous les types' })
    expect(idle).toHaveClass('text-muted-foreground')

    await pickType(user, 'Dividende')

    const marked = await screen.findByRole('button', { name: 'Type : Dividende' })
    expect(marked).toHaveClass('text-foreground')
    // No pill, no tint, no border: a filter is a text button.
    expect(marked.className).not.toMatch(/\b(border|bg)-/)
    // The other filters are untouched.
    expect(screen.getByRole('button', { name: 'Période : Depuis le début' })).toHaveClass(
      'text-muted-foreground',
    )
  })

  it('clears the address when a menu reduces a ledger that arrived by one', async () => {
    const { user, router } = renderData(withDividend(), '/ledger?type=dividend&account=alpha')
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))
    expect(router.state.location.search).not.toEqual({})

    await pickType(user, 'Achat')

    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    expect(router.state.location.search).toEqual({})
  })

  it('keeps Importer, Exporter and the one filled Saisir un événement on the control line', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // The row the search field sits in, and not the wrapper that also holds the table.
    const line = screen.getByRole('searchbox').closest('div.flex-wrap')
    expect(line).toBeTruthy()
    const inside = within(line as HTMLElement)
    expect(inside.getByRole('link', { name: 'Importer' })).toBeInTheDocument()
    expect(inside.getByRole('button', { name: 'Exporter' })).toBeInTheDocument()
    expect(inside.getByRole('button', { name: 'Saisir un événement' })).toHaveAttribute(
      'data-variant',
      'primary',
    )
  })

  it('says no count, draws no pill and keeps no summary line', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(screen.queryByText(/\d+ événements?( filtrés?)?$/)).not.toBeInTheDocument()
    await pickType(user, 'Achat')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    expect(screen.queryByText(/\d+ événements? filtrés?/)).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Filtres actifs' })).not.toBeInTheDocument()
    // The status region is there for the selection, and says nothing yet.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('names the set of securities a gesture reduced the ledger to, and lets go of it', async () => {
    const { user, router } = renderData(ledgerEvents(), '/ledger?symbol=ZZA')
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))

    // A reduction no control types into: the control line names it, once.
    await user.click(
      screen.getByRole('button', { name: /^Retirer ce filtre : Réduit à un titre : ZZA/ }),
    )
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
    expect(router.state.location.search).toEqual({})
  })
})

describe('the ledger reveals by packets, and only the first flight is silent', () => {
  it('draws forty of a hundred and seventy-six, without a spinner or a sentence', async () => {
    renderData(aLongLedger(176))
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // Forty rows, and the sentence under them counts rows the app **already
    // holds**: `GET /api/events` answered once, from the published snapshot in
    // process memory, and handed back the ledger entire.
    expect(rowsOf(ledger())).toHaveLength(40)
    expect(screen.queryByText(/sur 176/)).not.toBeInTheDocument()
    // No button: the next packet comes with the scroll.
    expect(screen.queryByRole('button', { name: 'Afficher la suite' })).not.toBeInTheDocument()
    // The end is not said before the last row has arrived.
    expect(screen.queryByText(/Fin du grand livre/)).not.toBeInTheDocument()
    // And there is no wait to dress, so nothing dresses one.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('adds forty each time the sentinel under the table comes into view', async () => {
    renderData(aLongLedger(85))
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    reachTheEnd()
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(80))

    reachTheEnd()
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(85))
    // Nothing left to reveal, so a further scroll reveals nothing.
    reachTheEnd()
    expect(rowsOf(ledger())).toHaveLength(85)
  })

  it('starts the reveal over when a filter moves', async () => {
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

    reachTheEnd()
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(80))

    // The chips are a reduction, so both sentences are true of what survives
    // them — and the budget starts over, or a reader asking a question would
    // get every row answering it at once.
    await pickType(user, 'Achat')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(40))

    await pickType(user, 'Versement')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))
  })
})

describe('a reduction in force always has the way out', () => {
  it('keeps the account filter after the rows naming that account are deleted', async () => {
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

    await pick(user, 'Compte', 'Beta')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))

    await user.click(within(rowsOf(ledger())[0]).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Supprimer' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Supprimer' }),
    )

    // The reduction survives the re-read, so the way out has to survive it too.
    const after = await openMenu(user, 'Compte')
    expect(within(after).getByRole('option', { name: 'Beta' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await user.click(within(after).getByRole('option', { name: 'Tous les comptes' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
  })
})

describe('deleting the ticked rows (#1113)', () => {
  function rowBox(table: HTMLElement, index: number) {
    return within(rowsOf(table)[index]).getByRole('checkbox')
  }

  it('shows no delete control with nothing ticked, and no string on the page says “réduction”', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // **No destructive control exists on the page** until a row is ticked
    // (#1278): the row's own removal is the only thing named *Supprimer*.
    expect(screen.queryByRole('button', { name: 'Supprimer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Supprimer la sélection/ })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/réduction/i)

    // The reduced wordings only render under a filter.
    await pickType(user, 'Achat')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    expect(document.body.textContent).not.toMatch(/réduction/i)
  })

  it('shows the count, Supprimer and Désélectionner once a row is ticked', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Désélectionner' })).not.toBeInTheDocument()

    await user.click(rowBox(ledger(), 0))
    expect(screen.getByText('1 sélectionné')).toBeInTheDocument()
    await user.click(rowBox(ledger(), 2))

    const line = screen.getByText('2 sélectionnés').closest('[role="status"]') as HTMLElement
    expect(within(line).getByRole('button', { name: 'Supprimer' })).toBeInTheDocument()
    expect(within(line).getByRole('button', { name: 'Désélectionner' })).toBeInTheDocument()
  })

  it('clears the selection from Désélectionner', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(rowBox(ledger(), 0))
    await user.click(rowBox(ledger(), 1))
    await user.click(screen.getByRole('button', { name: 'Désélectionner' }))

    expect(rowBox(ledger(), 0)).not.toBeChecked()
    expect(rowBox(ledger(), 1)).not.toBeChecked()
    expect(screen.queryByRole('button', { name: 'Supprimer' })).not.toBeInTheDocument()
    expect(screen.queryByText(/sélectionnés?$/)).not.toBeInTheDocument()
    // The button that was pressed is gone: the status region takes the focus.
    expect(document.activeElement).toHaveAttribute('role', 'status')
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
    await user.click(screen.getByRole('button', { name: 'Supprimer' }))

    const box = await screen.findByRole('alertdialog')
    expect(
      within(box).getByRole('heading', { name: 'Supprimer les 2 événements sélectionnés ?' }),
    ).toBeInTheDocument()
    await user.click(within(box).getByRole('button', { name: 'Supprimer' }))

    await waitFor(() => expect(asked).toEqual({ search: '', body: { ids: ['1', '3'] } }))
    expect(await screen.findByText('2 événements supprimés.')).toBeInTheDocument()
    // The selection is spent, and the control that consumed it leaves with it.
    expect(screen.queryByRole('button', { name: 'Supprimer' })).not.toBeInTheDocument()
    expect(screen.queryByText(/sélectionnés/)).not.toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toHaveAttribute('role', 'status'))
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
    await user.click(screen.getByRole('button', { name: 'Supprimer' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Annuler' }),
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

    await pickType(user, 'Achat')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(40))

    await user.click(
      screen.getByRole('checkbox', { name: 'Sélectionner les 120 événements filtrés' }),
    )
    expect(screen.getByText('120 sélectionnés')).toBeInTheDocument()

    // Revealing more shows the new rows already ticked.
    reachTheEnd()
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(80))
    expect(rowBox(ledger(), 79)).toBeChecked()
  })

  it('drops a ticked row a filter hides from the count, and ticks it again when lifted', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(rowBox(ledger(), 0))
    await user.click(rowBox(ledger(), 2))
    expect(screen.getByText('2 sélectionnés')).toBeInTheDocument()

    // Row 2 is the deposit; filtering on purchases hides it.
    await pickType(user, 'Achat')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    expect(screen.getByText('1 sélectionné')).toBeInTheDocument()

    // Cancelled here: what is sent is checked in the next case.
    await pickType(user, 'Tous les types')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(4))
    expect(rowBox(ledger(), 2)).toBeChecked()
    expect(screen.getByText('2 sélectionnés')).toBeInTheDocument()
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
    await pickType(user, 'Achat')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(2))
    // The deposit is ticked but hidden: nothing shown is ticked.
    expect(
      screen.getByRole('checkbox', { name: 'Sélectionner les 2 événements filtrés' }),
    ).toHaveAttribute('data-state', 'unchecked')

    await user.click(rowBox(ledger(), 0))
    await user.click(screen.getByRole('button', { name: 'Supprimer' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Supprimer' }),
    )
    await waitFor(() => expect(asked).toEqual({ ids: ['1'] }))
  })

  it('says nothing of a “reduction” under a filter, in English too', async () => {
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload())))
    const { user } = renderApp({ url: '/ledger', browserLanguages: ['en-GB'] })
    await screen.findByRole('table', { name: 'Your events' })

    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    await pickType(user, 'Buy')
    await waitFor(() => expect(rowsOf(screen.getByRole('table'))).toHaveLength(2))
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
    await user.click(screen.getByRole('button', { name: 'Supprimer' }))
    const box = await screen.findByRole('alertdialog')
    expect(within(box).queryByText(/Vider le grand livre/)).not.toBeInTheDocument()
    await user.click(within(box).getByRole('button', { name: 'Supprimer' }))

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
    await user.click(screen.getByRole('button', { name: 'Supprimer' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Supprimer' }),
    )

    const box = await screen.findByRole('alertdialog')
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
    await user.click(screen.getByRole('button', { name: 'Supprimer' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Supprimer' }),
    )

    const box = await screen.findByRole('alertdialog')
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

    await user.click(within(ledger()).getByRole('button', { name: 'Zeta Gamma' }))

    // A grant: a quantity, an optional price, and no fee field at all.
    expect(await screen.findByLabelText('Quantité')).toHaveValue('2')
    expect(screen.getByRole('tab', { name: 'Attribution' })).toHaveAttribute(
      'aria-selected',
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

    const row = within(ledger()).getByText('Zeta Gamma').closest('tr') as HTMLElement
    await user.click(within(row).getAllByRole('cell')[1])

    expect(await screen.findByLabelText('Quantité')).toHaveValue('2')
    expect(screen.getByRole('tab', { name: 'Attribution' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })
})

/** Opens the sheet on the row named `name`, asks for its removal, returns the box. */
async function askToRemove(user: ReturnType<typeof renderApp>['user'], name = 'Zeta Gamma') {
  await user.click(within(ledger()).getByRole('button', { name }))
  const sheet = await screen.findByRole('dialog')
  await user.click(within(sheet).getByRole('button', { name: 'Supprimer cet événement' }))
  return screen.findByRole('alertdialog', { name: 'Supprimer cet événement ?' })
}

describe('a row is removed at the unit', () => {
  it('offers the deletion in the sheet of a row, and names the row in the box', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const box = await askToRemove(user)
    expect(
      within(box).getByRole('heading', { name: 'Supprimer cet événement ?' }),
    ).toBeInTheDocument()
    // What names a row is what the row shows — its type, its identity, its day
    // — and never its key: a ledger row has no address.
    expect(within(box).getByText(/24 déc\. 2025 · Attribution ZZC/)).toBeInTheDocument()
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

    await user.click(within(await askToRemove(user)).getByRole('button', { name: 'Supprimer' }))

    await waitFor(() => expect(asked).toBe('typed-1'))
    expect(await screen.findByText('1 événement supprimé.')).toBeInTheDocument()
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))
  })

  it('closes the sheet once the row is deleted', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    server.use(
      http.delete(`${ROUTES.events}/:id`, ({ params }) =>
        HttpResponse.json({ id: String(params.id), removed: true }),
      ),
    )
    await user.click(within(await askToRemove(user)).getByRole('button', { name: 'Supprimer' }))

    await waitFor(() =>
      expect(screen.queryByRole('tablist', { name: 'Ce qui s’est passé' })).not.toBeInTheDocument(),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('goes back to the sheet when the box is dismissed', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(within(await askToRemove(user)).getByRole('button', { name: 'Annuler' }))

    expect(await screen.findByRole('tablist', { name: 'Ce qui s’est passé' })).toBeInTheDocument()
  })

  it('offers no deletion in the sheet of a new event', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await openTheForm(user)
    await user.click(screen.getByRole('tab', { name: 'Achat' }))

    expect(screen.getByRole('button', { name: 'Annuler' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Supprimer cet événement' }),
    ).not.toBeInTheDocument()
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

    await user.click(within(await askToRemove(user)).getByRole('button', { name: 'Supprimer' }))

    const box = await screen.findByRole('alertdialog')
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

    await user.click(within(await askToRemove(user)).getByRole('button', { name: 'Supprimer' }))

    const box = await screen.findByRole('alertdialog')
    expect(await within(box).findByRole('status')).toHaveTextContent(
      'Cet événement n’est plus dans le grand livre : il a été supprimé ailleurs, ' +
        'et rien n’a été modifié ici.',
    )
    // Not the generic sentence, which is the whole point of the second key.
    expect(within(box).queryByText(/n’existe pas/)).not.toBeInTheDocument()

    // The table is `aria-hidden` under the overlay, so what the re-read bought
    // is read where the reader reads it: the box comes down on a ledger that
    // no longer shows the row it was about.
    await user.click(within(box).getByRole('button', { name: 'Annuler' }))
    // The sheet the box was asked from is still up, and modal.
    await user.click(await screen.findByRole('button', { name: 'Annuler' }))
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(3))
  })
})

describe('the create form, which is the onboarding', () => {
  it('opens on Achat, with six tabs that state their effect', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const types = await openTheForm(user)

    expect(
      within(types)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Achat', 'Vente', 'Attribution', 'Dividende', 'Versement', 'Retrait'])
    expect(within(types).getByRole('tab', { name: 'Achat' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // Six codes are a decoding exercise at the exact moment nothing is there to
    // decode them against.
    for (const code of ['BUY', 'SELL', 'GRANT', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL']) {
      expect(within(types).queryByRole('tab', { name: code })).not.toBeInTheDocument()
    }
    // The fields of an Achat are already there, and the date is today's.
    expect(screen.getByLabelText('Quantité')).toBeInTheDocument()
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('changes shape with the type, which a row edited in place cannot', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)

    await user.click(screen.getByRole('tab', { name: 'Achat' }))
    expect(await screen.findByLabelText('Titre')).toBeInTheDocument()
    expect(screen.getByLabelText('Quantité')).toBeInTheDocument()
    expect(screen.getByLabelText('Prix unitaire')).toBeInTheDocument()
    expect(screen.getByLabelText('Frais')).toBeInTheDocument()
    expect(screen.queryByLabelText('Montant')).not.toBeInTheDocument()

    // A transfer names no security at all — not a missing one, none.
    await user.click(screen.getByRole('tab', { name: 'Versement' }))
    expect(await screen.findByLabelText('Montant')).toBeInTheDocument()
    expect(screen.getByLabelText('Frais')).toBeInTheDocument()
    expect(screen.queryByLabelText('Titre')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Quantité')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Prix unitaire')).not.toBeInTheDocument()

    // A dividend: an amount and a fee, on a security.
    await user.click(screen.getByRole('tab', { name: 'Dividende' }))
    expect(await screen.findByLabelText('Titre')).toBeInTheDocument()
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
    expect(within(panel).getByRole('tablist', { name: 'Ce qui s’est passé' })).toBeInTheDocument()
  })

  it('carries no ⓘ: the sheet states its fields and explains none', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await openTheForm(user)
    await user.click(screen.getByRole('tab', { name: 'Attribution' }))

    await screen.findByLabelText('Prix unitaire')
    expect(screen.queryAllByRole('button', { name: /^Ce que veut dire/ })).toHaveLength(0)
    expect(screen.queryByText(/se calculent à partir de ces dates/)).not.toBeInTheDocument()
  })

  it('marks a grant’s price as optional, in the label and with no sentence', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('tab', { name: 'Attribution' }))

    // A purchase's price is required, a grant's is not.
    const panel = screen.getByRole('dialog')
    const label = await within(panel).findByText('Prix unitaire')
    expect(label.parentElement).toHaveTextContent('facultatif')
    expect(screen.queryByText(/ajoute seulement des titres/)).not.toBeInTheDocument()
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
    await user.click(screen.getByRole('tab', { name: 'Attribution' }))

    fireEvent.change(await screen.findByLabelText('Date'), {
      target: { value: '2026-02-28' },
    })
    await user.type(screen.getByLabelText('Titre'), 'ZZA')

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
    await user.click(screen.getByRole('tab', { name: 'Attribution' }))

    fireEvent.change(await screen.findByLabelText('Date'), {
      target: { value: '2026-02-28' },
    })
    await user.type(screen.getByLabelText('Titre'), 'ZZA')

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

    await user.click(within(ledger()).getByRole('button', { name: 'Zeta Alpha' }))
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
    await user.click(screen.getByRole('tab', { name: 'Attribution' }))

    fireEvent.change(await screen.findByLabelText('Date'), {
      target: { value: '2026-02-28' },
    })
    const ticker = screen.getByLabelText('Titre')
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
    await user.click(screen.getByRole('tab', { name: 'Achat' }))

    fireEvent.change(await screen.findByLabelText('Date'), {
      target: { value: '2026-02-28' },
    })
    await user.type(screen.getByLabelText('Titre'), 'ZZA')

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

    await user.click(within(ledger()).getByRole('button', { name: 'Zeta Alpha' }))

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

    await user.click(within(ledger()).getByRole('button', { name: 'Zeta Gamma' }))
    expect(await screen.findByLabelText('Quantité')).toHaveValue('2')
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))

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
    const alive = within(ledger()).getByTitle('ZZA · Versement programmé mensuel').closest('tr')
    await user.click(within(alive as HTMLElement).getAllByRole('cell')[1])
    expect(await screen.findByLabelText('Quantité')).toHaveValue('3')
    expect(screen.queryByText(/n’est plus dans le grand livre/)).not.toBeInTheDocument()
  })

  it('forgets a refused save once the row is deleted from the same panel', async () => {
    // The removal closes the panel from outside, so it is a way out that never
    // goes through the cancel button's reset (#1264).
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    server.use(
      http.patch(`${ROUTES.events}/:id`, () =>
        HttpResponse.json(
          { status: 404, type: PROBLEM_TYPES.entryGone, title: 'Event no longer in the ledger' },
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
      http.delete(`${ROUTES.events}/:id`, ({ params }) =>
        HttpResponse.json({ id: String(params.id), removed: true }),
      ),
    )

    await user.click(within(ledger()).getByRole('button', { name: 'Zeta Gamma' }))
    await user.click(await screen.findByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByText(/n’est plus dans le grand livre/)).toBeInTheDocument()

    const sheet = screen.getByRole('dialog')
    await user.click(within(sheet).getByRole('button', { name: 'Supprimer cet événement' }))
    const box = await screen.findByRole('alertdialog', { name: 'Supprimer cet événement ?' })
    await user.click(within(box).getByRole('button', { name: 'Supprimer' }))
    await waitFor(() =>
      expect(screen.queryByRole('tablist', { name: 'Ce qui s’est passé' })).not.toBeInTheDocument(),
    )

    await user.click(within(ledger()).getAllByRole('button', { name: 'Zeta Alpha' })[0])
    expect(await screen.findByLabelText('Quantité')).toBeInTheDocument()
    expect(screen.queryByText(/n’est plus dans le grand livre/)).not.toBeInTheDocument()
  })

  it('records the event and puts it in the ledger', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)

    await user.click(screen.getByRole('tab', { name: 'Versement' }))
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

    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByText('Virement de février')).toBeInTheDocument()
  })

  it('never silently discards a date it cannot read', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('tab', { name: 'Versement' }))
    await user.type(await screen.findByLabelText('Montant'), '250')

    // `31/02/2026` is what a reader types where the widget degrades to text, and
    // the field hands back an **empty string** for it — which one line later is
    // indistinguishable from *left blank*. The form says so beside the field and
    // records nothing, rather than posting an event with no date.
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '31/02/2026' } })
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))

    expect(await screen.findByText(/Sans date lisible, rien n’est enregistré/)).toBeInTheDocument()
    expect(screen.getByLabelText('Date')).toHaveAttribute('aria-invalid', 'true')
    // The panel is still open, and no row joined the ledger.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('names a number it cannot read rather than sending a hole', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('tab', { name: 'Versement' }))

    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-02-20' } })
    await user.type(screen.getByLabelText('Montant'), 'deux cents')
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByText('Ce n’est pas un nombre.')).toBeInTheDocument()
  })

  it('says on the field that an amount is above zero, before the round trip (#1395)', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    await user.click(screen.getByRole('tab', { name: 'Versement' }))

    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-02-20' } })
    await user.type(screen.getByLabelText('Montant'), '-100')
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(
      await screen.findByText('Ce champ attend un nombre supérieur à zéro.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Montant')).toHaveAttribute('aria-invalid', 'true')
  })

  it('marks the field the server refused, by the key it names (#1395)', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    server.use(
      http.post(ROUTES.events, () =>
        HttpResponse.json(
          {
            status: 422,
            type: PROBLEM_TYPES.badRequest,
            title: 'Invalid request',
            key: 'amount',
            detail: 'amount must be positive for DEPOSIT',
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    await openTheForm(user)
    await user.click(screen.getByRole('tab', { name: 'Versement' }))

    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-02-20' } })
    await user.selectOptions(screen.getByLabelText('Compte'), 'alpha')
    await user.type(screen.getByLabelText('Montant'), '100')
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByText('L’application a refusé cette valeur.')).toBeInTheDocument()
    expect(screen.getByLabelText('Montant')).toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.queryByText('L’application a refusé la requête faite par cette page.'),
    ).not.toBeInTheDocument()
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
    expect(within(file).getByRole('button', { name: 'Importer' })).toBeInTheDocument()
    expect(
      within(file).getByRole('link', { name: 'Le format, colonne par colonne' }),
    ).toBeInTheDocument()

    // Neither entry is the recommended one.
    const action = within(manual).getByRole('button', { name: 'Saisir un événement' })
    expect(action).toHaveAttribute('data-variant', 'outline')

    await user.click(action)
    expect(await screen.findByRole('tablist', { name: 'Ce qui s’est passé' })).toBeInTheDocument()
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
    const { user } = renderApp({ url: '/ledger', browserLanguages: ['en-GB'] })

    const table = await screen.findByRole('table', { name: 'Your events' })
    expect(columnNames(table)).toEqual([
      '',
      'Date',
      'Type',
      'Event',
      'Quantity',
      'Unit price',
      'Amount',
      'Account',
    ])
    // `Free shares`, `Cash in`, `Cash out` — the effect, not the six codes at a
    // difference of case.
    expect(within(table).getByText('Cash in')).toBeInTheDocument()
    expect(within(table).getByText('Free shares')).toBeInTheDocument()
    // The filters speak English too, and the English is the source.
    expect(optionNames(await openMenu(user, 'Type'))[0]).toBe('All types')
  })
})

// --------------------------------------------------------------------------- //
// The ticker field suggests what the ledger already names (#1036)
// --------------------------------------------------------------------------- //

/** La liste des suggestions, une fois quelque chose tapé dans le champ Titre. */
function suggestions() {
  return screen.getByRole('listbox', { name: 'Titres de votre grand livre, puis de Yahoo Finance' })
}

/** Ses entrées, dans l'ordre où elles sont dessinées. */
function lines() {
  return within(suggestions()).getAllByRole('option')
}

/** Le panneau ouvert sur un achat, et son champ Titre. */
async function openOnABuy(user: ReturnType<typeof renderApp>['user']) {
  await openTheForm(user)
  await user.click(screen.getByRole('tab', { name: 'Achat' }))
  return screen.getByLabelText('Titre')
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
    // A title the ledger names: a free ticker now stops at the confirmation
    // (#1268), and this test is about the key, not about that stop.
    await user.type(field, 'ZZA')
    await user.type(field, '{Enter}')

    await waitFor(() => expect(recorded).not.toBeNull())
    expect(recorded).toMatchObject({ symbol: 'ZZA', event_type: 'BUY' })
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
    await user.click(screen.getByRole('tab', { name: 'Achat' }))
    const field = screen.getByLabelText('Titre')
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
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled()

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
    await user.click(screen.getByRole('tab', { name: 'Attribution' }))

    fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-02-28' } })
    const field = screen.getByLabelText('Titre')
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
      await user.click(screen.getByRole('tab', { name: type }))
      const field = screen.getByLabelText('Titre')
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

    await user.click(within(ledger()).getByRole('button', { name: 'Zeta Gamma' }))

    expect(await screen.findByLabelText('Titre')).toHaveValue('ZZC')
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
    await user.click(screen.getByRole('tab', { name: 'Buy' }))
    const field = screen.getByLabelText('Security')

    await user.type(field, 'zza')
    expect(
      screen.getByRole('listbox', { name: 'Securities from your ledger, then from Yahoo Finance' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Your ledger already names ZZA/)).toBeInTheDocument()

    await user.clear(field)
    await user.type(field, 'NVDA')
    expect(screen.getByRole('option', { name: 'Use “NVDA”' })).toBeInTheDocument()
  })
})

// --------------------------------------------------------------------------- //
// The refusal is brought into view, and a free ticker is confirmed (#1268)
// --------------------------------------------------------------------------- //

const OVERSELL = {
  status: 409,
  type: PROBLEM_TYPES.unreplayableLedger,
  title: 'Ledger does not replay',
  detail: 'Cannot sell 5.0 shares of ZZA (only 0.0 owned) on 2026-02-20',
  gesture: 'write',
  symbol: 'ZZA',
  wanted: 5,
  owned: 0,
  day: '2026-02-20',
}

/** The answer of `GET /api/securities`, whatever was asked. */
function yahooAnswers(
  securities: { symbol: string; name: string | null; exchange: string | null }[] | null,
) {
  const asked: string[] = []
  server.use(
    http.get(ROUTES.securities, ({ request }) => {
      const query = new URL(request.url).searchParams.get('q') ?? ''
      asked.push(query)
      return HttpResponse.json({ query, securities })
    }),
  )
  return asked
}

const ZZY = { symbol: 'ZZY', name: 'Zeta Yankee', exchange: 'Paris' }

/** A purchase, filled but for the ticker — which each case types its own way. */
async function fillABuy(user: ReturnType<typeof renderApp>['user']) {
  await waitFor(() => expect(ledger()).toBeInTheDocument())
  const field = await openOnABuy(user)
  fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2026-02-20' } })
  await user.selectOptions(screen.getByLabelText('Compte'), 'alpha')
  await user.type(screen.getByLabelText('Quantité'), '5')
  await user.type(screen.getByLabelText('Prix unitaire'), '120')
  return field
}

function save(user: ReturnType<typeof renderApp>['user']) {
  return user.click(screen.getByRole('button', { name: 'Enregistrer' }))
}

/** Every POST the form makes, as the body it sent. */
function recordPosts() {
  const posted: Record<string, unknown>[] = []
  server.use(
    http.post(ROUTES.events, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      posted.push(body)
      return HttpResponse.json(aTypedEvent({ id: 'created' }), { status: 201 })
    }),
  )
  return posted
}

const UNKNOWN = /Ce ticker n’est pas dans votre grand livre/

describe('a refusal brought into view', () => {
  it('moves focus to the refusal when the server refuses the save', async () => {
    server.use(
      http.post(ROUTES.events, () =>
        HttpResponse.json(OVERSELL, {
          status: 409,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
      ),
    )
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    const { user } = renderData()
    const field = await fillABuy(user)
    await user.type(field, 'ZZA')

    await save(user)

    const refusal = await within(screen.getByRole('dialog')).findByRole('status')
    expect(refusal).toHaveTextContent(/vend 5 parts de ZZA/)
    await waitFor(() => expect(refusal).toHaveFocus())
    // The native scroll is the point: nothing may ask the browser not to.
    const onRefusal = focus.mock.calls.filter(
      (_call, index) => focus.mock.contexts[index] === refusal,
    )
    expect(onRefusal.length).toBeGreaterThan(0)
    expect(onRefusal.some(([options]) => options?.preventScroll)).toBe(false)
    focus.mockRestore()
  })

  it('focuses the refusal again when a second save is refused', async () => {
    let refused = 0
    server.use(
      http.post(ROUTES.events, () => {
        refused += 1
        return HttpResponse.json(OVERSELL, {
          status: 409,
          headers: { 'Content-Type': 'application/problem+json' },
        })
      }),
    )
    const { user } = renderData()
    const field = await fillABuy(user)
    await user.type(field, 'ZZA')
    await save(user)
    const dialog = screen.getByRole('dialog')
    await waitFor(async () => expect(await within(dialog).findByRole('status')).toHaveFocus())

    // The reader goes back to the quantity, and presses save once more.
    await user.click(screen.getByLabelText('Quantité'))
    expect(within(dialog).queryByRole('status')).not.toHaveFocus()
    await save(user)

    await waitFor(() => expect(refused).toBe(2))
    await waitFor(async () => expect(await within(dialog).findByRole('status')).toHaveFocus())
  })

  it('moves focus to the first field it could not read', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openOnABuy(user)

    await save(user)
    // The date is today's from the start, so the account is the first to answer.
    expect(await screen.findByLabelText('Compte')).toHaveFocus()

    // The account answered: the next one in the order drawn.
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-02-20' } })
    await user.selectOptions(screen.getByLabelText('Compte'), 'alpha')
    await user.type(screen.getByLabelText('Titre'), 'ZZA')
    await save(user)
    expect(screen.getByLabelText('Quantité')).toHaveFocus()
  })
})

describe('a ticker the ledger does not name', () => {
  it('asks to confirm a ticker the ledger does not name, and posts nothing', async () => {
    const posted = recordPosts()
    const { user } = renderData()
    const field = await fillABuy(user)
    await user.type(field, 'ZZQ')

    await save(user)

    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: 'Enregistrer ZZQ sans cours connu' }),
    ).not.toBeChecked()
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(posted).toEqual([])
  })

  it('saves a confirmed free ticker, and forgets the confirmation when the ticker changes', async () => {
    const posted = recordPosts()
    const { user } = renderData()
    const field = await fillABuy(user)
    await user.type(field, 'ZZQ')
    await save(user)
    await user.click(
      await screen.findByRole('checkbox', { name: 'Enregistrer ZZQ sans cours connu' }),
    )
    expect(screen.queryByText(UNKNOWN)).not.toBeInTheDocument()
    // Ticked, the control stays: it is the reader's answer, and it is visible.
    expect(screen.getByRole('checkbox', { name: 'Enregistrer ZZQ sans cours connu' })).toBeChecked()

    // Another ticker is another question.
    await user.type(field, 'R')
    await save(user)
    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: 'Enregistrer ZZQR sans cours connu' }),
    ).not.toBeChecked()
    expect(posted).toEqual([])

    await user.click(screen.getByRole('checkbox', { name: 'Enregistrer ZZQR sans cours connu' }))
    await save(user)
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ symbol: 'ZZQR', name: null })
  })

  it('offers the ledger title the typed ticker starts', async () => {
    const { user } = renderData()
    const field = await fillABuy(user)
    await user.type(field, 'ZZ')
    await save(user)

    await user.click(await screen.findByRole('button', { name: 'Vouliez-vous dire ZZA ?' }))

    expect(field).toHaveValue('ZZA')
    expect(screen.queryByText(UNKNOWN)).not.toBeInTheDocument()
  })

  it('does not count the use-what-I-typed line as a pick', async () => {
    const posted = recordPosts()
    const { user } = renderData()
    const field = await fillABuy(user)
    await user.type(field, 'ZZQ')
    await user.click(await screen.findByRole('option', { name: 'Utiliser « ZZQ »' }))
    expect(field).toHaveValue('ZZQ')

    await save(user)

    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument()
    expect(posted).toEqual([])
  })

  it('still asks for a ticker typed to match a Yahoo line without picking it', async () => {
    yahooAnswers([ZZY])
    const posted = recordPosts()
    const { user } = renderData()
    const field = await fillABuy(user)
    await user.type(field, 'ZZY')
    // Yahoo knows it, and the reader did not take the line.
    await screen.findByRole('option', { name: /ZZY/ })

    await save(user)

    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument()
    expect(posted).toEqual([])
  })
})

describe('the ticker search', () => {
  it('finds a ledger title by its name', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zeta alpha')

    expect(lines().map((line) => line.textContent)).toEqual(['ZZAZeta Alpha'])
  })

  it('lists Yahoo lines after the ledger’s, without repeating a title the ledger names', async () => {
    yahooAnswers([{ symbol: 'ZZA', name: 'Zeta Alpha Inc', exchange: 'NYSE' }, ZZY])
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zeta')

    await screen.findByRole('option', { name: /ZZY/ })
    expect(lines().map((line) => line.textContent)).toEqual([
      'ZZAZeta Alpha',
      'ZZCZeta Gamma',
      'ZZYZeta Yankee · Paris',
    ])
  })

  it('saves a ticker picked from a Yahoo line without asking, with its name', async () => {
    yahooAnswers([ZZY])
    const posted = recordPosts()
    const { user } = renderData()
    const field = await fillABuy(user)
    await user.type(field, 'zeta')
    await user.click(await screen.findByRole('option', { name: /ZZY/ }))
    expect(field).toHaveValue('ZZY')

    await save(user)

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ symbol: 'ZZY', name: 'Zeta Yankee' })
    expect(screen.queryByText(UNKNOWN)).not.toBeInTheDocument()
  })

  it('asks Yahoo once per pause, and not before two characters', async () => {
    const asked = yahooAnswers([])
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'z')
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(asked).toEqual([])

    await user.type(field, 'eta')
    await waitFor(() => expect(asked).toEqual(['zeta']))
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(asked).toEqual(['zeta'])
  })

  it('says Yahoo is not answering and still offers the ledger’s titles', async () => {
    yahooAnswers(null)
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')

    expect(await screen.findByText(/Yahoo Finance ne répond pas/)).toBeInTheDocument()
    expect(field).toHaveAccessibleDescription(/Yahoo Finance ne répond pas/)
    expect(lines().map((line) => line.textContent)).toEqual(['ZZAZeta Alpha', 'ZZCZeta Gamma'])
  })

  it('says nothing about Yahoo while its answer is in flight', async () => {
    // The route is out of the in-flight net (#775 against #729), so this is
    // where its silence is proven.
    let answer: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      answer = resolve
    })
    let asked = 0
    server.use(
      http.get(ROUTES.securities, async () => {
        asked += 1
        await pending
        return HttpResponse.json({ query: 'zz', securities: null })
      }),
    )
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const field = await openOnABuy(user)

    await user.type(field, 'zz')

    // The request is really out, and still unanswered.
    await waitFor(() => expect(asked).toBe(1))
    expect(screen.queryByText(/Yahoo Finance ne répond pas/)).not.toBeInTheDocument()
    // The ledger's lines are there all along.
    expect(lines()).toHaveLength(2)

    answer()
    expect(await screen.findByText(/Yahoo Finance ne répond pas/)).toBeInTheDocument()
  })

  it('keeps the name of an imported row it edits', async () => {
    let sent: Record<string, unknown> | null = null
    server.use(
      http.patch(`${ROUTES.events}/:id`, async ({ params, request }) => {
        sent = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(aTypedEvent({ id: String(params.id) }))
      }),
    )
    const { user } = renderData([anEvent({ id: 'imp', name: 'Zeta Alpha Imported' })])
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(within(ledger()).getByRole('button', { name: 'Zeta Alpha Imported' }))
    await screen.findByLabelText('Quantité')
    await save(user)

    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent).toMatchObject({ symbol: 'ZZA', name: 'Zeta Alpha Imported' })
  })
})

describe('the ledger on a phone (#1339)', () => {
  const list = () => screen.getByRole('list', { name: 'Vos événements' })
  const items = () => within(list()).getAllByRole('listitem')

  async function renderPhone(events: LedgerEvent[] = ledgerEvents()) {
    setViewportWidth(390)
    const view = renderData(events)
    await screen.findByRole('list', { name: 'Vos événements' })
    return view
  }

  it('is a list of forty items revealed forty at a time, with no table and no card', async () => {
    await renderPhone(aLongLedger(120))

    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(items()).toHaveLength(40)
    expect(list().closest('[data-slot="card"]')).toBeNull()
    // Every figure is `fig` (Geist Mono, tabular): no stray `font-mono` is left.
    expect(list().querySelectorAll('.font-mono')).toHaveLength(0)

    reachTheEnd()
    expect(items()).toHaveLength(80)
  })

  it('keeps the table, and no list, from 768 px up', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    expect(screen.queryByRole('list', { name: 'Vos événements' })).not.toBeInTheDocument()
  })

  it('shows the date, the type, the identity, the amount and the account of an item', async () => {
    await renderPhone([
      anEvent({ id: 'a', event_type: 'DIVIDEND', amount: 480, fee: null, account: 'alpha' }),
    ])

    const item = items()[0]
    expect(within(item).getByRole('button', { name: 'Zeta Alpha' })).toBeInTheDocument()
    // The ticker beside the name, outside the button (#1433).
    expect(within(item).getByText('ZZA')).toHaveClass('fig')
    expect(within(item).getByText('Dividende')).toBeInTheDocument()
    expect(within(item).getByText('Alpha')).toHaveAttribute('title', 'Alpha')
    expect(within(item).getByText(/480/)).toHaveClass('fig')
    expect(within(item).getByText(/2026/)).toBeInTheDocument()
    // Quantity, price, fee and the label under a ticker live in the form.
    expect(within(item).queryByText(/Ordre au marché/)).not.toBeInTheDocument()
  })

  it('shows the amount on a trade and a transfer, and `× quantity` on a grant (#1355, #1425)', async () => {
    await renderPhone([
      anEvent({ id: 'a', event_type: 'GRANT', quantity: 0.1661 }),
      anEvent({ id: 'b', event_type: 'DEPOSIT', symbol: null, name: null, amount: 100, fee: null }),
      anEvent({ id: 'c', quantity: 4, unit_price: 120, fee: 1.5 }),
    ])

    const [grant, deposit, buy] = items()
    expect(within(grant).getByText(/×\s0,1661/)).toHaveClass('text-muted-foreground')
    expect(within(grant).queryByText('—')).not.toBeInTheDocument()
    expect(within(deposit).getByText(/\+100,00/)).toBeInTheDocument()
    expect(within(buy).getByText(/481,50/)).toBeInTheDocument()
  })

  it('says quantity × price on a trade, and a chevron says the row opens (persona pass)', async () => {
    await renderPhone([anEvent({ id: 'c', quantity: 4, unit_price: 120, fee: 1.5 })])

    const [buy] = items()
    expect(within(buy).getByText(/4\s×\s120,00/)).toHaveClass('fig')
    expect(buy.querySelector('svg.lucide-chevron-right')).not.toBeNull()
  })

  it('hands the focus back to the row when Escape closes the sheet', async () => {
    const { user } = await renderPhone()
    const open = within(items()[0]).getByRole('button', { name: 'Zeta Alpha' })

    await user.click(open)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(open).toHaveFocus()
  })

  it('opens the editor from the identity, and not from the checkbox', async () => {
    const { user } = await renderPhone()

    await user.click(within(items()[0]).getByRole('checkbox'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('1 sélectionné')).toBeInTheDocument()

    await user.click(within(items()[0]).getByRole('button', { name: 'Zeta Alpha' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('leaves a row without an id inert', async () => {
    await renderPhone([anUnaddressableEvent()])

    const item = items()[0]
    expect(within(item).getByRole('checkbox')).toBeDisabled()
    expect(within(item).queryByRole('button')).not.toBeInTheDocument()
  })

  it('ticks the whole reduction from the head, and deletes it through the summary', async () => {
    const { user } = await renderPhone(aLongLedger(120))
    let asked: { ids: string[] } | null = null
    server.use(
      http.delete(ROUTES.events, async ({ request }) => {
        asked = (await request.json()) as { ids: string[] }
        return HttpResponse.json({ events_removed: 120 })
      }),
    )

    await user.click(
      screen.getByRole('checkbox', { name: 'Sélectionner les 120 événements filtrés' }),
    )
    expect(screen.getByText('120 sélectionnés')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Supprimer' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Supprimer' }),
    )
    await waitFor(() => expect(asked?.ids).toHaveLength(120))
  })

  it('carries two ticked rows from the phone to the table', async () => {
    const { user } = await renderPhone()
    await user.click(within(items()[0]).getByRole('checkbox'))
    await user.click(within(items()[2]).getByRole('checkbox'))

    act(() => setViewportWidth(1024))

    await waitFor(() => expect(ledger()).toBeInTheDocument())
    expect(screen.getByText('2 sélectionnés')).toBeInTheDocument()
    expect(within(ledger()).getAllByRole('checkbox', { checked: true })).toHaveLength(2)
  })

  it('lets a label-less, symbol-less transfer be opened, and names the label-only ones', async () => {
    const { user } = await renderPhone([
      anEvent({ id: 'blank', event_type: 'DEPOSIT', symbol: null, notes: null }),
      anEvent({ id: 'label', event_type: 'DEPOSIT', symbol: null, notes: 'Incoming transfer' }),
    ])

    // Read before the dialog opens: it hides the page behind it.
    expect(within(items()[1]).getByRole('button', { name: 'Incoming transfer' })).toHaveAttribute(
      'title',
      'Incoming transfer',
    )
    await user.click(within(items()[0]).getByRole('button', { name: /Versement/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('reads the head checkbox as mixed, all, then none', async () => {
    const { user } = await renderPhone()
    const head = screen.getByRole('checkbox', { name: /^Sélectionner les 4 /u })

    await user.click(within(items()[0]).getByRole('checkbox'))
    expect(head).toHaveAttribute('data-state', 'indeterminate')
    await user.click(head)
    expect(head).toHaveAttribute('data-state', 'checked')
    expect(screen.getByText('4 sélectionnés')).toBeInTheDocument()
    await user.click(head)
    expect(head).toHaveAttribute('data-state', 'unchecked')
    expect(screen.queryByText(/sélectionnés?$/)).not.toBeInTheDocument()
  })

  it('disables the head checkbox when no row can be ticked', async () => {
    await renderPhone([anUnaddressableEvent()])
    expect(screen.getByRole('checkbox', { name: 'Sélectionner l’événement filtré' })).toBeDisabled()
  })

  it('starts useIsMobile on the real width, before any effect', () => {
    setViewportWidth(390)
    const seen: boolean[] = []
    renderHook(() => {
      const value = useIsMobile()
      seen.push(value)
      return value
    })
    expect(seen[0]).toBe(true)
  })
})

describe('EventFigure (#1355, #1425)', () => {
  const draw = (event: LedgerEvent) =>
    render(
      <I18nProvider>
        <p data-testid="figure">
          <EventFigure event={event} currency="EUR" />
        </p>
      </I18nProvider>,
    ).getByTestId('figure')

  it('draws the cash an event moved, fees in, its direction in its sign', () => {
    // The sign and the digits, whatever the language the test runs in.
    const said = (event: LedgerEvent) => {
      const text = draw(event).textContent ?? ''
      cleanup()
      return text.replace(/[^\d+\-\u2212]/g, '').replace('\u2212', '-')
    }
    // 5 × 541,20 + 1,35: what left the account, as the server books it.
    expect(said(anEvent({ quantity: 5, unit_price: 541.2, fee: 1.35 }))).toBe('-270735')
    expect(said(anEvent({ event_type: 'SELL', quantity: 5, unit_price: 541.2, fee: 1.35 }))).toBe(
      '+270465',
    )
    expect(said(anEvent({ event_type: 'DEPOSIT', amount: 100, fee: null }))).toBe('+10000')
    expect(said(anEvent({ event_type: 'WITHDRAWAL', amount: 100, fee: 2 }))).toBe('-10200')
    expect(said(anEvent({ event_type: 'DIVIDEND', amount: 10, fee: 1.5 }))).toBe('+850')
    // Never in colour: the sign is fixed by the type.
    const figure = draw(anEvent({ event_type: 'DIVIDEND', amount: 10 }))
    expect(figure.innerHTML).not.toMatch(/text-(gain|loss)/)
  })

  it('draws `× quantity` in muted text for a grant, which moves no cash', () => {
    const figure = draw(anEvent({ event_type: 'GRANT', quantity: 0.1661 }))
    expect(figure).toHaveTextContent(/^×\s0,1661$/)
    expect(figure.firstElementChild).toHaveClass('text-muted-foreground')
  })

  it('draws a dash, never `× —`, when the quantity is unknown', () => {
    expect(draw(anEvent({ event_type: 'GRANT', quantity: null }))).toHaveTextContent(/^—$/)
  })
})

describe('the effect line, which the server writes (#1461)', () => {
  /** The line, its spaces folded: `Intl` separates thousands with a narrow no-break space. */
  const said = () =>
    screen
      .queryByText(/liquidités/)
      ?.closest('p')
      ?.textContent?.replace(/\s/g, ' ')

  /** The dry run, answering `answer` and recording every body it was asked. */
  function previewing(answer: {
    cash_after: number
    amount: number
    fees: number
    realised?: number
  }) {
    const asked: Record<string, unknown>[] = []
    server.use(
      http.post(ROUTES.eventsPreview, async ({ request }) => {
        asked.push((await request.json()) as Record<string, unknown>)
        // The cases below state the move signed; the server answers a magnitude
        // and a direction.
        return HttpResponse.json({
          account: 'alpha',
          cash_before: answer.cash_after - answer.amount,
          cash_after: answer.cash_after,
          amount: Math.abs(answer.amount),
          fee: answer.fees,
          direction: answer.amount < 0 ? 'debit' : answer.amount > 0 ? 'credit' : 'none',
          realised_gain: answer.realised ?? null,
        })
      }),
    )
    return asked
  }

  async function fill(user: User, type: string, values: Record<string, string>) {
    await user.click(screen.getByRole('tab', { name: type }))
    await user.selectOptions(await screen.findByLabelText('Compte'), 'alpha')
    for (const [label, value] of Object.entries(values)) {
      await user.type(await screen.findByLabelText(label), value)
    }
  }

  async function openFresh() {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await openTheForm(user)
    return user
  }

  it('says a credit, with the cash left on the account', async () => {
    previewing({ cash_after: 1990, amount: 500, fees: 0 })
    const user = await openFresh()
    await fill(user, 'Versement', { Montant: '500' })
    await waitFor(() =>
      expect(said()).toBe('500,00 € arrivent sur le compte Alpha · liquidités 1 990,00 €'),
    )
  })

  it('says a debit, the fees in it, and the cash left', async () => {
    previewing({ cash_after: 1040, amount: -2707.35, fees: 1.35 })
    const user = await openFresh()
    await fill(user, 'Achat', {
      Titre: 'ZZA',
      Quantité: '5',
      'Prix unitaire': '541,20',
      Frais: '1,35',
    })
    await waitFor(() =>
      expect(said()).toBe(
        '2 707,35 € quittent le compte Alpha, dont 1,35 € de frais · liquidités 1 040,00 €',
      ),
    )
  })

  it('says only the cash when the write moves none', async () => {
    previewing({ cash_after: 1040, amount: 0, fees: 0 })
    const user = await openFresh()
    await fill(user, 'Attribution', { Titre: 'ZZA', Quantité: '2' })
    await waitFor(() =>
      expect(said()).toBe('+2 titres de ZZA sur le compte Alpha · liquidités 1 040,00 €'),
    )
  })

  it('shows what the server said and computes nothing itself', async () => {
    // The figures typed say 500, the server says 1: the line is the server's.
    previewing({ cash_after: 7, amount: 1, fees: 0 })
    const user = await openFresh()
    await fill(user, 'Versement', { Montant: '500' })
    await waitFor(() =>
      expect(said()).toBe('1,00 € arrivent sur le compte Alpha · liquidités 7,00 €'),
    )
  })

  it('asks nothing while a figure is missing or unreadable, and the typed fields once they read', async () => {
    const asked = previewing({ cash_after: 1000, amount: -20, fees: 0 })
    const user = await openFresh()
    await user.selectOptions(await screen.findByLabelText('Compte'), 'alpha')
    await user.type(screen.getByLabelText('Titre'), 'ZZA')
    await user.type(screen.getByLabelText('Quantité'), 'abc')
    await user.type(screen.getByLabelText('Prix unitaire'), '10')
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(asked).toEqual([])
    expect(said()).toBeUndefined()

    await user.clear(screen.getByLabelText('Quantité'))
    await user.type(screen.getByLabelText('Quantité'), '2')
    await waitFor(() => expect(asked).toHaveLength(1))
    expect(asked[0]).toMatchObject({
      event_type: 'BUY',
      account: 'alpha',
      symbol: 'ZZA',
      quantity: 2,
      unit_price: 10,
    })
    expect(asked[0]).not.toHaveProperty('id')
  })

  it('asks once the reader pauses, not at every keystroke', async () => {
    const asked = previewing({ cash_after: 1000, amount: 50, fees: 0 })
    const user = await openFresh()
    await fill(user, 'Versement', {})
    await user.type(await screen.findByLabelText('Montant'), '5')
    await user.type(screen.getByLabelText('Montant'), '0')

    await waitFor(() => expect(asked).toHaveLength(1))
    expect(asked[0]).toMatchObject({ event_type: 'DEPOSIT', amount: 50 })
  })

  it('is filled when a row is opened for edit, and names the row it replaces', async () => {
    const asked = previewing({ cash_after: 1040, amount: -2707.35, fees: 1.35 })
    const { user } = renderData([
      anEvent({ id: 'row-7', quantity: 5, unit_price: 541.2, fee: 1.35 }),
    ])
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await user.click(within(ledger()).getByRole('button', { name: 'Zeta Alpha' }))
    await screen.findByLabelText('Quantité')

    await waitFor(() => expect(said()).toMatch(/^2 707,35 € quittent le compte Alpha/))
    expect(asked[0]).toMatchObject({ id: 'row-7', quantity: 5, unit_price: 541.2, fee: 1.35 })
  })

  it('is a bare number while the base currency is unknown', async () => {
    previewing({ cash_after: 1990, amount: 500, fees: 0 })
    server.use(
      problemHandler(ROUTES.portfolioTotals, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    const user = await openFresh()
    await fill(user, 'Versement', { Montant: '500' })
    await waitFor(() =>
      expect(said()).toBe('500,00 arrivent sur le compte Alpha · liquidités 1 990,00'),
    )
  })

  it('says the loss a sale realises, before the save', async () => {
    previewing({ cash_after: 1500, amount: 492.06, fees: 0, realised: -50.49 })
    const user = await openFresh()
    await fill(user, 'Vente', { Titre: 'ZZA', Quantité: '1', 'Prix unitaire': '492,06' })
    await waitFor(() => expect(said()).toMatch(/moins-value de 50,49 €/))
  })

  /** The refusal the server gives the dry run, as `problem+json`. */
  function refusing(body: Record<string, unknown>, status: number) {
    server.use(
      http.post(ROUTES.eventsPreview, () =>
        HttpResponse.json(body, {
          status,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
      ),
    )
  }

  it('refuses a sale of shares the account does not hold, before « Enregistrer »', async () => {
    refusing(
      {
        status: 409,
        type: PROBLEM_TYPES.unreplayableLedger,
        title: 'Ledger does not replay',
        symbol: 'ZZA',
        wanted: 100,
        owned: 26,
        account: 'alpha',
      },
      409,
    )
    const user = await openFresh()
    await fill(user, 'Vente', { Titre: 'ZZA', Quantité: '100', 'Prix unitaire': '10' })

    expect(await screen.findByText(/n’en porte que 26/)).toBeInTheDocument()
  })

  it('refuses a withdrawal larger than the cash, before « Enregistrer »', async () => {
    refusing(
      {
        status: 422,
        type: PROBLEM_TYPES.badRequest,
        title: 'Invalid request',
        key: 'amount',
        code: 'overdraft',
      },
      422,
    )
    const user = await openFresh()
    await fill(user, 'Retrait', { Montant: '99999' })

    expect(
      await screen.findByText(/dépasse les liquidités que le compte détient/),
    ).toBeInTheDocument()
  })

  it('names an amount that is not a number, or not above zero, as it is typed', async () => {
    const user = await openFresh()
    await user.click(screen.getByRole('tab', { name: 'Versement' }))
    const amount = await screen.findByLabelText('Montant')

    await user.type(amount, 'abc')
    expect(await screen.findByText('Ce n’est pas un nombre.')).toBeInTheDocument()
    await user.clear(amount)
    await user.type(amount, '-50')
    expect(await screen.findByText(/supérieur à zéro/)).toBeInTheDocument()
    await user.clear(amount)
    await user.type(amount, '0')
    expect(await screen.findByText(/supérieur à zéro/)).toBeInTheDocument()
  })

  it('warns about a future date and a date before the account opened, and still allows both', async () => {
    server.use(
      http.get(ROUTES.accounts, () =>
        HttpResponse.json(
          anAccountsPayload(
            defaultAccounts().map((one) =>
              one.id === 'alpha' ? { ...one, opened_on: '2019-10-30' } : one,
            ),
          ),
        ),
      ),
    )
    const user = await openFresh()
    await user.click(screen.getByRole('tab', { name: 'Versement' }))
    await user.selectOptions(await screen.findByLabelText('Compte'), 'alpha')
    const date = screen.getByLabelText('Date')

    fireEvent.change(date, { target: { value: '2099-01-01' } })
    expect(await screen.findByText(/pas encore passée/)).toBeInTheDocument()
    fireEvent.change(date, { target: { value: '2019-01-01' } })
    expect(await screen.findByText(/Le compte est ouvert depuis le/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled()
  })

  it('has no colour and is not announced', async () => {
    previewing({ cash_after: 1040, amount: -10, fees: 0 })
    const user = await openFresh()
    await fill(user, 'Achat', { Titre: 'ZZA', Quantité: '1', 'Prix unitaire': '10' })
    const line = (await screen.findByText(/liquidités/)).closest('p') as HTMLElement
    expect(line.innerHTML).not.toMatch(/text-(gain|loss|destructive)/)
    // Explicit live regions, and the roles that imply one.
    expect(line.closest('[aria-live], [role="status"], [role="alert"], [role="log"]')).toBeNull()
    expect(line.closest('output')).toBeNull()
  })
})
