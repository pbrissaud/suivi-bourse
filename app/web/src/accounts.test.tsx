/**
 * The accounts page (#721, ADR-0019, ADR-0016), at the one seam: the whole app
 * in jsdom, HTTP the only faked edge.
 *
 * *A comparison never outruns the period where it exists* is not a property of
 * a chart component — it appears only once the range control, the curves and
 * the table's scalar column are mounted together, which is why this suite lives
 * here.
 *
 * The fixture's arithmetic is by hand in `test/factories.ts`. Two figures carry
 * the whole ticket:
 *
 *     stored     alpha 171,5   ·   beta 115,0     — 6,8 years beside 2,4
 *     rebased    1 an: beta +15,00 % > alpha +14,33 %
 *                1 mois: alpha +3,94 % > beta  +2,68 %
 *
 * Four windows, one inversion, every figure correct.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import type { Account } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  anAccount,
  anAccountsPayload,
  anAccountWithoutSeries,
  aRuntime,
  defaultAccounts,
  theSeededAccount,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

function renderAccounts(accounts: Account[] = defaultAccounts()) {
  server.use(http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload(accounts))))
  return renderApp({ url: '/comptes' })
}

function table() {
  return screen.getByRole('table', { name: 'Vos comptes, comparés' })
}

function rows() {
  return within(table())
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.textContent ?? '')
}

function columnNames() {
  return within(table())
    .getAllByRole('columnheader')
    .map((cell) => (cell.textContent ?? '').replace(/[↑↓]/g, '').trim())
}

/**
 * The page is settled once the rebasing has run: `+14,33 %` appears twice, on
 * the strip and in the `perf` cell, which is the coupling the ticket is about.
 */
async function settled() {
  await waitFor(() => expect(screen.getAllByText(/\+14,33/)).toHaveLength(2))
}

function range() {
  return screen.getByRole('radiogroup', { name: 'Plage' })
}

