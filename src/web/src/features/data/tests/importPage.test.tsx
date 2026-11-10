/**
 * **The import page** (« Relevé », `/ledger/import`, mockup
 * `GrandLivre-Import-Refonte`): the file is previewed line by line, each line
 * has its *Issue*, and only the new rows — with the owner's resolutions — are
 * committed. HTTP is the only faked edge; the multipart body does not survive
 * jsdom, so what is asserted is the request the app made (the fields it sent),
 * not what a server would read out of the file.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { ImportPreview, ImportPreviewRow } from '@/features/data/lib/api'
import { handOver as handOverFile } from '@/features/data/lib/handoff'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { renderApp } from '@/test/render'
import { setViewportWidth } from '@/test/media'
import { server } from '@/test/server'

function aRow(overrides: Partial<ImportPreviewRow> = {}): ImportPreviewRow {
  return {
    row: 1,
    status: 'new',
    reason: null,
    reason_code: null,
    reason_values: null,
    date: '2026-11-06',
    event_type: 'BUY',
    symbol: 'CW8.PA',
    isin: 'LU1681043599',
    name: 'Amundi MSCI World',
    quantity: 2,
    unit_price: 512.3,
    fee: null,
    amount: null,
    notes: 'ACHAT COMPTANT',
    account: 'alpha',
    matched_event_id: null,
    matched_on: null,
    ...overrides,
  }
}

function aPreview(rows: ImportPreviewRow[], overrides: Partial<ImportPreview> = {}): ImportPreview {
  const count = (status: string) => rows.filter((row) => row.status === status).length
  return {
    token: 'tok-1',
    filename: 'releve.csv',
    account_id: 'alpha',
    has_accounts: false,
    unnamed_rows: 0,
    base_currency: 'EUR',
    foreign_lines: [],
    unverified: [],
    counts: {
      new: count('new'),
      duplicate: count('duplicate'),
      unknown_security: count('unknown_security'),
      unreadable: count('unreadable'),
    },
    rows,
    ...overrides,
  }
}

const ROWS = [
  aRow(),
  aRow({
    row: 2,
    status: 'duplicate',
    date: '2026-10-01',
    matched_event_id: 'e1',
    matched_on: ['isin', 'date', 'quantity', 'price'],
  }),
  aRow({
    row: 3,
    status: 'duplicate',
    date: '2026-10-01',
    event_type: 'DEPOSIT',
    symbol: null,
    isin: null,
    name: null,
    quantity: null,
    unit_price: null,
    amount: 450,
    matched_event_id: 'e2',
    matched_on: ['date', 'amount'],
  }),
  aRow({
    row: 4,
    status: 'unknown_security',
    symbol: null,
    name: null,
    isin: 'IE00B5BMR087',
  }),
  aRow({
    row: 5,
    status: 'unreadable',
    reason: 'x is not a date',
    reason_code: 'bad_date',
    reason_values: { value: 'hier' },
    date: null,
    event_type: null,
  }),
]

/** What a multipart body says for one field, or `null` where it has none. */
function fieldOf(body: string, name: string): string | null {
  return body.match(new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]*)`))?.[1] ?? null
}

/** The preview route answers `answer`, and records the bodies it was sent. */
function previewing(answer: ImportPreview | Response = aPreview(ROWS)) {
  const sent: string[] = []
  server.use(
    http.post(ROUTES.eventsImportPreview, async ({ request }) => {
      sent.push(await request.text())
      return answer instanceof Response ? answer : HttpResponse.json(answer)
    }),
  )
  return sent
}

async function handOver(user: ReturnType<typeof renderApp>['user']) {
  const file = new File(['date,event_type\n'], 'releve.csv', { type: 'text/csv' })
  await user.upload(await screen.findByLabelText('Choisir un fichier'), file)
}

describe('the import page', () => {
  it('reads at once a file chosen on the empty ledger', async () => {
    const sent = previewing()
    handOverFile(new File(['date,event_type\n'], 'releve.csv', { type: 'text/csv' }))
    renderApp({ url: '/ledger/import' })

    expect(await screen.findByRole('table', { name: 'Aperçu de l’import' })).toBeInTheDocument()
    expect(sent).toHaveLength(1)
  })

  it('shows the account of each line when the file names them', async () => {
    previewing(aPreview(ROWS, { has_accounts: true }))
    const { user } = renderApp({ url: '/ledger/import' })
    await handOver(user)

    const table = await screen.findByRole('table', { name: 'Aperçu de l’import' })
    expect(within(table).getByRole('columnheader', { name: 'Compte' })).toBeInTheDocument()
    expect(screen.getByText(/Compte des lignes sans compte/)).toBeInTheDocument()
  })

  it('asks for a file first, naming the account it goes into, and reads nothing yet', async () => {
    const sent = previewing()
    renderApp({ url: '/ledger/import' })

    expect(await screen.findByLabelText('Choisir un fichier')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Importer dans : Alpha/ })).toBeInTheDocument()
    expect(sent).toHaveLength(0)
  })

  it('takes the account from the address', async () => {
    renderApp({ url: '/ledger/import?account=beta' })

    expect(await screen.findByRole('button', { name: /Importer dans : Beta/ })).toBeInTheDocument()
  })

  it('previews the file against the chosen account and says each line’s issue', async () => {
    const sent = previewing()
    const { user } = renderApp({ url: '/ledger/import' })

    await handOver(user)

    const table = await screen.findByRole('table', { name: 'Aperçu de l’import' })
    expect(sent).toHaveLength(1)
    expect(fieldOf(sent[0], 'account_id')).toBe('alpha')
    expect(within(table).getByText('Nouveau')).toBeInTheDocument()
    expect(
      within(table).getByText('Déjà présent · même ISIN, date, quantité, prix'),
    ).toBeInTheDocument()
    expect(within(table).getByText('Déjà présent · même date et montant')).toBeInTheDocument()
    expect(within(table).getByText('Titre inconnu')).toBeInTheDocument()
    expect(within(table).getByText('Illisible')).toBeInTheDocument()
    // The reason is in the row, in French, with no hover needed.
    expect(within(table).getByText(/« hier » n’est pas une date/)).toBeVisible()
    expect(screen.getByText('releve.csv')).toBeInTheDocument()
    // Only the new line will be written.
    expect(screen.getByRole('button', { name: 'Importer 1 événement' })).toBeEnabled()
  })

  it('narrows the table to one issue with the tabs, counting each', async () => {
    previewing()
    const { user } = renderApp({ url: '/ledger/import' })
    await handOver(user)
    await screen.findByRole('table', { name: 'Aperçu de l’import' })

    expect(screen.getByRole('tab', { name: /Tout 5/ })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Déjà présents 2/ }))

    const table = screen.getByRole('table', { name: 'Aperçu de l’import' })
    expect(within(table).queryByText('Nouveau')).not.toBeInTheDocument()
    expect(within(table).getAllByText(/^Déjà présent/)).toHaveLength(2)
  })

  it('reads the file again for another account', async () => {
    const sent = previewing()
    const { user } = renderApp({ url: '/ledger/import' })
    await handOver(user)
    await screen.findByRole('table', { name: 'Aperçu de l’import' })

    await user.click(screen.getByRole('button', { name: /Importer dans/ }))
    await user.click(await screen.findByRole('option', { name: 'Beta' }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(fieldOf(sent[1], 'account_id')).toBe('beta')
  })

  it('associates a stranger with a ticker, and commits it with the token', async () => {
    previewing()
    let committed: unknown
    server.use(
      http.post(ROUTES.eventsImportCommit, async ({ request }) => {
        committed = await request.json()
        return HttpResponse.json(
          { imported: 2, duplicate: 2, unknown_security: 0, unreadable: 1 },
          { status: 201 },
        )
      }),
    )
    const { user } = renderApp({ url: '/ledger/import' })
    await handOver(user)
    await screen.findByRole('table', { name: 'Aperçu de l’import' })

    await user.click(screen.getByRole('button', { name: 'Associer' }))
    await user.type(screen.getByRole('combobox', { name: 'Ticker de la ligne 4' }), 'CW8.PA')
    await user.tab()

    expect(await screen.findByText('Associé à CW8.PA')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Importer 2 événements' }))

    await waitFor(() =>
      expect(committed).toEqual({ token: 'tok-1', associate: [{ row: 4, security: 'CW8.PA' }] }),
    )
    // Back on the ledger once it is written.
    expect(await screen.findByRole('link', { name: 'Importer' })).toBeInTheDocument()
  })

  it('says a refusal of the file in the server’s terms, and offers another file', async () => {
    previewing(
      new Response(
        JSON.stringify({
          status: 422,
          type: PROBLEM_TYPES.invalidFile,
          title: 'Invalid file',
          detail: 'not a ledger',
          file: 'releve.csv',
        }),
        { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    )
    const { user } = renderApp({ url: '/ledger/import' })

    await handOver(user)

    expect(await screen.findByRole('alert')).toHaveTextContent(/a refusé releve\.csv/)
    expect(screen.getByRole('button', { name: 'Autre fichier' })).toBeInTheDocument()
  })

  it('says a file with no line plainly, and writes nothing', async () => {
    previewing(aPreview([]))
    const { user } = renderApp({ url: '/ledger/import' })

    await handOver(user)

    expect(await screen.findByText('Aucune ligne dans ce fichier')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Importer \d/ })).not.toBeInTheDocument()
  })

  it('words the refusal of a malformed file in French from its code', async () => {
    previewing(
      new Response(
        JSON.stringify({
          status: 422,
          type: PROBLEM_TYPES.invalidFile,
          title: 'Invalid file',
          detail: 'releve.csv has a header this app does not recognise',
          file: 'releve.csv',
          code: 'header',
        }),
        { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    )
    const { user } = renderApp({ url: '/ledger/import' })

    await handOver(user)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/L’en-tête de releve\.csv n’est pas reconnu/)
    expect(alert).not.toHaveTextContent(/header/)
  })

  it('says « Choisir un fichier » once', async () => {
    renderApp({ url: '/ledger/import' })

    await screen.findByLabelText('Choisir un fichier')
    expect(screen.getAllByText('Choisir un fichier')).toHaveLength(1)
  })

  it('preselects no account for a file that names them, and asks for one only if lines name none', async () => {
    previewing(aPreview(ROWS, { has_accounts: true, unnamed_rows: 2 }))
    const { user } = renderApp({ url: '/ledger/import' })
    await handOver(user)

    await screen.findByRole('table', { name: 'Aperçu de l’import' })
    expect(
      screen.getByRole('button', { name: /Importer dans : Choisir un compte/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Importer 1 événement/ })).toBeDisabled()
    expect(screen.getByText(/Certaines lignes ne nomment aucun compte/)).toBeInTheDocument()
  })

  it('does not hold the commit back when every line names its account', async () => {
    previewing(aPreview(ROWS, { has_accounts: true, unnamed_rows: 0 }))
    const { user } = renderApp({ url: '/ledger/import' })
    await handOver(user)

    await screen.findByRole('table', { name: 'Aperçu de l’import' })
    expect(
      screen.getByRole('button', { name: /Importer dans : Choisir un compte/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Importer 1 événement/ })).toBeEnabled()
  })

  it('asks what the amounts of a foreign security are written in, and sends the answer', async () => {
    previewing(
      aPreview([aRow({ symbol: 'AAPL', isin: null, name: 'Apple' })], {
        foreign_lines: [{ symbol: 'AAPL', currency: 'USD', rows: 1 }],
      }),
    )
    let committed: unknown
    server.use(
      http.post(ROUTES.eventsImportCommit, async ({ request }) => {
        committed = await request.json()
        return HttpResponse.json(
          { imported: 1, duplicate: 0, unknown_security: 0, unreadable: 0 },
          { status: 201 },
        )
      }),
    )
    const { user } = renderApp({ url: '/ledger/import' })
    await handOver(user)

    expect(await screen.findByText(/AAPL est coté en USD · 1 ligne/)).toBeInTheDocument()
    // The assumption is said before anything is written: as the base.
    expect(screen.getByRole('button', { name: /EUR, la devise du portefeuille/ })).toBeVisible()
    await user.click(screen.getByRole('button', { name: /EUR, la devise du portefeuille/ }))
    await user.click(await screen.findByRole('option', { name: /USD, la devise de cotation/ }))
    await user.click(screen.getByRole('button', { name: 'Importer 1 événement' }))

    await waitFor(() =>
      expect(committed).toEqual({
        token: 'tok-1',
        associate: [],
        foreign: [{ symbol: 'AAPL', currency: 'USD', amounts_in: 'quote' }],
      }),
    )
  })

  it('draws ruled rows on a phone, each with its status', async () => {
    setViewportWidth(390)
    try {
      previewing()
      const { user } = renderApp({ url: '/ledger/import' })
      await handOver(user)

      const list = await screen.findByRole('list', { name: 'Aperçu de l’import' })
      expect(within(list).getAllByRole('listitem')).toHaveLength(ROWS.length)
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
      expect(within(list).getByText('Nouveau')).toBeVisible()
      expect(within(list).getByText(/« hier » n’est pas une date/)).toBeVisible()
    } finally {
      setViewportWidth(1024)
    }
  })
})
