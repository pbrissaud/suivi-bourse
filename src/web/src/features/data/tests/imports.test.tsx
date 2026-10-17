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
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Account } from '@/features/accounts/lib/api'
import type { ImportReceipt, LedgerEvent } from '@/features/data/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  anAccount,
  anAccountsPayload,
  aDuplicateRow,
  aReceipt,
  aLedgerPayload,
  ledgerEvents,
  theSeededAccount,
} from '@/test/factories'
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
  await user.click(screen.getByRole('button', { name: 'Type' }))
  await user.click(await screen.findByRole('button', { name }))
}

/** The export is a menu since #794: its entries exist once it is open. */
async function openExport(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Exporter' }))
  return screen.findByRole('menu')
}

/**
 * The file field: the toolbar's *Importer* over a populated ledger (#1278), the
 * band's *Parcourir…* over an empty one — the two mounts of one control.
 */
function fileField() {
  return screen.queryByLabelText('Parcourir…') ?? screen.getByLabelText('Importer')
}

/**
 * The *Importer* of the preview window. The toolbar's own button carries the
 * same word, so the window — a modal, which hides the page behind it — is where
 * the confirmation is looked for.
 */
async function windowImport() {
  return within(await screen.findByRole('dialog')).getByRole('button', { name: 'Importer' })
}
function windowImportNow() {
  return within(screen.getByRole('dialog')).getByRole('button', { name: 'Importer' })
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
      'Comptes et positionsSoldes, PRU et valorisationsCSV',
    ])
    // And the menu says once what its four entries answer.
    expect(within(menu).getByText('Ce que vous exportez')).toBeInTheDocument()
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
    expect(
      within(declared).getByRole('menuitem', { name: /Comptes et positions/ }),
    ).toHaveTextContent('Soldes, PRU et valorisations')
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
      within(await openExport(user)).getByRole('menuitem', { name: /Comptes et positions/ }),
    )

    await waitFor(() => expect(asked).toHaveLength(1))
    expect(new URL(asked[0]).search).toBe('')
    // The name is the server's here as everywhere, and it never becomes a
    // *selection*: nothing was held back.
    await waitFor(() => expect(saved).toEqual(['suivi-bourse-portfolio.csv']))
    // The receipt names what was made, and it is not *your events*.
    expect(
      await screen.findByText('Vos comptes et positions sont sur votre disque.'),
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

describe('the import over a populated ledger (#1278)', () => {
  function aFile(name = 'zeta-events_2.csv') {
    return new File(['date,event_type\n'], name, { type: 'text/csv' })
  }

  /** What a browser hands a drop: `types` names `Files` only when a file is dragged. */
  function dragOf(files: File[]) {
    return { dataTransfer: { types: files.length > 0 ? ['Files'] : ['text/plain'], files } }
  }

  /** The dry-run requests the route saw. */
  function watchingPreviews() {
    const seen: string[] = []
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) => {
        seen.push(new URL(request.url).searchParams.has('dry_run') ? 'preview' : 'write')
        return HttpResponse.json(aReceipt(), { status: 200 })
      }),
    )
    return seen
  }

  it('draws no import band over a populated ledger', async () => {
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(screen.queryByText(/Déposez un fichier \.csv ou \.xlsx/)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Import et export' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Parcourir…')).not.toBeInTheDocument()
  })

  it('imports from the toolbar’s Importer button', async () => {
    const seen = watchingPreviews()
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Importer' })).toBeInTheDocument()
    await user.upload(screen.getByLabelText('Importer'), aFile())

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(seen).toEqual(['preview'])
  })

  it('takes a file dropped on the table', async () => {
    const seen = watchingPreviews()
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const card = ledger().closest('[data-slot="card"]') as HTMLElement

    fireEvent.dragOver(card, dragOf([aFile()]))
    // While a file is over the card, the card says what dropping it does.
    expect(
      screen.getByText(/Déposez ici : vous verrez ce que le fichier ferait/),
    ).toBeInTheDocument()

    fireEvent.drop(card, dragOf([aFile()]))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(seen).toEqual(['preview'])
  })

  it('ignores a drag that carries no file', async () => {
    const seen = watchingPreviews()
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    const card = ledger().closest('[data-slot="card"]') as HTMLElement

    fireEvent.dragOver(card, dragOf([]))
    expect(screen.queryByText(/Déposez ici/)).not.toBeInTheDocument()

    fireEvent.drop(card, dragOf([]))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(seen).toEqual([])
  })
})

