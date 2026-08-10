/**
 * The head of the dashboard, and the three primitives it is the first surface
 * to need (#718, ADR-0016, ADR-0018).
 *
 * Every case below names the wrong figure it prevents. The four terms sum to a
 * gain the reader can check by hand — `+300,00 + 50,00 + 25,00 − 5,00 = 370,00`
 * — and the year-to-date pair is the measured one, `+40,69 €` against
 * `−1,25 %`, of opposite signs over the same period and both correct.
 *
 * Assertions are on the accessible rendering: a role, a name, a text. Amounts
 * are matched with regular expressions rather than literals because `fr-FR`
 * groups with a narrow no-break space, and a test that hard-coded a plain one
 * would be asserting the wrong thing about the right number.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import {
  anAccountsPayload,
  aPositionsPayload,
  aRuntime,
  aTotals,
  aTotalsPayload,
  defaultAccounts,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

/** One figure and everything subordinate to it, by the name it wears. */
function figure(name: string) {
  return screen.getByRole('group', { name })
}

function totalsOf(overrides: Parameters<typeof aTotals>[0]) {
  return http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(aTotals(overrides))))
}

describe('the gain is computed, never read', () => {
  it('adds its four terms up and ignores a divergent `gain_absolu`', async () => {
    // Two producers for one figure is what the shares page spent a session
    // dismantling. The payload is handed a total that is off by an order of
    // magnitude; the head does not blink.
    server.use(totalsOf({ gain_absolu: 99999 }))
    renderApp()

    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/370,00/)
    expect(head).not.toHaveTextContent(/99\D?999/)
    expect(screen.queryByText(/99\D?999/)).not.toBeInTheDocument()
  })

  it('shows the four terms on their own row, never on the head’s', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    expect(figure('Plus-value latente')).toHaveTextContent(/300,00/)
    expect(figure('Plus-value réalisée')).toHaveTextContent(/50,00/)
    expect(figure('Dividendes reçus')).toHaveTextContent(/25,00/)
    expect(figure('Frais de versement')).toHaveTextContent(/5,00/)

    // A total and its terms never share a line: the terms are not inside the
    // head's group, or the form would invite adding them to it.
    const head = figure('Gain total')
    expect(within(head).queryByRole('group')).not.toBeInTheDocument()
  })

  it('never mentions the fourth term to an install whose transfers are free', async () => {
    server.use(totalsOf({ transfer_fees: 0, gain_absolu: 375 }))
    renderApp()

    // Three terms, and the gain is their sum — not `370,00 − 0,00` written out.
    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/375,00/)
    expect(screen.queryByRole('group', { name: 'Frais de versement' })).not.toBeInTheDocument()
    expect(screen.queryByText('Frais de versement')).not.toBeInTheDocument()
  })
})

describe('the year-to-date is two figures that do not touch', () => {
  it('puts the euro under the head and the percentage inside the TWR statistic', async () => {
    renderApp()

    const head = await screen.findByRole('group', { name: 'Gain total' })
    const twr = figure('TWR')

    // `+40,69 €` and `−1,25 %` are of opposite signs over the same period and
    // both correct: the portfolio grew by deposits while its holdings lost.
    // Side by side they read as a contradiction.
    expect(head).toHaveTextContent(/40,69/)
    expect(twr).toHaveTextContent(/1,25\D?%/)
    expect(head).not.toHaveTextContent(/1,25/)
    expect(twr).not.toHaveTextContent(/40,69/)
  })

  it('offers no range control at all', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // The delta is fixed to year-to-date. The `1S / 1M / 1A / —` selector was
    // the second range control on this page, and two sibling controls read as
    // two settings of the same thing.
    for (const preset of ['1S', '1M', '1A', 'YTD', 'MAX']) {
      expect(screen.queryByRole('button', { name: preset })).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('never puts a delta on the money-weighted return, which is annualised', async () => {
    renderApp()
    const xirr = await screen.findByRole('group', { name: 'TRI' })
    expect(xirr).toHaveTextContent(/\+3,22\D?%/)
    expect(xirr).not.toHaveTextContent(/janvier/)
  })
})

describe('the two time-weighted scalars', () => {
  it('carries the base date while the rebuild is still moving it', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    renderApp()

    await waitFor(() => expect(figure('TWR')).toHaveTextContent(/30 oct\. 2019/))
    expect(figure('TWR')).toHaveTextContent(/\+102,89/)
  })

  it('drops it once the reconstruction is over', async () => {
    // A base date that never changes again is not news, and the origin scalar
    // is the one that has to keep saying it *is* moving while it does.
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    expect(figure('TWR')).not.toHaveTextContent(/2019/)
    // Both scalars are there all the same — origin and year-to-date.
    expect(figure('TWR')).toHaveTextContent(/\+102,89/)
    expect(figure('TWR')).toHaveTextContent(/1,25/)
  })
})

describe('during the reconstruction', () => {
  it('keeps the head normal and degrades the year-to-date alone', async () => {
    server.use(totalsOf({ ytd: null }))
    renderApp()

    // Exact from the first cycle: the gain, the money-weighted return and the
    // four terms. Twenty-five minutes of "nothing works" is what this prevents.
    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/370,00/)
    expect(figure('TRI')).toHaveTextContent(/\+3,22/)
    expect(figure('Plus-value latente')).toHaveTextContent(/300,00/)

    // And the one figure that is degraded says which and why — once, under the
    // head, rather than twice on the same page.
    expect(head).toHaveTextContent(/—/)
    expect(head).toHaveTextContent(/historique pas encore reconstruit jusque-là/)
    expect(screen.getAllByText(/historique pas encore reconstruit/)).toHaveLength(1)
  })
})

