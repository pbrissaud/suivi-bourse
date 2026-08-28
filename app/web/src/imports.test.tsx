/**
 * **Import et export** (#728, #811, #813, ADR-0020, ADR-0032), at the one seam:
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
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ROUTES, type Account, type LedgerEvent } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  anAccount,
  anAccountsPayload,
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
    server.use(http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload(accounts, declared))))
  }
  return renderApp({ url: '/donnees' })
}

function ledger() {
  return screen.getByRole('table', { name: 'Vos événements' })
}

describe('one population, and no source to act on', () => {
  it('renders no list of sources and offers no revocation anywhere', async () => {
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    // The bar is still there — it holds the zone and the export — and what it
    // no longer holds is a table of files (#816, ADR-0032).
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

/** The export is a menu since #794: its entries exist once it is open. */
async function openExport(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Exporter' }))
  return screen.findByRole('menu')
}

/** The imports bar above the table: the drop zone and the export menu, and no more. */
function block() {
  return screen.getByRole('region', { name: 'Import et export' })
}

describe('the export', () => {
  it('offers four files: the ledger, the workbook, the selection and the portfolio', async () => {
    // **The criterion of #836**, said on the rendering. Each entry carries its
    // own perimeter under it and its format beside it, which is what lets two
    // of them share a label without being the same gesture.
    const { user } = renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())
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
    // Nothing announces that a round trip takes two files: it does not
    // (ADR-0034). A label saying so would send the reader looking for a second
    // file the menu no longer has.
    expect(within(menu).queryByText(/deux fichiers/)).not.toBeInTheDocument()
  })

  it('offers no accounts declaration, whatever this install has declared', async () => {
    // ADR-0034, and the fourth entry does not reopen it. Nothing reads an
    // accounts *file* back in, so one offered here would be a backup that
    // restores nothing — the residue that is worst because it *looks* like half
    // a round trip. What the menu offers instead is a **report**, named after
    // what is in it, and the import refuses it by name.
    const declared = await openExport(renderImports({ accounts: [anAccount({ id: 'zeta' })] }).user)
    expect(within(declared).queryByRole('menuitem', { name: 'Vos comptes' })).not.toBeInTheDocument()
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

    await user.click(screen.getByRole('button', { name: /^Achat/ }))
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
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.click(within(await openExport(user)).getByRole('menuitem', { name: /Tous vos événements.*grand livre/ }))

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
    await user.click(screen.getByRole('button', { name: /^Achat/ }))
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
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.click(
      within(await openExport(user)).getByRole('menuitem', { name: /Tous vos événements.*Classeur/ }),
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
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.click(within(await openExport(user)).getByRole('menuitem', { name: /Tous vos événements.*grand livre/ }))

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
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.click(within(await openExport(user)).getByRole('menuitem', { name: /Tous vos événements.*grand livre/ }))

    // Read by `problem.type` like every other refusal, never by the sentence
    // the server wrote for a log.
    expect(
      await screen.findByText(/Les données ne sont pas lisibles pour l’instant/),
    ).toBeInTheDocument()
    expect(saved).toEqual([])
  })

  it('lives in the bar, which holds the drop zone with it and nothing else', async () => {
    renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())

    // One bar above the table (#794, ADR-0030, ADR-0032): the zone and the
    // menu, and **no list of files** since #816. Getting one's data out is a
    // question of files, not of the ledger.
    const bar = block()
    expect(within(bar).getByText(/Importer un \.csv ou un \.xlsx/)).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: 'Exporter' })).toBeInTheDocument()
    expect(within(bar).queryByRole('table')).toBeNull()
  })

  it('puts the bar above the ledger it describes', async () => {
    renderImports()
    await waitFor(() => expect(ledger()).toBeInTheDocument())

    const bar = block()
    expect(bar.compareDocumentPosition(ledger()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('an install that has imported nothing', () => {
  it('offers the file entrance once, with a declaration and nothing recorded', async () => {
    // An install with something declared and no event. The bar stood here while
    // the declaration was itself a file worth handing back; ADR-0034 took that
    // file away, so what there is to hand back is the ledger — and there is
    // none. The gesture is then offered once, by the empty state's own entry.
    renderImports({ events: [], accounts: [anAccount({ id: 'zeta' })] })
    await screen.findByText('Importer un fichier')

    expect(screen.queryByRole('region', { name: 'Import et export' })).not.toBeInTheDocument()
    expect(screen.getAllByLabelText('Choisir un fichier')).toHaveLength(1)
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
    expect(screen.getByLabelText('Choisir un fichier')).toBeInTheDocument()
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
    await user.upload(screen.getByLabelText('Choisir un fichier'), file)
    await user.click(await screen.findByRole('button', { name: 'Importer' }))
  }

  it('previews the file before writing it, and writes on the confirmation', async () => {
    // **The criterion, in the order the reader lives it** (#813, ADR-0032): the
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
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.upload(screen.getByLabelText('Choisir un fichier'), aFile())

    expect(
      await screen.findByText(
        /3 événements seront écrits, du 5 janv\. 2026 au 27 févr\. 2026, sur 1 compte et 2 titres\./,
      ),
    ).toBeInTheDocument()
    // Nothing has been written yet, and the app has asked for nothing but the
    // forecast — which is the property the server side asserts on the table.
    expect(seen).toEqual(['preview'])

    await user.click(screen.getByRole('button', { name: 'Importer' }))

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
    expect(screen.queryByRole('button', { name: 'Importer' })).not.toBeInTheDocument()
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
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.upload(screen.getByLabelText('Choisir un fichier'), aFile())
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
        return HttpResponse.json(aReceipt({ rows: 3, written: 1, duplicates: 2 }), {
          status: previewing ? 200 : 201,
        })
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.upload(screen.getByLabelText('Choisir un fichier'), aFile())

    expect(
      await screen.findByText(
        /2 lignes de ce fichier sont déjà dans votre grand livre et seront ignorées\./,
      ),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Importer' }))

    expect(
      await screen.findByText(
        /2 lignes étaient déjà dans votre grand livre et n’ont pas été réécrites\./,
      ),
    ).toBeInTheDocument()
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
        return HttpResponse.json(aReceipt({ rows: 3, written: 1, duplicates: 2 }), {
          status: previewing ? 200 : 201,
        })
      }),
    )
    const { user } = renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.upload(screen.getByLabelText('Choisir un fichier'), aFile())
    await user.click(
      await screen.findByLabelText('Écrire quand même les lignes déjà dans mon grand livre'),
    )
    await user.click(screen.getByRole('button', { name: 'Importer' }))

    await waitFor(() => expect(asked).toEqual(['1']))
  })

  it('asks nothing about duplicates when the file has none', async () => {
    // A box about rows that do not exist is a question the reader cannot
    // answer — the default receipt carries no duplicate at all.
    const { user } = renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.upload(screen.getByLabelText('Choisir un fichier'), aFile())
    await screen.findByRole('button', { name: 'Importer' })

    expect(
      screen.queryByLabelText('Écrire quand même les lignes déjà dans mon grand livre'),
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
    await waitFor(() => expect(block()).toBeInTheDocument())

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
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.upload(screen.getByLabelText('Choisir un fichier'), aFile('vide.csv'))

    // The forecast says it first, in its own tense — there is nothing to write.
    expect(
      await screen.findByText('vide.csv ne porte aucun événement : il n’y a rien à écrire.'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Importer' }))

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
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.upload(screen.getByLabelText('Choisir un fichier'), aFile())

    expect(
      await screen.findByText(/L’application a refusé ce fichier et n’a rien écrit/),
    ).toBeInTheDocument()
    // The server's own sentence is a diagnostic for a log, and English: it is
    // carried, and rendered nowhere (ADR-0024).
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
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.upload(screen.getByLabelText('Choisir un fichier'), aFile())

    expect(
      await screen.findByText(
        'L’application a refusé et n’a rien écrit : ce geste vend 12 parts de AAPL, ' +
          'et votre grand livre n’en porte que 10 ce jour-là.',
      ),
    ).toBeInTheDocument()
    // Neither the sentence of `problem.conflict` — the one this refusal used to
    // borrow — nor a word of the server's English (ADR-0024).
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
    await waitFor(() => expect(block()).toBeInTheDocument())

    await user.upload(screen.getByLabelText('Choisir un fichier'), aFile())

    expect(
      await screen.findByText(/dépasse ce que l’application accepte en une fois/),
    ).toBeInTheDocument()
  })

  it('keeps the receipt when the first import fills an empty ledger', async () => {
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

  it('reads the ledger again once the rows have landed', async () => {
    // The server replays before answering (#697), so the receipt is the moment
    // every figure downstream of the ledger is stale — and the table below is
    // the nearest of them.
    const { user } = renderImports()
    await waitFor(() => expect(block()).toBeInTheDocument())
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
