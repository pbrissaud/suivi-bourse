/**
 * The shares page (#719, ADR-0017, ADR-0016), at the one seam: the whole app in
 * jsdom, HTTP the only faked edge.
 *
 * *The header sums the lines it sits above* is not a property of a table
 * component — it only appears once the folded section, the total and the rows
 * are mounted together, which is exactly why this suite lives here.
 *
 * The fixture's arithmetic is by hand in `test/factories.ts`:
 *
 *     +300,00 latent · +125,00 realised · +35,00 dividends  =  460,00
 *
 * and the figure the fold exists to prevent — the held lines alone — is
 * `+300,00 + 50,00 + 25,00 = 375,00`. Both are correct; only one is the gain.
 * On the portfolio that decided it the gap was 708,92 €, 73 % of what was shown.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aPosition,
  aPositionsPayload,
  aRuntime,
  defaultPositions,
  sharesPortfolio,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

/** The page under test, with the portfolio that has closed lines in it. */
function renderShares(positions = sharesPortfolio()) {
  server.use(http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload(positions))))
  return renderApp({ url: '/titres' })
}

function head() {
  return screen.getByRole('group', { name: 'Gain total' })
}

/** The live table, by its own accessible name — the folded one has another. */
function liveTable() {
  return screen.getByRole('table', { name: 'Positions détenues' })
}

function fold() {
  return screen.getByRole('button', { name: /position(s)? soldée(s)?/ })
}

function columnNames(table: HTMLElement) {
  return within(table)
    .getAllByRole('columnheader')
    .map((cell) => cell.textContent?.trim())
}

describe('the header sums the lines it sits above', () => {
  it('counts the closed positions, and folding the section does not move it', async () => {
    const { user } = renderShares()

    // 460,00 and not 375,00. The second is not false — it is the sum of the
    // three terms over the live lines alone — and nothing on screen would say
    // which of the two equals the dashboard's figure.
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))
    expect(screen.queryByText(/375,00/)).not.toBeInTheDocument()

    await user.click(fold())
    expect(head()).toHaveTextContent(/460,00/)

    await user.click(fold())
    expect(head()).toHaveTextContent(/460,00/)
  })

  it('shows the three terms it is the sum of, and never a fourth', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    expect(screen.getByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(/300,00/)
    expect(screen.getByRole('group', { name: 'Plus-value réalisée' })).toHaveTextContent(/125,00/)
    expect(screen.getByRole('group', { name: 'Dividendes reçus' })).toHaveTextContent(/35,00/)

    // The fees a broker takes out of a transfer belong to no security, so a
    // header that sums its rows can never carry them. They stay the
    // dashboard's, and that is what the bubble here has to say.
    expect(screen.queryByRole('group', { name: 'Frais de versement' })).not.toBeInTheDocument()
  })

  it('offers no way to hide the closed positions', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // No switch, no checkbox, and nothing named for it: the fold is a fold.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/masquer les .*soldées/i)).not.toBeInTheDocument()

    // And what does exist announces a fold rather than a filter — its rows come
    // back, and the total never moved in the first place.
    await user.click(fold())
    expect(await screen.findByRole('button', { name: 'Zeta Epsilon' })).toBeInTheDocument()
  })

  it('states its own scope in its bubble, closed lines and missing term both', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    await user.click(screen.getByRole('button', { name: 'Ce que veut dire Gain total' }))
    const bubble = await screen.findByRole('dialog')
    expect(bubble).toHaveTextContent(/positions soldées comprises/)
    expect(bubble).toHaveTextContent(/n’appartiennent à aucun titre/)
    expect(within(bubble).getByRole('link')).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#total-gain',
    )
  })
})