describe('the statistics shrink instead of filling with dashes', () => {
  it('drops what does not exist for this installation, and names what a ledger would add', async () => {
    server.use(http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(null))))
    renderApp()

    // The head keeps its subject: three terms are read off the positions, which
    // are not under the constraint that empties `portfolio_totals`.
    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/375,00/)

    for (const absent of ['Valeur totale', 'Versé net', 'TRI', 'TWR']) {
      expect(screen.queryByRole('group', { name: absent })).not.toBeInTheDocument()
    }
    expect(
      screen.getByText(/Un grand livre d’événements datés ajouterait/),
    ).toBeInTheDocument()
  })

  it('says nothing at all when there is no ledger and nothing held', async () => {
    server.use(
      http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload([], null))),
      http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(null, null))),
    )
    renderApp()

    expect(await screen.findByText('Aucun événement')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Aller à Données' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Gain total' })).not.toBeInTheDocument()
  })
})

describe('the consolidated figures name their perimeter', () => {
  it('counts the accounts and leads to the page where the gap is legible', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    const scope = await screen.findByRole('link', { name: '3 comptes' })
    expect(scope).toHaveAttribute('href', '/comptes')
  })

  it('drops the link of itself at one account', async () => {
    server.use(
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload([defaultAccounts()[0]]))),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    await waitFor(() => expect(screen.getByText('1 compte')).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: /compte/ })).not.toBeInTheDocument()
  })
})

describe('the convention bubble', () => {
  it('opens on click and never on hover, and holds sense, rule and link', async () => {
    const { user } = renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    const trigger = screen.getByRole('button', { name: 'Ce que veut dire Gain total' })

    // Hover does not exist on touch, and a convention readable on half the
    // devices is a convention not stated.
    await user.hover(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(trigger)
    const bubble = await screen.findByRole('dialog')
    expect(bubble).toHaveTextContent(/somme de quatre termes/)
    // One text, not two levels — and a link the reader can walk to, which is
    // the other half of why it opens on click.
    const link = within(bubble).getByRole('link', { name: 'Lire la règle complète' })
    expect(link).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#total-gain',
    )
  })

  it('closes on scroll, because it must not outlive its figure', async () => {
    const { user } = renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    await user.click(screen.getByRole('button', { name: 'Ce que veut dire TWR' }))
    await screen.findByRole('dialog')

    // Mounted `position: fixed`, the board's bubble stayed pinned above
    // unrelated content — worse than no bubble at all.
    fireEvent.scroll(document)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('carries the reader’s locale to the documentation', async () => {
    const { user } = renderApp({ browserLanguages: ['en-GB'] })
    await screen.findByRole('group', { name: 'Total P&L' })

    await user.click(screen.getByRole('button', { name: 'What Money-weighted return means' }))
    expect(within(await screen.findByRole('dialog')).getByRole('link')).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/docs/v5/read-your-figures#xirr',
    )
  })

  it('puts four icons on the head, not nine', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // A total and its subordinate terms are one figure, not five: the
    // `Gain total` bubble carries the identity **and** its four terms, and the
    // terms carry none of their own.
    const bubbles = screen.getAllByRole('button', { name: /^Ce que veut dire/ })
    expect(bubbles.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Ce que veut dire Gain total',
      'Ce que veut dire Versé net',
      'Ce que veut dire TRI',
      'Ce que veut dire TWR',
    ])
  })
})

describe('the head in English', () => {
  it('renders whole, and says `Total P&L` rather than `Total gain`', async () => {
    renderApp({ browserLanguages: ['en-GB'] })

    // `Total gain` and `Total return` start with the same word and cohabit on
    // this very block.
    expect(await screen.findByRole('group', { name: 'Total P&L' })).toHaveTextContent(/370\.00/)
    expect(screen.queryByText('Total gain')).not.toBeInTheDocument()
    expect(figure('Unrealised P&L')).toHaveTextContent(/300\.00/)
    // Numbers follow the language, not the currency: the same euros, grouped
    // and pointed the English way.
    expect(figure('Total value')).toHaveTextContent(/2,800\.00/)
    expect(await screen.findByRole('link', { name: '3 accounts' })).toBeInTheDocument()
  })
})
