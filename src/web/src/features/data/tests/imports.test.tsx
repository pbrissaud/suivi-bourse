/**
 * **Import et export** (#728, #811, #813), at the one seam:
 * the whole app in jsdom, HTTP the only faked edge.
 *
 * The imports bar above the ledger held three things and holds two: the drop zone and
 * the export menu. **The list of sources with its revocation left with the
 * population it described** (#816) — nothing persists that could be listed, so
 * the cases that named a file, ordered the list, counted what a revocation would
 * take and named the refusal it would meet are gone with their subject, and
 * #803 says of them by name that they disappear without replacement.
 *
 * What replaces the first case in the file is its inverse: the list is not
 * rendered, no revocation is offered anywhere, and **every row of the ledger is
 * editable** — which is the ticket's own criterion, said on the accessible
 * rendering.
 */
import fs from 'node:fs'
import path from 'node:path'
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Account } from '@/features/accounts/lib/api'
import type { LedgerEvent } from '@/features/data/lib/api'
import { EVENT_FILE_COLUMNS } from '@/features/data/lib/imports'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { anAccount, anAccountsPayload, aLedgerPayload, ledgerEvents } from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

/**
 * What the browser was handed, per test. A download has **no accessible
 * rendering** — the file leaves the document, and the *Save as* is the
 * browser's own — so the one thing observable about it is that the app asked
 * for it and under which name. jsdom implements neither object URLs nor
 * downloads, so both are stood in for here and nowhere else: everything above
 * them is the app as it ships, HTTP still the only faked edge.
 */
const saved: string[] = []

beforeEach(() => {
  saved.length = 0
  URL.createObjectURL = vi.fn(() => 'blob:export')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push(this.download)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** One exported file as the server hands it over: bytes, and their name. */
function csvNamed(filename: string) {
  return new HttpResponse('date,event_type\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

function renderImports({
  events = ledgerEvents(),
  accounts = undefined as Account[] | undefined,
  declared = true,
}: {
  events?: LedgerEvent[]
  accounts?: Account[]
  declared?: boolean
} = {}) {
  server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(events))))
  if (accounts) {
    server.use(
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload(accounts, declared))),
    )
  }
  return renderApp({ url: '/ledger' })
}

function ledger() {
  return screen.getByRole('table', { name: 'Vos événements' })
}

describe('one population, and no source to act on', () => {
  it('renders no list of sources and offers no revocation anywhere', async () => {
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // The bar is still there — it holds the zone and the export — and what it
    // no longer holds is a table of files (#816).
    expect(screen.getByRole('button', { name: 'Exporter' })).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Import et export' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Oublier/ })).toBeNull()
    // And the band **says** nothing of it either (#834): the mock-up's zone
    // still carried *« La révocation s'effectue par fichier »*, a sentence
    // about an apparatus that has no subject left — there is no provenance,
    // no column and no link.
    expect(screen.queryByText(/révocation/i)).toBeNull()
  })

  it('renders no provenance column, and nothing that leads to a source', async () => {
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const headers = within(ledger())
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent)
    expect(headers).not.toContain('Provenance')
    expect(within(ledger()).queryByText(/zeta-events_2\.csv/)).toBeNull()
  })

  it('offers the editor on every row, and not on a chosen few', async () => {
    // **The ticket's criterion** (story 13): a row a file laid down is corrected
    // exactly like a row somebody typed, so the affordance is on all of them.
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const rows = within(ledger()).getAllByRole('row').slice(1)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(within(row).getAllByRole('button').length).toBeGreaterThan(0)
    }
  })
})

/** A type, picked in the toolbar's *Type* menu (#1278): open it, press the option. */
async function pickType(user: ReturnType<typeof renderApp>['user'], name: RegExp) {
  await user.click(screen.getByRole('button', { name: /^Type :/ }))
  await user.click(await screen.findByRole('option', { name }))
}

/** The export is a menu since #794: its entries exist once it is open. */
async function openExport(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Exporter' }))
  return screen.findByRole('menu')
}