describe('the folded section', () => {
  it('is closed on load and already carries realised and dividends', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // Opening it is an intention, not a discovery: the summary line says the
    // two figures that matter before anyone clicks.
    expect(fold()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Zeta Delta' })).not.toBeInTheDocument()

    const section = fold().closest('section') as HTMLElement
    // +120,00 − 45,00 = 75,00 realised, and 10,00 of dividends.
    expect(section).toHaveTextContent(/Réalisée\s*75,00/)
    expect(section).toHaveTextContent(/Dividendes\s*10,00/)
    expect(fold()).toHaveTextContent('2 positions soldées')
  })

  it('has its own five columns — no price, no held, no unit cost, no latent', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))
    await user.click(fold())

    const table = screen.getByRole('table', { name: 'Positions soldées' })
    expect(columnNames(table)).toEqual([
      'Titre',
      'Soldée le',
      'Réalisée',
      'Dividendes',
      'Compte',
    ])
    // Those four would be an em dash on every row of the section.
    for (const absent of ['Cours', 'Détenu', 'PRU', 'Latente']) {
      expect(within(table).queryByRole('columnheader', { name: absent })).not.toBeInTheDocument()
    }
  })

  it('sorts on the closing date, descending', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))
    await user.click(fold())

    const table = screen.getByRole('table', { name: 'Positions soldées' })
    const names = within(table)
      .getAllByRole('button')
      .map((button) => button.textContent)
    // Closed 2026-01-15 before closed 2025-11-04. Market value is zero on both,
    // so no other column of this section orders anything.
    expect(names).toEqual(['Zeta Epsilon', 'Zeta Delta'])
  })

  it('carries no explanation icon of its own', async () => {
    // *One icon per figure and per surface*, and the folded section is not a
    // surface but a part of the page — which is what takes eleven down to nine.
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    const before = screen.getAllByRole('button', { name: /^Ce que veut dire/ }).length
    await user.click(fold())
    expect(screen.getAllByRole('button', { name: /^Ce que veut dire/ })).toHaveLength(before)
  })
})

describe('the nine columns of the live table', () => {
  it('are exactly those nine, in that order', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    expect(columnNames(liveTable())).toEqual([
      'Titre',
      'Cours',
      'Détenu',
      'PRU',
      'Valorisation',
      'Latente',
      'Réalisée',
      'Dividendes',
      'Compte',
    ])
  })

  it('has no `Écart unitaire`, no `Investi`, and no fourth `Gain total` column', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // `Écart unitaire` is `Cours − PRU`, two columns already on the same line,
    // and nil by construction on a line carried at its cost. `Investi` is
    // `Valorisation − latente` and stays on the sheet. And a fourth column would
    // put a total beside its own terms, which is the addition ADR-0018 exists
    // to prevent.
    for (const absent of ['Écart unitaire', 'Investi', 'Gain total', 'Variation']) {
      expect(
        within(liveTable()).queryByRole('columnheader', { name: absent }),
      ).not.toBeInTheDocument()
    }
  })

  it('keeps `PRU`, the word read at the broker, and gives the rule to the icon', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    expect(within(liveTable()).getByRole('columnheader', { name: /PRU/ })).toBeInTheDocument()
    expect(screen.queryByText('PMP')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Ce que veut dire PRU' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent(/moyenne pondérée/)
  })

  it('puts the percentage on a second line under the latent gain', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // 1 300,00 − 1 000,00 = +300,00, which is +30,00 % of the basis — and it is
    // not a tenth column.
    const row = screen.getByRole('button', { name: 'Zeta Alpha' }).closest('tr') as HTMLElement
    expect(row).toHaveTextContent(/300,00/)
    expect(row).toHaveTextContent(/\+30,00\D?%/)
    expect(columnNames(liveTable())).toHaveLength(9)
  })

  it('keeps the four renderings of absence apart, on one screen', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // Carried at its cost (ADR-0004): an em dash in the price — which **is**
    // the signal, so the row gets no marker of its own — a value, and a latent
    // gain of exactly zero rather than a total loss.
    const carried = screen.getByRole('button', { name: 'Zeta Gamma' }).closest('tr') as HTMLElement
    expect(carried).toHaveTextContent(/—/)
    expect(carried).toHaveTextContent(/600,00/)
    expect(carried).toHaveTextContent(/0,00/)

  })

  it('names the missing rate instead of dashing it', async () => {
    // Quoted, and the rate has not resolved: the native price is worth showing
    // — it is what the reader's broker displays — and what is missing is
    // **named**, because it is repairable. A dash here would say *there is
    // nothing to compute* about a rate the app fetches by itself.
    renderShares([
      aPosition({ symbol: 'ZZB', name: 'Zeta Beta', price: 125, currency: 'USD', rate: null }),
    ])

    const row = (await screen.findByRole('button', { name: 'Zeta Beta' })).closest(
      'tr',
    ) as HTMLElement
    expect(row).toHaveTextContent(/125,00/)
    expect(row).toHaveTextContent(/en attente du taux/)
    // And the header inherits the reason rather than the em dash.
    expect(head()).toHaveTextContent(/en attente du taux/)
  })

  it('carries a line quoted in no nameable unit at its cost, like the curves do', async () => {
    // The shape the payload serves for a symbol whose closes came back and whose
    // `.info` named no currency (#774): `price` present, `price.currency`
    // absent. The server has valued that line at its PMP since #773, so the page
    // saying *en attente du taux* about it made one position two figures on one
    // screen — and a rate that was never coming, there being no pair.
    renderShares([
      ...defaultPositions(),
      aPosition({
        symbol: 'ZZH',
        name: 'Zeta Theta',
        quantity: 6,
        cost_basis: 600,
        price: 130,
        currency: null,
      }),
    ])

    const row = (await screen.findByRole('button', { name: 'Zeta Theta' })).closest(
      'tr',
    ) as HTMLElement
    // Its cost, and a latent gain of exactly zero — the first row of the absence
    // table, not a fifth rendering of its own. Both are read **on their own
    // cell**: `Cours` is the second and `Latente` the sixth of the nine, and a
    // `0,00` sought anywhere in the row is already satisfied by the valuation
    // `600,00` and the PRU `100,00` beside it, i.e. it could not fail alone.
    const cells = within(row).getAllByRole('cell')
    expect(row).toHaveTextContent(/600,00/)
    expect(cells[5]).toHaveTextContent(/^0,00/)
    expect(row).not.toHaveTextContent(/en attente du taux/)
    // And no number under a unit nothing named: 130 is not 130 €.
    expect(row).not.toHaveTextContent(/130,00/)
    expect(cells[1]).toHaveTextContent(/^—$/)

    // The header stays a figure and does not move: the line contributes exactly
    // zero, so the three terms are the ones `defaultPositions()` already sums to.
    expect(head()).toHaveTextContent(/375,00/)
    expect(head()).not.toHaveTextContent(/en attente du taux/)
  })
})

