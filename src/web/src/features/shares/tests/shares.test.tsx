/**
 * The shares page and the title's page (« Relevé »), at the one seam: the whole
 * app in jsdom, HTTP the only faked edge.
 *
 * The fixture's arithmetic is by hand in `test/factories.ts`:
 *
 *     ZZA  10 × 130,00 = 1 300,00  for 1 000,00  →  +300,00
 *     ZZB   4 × 100,00 =   400,00  for   400,00  →     0,00   (125 USD × 0,80)
 *     ZZC   6 at cost  =   600,00  for   600,00  →     0,00   (never quoted)
 *                       2 300,00     2 000,00        +300,00
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { aPositionsPayload, defaultPositions, sharesPortfolio } from '@/test/factories'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

const UNAVAILABLE = {
  status: 503,
  type: PROBLEM_TYPES.storageUnavailable,
  title: 'Storage unavailable',
}

function renderShares(url = '/shares', payload = aPositionsPayload(defaultPositions())) {
  server.use(http.get(ROUTES.positions, () => HttpResponse.json(payload)))
  return renderApp({ url })
}

const table = () => screen.findByRole('table', { name: 'Lignes détenues' })

function footer(root: HTMLElement) {
  const rows = root.querySelectorAll('tfoot tr')
  expect(rows).toHaveLength(1)
  return rows[0] as HTMLElement
}

describe('the table alone', () => {
  it('has the six columns of the mockup, valuation first', async () => {
    renderShares()
    const live = await table()
    expect(
      within(live)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent?.trim()),
    ).toEqual([
      'Titre',
      'Détenu · prix moyen',
      'Cours · jour',
      'Investi',
      'Valorisation · poids',
      'Gain',
    ])
    // Sorted by valuation, descending, and the column says so.
    const sorted = within(live).getByRole('columnheader', { name: 'Valorisation · poids' })
    expect(sorted).toHaveAttribute('aria-sort', 'descending')
    expect(within(live).getByRole('columnheader', { name: 'Investi' })).not.toHaveAttribute(
      'aria-sort',
    )
  })

  it('lists the held lines, closed ones left out, each leading to its page', async () => {
    renderShares('/shares', aPositionsPayload(sharesPortfolio()))
    const live = await table()
    const names = within(live)
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(names).toEqual(['Zeta Alpha', 'Zeta Gamma', 'Zeta Beta'])
    expect(within(live).getByRole('link', { name: 'Zeta Alpha' })).toHaveAttribute(
      'href',
      '/shares/ZZA',
    )
    expect(screen.queryByText('Zeta Delta')).not.toBeInTheDocument()
  })

  it('says the holding, the day and the weight under their figures', async () => {
    renderShares()
    const live = await table()
    const alpha = within(live)
      .getByRole('link', { name: 'Zeta Alpha' })
      .closest('tr') as HTMLElement
    // 10 held at an average 100,00; 130,00 today, +2,00 % on the day; 56,5 % of 2 300,00.
    expect(alpha).toHaveTextContent(/10\s*100,00/)
    expect(alpha).toHaveTextContent(/130,00.*\+2,00\s?%/)
    expect(alpha).toHaveTextContent(/1\D?300,00.*56,5\s?%/)
    expect(alpha).toHaveTextContent(/\+300,00.*\+30,00\s?%/)
  })

  it('sums the rows above it in its last row', async () => {
    renderShares()
    const total = footer(await table())
    expect(total).toHaveTextContent(/Total.*3 lignes/)
    expect(total).toHaveTextContent(/2\D?000,00/)
    expect(total).toHaveTextContent(/2\D?300,00.*100\s?%/)
    expect(total).toHaveTextContent(/\+300,00/)
  })

  it('states the securities gain with its base beside it', async () => {
    renderShares()
    await table()
    expect(screen.getByText(/Plus-value des titres/)).toHaveTextContent(
      /\+300,00.*hors dividendes et liquidités/,
    )
    expect(screen.getByText(/investis/)).toHaveTextContent(/sur\s*3\s*lignes, pour\s*2\D?000,00/)
  })

  it('shows the payload ratio of the gain when it states one, and computes none otherwise', async () => {
    renderShares('/shares', { ...aPositionsPayload(defaultPositions()), latent_gain_pct: 0.15 })
    await table()
    expect(screen.getByText(/Plus-value des titres/)).toHaveTextContent(/\(\+15,00\s?%\)/)
    expect(footer(await table())).toHaveTextContent(/\+15,00\s?%/)
  })

  it('does not state a ratio the payload did not', async () => {
    renderShares()
    await table()
    expect(screen.getByText(/Plus-value des titres/)).not.toHaveTextContent(/\(\+/)
  })

  it('re-sorts on a header, naming the column in force', async () => {
    const { user } = renderShares()
    const live = await table()
    await user.click(within(live).getByRole('button', { name: 'Investi' }))
    expect(within(live).getByRole('columnheader', { name: 'Investi' })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    expect(
      within(live)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Zeta Alpha', 'Zeta Gamma', 'Zeta Beta'])
    await user.click(within(live).getByRole('button', { name: 'Investi' }))
    expect(within(live).getByRole('columnheader', { name: 'Investi' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
  })

  it('opens a title on its row', async () => {
    const { user } = renderShares()
    const live = await table()
    await user.click(within(live).getByRole('link', { name: 'Zeta Gamma' }))
    expect(await screen.findByText('Valorisation de la ligne')).toBeInTheDocument()
  })

  it('hands the old ?symbol= address over to the title page', async () => {
    renderShares('/shares?symbol=ZZA')
    expect(await screen.findByText('Valorisation de la ligne')).toBeInTheDocument()
  })

  it('reduces to one account and says so', async () => {
    renderShares('/shares?account=beta')
    const live = await table()
    expect(
      within(live)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Zeta Beta'])
    expect(screen.getByText(/Réduit au compte beta/)).toBeInTheDocument()
  })

  it('says why it is empty, over an answered read only', async () => {
    renderShares('/shares', aPositionsPayload([]))
    expect(await screen.findByText('Aucune ligne')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Aller au grand livre' })).toBeInTheDocument()
  })

  it('says it could not read, where the table would have been', async () => {
    server.use(problemHandler(ROUTES.positions, UNAVAILABLE))
    renderApp({ url: '/shares' })
    await waitFor(() => expect(screen.getByText(/Lecture impossible/)).toBeInTheDocument())
    expect(screen.queryByRole('table', { name: 'Lignes détenues' })).not.toBeInTheDocument()
  })

  it('becomes a ruled list under 768 px, each line leading to its page', async () => {
    setViewportWidth(390)
    renderShares()
    const list = await screen.findByRole('list', { name: 'Lignes détenues' })
    expect(within(list).getByRole('link', { name: /Zeta Alpha/ })).toHaveAttribute(
      'href',
      '/shares/ZZA',
    )
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('the title page', () => {
  it('leads with the line, its gain and its holding', async () => {
    renderShares('/shares/ZZA')
    expect(await screen.findByText('Valorisation de la ligne')).toBeInTheDocument()
    expect(screen.getByText(/de gain/).parentElement).toHaveTextContent(
      /\+300,00.*\(\+30,00\s?%\).*10.*titres au prix moyen d’achat de.*100,00/,
    )
    expect(screen.getByRole('link', { name: '← Titres' })).toHaveAttribute('href', '/shares')
  })

  it('names the invested and the gained, and the three terms of the gain', async () => {
    renderShares('/shares/ZZA')
    await screen.findByText('Valorisation de la ligne')
    const bar = screen.getByRole('img', { name: /^Investi .*gain .* de la valorisation$/ })
    expect(bar).toBeInTheDocument()
    expect(screen.getByText('Latente').parentElement).toHaveTextContent(/\+300,00/)
    expect(screen.getByText('Dividendes').parentElement).toHaveTextContent(/25,00/)
  })

  it('draws the price and its legend, the average purchase price included', async () => {
    renderShares('/shares/ZZA')
    expect(await screen.findByRole('radiogroup', { name: 'Plage' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '1 an' })).toBeChecked()
    expect(await screen.findByText('Prix moyen d’achat')).toBeInTheDocument()
  })

  it('lists the last events and leads to the ledger', async () => {
    renderShares('/shares/ZZA')
    const section = (await screen.findByRole('region', { name: 'Événements' })) as HTMLElement
    expect(await within(section).findByRole('table')).toBeInTheDocument()
    expect(within(section).getAllByText('Achat').length).toBeGreaterThan(0)
    expect(within(section).getByRole('link', { name: /dans le grand livre/ })).toHaveAttribute(
      'href',
      '/ledger',
    )
  })

  it('says what the title is, its accounts linked', async () => {
    renderShares('/shares/ZZA')
    const section = await screen.findByRole('region', { name: 'Le titre' })
    expect(within(section).getByRole('link', { name: 'alpha' })).toHaveAttribute(
      'href',
      '/accounts?account=alpha',
    )
    expect(section).toHaveTextContent(/Part du portefeuille.*56,5\s?%/)
  })

  it('says a title is unknown only over an answered read, and offers the way back', async () => {
    renderShares('/shares/NOPE')
    expect(await screen.findByText('Titre introuvable')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Titres' })).toBeInTheDocument()
  })

  it('says the ledger could not be read where the events would be', async () => {
    server.use(problemHandler(ROUTES.events, UNAVAILABLE))
    renderShares('/shares/ZZA')
    const section = await screen.findByRole('region', { name: 'Événements' })
    await waitFor(() => expect(within(section).getByText(/Lecture impossible/)).toBeInTheDocument())
  })
})
