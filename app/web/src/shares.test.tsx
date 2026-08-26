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
  aClosedPosition,
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

    // The maquette's own nine, rendered and counted (#831). `Poids` was the
    // tenth for one ticket and is not one of them.
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
    // And `Poids` is in the list since #831: the weight of a line is answered
    // on this page by the `Répartition` above the table — a figure of the whole
    // — and never by a tenth cell on every row (`components/shares/Allocation`).
    for (const absent of ['Écart unitaire', 'Investi', 'Gain total', 'Variation', 'Poids']) {
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
    // cell**: `Cours` is the second and `Latente` the seventh of the ten, and a
    // `0,00` sought anywhere in the row is already satisfied by the valuation
    // `600,00` and the PRU `100,00` beside it, i.e. it could not fail alone.
    const cells = within(row).getAllByRole('cell')
    expect(row).toHaveTextContent(/600,00/)
    expect(cells[6]).toHaveTextContent(/^0,00/)
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

  it('says nothing about anomalies while either read is still in flight', async () => {
    // ADR-0026's fourth occurrence, and the one the net cannot see: the phrase
    // is in the baseline — the default fixture reports no failing symbol — so
    // *appeared because a read did not answer* and *true of the fixture* are
    // the same string here.
    //
    // Two reads compose the count and each of them breaks it on its own.
    // Without the positions there are no rows, so nought is nought before
    // anything is known. Without `/api/runtime` every counter reads zero, so a
    // symbol that has failed three times is classified *carried at cost*
    // instead of *no quote* and drops out of the count — the page then states
    // that nothing is wrong precisely when it cannot know.
    server.use(http.get(ROUTES.runtime, () => new Promise(() => {})))
    renderShares()

    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))
    expect(screen.queryByText('Aucun titre en anomalie')).not.toBeInTheDocument()
  })

  it('says nothing about anomalies when the runtime read failed', async () => {
    // The same claim by the other road, and the quieter one: a `shellError`
    // used to short-circuit `readConditions` to nothing at all, on the argument
    // that the shell's own band was saying it — so the page had nothing to show
    // for the failure *and* went on saying nothing was wrong. The short-circuit
    // left with the band (#829, ADR-0037); the counter waits either way.
    server.use(http.get(ROUTES.runtime, () => HttpResponse.error()))
    renderShares()

    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))
    expect(screen.queryByText('Aucun titre en anomalie')).not.toBeInTheDocument()
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

  it('keeps every one of them on a column header and none on a cell', async () => {
    // ADR-0016's rule, and the one exception to it is not a bubble: the icon on
    // an unquotable `Titre` cell carries a **repair**, which is why it is not
    // named *Ce que veut dire …* and does not enter this count.
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    for (const bubble of within(liveTable()).getAllByRole('button', {
      name: /^Ce que veut dire/,
    })) {
      expect(bubble.closest('th')).not.toBeNull()
      expect(bubble.closest('td')).toBeNull()
    }
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
    // The bell reads `/health` and says the installation is unreachable, but a
    // page that rendered nothing would still make *the store is unreadable* and
    // *you own nothing yet* one screen, in its worst form: a blank one. Since
    // #829 the sentence is the page's **empty state** — where the table would
    // have been — and never a band at the top of the column (ADR-0037).
    server.use(
      problemHandler(ROUTES.positions, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp({ url: '/titres' })

    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.getByText(/son magasin ne répond pas/)).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('says the portfolio is empty, and where to go, when it really is', async () => {
    renderShares([])
    expect(await screen.findByText('Aucune position')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Aller au grand livre' })).toHaveAttribute(
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

// ------------------------------------------------------------------------- //
// The two gestures the table kept from #791 — the order and the grouping —
// plus the row that opens the sheet. The weight column left again (its figure
// lives on in `lib/shares.ts`, read by nothing here).
//
// None of them removes a line, and that is the property the page is built on:
// a permutation and a partition both leave the set alone, so the header goes
// on stating the sum of what is under it without a word of explanation.
// ------------------------------------------------------------------------- //

describe('every column sorts', () => {
  /** The names in the live table, in the order the table is showing them. */
  function liveNames() {
    return within(liveTable())
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].textContent?.replace(/Z[A-Z]+$/, ''))
  }

  it('gives all nine a control of their own, and its name is the column’s', async () => {
    // *Every* column, which is the criterion — and the control is the label
    // itself rather than a ninth *Trier par …* saying what the cell it sits in
    // already says. The list of orders and the header row are read together:
    // a sort key for a column nobody renders is a control nobody can reach,
    // which is what took `weight` back out with the column (#831).
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    const headers = within(liveTable()).getAllByRole('columnheader')
    expect(headers).toHaveLength(9)
    for (const header of headers) {
      const label = header.textContent?.trim() as string
      expect(within(header).getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('opens heaviest first, and says so on the column in force', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // Value is the only ordering a portfolio reads naturally, so it is what
    // the reader is handed before making a gesture.
    expect(liveNames()).toEqual(['Zeta Alpha', 'Zeta Gamma', 'Zeta Beta'])
    expect(within(liveTable()).getByRole('columnheader', { name: /Valorisation/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
  })

  it('orders by any of them, and pressing the same one turns it round', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // Held: 10, 4, 6. Money descends first, because *which line is the
    // biggest* is what a figure is pressed for.
    await user.click(within(liveTable()).getByRole('button', { name: 'Détenu' }))
    expect(liveNames()).toEqual(['Zeta Alpha', 'Zeta Gamma', 'Zeta Beta'])
    await user.click(within(liveTable()).getByRole('button', { name: 'Détenu' }))
    expect(liveNames()).toEqual(['Zeta Beta', 'Zeta Gamma', 'Zeta Alpha'])
    expect(within(liveTable()).getByRole('columnheader', { name: /Détenu/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )

    // A name ascends first: *where is the line called Z* is the other reading,
    // and a single rule would cost one of the two gestures a second click.
    await user.click(within(liveTable()).getByRole('button', { name: 'Titre' }))
    expect(liveNames()).toEqual(['Zeta Alpha', 'Zeta Beta', 'Zeta Gamma'])
  })

  it('never floats an absence to the top, whichever way it is pointed', async () => {
    const { user } = renderShares([
      ...defaultPositions(),
      aPosition({
        account: 'delta',
        symbol: 'ZZI',
        name: 'Zeta Iota',
        quantity: 3,
        cost_basis: 300,
        price: 125,
        currency: 'USD',
        rate: null,
      }),
    ])
    await waitFor(() => expect(liveTable()).toBeInTheDocument())

    // A line with no value has no rank; letting the direction lift it would
    // put the line the reader knows least about above the ones they came for.
    expect(liveNames().at(-1)).toBe('Zeta Iota')
    await user.click(within(liveTable()).getByRole('button', { name: 'Valorisation' }))
    expect(liveNames().at(-1)).toBe('Zeta Iota')
  })

  it('moves the rows and never the header, which sums the same lines', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    await user.click(within(liveTable()).getByRole('button', { name: 'Réalisée' }))
    expect(liveNames()).toEqual(['Zeta Beta', 'Zeta Alpha', 'Zeta Gamma'])
    // A permutation leaves the set alone — which is the whole reason ordering
    // is safe on a page whose header is a sum of what is under it.
    expect(head()).toHaveTextContent(/460,00/)
    expect(liveNames()).toHaveLength(3)
  })
})

describe('the grouping by account', () => {
  function groupToggle() {
    return screen.getByRole('button', { name: 'Grouper par compte' })
  }

  it('puts each subtotal in the header of its group, never in a footer row', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))
    await user.click(groupToggle())

    // A total and its terms are not read at equal weight (ADR-0016) — here one
    // level down: the account's figures sit **above** the lines they sum,
    // exactly as the page's own header does.
    const alpha = screen.getByRole('rowheader', { name: /alpha/ })
    expect(alpha).toHaveTextContent(/Valorisation\s*1\s*300,00/)
    // 300,00 latent + 0,00 realised + 25,00 dividends on this account's own
    // held line — the closed one is under the fold, where its own summary is.
    expect(alpha).toHaveTextContent(/Gain total\s*325,00/)

    expect(screen.getByRole('rowheader', { name: /beta/ })).toHaveTextContent(/50,00/)
    expect(screen.getByRole('rowheader', { name: /gamma/ })).toHaveTextContent(/600,00/)
  })

  it('is a partition: an account that sold out keeps its realised gain on screen', async () => {
    // The trap the grouping had to answer. A symbol still held on one account
    // and sold out on another carries that second account's realised gain, and
    // a grouping built out of *the accounts that still hold something* would
    // drop it — leaving the page header summing a figure no row accounts for.
    const { user } = renderShares([
      ...defaultPositions(),
      aPosition({
        account: 'alpha',
        symbol: 'ZZF',
        name: 'Zeta Phi',
        quantity: 2,
        cost_basis: 200,
        price: 110,
      }),
      aClosedPosition({
        account: 'beta',
        symbol: 'ZZF',
        name: 'Zeta Phi',
        realised: 70,
        dividends: 5,
        closed_at: '2025-06-01',
      }),
    ])
    await waitFor(() => expect(head()).toHaveTextContent(/470,00/))

    await user.click(groupToggle())
    const lines = screen.getAllByRole('button', { name: 'Zeta Phi' })
    expect(lines).toHaveLength(2)
    // Summed over the two, the figures are the ungrouped line's, exactly.
    const realised = lines.map(
      (line) => within(line.closest('tr') as HTMLElement).getAllByRole('cell')[6].textContent,
    )
    expect(realised.join(' ')).toMatch(/70,00/)
    expect(head()).toHaveTextContent(/470,00/)
  })

  it('does not move the page header, and gives it back when it is lifted', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    await user.click(groupToggle())
    expect(groupToggle()).toHaveAttribute('aria-pressed', 'true')
    expect(head()).toHaveTextContent(/460,00/)

    await user.click(groupToggle())
    expect(screen.queryByRole('rowheader', { name: /alpha/ })).not.toBeInTheDocument()
    expect(head()).toHaveTextContent(/460,00/)
  })

  it('is not offered where there is one account to group', async () => {
    // One group would repeat the page header line for line — which is the
    // argument `accountBreakdown` already makes for the sheet — so the control
    // is not offered rather than offered and inert.
    server.use(http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload(sharesPortfolio()))))
    renderApp({ url: '/titres?compte=alpha' })
    await waitFor(() => expect(head()).toHaveTextContent(/455,00/))
    expect(screen.queryByRole('button', { name: 'Grouper par compte' })).not.toBeInTheDocument()
  })
})

describe('a click on the line opens its sheet', () => {
  it('opens on the row itself, not only on the name', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // The `Détenu` cell carries no control of its own, so this is the row's
    // own gesture and nothing else's.
    const row = screen.getByRole('button', { name: 'Zeta Alpha' }).closest('tr') as HTMLElement
    await user.click(within(row).getAllByRole('cell')[2])

    expect(await screen.findByRole('dialog', { name: 'Zeta Alpha' })).toBeInTheDocument()
  })

  it('leaves the name a button, which is the keyboard’s way in', async () => {
    const { user } = renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    await user.click(screen.getByRole('button', { name: 'Zeta Gamma' }))
    expect(await screen.findByRole('dialog', { name: 'Zeta Gamma' })).toBeInTheDocument()
  })
})

describe('the absences of this page, one screen apart', () => {
  it('gives a share carried at its cost an em dash and no triangle', async () => {
    // Nothing is broken: no price was ever observed, the line is carried at
    // what it cost (ADR-0004), and the em dash in `Cours` **is** the signal.
    // The attention mark is reserved for what is genuinely repairable.
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    const row = screen.getByRole('button', { name: 'Zeta Gamma' }).closest('tr') as HTMLElement
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent(/^—$/)
    expect(within(row).queryByText(/faute de frappe/)).not.toBeInTheDocument()
    expect(screen.getByText('Aucun titre en anomalie')).toBeInTheDocument()
  })

  it('names a share it never managed to quote, and says it can be repaired', async () => {
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(
          aRuntime({ symbols: [{ symbol: 'ZZC', next_run: null, consecutive_failures: 3 }] }),
        ),
      ),
    )
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    const row = screen.getByRole('button', { name: 'Zeta Gamma' }).closest('tr') as HTMLElement
    // Named — the count, which is a fact the reader can act on and never a
    // verdict — and then what to do about it, which is what ADR-0016 gives the
    // one icon allowed on a cell for a job.
    expect(row).toHaveTextContent(/3 relevés consécutifs, aucun cours/)
    expect(within(row).getByText(/Vérifiez le symbole/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1 titre en anomalie' })).toBeInTheDocument()
  })

  it('keeps a zero a figure, in the cells where it is one', async () => {
    renderShares()
    await waitFor(() => expect(head()).toHaveTextContent(/460,00/))

    // `Réalisée` and `Dividendes` are figures on every row: a zero wears the
    // colour of text and never the grey of absence (`lib/sign.ts`).
    const row = screen.getByRole('button', { name: 'Zeta Alpha' }).closest('tr') as HTMLElement
    const cells = within(row).getAllByRole('cell')
    expect(cells[6]).toHaveTextContent(/^0,00/)
    expect(cells[6]).not.toHaveTextContent('—')
  })
})