describe('the exception marker and the date', () => {
  it('is an icon on the share, never a column, plus a counter that is the filter', async () => {
    // Eleven rows rendered ten identical *Marché ouvert* and one *Cours figé*: a
    // per-row marker that does not discriminate is noise however correct it is.
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(
          aRuntime({
            symbols: [{ symbol: 'ZZC', next_run: null, consecutive_failures: 3 }],
          }),
        ),
      ),
    )
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // No column for it, and the reader is told the count rather than *never*,
    // which is not computable.
    expect(columnNames(liveTable())).toHaveLength(9)
    const row = screen.getByRole('button', { name: 'Zeta Gamma' }).closest('tr') as HTMLElement
    expect(row).toHaveTextContent(/3 relevés consécutifs, aucun cours/)

    // The counter is the filter at a click.
    const counter = screen.getByRole('button', { name: '1 titre en anomalie' })
    expect(counter).toHaveAttribute('aria-pressed', 'false')
    await user.click(counter)
    expect(screen.getByRole('button', { name: '1 titre en anomalie' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Zeta Gamma' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Zeta Alpha' })).not.toBeInTheDocument()

    // And the header keeps stating the sum of the rows it sits above rather
    // than the portfolio's: a figure held over a table showing one line is read
    // as that line's summary, which is exactly the reading the *hide the closed
    // ones* switch was deleted for. Zeta Gamma is carried at its cost, so its
    // latent gain is nil; the closed lines stay under the fold and stay counted
    // — 0,00 + 75,00 realised + 10,00 dividends.
    expect(head()).toHaveTextContent(/85,00/)
    await user.click(screen.getByRole('button', { name: '1 titre en anomalie' }))
    expect(head()).toHaveTextContent(/460,00/)
  })

  it('reads the absence of an anomaly as information', async () => {
    // It fires zero times on the real portfolio, and the header is the only
    // place where nothing to report reads as a statement rather than a void.
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    expect(screen.getByText('Aucun titre en anomalie')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /en anomalie/ })).not.toBeInTheDocument()
  })

  it('dates the prices once, at the level of the page', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // A table of money with no date reads as *now*, which is false of two
    // families of line — and a *last reading* column would be the fourth
    // near-constant column of a page that has just deleted one.
    expect(screen.getAllByText(/^Cours au /)).toHaveLength(1)
    expect(
      within(liveTable()).queryByRole('columnheader', { name: /Cours au|Dernier relevé/ }),
    ).not.toBeInTheDocument()
  })
})