describe('the export', () => {
  it('offers four files: the ledger, the workbook, the selection and the portfolio', async () => {
    // **The criterion of #836**, said on the rendering. Each entry carries its
    // own perimeter under it and its format beside it, which is what lets two
    // of them share a label without being the same gesture.
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const menu = await openExport(user)

    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Tous vos événements4 lignes du grand livreCSV',
      'Tous vos événementsClasseur avec un onglet par annéeXLSX',
      // The count is part of the entry: what it will produce, said before the
      // click rather than discovered in a file.
      'La sélection filtrée4 lignes retenuesCSV',
      'Comptes et lignesSoldes, prix moyens d’achat et valorisationsCSV',
    ])
    // Nothing announces that a round trip takes two files: it does not.
    //A label saying so would send the reader looking for a second
    // file the menu no longer has.
    expect(within(menu).queryByText(/deux fichiers/)).not.toBeInTheDocument()
  })

  it('offers no accounts declaration, whatever this install has declared', async () => {
    // Nothing reads an accounts *file* back in, so one offered here would be a
    // backup that restores nothing — the residue that is worst because it
    // *looks* like half a round trip. What the menu offers instead is a
    // **report**, named after what is in it, and the import refuses it by name.
    const declared = await openExport(renderImports({ accounts: [anAccount({ id: 'zeta' })] }).user)
    expect(
      within(declared).queryByRole('menuitem', { name: 'Vos comptes' }),
    ).not.toBeInTheDocument()
    expect(within(declared).getByRole('menuitem', { name: /Comptes et lignes/ })).toHaveTextContent(
      'Soldes, prix moyens d’achat et valorisations',
    )
  })

  it('asks the portfolio route for the accounts and their positions, with no reduction', async () => {
    // The five parameters are the **ledger's** dimensions and a position has
    // none of them, so nothing of the reduction travels — even with a chip
    // pressed. The perimeter of this file is the portfolio.
    const asked: string[] = []
    server.use(
      http.get(ROUTES.exportPortfolio, ({ request }) => {
        asked.push(request.url)
        return csvNamed('suivi-bourse-portfolio.csv')
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await pickType(user, /^Achat/)
    await user.click(
      within(await openExport(user)).getByRole('menuitem', { name: /Comptes et lignes/ }),
    )

    await waitFor(() => expect(asked).toHaveLength(1))
    expect(new URL(asked[0]).search).toBe('')
    // The name is the server's here as everywhere, and it never becomes a
    // *selection*: nothing was held back.
    await waitFor(() => expect(saved).toEqual(['suivi-bourse-portfolio.csv']))
    // The receipt names what was made, and it is not *your events*.
    expect(
      await screen.findByText('Vos comptes et lignes sont sur votre disque.'),
    ).toBeInTheDocument()
  })

  it('asks the server for the whole ledger, and saves it under the name it answers with', async () => {
    const asked: string[] = []
    server.use(
      http.get(ROUTES.exportEvents, ({ request }) => {
        asked.push(request.url)
        return csvNamed('suivi-bourse-events.csv')
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(
      within(await openExport(user)).getByRole('menuitem', {
        name: /Tous vos événements.*grand livre/,
      }),
    )

    await waitFor(() => expect(asked).toHaveLength(1))
    // No parameter at all: this entry is the backup, and the backup is whole.
    expect(new URL(asked[0]).search).toBe('')
    // The name is the server's — it is the one side that knows whether anything
    // was held back, and therefore which of the two names the file takes.
    await waitFor(() => expect(saved).toEqual(['suivi-bourse-events.csv']))
  })

  it('carries the chips to the server rather than narrowing the file here', async () => {
    const asked: string[] = []
    server.use(
      http.get(ROUTES.exportEvents, ({ request }) => {
        asked.push(request.url)
        return csvNamed('suivi-bourse-selection.csv')
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // The reduction, made with the controls the reader has: a type facet and
    // the search field.
    await pickType(user, /^Achat/)
    await user.type(screen.getByRole('searchbox'), 'zza')

    await user.click(
      within(await openExport(user)).getByRole('menuitem', { name: /La sélection filtrée/ }),
    )

    await waitFor(() => expect(asked).toHaveLength(1))
    const parameters = new URL(asked[0]).searchParams
    expect(parameters.get('type')).toBe('BUY')
    expect(parameters.get('q')).toBe('zza')
    // What comes back is a file the server named a selection: a reduction does
    // not take the backup's name, and the front does not compose either.
    await waitFor(() => expect(saved).toEqual(['suivi-bourse-selection.csv']))
  })

  it('names the file it is really making, and not the entry that was clicked', async () => {
    // With no chip pressed the selection *is* the whole ledger: the server
    // answers under the backup's name, so a receipt saying « votre sélection »
    // would be the one sentence on screen contradicting the file on the disk.
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(
      within(await openExport(user)).getByRole('menuitem', { name: /La sélection filtrée/ }),
    )

    expect(await screen.findByText('Vos événements sont sur votre disque.')).toBeInTheDocument()
    await waitFor(() => expect(saved).toEqual(['suivi-bourse-events.csv']))
  })

  it('asks the workbook route for the workbook', async () => {
    const asked: string[] = []
    server.use(
      http.get(ROUTES.exportEventsWorkbook, ({ request }) => {
        asked.push(request.url)
        return csvNamed('suivi-bourse-events.xlsx')
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(
      within(await openExport(user)).getByRole('menuitem', {
        name: /Tous vos événements.*Classeur/,
      }),
    )

    await waitFor(() => expect(saved).toEqual(['suivi-bourse-events.xlsx']))
    expect(asked).toHaveLength(1)
  })

  it('confirms for as long as the file is being made, and not one second more', async () => {
    // The criterion, and the reason the entries are gestures rather than links:
    // a receipt over an `<a download>` could only be a guess with a timer on it.
    let hand: (() => void) | null = null
    server.use(
      http.get(ROUTES.exportEvents, async () => {
        await new Promise<void>((resolve) => {
          hand = resolve
        })
        return csvNamed('suivi-bourse-events.csv')
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(
      within(await openExport(user)).getByRole('menuitem', {
        name: /Tous vos événements.*grand livre/,
      }),
    )

    // It says what is being made, and it is still saying it a while later: the
    // sentence is not on a clock of its own.
    expect(await screen.findByText('Préparation de vos événements…')).toBeInTheDocument()
    await waitFor(() => expect(hand).not.toBeNull())
    expect(screen.getByText('Préparation de vos événements…')).toBeInTheDocument()

    hand!()

    // And it leaves when the file is there, saying so.
    expect(await screen.findByText('Vos événements sont sur votre disque.')).toBeInTheDocument()
    await waitFor(() => expect(saved).toEqual(['suivi-bourse-events.csv']))
    expect(screen.queryByText('Préparation de vos événements…')).not.toBeInTheDocument()
  })

  it('says the refusal rather than handing over a file that is not there', async () => {
    server.use(
      problemHandler(ROUTES.exportEvents, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'Portfolio storage unavailable',
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(
      within(await openExport(user)).getByRole('menuitem', {
        name: /Tous vos événements.*grand livre/,
      }),
    )

    // Read by `problem.type` like every other refusal, never by the sentence
    // the server wrote for a log.
    expect(
      await screen.findByText(/Vos données sont illisibles pour l’instant/),
    ).toBeInTheDocument()
    expect(saved).toEqual([])
  })

  it('keeps Exporter in the toolbar, with the search and the page’s other gestures', async () => {
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // One row above the table (#1278): the export rides at the right of the
    // search, and **no list of files** since #816. Getting one's data out is a
    // question of files, not of the ledger.
    const exporter = screen.getByRole('button', { name: 'Exporter' })
    expect(
      exporter.compareDocumentPosition(ledger()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      screen.getByRole('searchbox').compareDocumentPosition(exporter) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

describe('the way into the import', () => {
  it('leads from the toolbar’s Importer to the import page', async () => {
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.click(screen.getByRole('link', { name: 'Importer' }))

    expect(await screen.findByRole('heading', { name: 'Importer', level: 1 })).toBeInTheDocument()
  })

  it('draws no import band over a populated ledger, and takes no drop on the table', async () => {
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(screen.queryByLabelText('Parcourir…')).not.toBeInTheDocument()
    expect(ledger().closest('[data-drop="ledger"]')).toBeNull()
  })
})

describe('an install that has imported nothing', () => {
  it('offers the import page once, as the empty ledger’s file entry', async () => {
    renderImports({ events: [], accounts: [anAccount({ id: 'zeta' })] })
    await screen.findByText('Importer un fichier')

    expect(screen.getAllByRole('button', { name: 'Importer' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Exporter' })).not.toBeInTheDocument()
  })
})

describe('an install that has imported nothing, and the format it reads (#1266)', () => {
  it('links the format section of the docs in the reader language', async () => {
    renderImports({ events: [] })

    const link = await screen.findByRole('link', { name: 'Le format, colonne par colonne' })

    expect(link).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/import-your-events#format',
    )
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
  })

  it('keeps the column list equal to the docs example', () => {
    const page = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../../../..', 'website/docs/import-your-events.mdx'),
      'utf8',
    )

    const example = page.split('## The format {#format}')[1].split('```csv\n')[1].split('\n')[0]

    expect(example.split(',')).toEqual([...EVENT_FILE_COLUMNS])
  })
})