describe('an install that has imported nothing', () => {
  it('offers the file entrance once, with a declaration and nothing recorded', async () => {
    // An install with something declared and no event. The gesture is then
    // offered once, by the empty state's own entry.
    renderImports({ events: [], accounts: [anAccount({ id: 'zeta' })] })
    await screen.findByText('Importer un fichier')

    expect(screen.queryByRole('region', { name: 'Import et export' })).not.toBeInTheDocument()
    expect(screen.getAllByLabelText('Parcourir…')).toHaveLength(1)
  })

  it('draws the band as the empty ledger’s file entry, and takes a drop there', async () => {
    const seen: string[] = []
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) => {
        seen.push(new URL(request.url).searchParams.has('dry_run') ? 'preview' : 'write')
        return HttpResponse.json(aReceipt(), { status: 200 })
      }),
    )
    renderImports({ events: [] })
    const band = (await screen.findByText(/Déposez un fichier \.csv ou \.xlsx/)).parentElement
      ?.parentElement as HTMLElement
    // No export beside it, and no toolbar: the band is the page.
    expect(within(band).queryByRole('button', { name: 'Exporter' })).not.toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()

    const file = new File(['date,event_type\n'], 'zeta-events_2.csv', { type: 'text/csv' })
    fireEvent.drop(band, { dataTransfer: { types: ['Files'], files: [file] } })

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(seen).toEqual(['preview'])
  })

  it('renders no bar at all with nothing recorded and nothing declared', async () => {
    // The drop zone is then the empty state's own entry, one line below: the
    // bar would say the same thing twice, and a block with nothing in it does
    // not exist.
    renderImports({ events: [], accounts: [theSeededAccount()], declared: false })
    await screen.findByText('Importer un fichier')

    expect(screen.queryByRole('region', { name: 'Import et export' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Exporter' })).not.toBeInTheDocument()
    // And the file entrance is **still there**: it is the empty state's own
    // entry, which is the whole of story 2 — an install that mounted nothing is
    // not an install missing half the product.
    expect(screen.getByLabelText('Parcourir…')).toBeInTheDocument()
  })
})

describe('the file handed over', () => {
  /** One file, as a browser's own picker hands it to the input. */
  function aFile(name = 'zeta-events_2.csv') {
    return new File(['date,event_type\n'], name, { type: 'text/csv' })
  }

  /**
   * The whole gesture, both halves (#813): hand the file over, read the
   * forecast, press *Importer*. A test that only cares about what landed says
   * so in one line rather than spelling the confirmation out five times.
   */
  async function handOver(user: ReturnType<typeof renderImports>['user'], file = aFile()) {
    await user.upload(fileField(), file)
    await user.click(await windowImport())
  }

  it('previews the file before writing it, and writes on the confirmation', async () => {
    // **The criterion, in the order the reader lives it** (#813): the
    // file is read back *before* it costs anything, in the same sentence the
    // fact will be said in — only the tense moves — and the write happens when
    // the reader says so.
    const seen: string[] = []
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) => {
        const previewing = new URL(request.url).searchParams.has('dry_run')
        seen.push(previewing ? 'preview' : 'write')
        return HttpResponse.json(aReceipt(), { status: previewing ? 200 : 201 })
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.upload(fileField(), aFile())

    expect(
      await screen.findByText(
        /3 événements seront écrits, du 5 janv\. 2026 au 27 févr\. 2026, sur 1 compte et 2 titres\./,
      ),
    ).toBeInTheDocument()
    // Nothing has been written yet, and the app has asked for nothing but the
    // forecast — which is the property the server side asserts on the table.
    expect(seen).toEqual(['preview'])

    await user.click(windowImportNow())

    expect(
      await screen.findByText(
        /3 événements écrits, du 5 janv\. 2026 au 27 févr\. 2026, sur 1 compte et 2 titres\./,
      ),
    ).toBeInTheDocument()
    // **The same file, sent again** — the server holds no import to commit, so
    // the second call carries the payload exactly as the first did.
    expect(seen).toEqual(['preview', 'write'])
    // And the forecast is gone: the fact replaces it rather than joining it.
    expect(screen.queryByText(/seront écrits/)).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('puts the file down without writing it when the reader refuses', async () => {
    // What the preview is *for*: refusing a file the reader did not mean to
    // import, before it costs anything at all.
    const seen: string[] = []
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) => {
        const previewing = new URL(request.url).searchParams.has('dry_run')
        seen.push(previewing ? 'preview' : 'write')
        return HttpResponse.json(aReceipt(), { status: previewing ? 200 : 201 })
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.upload(fileField(), aFile())
    await user.click(await screen.findByRole('button', { name: 'Annuler' }))

    expect(screen.queryByText(/seront écrits/)).not.toBeInTheDocument()
    expect(seen).toEqual(['preview'])
  })

  it('says how many lines of the file the ledger already has, at both moments', async () => {
    // Story 4 and story 5: the count is stated, and the rows are skipped
    // without the reader having to do anything about them.
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) => {
        const previewing = new URL(request.url).searchParams.has('dry_run')
        return HttpResponse.json(
          aReceipt({
            rows: 3,
            written: 1,
            duplicates: 2,
            duplicate_rows: [aDuplicateRow(), aDuplicateRow()],
          }),
          {
            status: previewing ? 200 : 201,
          },
        )
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.upload(fileField(), aFile())

    expect(
      await screen.findByText(
        /2 lignes de ce fichier sont déjà dans votre grand livre et seront ignorées\./,
      ),
    ).toBeInTheDocument()

    await user.click(windowImportNow())

    expect(await screen.findByText(/2 doublons ignorés\./)).toBeInTheDocument()
  })

  it('offers to write the duplicates anyway', async () => {
    // Story 6: the owner who really did place the same order twice. The app
    // reports and offers — it never decides on their behalf. That the offer is
    // *only* made when there are duplicates is the next test's assertion, on a
    // receipt that carries none.
    const asked: string[] = []
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) => {
        const params = new URL(request.url).searchParams
        const previewing = params.has('dry_run')
        if (!previewing) asked.push(params.get('write_duplicates') ?? 'no')
        return HttpResponse.json(
          aReceipt({
            rows: 3,
            written: 1,
            duplicates: 2,
            duplicate_rows: [aDuplicateRow(), aDuplicateRow()],
          }),
          {
            status: previewing ? 200 : 201,
          },
        )
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.upload(fileField(), aFile())
    await user.click(
      await screen.findByLabelText('Écrire quand même les lignes déjà dans votre grand livre'),
    )
    await user.click(windowImportNow())

    await waitFor(() => expect(asked).toEqual(['1']))
  })

  it('asks nothing about duplicates when the file has none', async () => {
    // A box about rows that do not exist is a question the reader cannot
    // answer — the default receipt carries no duplicate at all.
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.upload(fileField(), aFile())
    await windowImport()

    expect(
      screen.queryByLabelText('Écrire quand même les lignes déjà dans votre grand livre'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/déjà dans votre grand livre/)).not.toBeInTheDocument()
  })

  it('sends the file to the gesture, and never to a resource', async () => {
    // `/api/events/import` and not `/api/imports`: an import is no longer a
    // resource, so there is nothing to POST to and nothing to come back to.
    // What is asserted is the **request**: the route, and a multipart body —
    // the file inside it does not survive jsdom and undici disagreeing about
    // what a `File` is, and what the server makes of a real one is asserted
    // over the real route in `tests/test_ledger.py`.
    const seen: string[] = []
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) => {
        seen.push(request.headers.get('content-type') ?? 'no content type')
        const previewing = new URL(request.url).searchParams.has('dry_run')
        return HttpResponse.json(aReceipt(), { status: previewing ? 200 : 201 })
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await handOver(user, aFile('broker.csv'))
    await screen.findByText(/3 événements écrits/)

    // **Twice, and that is the design** (#813): the preview and the write are
    // one file sent two times, because the server keeps no import between them.
    expect(seen).toHaveLength(2)
    // The boundary is the browser's, never ours: a hand-written `Content-Type`
    // is a multipart body no server can split.
    for (const contentType of seen) {
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
    }
  })

  it('says a file that wrote nothing wrote nothing, and states no period', async () => {
    // *0 événements écrits, du — au —* would state a period the file does not
    // carry, and no plural rule can invent the two days that are missing.
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) =>
        HttpResponse.json(
          aReceipt({
            filename: 'vide.csv',
            rows: 0,
            written: 0,
            duplicates: 0,
            period: null,
            accounts: [],
            symbols: [],
          }),
          { status: new URL(request.url).searchParams.has('dry_run') ? 200 : 201 },
        ),
      ),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.upload(fileField(), aFile('vide.csv'))

    // The forecast says it first, in its own tense — there is nothing to write.
    expect(
      await screen.findByText('vide.csv ne porte aucun événement : il n’y a rien à écrire.'),
    ).toBeInTheDocument()

    await user.click(windowImportNow())

    expect(
      await screen.findByText('vide.csv ne portait aucun événement : rien n’a été écrit.'),
    ).toBeInTheDocument()
  })

  it('reads a refusal by its type, and never by the sentence the server wrote', async () => {
    server.use(
      http.post(ROUTES.eventsImport, () =>
        HttpResponse.json(
          {
            type: PROBLEM_TYPES.invalidFile,
            title: 'Invalid file',
            status: 422,
            detail: "account 'pea' is not declared",
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.upload(fileField(), aFile())

    expect(
      await screen.findByText(/L’application a refusé ce fichier et n’a rien écrit/),
    ).toBeInTheDocument()
    // The server's own sentence is a diagnostic for a log, and English: it is
    // carried, and rendered nowhere.
    expect(screen.queryByText(/is not declared/)).not.toBeInTheDocument()
  })

  it('names the security when the file sells shares the ledger does not hold', async () => {
    // The common case #811 made ordinary: the owner exports 2024 at their
    // broker, and every `SELL` of a position opened in 2023 oversells. The file
    // is refused whole — which is right — and what they used to be told was
    // *what this names is already there*, which describes nothing that just
    // happened. The true sentence names a security and two quantities, and they
    // travel as extension members so the front can say it in French (#824).
    server.use(
      http.post(ROUTES.eventsImport, () =>
        HttpResponse.json(
          {
            type: PROBLEM_TYPES.unreplayableLedger,
            title: 'Ledger does not replay',
            status: 409,
            detail: 'Cannot sell 12.0 shares of AAPL (only 10.0 owned) on 2024-09-15',
            gesture: 'write',
            symbol: 'AAPL',
            wanted: 12,
            owned: 10,
            day: '2024-09-15',
          },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.upload(fileField(), aFile())

    expect(
      await screen.findByText(
        'L’application a refusé et n’a rien écrit : ce geste vend 12 parts de AAPL, ' +
          'et votre grand livre n’en porte que 10 ce jour-là.',
      ),
    ).toBeInTheDocument()
    // Neither the sentence of `problem.conflict` — the one this refusal used to
    // borrow — nor a word of the server's English.
    expect(screen.queryByText(/existe déjà/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Cannot sell/)).not.toBeInTheDocument()
  })

  it('names the bound rather than the generic refusal when the file is too big', async () => {
    server.use(
      http.post(ROUTES.eventsImport, () =>
        HttpResponse.json(
          { type: PROBLEM_TYPES.tooLarge, title: 'File too large', status: 413, limit: 8388608 },
          { status: 413, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await user.upload(fileField(), aFile())

    expect(
      await screen.findByText(/dépasse ce que l’application accepte en une fois/),
    ).toBeInTheDocument()
  })

  it('keeps the first import’s receipt once the ledger fills', async () => {
    // **The gesture this whole ticket exists for**, and the one place a receipt
    // held by the zone would be destroyed by the write it announces: an empty
    // ledger offers the file entrance inside the entry pair, the import fills
    // the table, the pair unmounts and the bar's own zone mounts in its place.
    const { user } = renderImports({ events: [] })
    await screen.findByText('Importer un fichier')
    // The ledger the import leaves behind, armed **after** the empty one has
    // been read: `renderImports` registers its own handler, and the last one
    // registered is the one that answers.
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload())))

    await handOver(user)

    // The table the import produced is there, and so is the sentence saying
    // what produced it.
    expect(await screen.findByRole('table', { name: 'Vos événements' })).toBeInTheDocument()
    expect(screen.getByText(/3 événements écrits/)).toBeInTheDocument()
  })

  it('says its own sentence for every import, including a file already dismissed once', async () => {
    // **The receipt lasts as long as the operation** (#787's story 42) — and
    // *the operation* is this import, not this filename. The broker's weekly
    // export is called the same thing every week, and so is the file somebody
    // corrected and handed back; an import whose sentence never appears is one
    // the reader has no way of reading at all.
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await handOver(user, aFile('operations.csv'))
    expect(await screen.findByText(/3 événements écrits/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Fermer ce reçu' }))
    expect(screen.queryByText(/3 événements écrits/)).not.toBeInTheDocument()

    await handOver(user, aFile('operations.csv'))

    expect(await screen.findByText(/3 événements écrits/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fermer ce reçu' })).toBeInTheDocument()
  })

  it('reads the ledger again once the rows have landed', async () => {
    // The server replays before answering (#697), so the receipt is the moment
    // every figure downstream of the ledger is stale — and the table below is
    // the nearest of them.
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    // Armed **after** the first read has landed, so what it counts is the
    // reading the gesture caused and not the one the mount did.
    let reads = 0
    server.use(
      http.get(ROUTES.events, () => {
        reads += 1
        return HttpResponse.json(aLedgerPayload())
      }),
    )

    await handOver(user)
    await screen.findByText(/3 événements écrits/)

    await waitFor(() => expect(reads).toBeGreaterThan(0))
  })
})

/**
 * **La correspondance des comptes** (#835) — the window that collects the three
 * answers, at the one seam: the whole app in jsdom, HTTP the only faked edge.
 *
 * The receipts below are the ones the server answers, so what is exercised is
 * the reading of them: which line the modal puts a question about, what blocks
 * the button and in what words, what the gesture then carries on the wire, and
 * what the reader is spared when there is nothing to ask.
 */
describe('what this import would do', () => {
  function aFile(name = 'zeta-events_2.csv') {
    return new File(['date,event_type\n'], name, { type: 'text/csv' })
  }

  /**
   * The requests the route saw, so the answers can be read off the wire.
   *
   * It answers `?write_duplicates=1` **as the route does** (`test_ledger.py`'s
   * `test_the_flag_that_writes_the_duplicates_leaves_none_to_name`): the flag
   * moves the rows the ledger already holds out of `duplicates` and into
   * `written`, and there is nothing skipped left to name. A double that ignored
   * the flag would let the window read the wrong receipt for the answer the
   * reader gave and no test would see it.
   */
  function watching(receipt: () => ImportReceipt) {
    const seen: URL[] = []
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) => {
        const url = new URL(request.url)
        seen.push(url)
        const answered = receipt()
        return HttpResponse.json(
          url.searchParams.has('write_duplicates')
            ? { ...answered, written: answered.rows, duplicates: 0, duplicate_rows: [] }
            : answered,
          { status: url.searchParams.has('dry_run') ? 200 : 201 },
        )
      }),
    )
    return seen
  }

  async function hand(user: ReturnType<typeof renderImports>['user'], file = aFile()) {
    await user.upload(fileField(), file)
  }

  it('puts one line per account the file names, with its volume', async () => {
    // The census is the server's — nobody parses a spreadsheet in a browser to
    // count it — and the volume is what makes the question answerable: *where do
    // these 47 events go* is a decision, *where does TR go* is a riddle.
    watching(() =>
      aReceipt({
        file_accounts: [
          { name: '', rows: 3 },
          { name: 'TR', rows: 47 },
        ],
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    const window = await screen.findByRole('dialog')
    expect(await within(window).findByText('47 événements')).toBeInTheDocument()
    expect(within(window).getByText('3 événements')).toBeInTheDocument()
    // The blank column is a line like the others, named rather than swallowed:
    // it means `default` only while nothing is declared.
    expect(within(window).getByText('(aucun compte)')).toBeInTheDocument()
  })

  it('blocks the button in prose while a target is missing', async () => {
    // A control that refuses without saying why is a control the reader cannot
    // act on — and *no refusal arrives after the button* is held here, by the
    // button, and not by the server forgetting a rule.
    watching(() => aReceipt({ file_accounts: [{ name: 'TR', rows: 47 }] }))
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    expect(await windowImport()).toBeDisabled()
    expect(
      screen.getByText('Une correspondance manque : dites où vont les 47 événements de ce compte.'),
    ).toBeInTheDocument()
    // And the line says whose answer is missing, beside the control that gives it.
    expect(screen.getByText('Personne n’a déclaré « TR »')).toBeInTheDocument()
  })

  it('sends the file account to a declared one, and reads the file again', async () => {
    // The answer travels on the query string with the gesture's other
    // parameters, and it costs a **fresh forecast**: the duplicate key carries
    // the account, so what is skipped changes with the answer.
    const seen = watching(() => aReceipt({ file_accounts: [{ name: 'TR', rows: 47 }] }))
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)
    await user.selectOptions(await screen.findByLabelText('Cible pour TR'), 'beta')

    await waitFor(() => expect(seen).toHaveLength(2))
    expect(JSON.parse(seen[1].searchParams.get('map') ?? '{}')).toEqual({ TR: 'beta' })
    expect(seen[1].searchParams.has('dry_run')).toBe(true)

    await user.click(windowImportNow())

    await waitFor(() => expect(seen).toHaveLength(3))
    expect(JSON.parse(seen[2].searchParams.get('map') ?? '{}')).toEqual({ TR: 'beta' })
    expect(seen[2].searchParams.has('dry_run')).toBe(false)
  })

  it('declares the account nobody had declared, from the window', async () => {
    // The entry that repairs the `422`: the file is no longer refused whole, and
    // the reader never leaves the window holding a file the app turned back.
    const seen = watching(() => aReceipt({ file_accounts: [{ name: 'TR', rows: 47 }] }))
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)
    await user.selectOptions(
      await screen.findByLabelText('Cible pour TR'),
      screen.getByRole('option', { name: 'Déclarer « TR » comme un nouveau compte' }),
    )

    expect(await screen.findByText('« TR » sera déclaré avec le fichier')).toBeInTheDocument()
    await user.click(windowImportNow())

    await waitFor(() => expect(seen[seen.length - 1].searchParams.has('dry_run')).toBe(false))
    expect(seen[seen.length - 1].searchParams.getAll('declare')).toEqual(['TR'])
  })

  it('says the correspondence is dropped with the gesture', async () => {
    watching(() => aReceipt({ file_accounts: [{ name: 'TR', rows: 47 }] }))
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    expect(
      await screen.findByText(
        'Cette correspondance ne vaut que pour cet import. Le prochain fichier reposera la question.',
      ),
    ).toBeInTheDocument()
  })

  it('reduces the accounts to one line and asks nothing when everything lands', async () => {
    // **The simple case**, which the maquette does not draw because no prop
    // exercises it: everything declared and nothing duplicated. One line of
    // affirmation, no selector, and no block of duplicates at all — a block with
    // nothing in it does not exist.
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    const window = await screen.findByRole('dialog')
    expect(
      within(window).getByText('Le compte que ce fichier nomme est déjà déclaré.'),
    ).toBeInTheDocument()
    expect(within(window).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(window).queryByText('Déjà dans votre grand livre')).not.toBeInTheDocument()
    expect(windowImportNow()).toBeEnabled()
  })

  it('names the duplicated lines and says what each of them repeats', async () => {
    // A count cannot be argued with; a line can. The two kinds of duplicate are
    // told apart by the block they stand in, and not by a tag on each row (#1267).
    watching(() =>
      aReceipt({
        rows: 3,
        written: 1,
        duplicates: 2,
        duplicate_rows: [
          aDuplicateRow({ date: '2026-02-10', symbol: 'ZZA', quantity: 2, unit_price: 120 }),
          aDuplicateRow({ date: '2026-01-12', symbol: 'ZZB', duplicate_of: null, repeat_of: 0 }),
        ],
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    const held = (await screen.findByRole('heading', { name: 'Déjà dans votre grand livre' }))
      .parentElement!
    const repeats = screen.getByRole('heading', { name: 'Répétées dans le fichier' }).parentElement!
    expect(within(held).getByText(/10 févr\. 2026 · Achat · ZZA · 2 × 120,00/)).toBeInTheDocument()
    expect(within(repeats).getByText(/12 janv\. 2026 · Achat · ZZB/)).toBeInTheDocument()
    expect(screen.queryByText('déjà dans votre grand livre')).not.toBeInTheDocument()
    expect(screen.queryByText('répétée dans le fichier')).not.toBeInTheDocument()
  })

  /**
   * The route as it answers `write_repeat` (#1267): a form field, read off the
   * body, that writes the group whole and takes its copies out of the list.
   */
  function watchingRepeats(census: () => ImportReceipt, refuseWhenWritingAll = false) {
    const seen: { url: URL; repeats: string[] }[] = []
    server.use(
      http.post(ROUTES.eventsImport, async ({ request }) => {
        const url = new URL(request.url)
        // Read off the raw multipart body: jsdom's `File` and undici's disagree
        // about what one is, so `formData()` cannot parse what jsdom sent.
        const body = await request.text()
        const repeats = [...body.matchAll(/name="write_repeat"\r\n\r\n(\d+)/g)].map(
          (match) => match[1],
        )
        seen.push({ url, repeats })
        const status = url.searchParams.has('dry_run') ? 200 : 201
        const answered = census()
        if (repeats.length === 0) return HttpResponse.json(answered, { status })
        if (refuseWhenWritingAll) {
          return HttpResponse.json(
            {
              type: PROBLEM_TYPES.unreplayableLedger,
              title: 'Ledger does not replay',
              status: 409,
              detail: 'Cannot sell 4.0 shares of ZZA (only 2.0 owned) on 2026-02-10',
              gesture: 'write',
              symbol: 'ZZA',
              wanted: 4,
              owned: 2,
              day: '2026-02-10',
            },
            { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
          )
        }
        return HttpResponse.json(
          {
            ...answered,
            written:
              answered.rows -
              answered.duplicate_rows.filter((row) => row.repeat_of === null).length,
            duplicates: answered.duplicate_rows.filter((row) => row.repeat_of === null).length,
            duplicate_rows: answered.duplicate_rows.filter((row) => row.repeat_of === null),
          },
          { status },
        )
      }),
    )
    return seen
  }

  /** A dividend the file carries twice: the issue's own case. */
  const twiceTheSameDividend = (first = 0, symbol = 'ZZA') =>
    aDuplicateRow({
      event_type: 'DIVIDEND',
      symbol,
      quantity: null,
      unit_price: null,
      amount: 8.5,
      duplicate_of: null,
      repeat_of: first,
    })

  it('writes a line repeated in the file by default', async () => {
    const seen = watchingRepeats(() =>
      aReceipt({ rows: 2, written: 1, duplicates: 1, duplicate_rows: [twiceTheSameDividend()] }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    expect(
      await screen.findByRole('heading', { name: 'Répétées dans le fichier' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Écrire les deux' })).toBeChecked()
    expect(await screen.findByText(/2 événements seront écrits/)).toBeInTheDocument()
    expect(screen.getByText('aucun doublon sauté')).toBeInTheDocument()
    // The census read carries nothing; the writing read carries the group.
    expect(seen.map((read) => read.repeats)).toEqual([[], ['0']])

    await user.click(windowImportNow())

    await waitFor(() => expect(seen).toHaveLength(3))
    expect(seen[2].repeats).toEqual(['0'])
    expect(seen[2].url.searchParams.has('dry_run')).toBe(false)
    expect(seen[2].url.searchParams.has('write_repeat')).toBe(false)
  })

  it('keeps one copy when the reader says so', async () => {
    const seen = watchingRepeats(() =>
      aReceipt({ rows: 2, written: 1, duplicates: 1, duplicate_rows: [twiceTheSameDividend()] }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await hand(user)

    await user.click(await screen.findByRole('radio', { name: 'N’en écrire qu’une' }))

    expect(await screen.findByText(/1 événement sera écrit/)).toBeInTheDocument()
    expect(screen.getByText('1 doublon sauté')).toBeInTheDocument()
    expect(seen[seen.length - 1].repeats).toEqual([])

    await user.click(windowImportNow())

    await waitFor(() => expect(seen[seen.length - 1].url.searchParams.has('dry_run')).toBe(false))
    expect(seen[seen.length - 1].repeats).toEqual([])
  })

  it('keeps the lines already in the ledger in their own block, skipped by default', async () => {
    watching(() =>
      aReceipt({ rows: 2, written: 1, duplicates: 1, duplicate_rows: [aDuplicateRow()] }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    const held = (await screen.findByRole('heading', { name: 'Déjà dans votre grand livre' }))
      .parentElement!
    expect(within(held).getByText(/Achat · ZZA/)).toBeInTheDocument()
    expect(
      within(held).getByLabelText('Écrire quand même les lignes déjà dans votre grand livre'),
    ).not.toBeChecked()
    expect(screen.queryByText('déjà dans votre grand livre')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Répétées dans le fichier' }),
    ).not.toBeInTheDocument()
  })

  it('offers the shortcuts from two groups on', async () => {
    watchingRepeats(() =>
      aReceipt({
        rows: 4,
        written: 2,
        duplicates: 2,
        duplicate_rows: [twiceTheSameDividend(1, 'ZZA'), twiceTheSameDividend(3, 'ZZB')],
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await hand(user)

    const one = await screen.findByRole('button', { name: 'Une seule de chaque' })
    expect(screen.getAllByRole('radio', { name: 'N’en écrire qu’une' })).toHaveLength(2)

    await user.click(one)

    await waitFor(() =>
      screen.getAllByRole('radio', { name: 'N’en écrire qu’une' }).forEach((radio) => {
        expect(radio).toBeChecked()
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Tout écrire' }))

    await waitFor(() =>
      screen.getAllByRole('radio', { name: 'Écrire les deux' }).forEach((radio) => {
        expect(radio).toBeChecked()
      }),
    )
  })

  it('offers no shortcut for a single group', async () => {
    watchingRepeats(() =>
      aReceipt({ rows: 2, written: 1, duplicates: 1, duplicate_rows: [twiceTheSameDividend()] }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await hand(user)

    await screen.findByRole('radio', { name: 'Écrire les deux' })

    expect(screen.queryByRole('button', { name: 'Une seule de chaque' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Tout écrire' })).not.toBeInTheDocument()
  })

  it('leaves the choice usable when writing every copy is refused', async () => {
    watchingRepeats(
      () =>
        aReceipt({
          rows: 4,
          written: 2,
          duplicates: 2,
          duplicate_rows: [twiceTheSameDividend(1, 'ZZA'), twiceTheSameDividend(3, 'ZZB')],
        }),
      true,
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await hand(user)

    expect(await screen.findByText(/ce geste vend 4 parts de ZZA/)).toBeInTheDocument()
    expect(windowImportNow()).toBeDisabled()
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Une seule de chaque' }))

    await waitFor(() => expect(windowImportNow()).toBeEnabled())
    expect(screen.queryByText(/ce geste vend 4 parts de ZZA/)).not.toBeInTheDocument()
  })

  it('renders neither block on a clean file', async () => {
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await hand(user)

    await windowImport()

    expect(
      screen.queryByRole('heading', { name: 'Répétées dans le fichier' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Déjà dans votre grand livre' }),
    ).not.toBeInTheDocument()
  })

  it('makes the footer follow the reader’s answer about the duplicates', async () => {
    // The three numbers close — `rows === written + duplicates` — so the flag
    // moves the same rows from one column to the other and the footer is
    // arithmetic rather than a second question put to the server.
    watching(() =>
      aReceipt({
        rows: 3,
        written: 1,
        duplicates: 2,
        duplicate_rows: [aDuplicateRow(), aDuplicateRow()],
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    expect(await screen.findByText(/1 événement sera écrit/)).toBeInTheDocument()
    expect(screen.getByText('2 doublons sautés')).toBeInTheDocument()

    await user.click(
      screen.getByLabelText('Écrire quand même les lignes déjà dans votre grand livre'),
    )

    expect(await screen.findByText(/3 événements seront écrits/)).toBeInTheDocument()
    expect(screen.getByText('aucun doublon sauté')).toBeInTheDocument()
    expect(screen.getByText('Ces 2 lignes seront écrites en double.')).toBeInTheDocument()
  })

  it('judges the duplicates the reader keeps at the box, and never after the button', async () => {
    // **The criterion, on the one answer that used to escape it** (#835). Writing
    // the rows the ledger already holds is a *different ledger to replay*: the
    // file's `SELL` only got through because its duplicate was skipped, and it
    // stops replaying once it is not. Left to the button, that refusal arrives
    // after it — so the box re-reads the file under the flag, and what the
    // reader meets is a sentence beside a control they can still take back.
    const seen: URL[] = []
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) => {
        const url = new URL(request.url)
        seen.push(url)
        if (url.searchParams.has('write_duplicates')) {
          return HttpResponse.json(
            {
              type: PROBLEM_TYPES.unreplayableLedger,
              title: 'Ledger does not replay',
              status: 409,
              detail: 'Cannot sell 4.0 shares of ZZA (only 2.0 owned) on 2026-02-10',
              gesture: 'write',
              symbol: 'ZZA',
              wanted: 4,
              owned: 2,
              day: '2026-02-10',
            },
            { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
          )
        }
        return HttpResponse.json(
          aReceipt({
            rows: 2,
            written: 1,
            duplicates: 1,
            duplicate_rows: [aDuplicateRow({ date: '2026-02-10', symbol: 'ZZA' })],
          }),
          { status: url.searchParams.has('dry_run') ? 200 : 201 },
        )
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)
    const box = await screen.findByLabelText(
      'Écrire quand même les lignes déjà dans votre grand livre',
    )
    await user.click(box)

    expect(await screen.findByText(/ce geste vend 4 parts de ZZA/)).toBeInTheDocument()
    expect(windowImportNow()).toBeDisabled()
    // The answer was judged on a **preview**: the flag reached the server on a
    // request that writes nothing, and no write was ever made.
    expect(
      seen.some(
        (url) => url.searchParams.has('write_duplicates') && url.searchParams.has('dry_run'),
      ),
    ).toBe(true)
    expect(seen.every((url) => url.searchParams.has('dry_run'))).toBe(true)
    // And the window is not a dead end: the census stands beside the refusal, so
    // the box that caused it is still there to untick.
    await user.click(
      screen.getByLabelText('Écrire quand même les lignes déjà dans votre grand livre'),
    )

    await waitFor(() => expect(windowImportNow()).toBeEnabled())
    expect(screen.queryByText(/ce geste vend 4 parts de ZZA/)).not.toBeInTheDocument()
  })

  it('states the count the server answers for the answer the reader gave', async () => {
    // The footer is not arithmetic done here: there is a real forecast of the
    // real answer to read it off, and a number the front computed beside it
    // would be a second authority on what the button does.
    const seen = watching(() =>
      aReceipt({
        rows: 3,
        written: 1,
        duplicates: 2,
        duplicate_rows: [aDuplicateRow(), aDuplicateRow()],
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)
    expect(await screen.findByText(/1 événement sera écrit/)).toBeInTheDocument()

    await user.click(
      screen.getByLabelText('Écrire quand même les lignes déjà dans votre grand livre'),
    )

    expect(await screen.findByText(/3 événements seront écrits/)).toBeInTheDocument()
    await waitFor(() =>
      expect(seen.filter((url) => url.searchParams.has('write_duplicates')).length).toBeGreaterThan(
        0,
      ),
    )
  })

  it('keeps its body and its footer standing while a second forecast is in flight', async () => {
    // **A second forecast must not take the window down** (#835). The answer
    // re-reads the file, and a body that unmounted for the length of that round
    // trip would take the select the reader has just used with it — focus and
    // all — and, on a file naming three accounts, the two lines they had not
    // answered yet. What guards the figures meanwhile is `pending`: every
    // control is disabled, so nothing can be done with a forecast that is one
    // answer behind.
    let hold: (() => void) | null = null
    let calls = 0
    server.use(
      http.post(ROUTES.eventsImport, async ({ request }) => {
        calls += 1
        if (calls > 1) {
          await new Promise<void>((resolve) => {
            hold = resolve
          })
        }
        return HttpResponse.json(aReceipt({ file_accounts: [{ name: 'TR', rows: 47 }] }), {
          status: new URL(request.url).searchParams.has('dry_run') ? 200 : 201,
        })
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)
    const select = await screen.findByLabelText('Cible pour TR')
    await user.selectOptions(select, 'beta')

    await waitFor(() => expect(hold).not.toBeNull())
    // The very same control, still in the document — not a second one mounted in
    // its place, and not nothing.
    expect(screen.getByLabelText('Cible pour TR')).toBe(select)
    expect(select.isConnected).toBe(true)
    expect(select).toBeDisabled()
    expect(windowImportNow()).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Annuler' })).toBeInTheDocument()

    hold!()

    await waitFor(() => expect(screen.getByLabelText('Cible pour TR')).toBeEnabled())
    expect(screen.getByLabelText('Cible pour TR')).toBe(select)
  })

  it('disables the button when the answer itself is refused, and keeps the select', async () => {
    // **The other half of the criterion, and the one two passes missed** (#835).
    // The first read is the one carrying `map` and `declare`, so it is the read
    // `_settled_mapping` and `entries.judge` refuse when the reader retargets an
    // account — and it is thrown, so the forecast standing on screen is the
    // *previous* answer's. Left alone the window promises what that stale
    // forecast promised, with `Importer` live above it, and the refusal arrives
    // after the button rather than before it.
    const seen: URL[] = []
    let calls = 0
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) => {
        calls += 1
        const url = new URL(request.url)
        seen.push(url)
        if (calls > 1) {
          return HttpResponse.json(
            {
              type: PROBLEM_TYPES.unreplayableLedger,
              title: 'Ledger does not replay',
              status: 409,
              detail: 'Cannot sell 4.0 shares of ZZA (only 2.0 owned) on 2026-02-10',
              gesture: 'write',
              symbol: 'ZZA',
              wanted: 4,
              owned: 2,
              day: '2026-02-10',
            },
            { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
          )
        }
        return HttpResponse.json(aReceipt({ file_accounts: [{ name: 'TR', rows: 47 }] }), {
          status: url.searchParams.has('dry_run') ? 200 : 201,
        })
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)
    const select = await screen.findByLabelText('Cible pour TR')
    await user.selectOptions(select, 'beta')

    // The refusal is read before the button, and the button cannot be pressed.
    expect(await screen.findByText(/ce geste vend 4 parts de ZZA/)).toBeInTheDocument()
    await waitFor(() => expect(windowImportNow()).toBeDisabled())
    // The window is not a dead end: the select the reader has just used is the
    // same node, still there to answer differently.
    expect(screen.getByLabelText('Cible pour TR')).toBe(select)
    expect(select.isConnected).toBe(true)
    // And nothing was written — every request this walk made was a preview.
    expect(seen.every((url) => url.searchParams.has('dry_run'))).toBe(true)
  })

  it('offers the currency the file declares, and lets it be declined', async () => {
    // The app reads a declaration and never asserts one. The box is
    // ticked, because the round trip is the whole point of the column — upload
    // the export and the install is the install it came from — and it is a box,
    // because the answer cannot be taken back.
    const seen = watching(() => aReceipt({ currency: { declared: 'EUR', adopting: true } }))
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    expect(
      await screen.findByText(
        'Ce fichier enregistre ses montants en EUR, et vous n’avez pas encore choisi de devise de base. L’utiliser ? Elle ne pourra plus être changée.',
      ),
    ).toBeInTheDocument()
    await user.click(screen.getByLabelText('Utiliser EUR comme devise de base'))
    await user.click(windowImportNow())

    await waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1].searchParams.get('adopt_currency')).toBe('0')
  })

  it('asks nothing about a currency the install has already answered', async () => {
    // `adopting: false` — nothing is being offered, so there is no question to
    // put and no block to render.
    watching(() => aReceipt({ currency: { declared: 'EUR', adopting: false } }))
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    await windowImport()
    expect(screen.queryByText('La devise')).not.toBeInTheDocument()
  })

  it('keeps the window open on a refusal, with the button beside it', async () => {
    // A file the server turned back is still in the reader's hands. The window
    // stays, the sentence is the front's own, and the gesture that
    // leaves nothing behind is the one on offer.
    server.use(
      http.post(ROUTES.eventsImport, () =>
        HttpResponse.json(
          {
            type: PROBLEM_TYPES.invalidFile,
            title: 'Invalid file',
            status: 422,
            detail: 'the file declares USD as the reporting currency',
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    const window = await screen.findByRole('dialog')
    expect(
      await within(window).findByText(/L’application a refusé ce fichier et n’a rien écrit/),
    ).toBeInTheDocument()
    // There is no forecast behind a refusal, so the button is **disabled beside
    // the sentence** rather than absent: the window says what it would do and
    // why it will not.
    expect(within(window).getByRole('button', { name: 'Importer' })).toBeDisabled()
    expect(within(window).getByRole('button', { name: 'Annuler' })).toBeInTheDocument()
  })

  it('closes the window on the receipt, which stays until it is dismissed', async () => {
    // *A receipt lasts as long as the operation, never three seconds* — and the
    // window is not where it lives: the write is done, and what is left is the
    // sentence the app owes the reader.
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)
    await user.click(await windowImport())

    expect(await screen.findByText(/3 événements écrits/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Fermer ce reçu' }))

    expect(screen.queryByText(/3 événements écrits/)).not.toBeInTheDocument()
  })
})

describe('the currency of the amounts (#1261)', () => {
  function aFile(name = 'zeta-events_2.csv') {
    return new File(['date,event_type\n'], name, { type: 'text/csv' })
  }

  const AAPL = { symbol: 'AAPL', currency: 'USD', rows: 3 }
  const VOD = { symbol: 'VOD.L', currency: 'GBP', rows: 2 }

  /** Every request the route saw, answered with `receipt` unless `answer` says otherwise. */
  function watching(receipt: () => ImportReceipt, answer?: (url: URL) => Response | undefined) {
    const seen: URL[] = []
    server.use(
      http.post(ROUTES.eventsImport, ({ request }) => {
        const url = new URL(request.url)
        seen.push(url)
        return (
          answer?.(url) ??
          HttpResponse.json(receipt(), { status: url.searchParams.has('dry_run') ? 200 : 201 })
        )
      }),
    )
    return seen
  }

  async function hand(user: ReturnType<typeof renderImports>['user']) {
    await user.upload(fileField(), aFile())
  }

  async function open(receipt: () => ImportReceipt = () => aReceipt({ foreign_lines: [AAPL] })) {
    const seen = watching(receipt)
    const rendered = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await hand(rendered.user)
    return { ...rendered, seen }
  }

  it('renders no currency block when no line is foreign', async () => {
    await open(() => aReceipt())

    await windowImport()
    expect(screen.queryByText('Les montants en devise')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(windowImportNow()).toBeEnabled()
  })

  it('renders no currency block when the file declares its currency', async () => {
    // The server lists nothing for a file that states its amounts' unit, and the
    // window believes it: a file that declares one has answered.
    await open(() => aReceipt({ currency: { declared: 'EUR', adopting: false } }))

    await windowImport()
    expect(screen.queryByText('Les montants en devise')).not.toBeInTheDocument()
  })

  it('lists the foreign lines and leaves both radios unchecked', async () => {
    await open(() => aReceipt({ foreign_lines: [AAPL, VOD] }))

    const section = (await screen.findByText('Les montants en devise')).closest('section')!
    expect(
      within(section).getByText(/2 titres de ce fichier sont cotés hors EUR/),
    ).toBeInTheDocument()
    expect(within(section).getByText('AAPL')).toBeInTheDocument()
    expect(within(section).getByText('USD · 3 événements')).toBeInTheDocument()
    expect(within(section).getByText('VOD.L')).toBeInTheDocument()
    expect(within(section).getByText('GBP · 2 événements')).toBeInTheDocument()
    const radios = within(section).getAllByRole('radio')
    expect(radios).toHaveLength(2)
    for (const radio of radios) expect(radio).not.toBeChecked()
  })

  it('shows five lines and counts the rest past six', async () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((symbol) => ({
      symbol,
      currency: 'USD',
      rows: 1,
    }))
    await open(() => aReceipt({ foreign_lines: many }))

    const section = (await screen.findByText('Les montants en devise')).closest('section')!
    expect(within(section).getAllByRole('listitem')).toHaveLength(6)
    expect(within(section).getByText('et 2 autres')).toBeInTheDocument()
    expect(within(section).queryByText('F')).not.toBeInTheDocument()
  })

  it('keeps Import disabled with the reason written while unanswered', async () => {
    await open(() => aReceipt({ foreign_lines: [AAPL, VOD] }))

    expect(await windowImport()).toBeDisabled()
    expect(
      screen.getByText('Dites dans quelle devise sont les montants des titres cotés en USD, GBP.'),
    ).toBeInTheDocument()
  })

  it('re-reads the forecast with amounts_in when a radio is chosen', async () => {
    const { user, seen } = await open()

    await user.click(await screen.findByLabelText('En USD, la devise de chaque titre'))

    await waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[0].searchParams.has('amounts_in')).toBe(false)
    expect(seen[1].searchParams.get('amounts_in')).toBe('quote')
    expect(seen[1].searchParams.has('dry_run')).toBe(true)
    await waitFor(() => expect(windowImportNow()).toBeEnabled())
    expect(screen.queryByText(/Dites dans quelle devise/)).not.toBeInTheDocument()
  })

  it('shows the unconvertible refusal and keeps the radios enabled', async () => {
    const seen = watching(
      () => aReceipt({ foreign_lines: [AAPL] }),
      (url) =>
        url.searchParams.get('amounts_in') === 'quote'
          ? HttpResponse.json(
              {
                type: PROBLEM_TYPES.currencyUnconvertible,
                title: 'Currency not convertible',
                status: 422,
                symbol: 'AAPL',
                currency: 'USD',
                base: 'EUR',
                date: '2026-01-05',
              },
              { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
            )
          : undefined,
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await hand(user)

    await user.click(await screen.findByLabelText('En USD, la devise de chaque titre'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Aucun cours USD/EUR n’est connu autour du 2026-01-05 (AAPL) : ces montants ne peuvent pas être convertis. Choisissez « En EUR » ou réessayez plus tard.',
    )
    expect(windowImportNow()).toBeDisabled()
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeEnabled()

    // The other answer is one click away, and it is judged like any other.
    await user.click(screen.getByLabelText('En EUR, déjà convertis'))
    await waitFor(() => expect(windowImportNow()).toBeEnabled())
    expect(seen.at(-1)?.searchParams.get('amounts_in')).toBe('base')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('asks again when the refused answer is clicked a second time', async () => {
    const seen = watching(
      () => aReceipt({ foreign_lines: [AAPL] }),
      (url) =>
        url.searchParams.get('amounts_in') === 'quote'
          ? HttpResponse.json(
              {
                type: PROBLEM_TYPES.currencyUnconvertible,
                title: 'Currency not convertible',
                status: 422,
                symbol: 'AAPL',
                currency: 'USD',
                base: 'EUR',
                date: '2026-01-05',
              },
              { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
            )
          : undefined,
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())
    await hand(user)

    const quote = await screen.findByLabelText('En USD, la devise de chaque titre')
    await user.click(quote)
    await screen.findByRole('alert')
    const before = seen.length

    await user.click(quote)

    await waitFor(() => expect(seen.length).toBe(before + 1))
    expect(seen.at(-1)?.searchParams.get('amounts_in')).toBe('quote')
  })

  it('names the unverified securities', async () => {
    await open(() => aReceipt({ foreign_lines: [AAPL], unverified: ['XYZ', 'ABC'] }))

    expect(
      await screen.findByText(
        'La devise de 2 titres n’a pas pu être vérifiée (XYZ, ABC) : leurs montants seront lus en EUR.',
      ),
    ).toBeInTheDocument()
  })

  it('says it is checking currencies while the first forecast is in flight', async () => {
    let release: (() => void) | null = null
    server.use(
      http.post(ROUTES.eventsImport, async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return HttpResponse.json(aReceipt())
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    await hand(user)

    expect(
      await screen.findByText('Lecture de zeta-events_2.csv et vérification des devises…'),
    ).toBeInTheDocument()
    await waitFor(() => expect(release).not.toBeNull())
    release!()
    await windowImport()
  })

  it('sends amounts_in and the foreign pairs with the commit', async () => {
    const { user, seen } = await open(() => aReceipt({ foreign_lines: [AAPL, VOD] }))

    await user.click(await screen.findByLabelText('En USD, GBP, la devise de chaque titre'))
    await waitFor(() => expect(windowImportNow()).toBeEnabled())
    await user.click(windowImportNow())

    await waitFor(() => expect(seen.some((url) => !url.searchParams.has('dry_run'))).toBe(true))
    const written = seen.find((url) => !url.searchParams.has('dry_run'))!
    expect(written.searchParams.get('amounts_in')).toBe('quote')
    expect(written.searchParams.getAll('foreign')).toEqual(['AAPL:USD', 'VOD.L:GBP'])
  })

  it('forgets the answer when another file is handed over', async () => {
    const { user } = await open()
    await user.click(await screen.findByLabelText('En EUR, déjà convertis'))
    await waitFor(() => expect(windowImportNow()).toBeEnabled())

    await user.click(screen.getByRole('button', { name: 'Annuler' }))
    await hand(user)

    await screen.findByText('Les montants en devise')
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked()
    expect(windowImportNow()).toBeDisabled()
  })

  it('gives the radio group an accessible name and each radio a description', async () => {
    await open()

    const group = await screen.findByRole('group', {
      name: /Dans quelle devise votre courtier a-t-il écrit leurs montants/,
    })
    const inBase = within(group).getByRole('radio', { name: 'En EUR, déjà convertis' })
    expect(inBase).toHaveAccessibleDescription('Ils sont écrits tels quels.')
    expect(
      within(group).getByRole('radio', { name: 'En USD, la devise de chaque titre' }),
    ).toHaveAccessibleDescription(/Convertis en EUR au cours de clôture/)
  })
})