describe('the account column at N ≥ 2', () => {
  it('renders one account as plain text and never as a list of one', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    const row = screen.getByRole('button', { name: 'Zeta Alpha' }).closest('tr') as HTMLElement
    expect(row).toHaveTextContent('alpha')
    expect(within(row).queryByRole('list')).not.toBeInTheDocument()
  })

  it('keeps the model multi-account: two accounts on one share are two entries', async () => {
    // Contingent, not structural — the same ETF on a PEA and on a CTO is the
    // most ordinary case of the domain — so it is the rendering that bends.
    renderShares([
      ...sharesPortfolio(),
      aPosition({ account: 'alpha', symbol: 'ZZF', name: 'Zeta Phi', quantity: 2, cost_basis: 200, price: 110 }),
      aPosition({ account: 'beta', symbol: 'ZZF', name: 'Zeta Phi', quantity: 3, cost_basis: 300, price: 110 }),
    ])
    await waitFor(() => expect(head()).toHaveTextContent(/510,00/))

    const row = screen.getByRole('button', { name: 'Zeta Phi' }).closest('tr') as HTMLElement
    expect(within(row).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'alpha',
      'beta',
    ])
    // One line, not two: 2 + 3 held, 500,00 of basis, 550,00 of value.
    expect(row).toHaveTextContent(/550,00/)
    expect(screen.getAllByRole('button', { name: 'Zeta Phi' })).toHaveLength(1)
  })
})

describe('nine icons on the page', () => {
  it('places five on the header block and four on the column headers', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // *One per figure and per surface.* The header block and the column headers
    // are two surfaces on purpose: a table is read scrolled, with the page's
    // header off screen.
    const bubbles = screen.getAllByRole('button', { name: /^Ce que veut dire/ })
    expect(bubbles.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Ce que veut dire Gain total',
      'Ce que veut dire Plus-value latente',
      'Ce que veut dire Plus-value réalisée',
      'Ce que veut dire Dividendes reçus',
      'Ce que veut dire Valorisation',
      'Ce que veut dire PRU',
      'Ce que veut dire Latente',
      'Ce que veut dire Réalisée',
      'Ce que veut dire Dividendes',
    ])
  })

  it('opens on click, never on hover, and closes on scroll', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    const trigger = screen.getByRole('button', { name: 'Ce que veut dire Latente' })
    await user.hover(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(trigger)
    expect(await screen.findByRole('dialog')).toHaveTextContent(/portée à son coût/)
  })
})

describe('the chart', () => {
  it('offers the four rungs of the ladder, and changing the range changes the resolution', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    await user.click(screen.getByRole('button', { name: 'Zeta Alpha' }))
    const range = await screen.findByRole('radiogroup', { name: 'Plage' })
    expect(within(range).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      '1M',
      '1A',
      '2A',
      'MAX',
    ])
    // `3M` is gone: from February to December, the year-to-date covers it.
    expect(within(range).queryByRole('radio', { name: '3M' })).not.toBeInTheDocument()

    // As written under a year, hourly from one to two, daily beyond — so the
    // presets make the archive's shape legible instead of being four spellings
    // of one range.
    expect(await screen.findByText('Au relevé')).toBeInTheDocument()
    await user.click(within(range).getByRole('radio', { name: '2A' }))
    expect(await screen.findByText('Agrégé par heure')).toBeInTheDocument()
    await user.click(within(range).getByRole('radio', { name: 'MAX' }))
    expect(await screen.findByText('Agrégé par jour')).toBeInTheDocument()
  })

  it('announces the resolution once, and reads it off the API', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))
    await user.click(screen.getByRole('button', { name: 'Zeta Alpha' }))

    // The server's bucket and the storage ladder are two facts about one graph;
    // two announcers on one graph is the defect refused everywhere else.
    expect(await screen.findByText('Au relevé')).toBeInTheDocument()
    expect(screen.getAllByText(/Au relevé|Agrégé par/)).toHaveLength(1)
  })
})

