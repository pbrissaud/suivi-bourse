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
  anAccountsPayload,
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

describe('the two tabs under one route', () => {
  it('names them by what the user declared and what the installation is', async () => {
    renderData()

    // A tab is not a page: the product's cut at four pages holds, and the line
    // between the two is ADR-0014's boot test transposed to the render.
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Le grand livre', 'L’installation'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('table', { name: 'Vos événements' })).toBeInTheDocument()
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
    // false defect — and the link to the import block is #728's.
    expect(within(ledger()).getAllByText('zeta-events_2.csv · l. 118')).toHaveLength(1)
    expect(within(ledger()).queryAllByRole('link')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /oublier/i })).not.toBeInTheDocument()
  })

  it('sorts by date descending and paginates nothing', async () => {
    renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // A ledger is opened to check what has just happened, and « page 4 sur 6 »
    // means nothing on an axis of dates.
    expect(rowsOf(ledger())).toHaveLength(4)
    expect(
      rowsOf(ledger()).map((row) => within(row).getAllByRole('cell')[0].textContent),
    ).toEqual(['10 févr. 2026', '12 janv. 2026', '5 janv. 2026', '24 déc. 2025'])
    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/page \d+/i)).not.toBeInTheDocument()
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

  it('filters by type, and says how many rows are left', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    expect(screen.getByText('4 événements')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Type'), 'DEPOSIT')
    await waitFor(() => expect(rowsOf(ledger())).toHaveLength(1))
    expect(screen.getByText('1 événement')).toBeInTheDocument()
  })

  it('says nothing matches rather than showing an empty table', async () => {
    const { user } = renderData()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.type(screen.getByLabelText('Rechercher'), 'zzzz')
    expect(await screen.findByText('Aucun événement ne correspond')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('the editor, and where it does not appear', () => {
  it('never appears on an install that has only ever imported', async () => {
    // The real portfolio exactly: 285 imported rows, 0 typed. The read-only
    // rule needs no column to state itself — a row carrying a provenance came
    // from a file, and there is nothing on it to press.
    renderData(importedOnly())
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(within(ledger()).queryAllByRole('button')).toHaveLength(0)
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
    const file = await screen.findByRole('region', { name: 'Déposer un fichier' })
    const manual = screen.getByRole('region', { name: 'Saisir un premier événement' })
    expect(file).toBeInTheDocument()
    expect(manual).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

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
  })
})