describe('the comparison', () => {
  it('rebases both series to 100 at the start of the window, never showing the stored index', async () => {
    renderAccounts()
    await settled()

    // `171,5` read as an index would render `+71,50 %` beside `+15,00 %`: a
    // figure counted from 2019 next to one counted from 2025.
    expect(screen.getAllByText(/\+15,00/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/\+71,50/)).not.toBeInTheDocument()
    expect(screen.queryByText(/171,5/)).not.toBeInTheDocument()
  })

  it('drives the chart and the table’s scalar column from one control', async () => {
    const { user } = renderAccounts()
    await settled()

    // One control on the page, and one only: two would be two announcers.
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1)

    // Over one month the ranking is the other way round — and both the strip
    // under the chart and the `perf` cell move together, because they read one
    // rebasing.
    await user.click(within(range()).getByRole('radio', { name: '1M' }))
    expect(await screen.findAllByText(/\+3,94/)).toHaveLength(2)
    expect(screen.getAllByText(/\+2,68/)).toHaveLength(2)
    expect(screen.queryByText(/\+14,33/)).not.toBeInTheDocument()
  })

  it('offers four presets and never MAX', async () => {
    renderAccounts()
    await settled()

    expect(within(range()).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      '1M',
      'Depuis le 1ᵉʳ janvier',
      '1A',
      'Depuis l’ouverture',
    ])
    expect(within(range()).queryByRole('radio', { name: 'MAX' })).not.toBeInTheDocument()
  })

  it('reads one thing only — there is no amounts view to mount four curves on', async () => {
    renderAccounts()
    await settled()

    // *Amounts* here is four curves at two accounts, ten at five, the pairs
    // overlapping and no surface being anybody's gain.
    expect(screen.queryByRole('radio', { name: /montants/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })
})

describe('the table', () => {
  it('carries eight columns, the type folded into the account cell', async () => {
    renderAccounts()
    await settled()

    expect(columnNames()).toEqual([
      'Compte',
      'Valeur totale',
      'Titres',
      'Liquidités',
      'Versé net',
      'Gain total',
      'TRI',
      'perf',
    ])
    // `Type` is a second level of the `Compte` cell rather than a column.
    expect(rows()[0]).toContain('PEA')
  })

  it('carries Gain total alone — its four terms live in the panel', async () => {
    renderAccounts()
    await settled()

    // A total and its terms never share a row: mounted side by side they are
    // numeric columns of equal weight, and nothing says the last four are
    // inside the first. The twelve-column variant fits at 1 440 px, which is
    // exactly what condemns it.
    expect(columnNames()).not.toContain('Latente')
    expect(columnNames()).not.toContain('Réalisée')
    expect(columnNames()).not.toContain('Dividendes')
    // `Versé net` stays though it is `Valeur − Gain`: it is the silent
    // denominator of the two columns after it.
    expect(columnNames()).toContain('Versé net')
  })

  it('closes with a Portefeuille line, never a Total, and it is not a train of dashes', async () => {
    renderAccounts()
    await settled()

    const last = rows()[rows().length - 1]
    expect(last).toContain('Portefeuille')
    expect(within(table()).queryByText('Total')).not.toBeInTheDocument()
    // The two rates are not sums — two rates do not add — and they are not
    // absences either: the store holds both at portfolio level.
    expect(last).toMatch(/\+3,22/)
    expect(last).toMatch(/\+6,78/)
    expect(last).toMatch(/2\s?800,00/)
  })

  it('keeps the portfolio out of the strip under the chart', async () => {
    renderAccounts()
    await settled()

    // The portfolio is not drawn — its curve is the dashboard's — so the strip
    // carries one scalar per **drawn** curve and its performance lives in its
    // table row only.
    expect(screen.getAllByText(/\+6,78/)).toHaveLength(1)
    expect(within(table()).getByText(/\+6,78/)).toBeInTheDocument()
  })

  it('keeps the declaration order when the window changes', async () => {
    const { user } = renderAccounts()
    await settled()

    const order = () => rows().map((row) => row.slice(0, 5))
    const before = order()
    await user.click(within(range()).getByRole('radio', { name: '1M' }))
    await screen.findAllByText(/\+3,94/)
    expect(order()).toEqual(before)
    await user.click(within(range()).getByRole('radio', { name: 'Depuis l’ouverture' }))
    // Bounded at the youngest opening, the old account is **down** — and the
    // rows have not moved for it.
    await screen.findAllByText(/-4,72/)
    expect(order()).toEqual(before)
  })

  it('sorts on a header when the reader asks for it', async () => {
    const { user } = renderAccounts()
    await settled()

    await user.click(screen.getByRole('button', { name: 'Trier par Valeur totale' }))
    expect(rows()[0]).toContain('Alpha')
    await user.click(screen.getByRole('button', { name: 'Trier par Valeur totale' }))
    expect(rows()[0]).toContain('Beta')
  })

  it('says which column is sorted, and which way, without the glyph', async () => {
    // The direction lived only in the ` ↑` / ` ↓` inside the button — whose
    // accessible name the `aria-label` overrides — so the one state of this
    // table a sighted reader gets for free was announced to nobody. The helper
    // above strips those arrows before comparing, which is why no test saw it.
    const { user } = renderAccounts()
    await settled()

    const header = () =>
      screen.getByRole('button', { name: 'Trier par Valeur totale' }).closest('th')!

    expect(header()).toHaveAttribute('aria-sort', 'none')
    await user.click(screen.getByRole('button', { name: 'Trier par Valeur totale' }))
    expect(header()).toHaveAttribute('aria-sort', 'descending')
    await user.click(screen.getByRole('button', { name: 'Trier par Valeur totale' }))
    expect(header()).toHaveAttribute('aria-sort', 'ascending')
  })
})

describe('the two gestures', () => {
  function accountRow(name: string) {
    return within(table())
      .getAllByRole('row')
      .find((row) => (row.textContent ?? '').includes(name))!
  }

  it('previews a curve on hover and puts it back on the way out', async () => {
    const { user } = renderAccounts()
    await settled()

    await user.hover(accountRow('Alpha'))
    expect(accountRow('Alpha')).toHaveAttribute('aria-selected', 'true')
    // Pointing at a row is not choosing it: nothing opens, and nothing is left
    // behind once the pointer goes.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.unhover(accountRow('Alpha'))
    expect(accountRow('Alpha')).toHaveAttribute('aria-selected', 'false')
  })

  it('opens the panel from anywhere on the row, not from the name alone', async () => {
    const { user } = renderAccounts()
    await settled()

    // The click target is the whole row — a figure cell is as good as the name.
    // The row is held by reference: the open panel puts the whole column behind
    // an `aria-hidden`, so it cannot be queried again.
    const beta = accountRow('Beta')
    await user.click(within(beta).getAllByRole('cell')[1])
    expect(await screen.findByRole('dialog')).toHaveTextContent('Beta')
  })

  it('lets the keyboard preview what the pointer previews', async () => {
    const { user } = renderAccounts()
    await settled()

    // Hover says nothing to a keyboard, so focus carries the same preview —
    // without it the isolated curve would exist for the mouse alone.
    await user.tab()
    while (
      document.activeElement?.textContent !== 'Alpha' &&
      document.activeElement !== document.body
    ) {
      await user.tab()
    }
    expect(accountRow('Alpha')).toHaveAttribute('aria-selected', 'true')
  })

  it('leaves a row with no curve out of the gesture that previews one', async () => {
    const { user } = renderAccounts()
    await settled()

    // `gamma` has no cash event, so no index, so no curve on the plot. Previewed
    // it would dim every drawn series and put none forward — the chart going
    // out for a gesture with no subject, on a line reading as chosen. It still
    // **opens**, because a row with no curve is still an account.
    await user.hover(accountRow('Gamma'))
    expect(accountRow('Gamma')).not.toHaveAttribute('aria-selected')
    expect(accountRow('Alpha')).toHaveAttribute('aria-selected', 'false')

    await user.click(accountRow('Gamma'))
    expect(await screen.findByRole('dialog')).toHaveTextContent('Gamma')
  })
})

describe('the degraded rows', () => {
  it('names two different reasons where the dashes look alike', async () => {
    // *Without a cash ledger* is five dashes out of eight and *being rebuilt* is
    // eight; the trains of dashes are indistinguishable, the sentences are not.
    renderAccounts([...defaultAccounts(), anAccountWithoutSeries({ id: 'delta', label: 'Delta' })])
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    await settled()

    expect(screen.getByText('aucun mouvement d’espèces enregistré sur ce compte')).toBeInTheDocument()
    expect(screen.getByText('historique encore en reconstruction')).toBeInTheDocument()
  })

  it('names a reason and never a progress with a target date', async () => {
    renderAccounts([...defaultAccounts(), anAccountWithoutSeries({ id: 'delta', label: 'Delta' })])
    await settled()

    // A progression with a date belongs to the banner, which is the one place
    // that can carry it without repeating it per row.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(within(table()).queryByText(/%.*reconstruction|reconstruction.*%/)).not.toBeInTheDocument()
  })

  it('drops a column absent for every account, and keeps it for one out of three', async () => {
    const noCash = defaultAccounts().map((account) => ({
      ...account,
      total_value: null,
      cash_balance: null,
      net_contributed: null,
      xirr: null,
      twr_index: null,
    }))
    renderAccounts(noCash)
    await waitFor(() => expect(columnNames()).not.toContain('Liquidités'))

    // `Liquidités` follows `total_value`: without a ledger the balance is
    // defined and false. As soon as one account out of three has one, the
    // dashes come back — there they are a difference between the accounts.
    expect(columnNames()).not.toContain('Valeur totale')
    expect(columnNames()).toContain('Titres')
  })

  it('distinguishes the unassigned line and gives it the way back', async () => {
    renderAccounts([...defaultAccounts(), theSeededAccount()])
    await settled()

    // The one line the promise *your declared accounts* does not cover — and
    // while it still wears the name the schema seeded, that name comes from the
    // catalogue rather than from the payload (#745).
    expect(screen.getByRole('button', { name: 'Non affecté' })).toBeInTheDocument()
    expect(screen.queryByText('Default account')).not.toBeInTheDocument()
    // **The gesture, not the page** (#725): a link with no hash landed on the
    // ledger and left the reader to find the reassignment for themselves.
    expect(
      screen.getByRole('link', { name: 'Affecter ces événements à un compte' }),
    ).toHaveAttribute('href', '/donnees#reassignment')
  })

  it('wears the name its owner gave it, once they have given one', async () => {
    // #729 refines #745 rather than contradicting it, and the argument is
    // #745's own: what must never follow the reader is a value *the server*
    // seeded — English, written about a row nobody declared. A name the owner
    // typed is not that, and the declaration block is the only place the row
    // can be renamed at all, so a rename rendered nowhere would not be one.
    // Both surfaces read `declaredLabel`, so they cannot disagree.
    renderAccounts([...defaultAccounts(), theSeededAccount({ label: 'Mon PEA' })])
    await settled()

    expect(screen.getByRole('button', { name: 'Mon PEA' })).toBeInTheDocument()
    expect(screen.queryByText('Non affecté')).not.toBeInTheDocument()
    // Still the unassigned line, by its id: only the name moved.
    expect(
      screen.getByRole('link', { name: 'Affecter ces événements à un compte' }),
    ).toHaveAttribute('href', '/donnees#reassignment')
  })

  it('reads the unassigned line’s name in the reader’s language', async () => {
    server.use(
      http.get(ROUTES.accounts, () =>
        HttpResponse.json(anAccountsPayload([...defaultAccounts(), theSeededAccount()])),
      ),
    )
    renderApp({ url: '/comptes', browserLanguages: ['en-GB'] })

    // A value seeded once never follows the reader; the catalogue does. Every
    // other account shows what it declares, in the language its owner wrote it
    // in.
    expect(await screen.findByRole('button', { name: 'Unassigned' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
  })
})

describe('the icons, the date and N = 1', () => {
  it('carries four bubbles, on the four figures that rest on a convention', async () => {
    renderAccounts()
    await settled()

    expect(
      screen.getAllByRole('button', { name: /^Ce que veut dire/ }).map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual([
      'Ce que veut dire Versé net',
      'Ce que veut dire Gain total',
      'Ce que veut dire TRI',
      'Ce que veut dire perf',
    ])
  })

  it('ends both rate bubbles on the same sentence, and lets perf warn against itself', async () => {
    const { user } = renderAccounts()
    await settled()

    // The same last sentence in both, deliberately: the two rates are far more
    // often misread together than apart.
    const CONVENTION = /Les rendements sont calculés à partir des dates de vos événements\./

    await user.click(screen.getByRole('button', { name: 'Ce que veut dire TRI' }))
    const xirr = await screen.findByRole('dialog')
    expect(xirr).toHaveTextContent(CONVENTION)
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Ce que veut dire perf' }))
    const perf = await screen.findByRole('dialog')
    expect(perf).toHaveTextContent(CONVENTION)
    // The one bubble in the product that warns against its own figure.
    expect(perf).toHaveTextContent(/s’inversent quatre fois sur sept plages/)
    expect(within(perf).getByRole('link')).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#twr',
    )
  })

  it('dates its money figures once, at the level of the page, and names no interval', async () => {
    renderAccounts()
    await settled()

    expect(screen.getByText('Chiffres arrêtés au 2 mars 2026')).toBeInTheDocument()
    // The interval is carried by the range control and never written twice.
    expect(screen.queryByText(/sur (un an|les douze derniers mois)/i)).not.toBeInTheDocument()
  })

  it('tells the two rates apart in its subtitle', async () => {
    renderAccounts()
    await settled()

    expect(screen.getByText(/annualisé depuis l’origine/)).toBeInTheDocument()
    expect(screen.getByText(/sur la plage affichée/)).toBeInTheDocument()
  })

  it('answers at N = 1, without a Portefeuille line and without a navigation entry', async () => {
    renderAccounts([anAccount()])
    await waitFor(() => expect(table()).toBeInTheDocument())

    // The row would copy the single line above it, with a rule drawn between a
    // line and itself.
    expect(within(table()).queryByText('Portefeuille')).not.toBeInTheDocument()
    // The page leaves the **navigation** and never the route: a bookmark that
    // was valid yesterday costs a 404 for nothing.
    expect(
      within(screen.getByRole('navigation', { name: 'Sections' })).queryByRole('link', {
        name: 'Comptes',
      }),
    ).not.toBeInTheDocument()
  })
})

describe('the page’s own reads', () => {
  it('names an unreadable store instead of showing an empty comparison', async () => {
    server.use(
      problemHandler(ROUTES.accounts, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp({ url: '/comptes' })

    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('says nothing has been declared, and where to declare it', async () => {
    renderAccounts([])
    expect(await screen.findByText('Aucun compte déclaré')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Aller à Données' })).toHaveAttribute('href', '/donnees')
  })
})