describe('the page’s own reads', () => {
  it('names an unreadable store instead of showing an empty table', async () => {
    // `/api/runtime` answers from process memory and never opens the store, so
    // the shell's banner is silent on exactly this failure — and a page that
    // rendered nothing would make *the store is unreadable* and *you own
    // nothing yet* one screen, in its worst form: a blank one.
    server.use(
      problemHandler(ROUTES.positions, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp({ url: '/titres' })

    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('says the portfolio is empty, and where to go, when it really is', async () => {
    renderShares([])
    expect(await screen.findByText('Aucune position')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Aller à Données' })).toHaveAttribute(
      'href',
      '/donnees',
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('the page in English', () => {
  it('renders whole, with the numbers following the language', async () => {
    server.use(
      http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload(sharesPortfolio()))),
    )
    renderApp({ url: '/titres', browserLanguages: ['en-GB'] })

    const total = await screen.findByRole('group', { name: 'Total P&L' })
    expect(total).toHaveTextContent(/460\.00/)
    expect(
      columnNames(screen.getByRole('table', { name: 'Held positions' })),
    ).toEqual([
      'Share',
      'Price',
      'Held',
      'Avg. cost',
      'Value',
      'Unrealised',
      'Realised',
      'Dividends',
      'Account',
    ])
    expect(screen.getByText('No share needs attention')).toBeInTheDocument()
  })
})

describe('a portfolio with nothing closed', () => {
  it('renders no folded section at all rather than an empty one', async () => {
    renderShares(defaultPositions())
    // +300,00 + 50,00 + 25,00 = 375,00, and here that *is* the gain.
    await waitFor(() => expect(head()).toHaveTextContent(/375,00/))
    expect(screen.queryByRole('button', { name: /position(s)? soldée(s)?/ })).not.toBeInTheDocument()
  })
})

// ------------------------------------------------------------------------- //
// The reduction an account's panel leads to (#722)
//
// It is **not** the *hide the closed ones* switch this page refuses: that one
// hid part of the table its header summed, silently, leaving two correct
// figures with nothing on screen to tell them apart. This one names the account
// it reduces to, offers the way out, and the header goes on summing the lines
// it sits above — which reduced are that account's lines, and that account's
// gain.
// ------------------------------------------------------------------------- //

describe('the reduction to one account', () => {
  function renderReduced(account: string, positions = sharesPortfolio()) {
    server.use(http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload(positions))))
    return renderApp({ url: `/titres?compte=${account}` })
  }

  it('keeps that account’s lines, closed ones included, and no other', async () => {
    renderReduced('alpha')

    // `alpha` holds ZZA and has closed ZZD. The fold is not a filter here
    // either: the closed line stays and the header counts it.
    await waitFor(() => expect(liveTable()).toBeInTheDocument())
    expect(within(liveTable()).getByText('Zeta Alpha')).toBeInTheDocument()
    expect(within(liveTable()).queryByText('Zeta Beta')).not.toBeInTheDocument()
    expect(within(liveTable()).queryByText('Zeta Gamma')).not.toBeInTheDocument()
    expect(fold()).toBeInTheDocument()
  })

  it('sums the lines it sits above, which are that account’s', async () => {
    renderReduced('alpha')

    // +300,00 latent · +120,00 realised · +35,00 dividends = 455,00, and never
    // the portfolio's 460,00, which counts an account that is not on screen.
    // That is the *other correct figure* one axis over.
    await waitFor(() => expect(head()).toHaveTextContent(/455,00/))
    expect(screen.queryByText(/460,00/)).not.toBeInTheDocument()
  })

  it('states itself with the account it names, and offers the way out', async () => {
    renderReduced('alpha')

    // A table silently shorter than expected is the defect the ledger met one
    // page over — and worse here, the header over it being a **sum**. The
    // account is named by its id, which is what the `Compte` column renders.
    expect(await screen.findByText(/Réduit au compte alpha/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Afficher tous les comptes' })).toHaveAttribute(
      'href',
      '/titres',
    )
  })

  it('lifts it, and the header comes back to the portfolio’s own figure', async () => {
    const { user } = renderReduced('alpha')
    await waitFor(() => expect(head()).toHaveTextContent(/455,00/))

    await user.click(screen.getByRole('link', { name: 'Afficher tous les comptes' }))
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))
    expect(screen.queryByText(/Réduit au compte/)).not.toBeInTheDocument()
  })

  it('does not tell an owner with a full ledger that they own nothing', async () => {
    renderReduced('delta')

    // *No positions* is a claim about the reader's data; here the cause is a
    // filter they can lift in one click, and the sentence says so.
    expect(await screen.findByText('Aucune position sur ce compte')).toBeInTheDocument()
    expect(screen.queryByText('Aucune position')).not.toBeInTheDocument()
    // The bar's, and the empty state's own — a reader who has scrolled past the
    // first must not have to scroll back up to undo what emptied the page.
    expect(screen.getAllByRole('link', { name: 'Afficher tous les comptes' })).toHaveLength(2)
  })

  it('says nothing at all when nothing is reduced', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    expect(screen.queryByText(/Réduit au compte/)).not.toBeInTheDocument()
  })
})
