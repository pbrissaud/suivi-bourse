/**
 * The share's sheet (#720, ADR-0016, ADR-0017), at the one seam: the whole app
 * in jsdom, HTTP the only faked edge.
 *
 * Two of its criteria cannot be attested anywhere else. *`Gain total` dominates
 * its three terms, in a block and not in a row* is a statement about **nesting**
 * — the terms live inside the total's own group — and it only exists once the
 * real `Stat`, the real catalogue and the real payload are mounted together.
 * And *the liaison is a selection, not a hover* is a statement about the two
 * objects at once: the marker on the chart and the line in the list are one
 * state, and a component test of either would attest half of it.
 *
 * **Every gesture here is a click or a key, and never a hover.** ADR-0016
 * refuses hover on the argument this ticket inherits: it does not exist on a
 * finger and says nothing to a keyboard, so a test that drove the selection with
 * `user.hover` would attest a link half the readers do not have.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aPosition,
  aPositionsPayload,
  fundamentalsOf,
  shareLedger,
  sharesPortfolio,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

/** The page, with the ledger the markers are decided on. */
function renderShares(positions = sharesPortfolio(), events = shareLedger()) {
  server.use(
    http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload(positions))),
    http.get(ROUTES.events, () => HttpResponse.json(events)),
  )
  return renderApp({ url: '/titres' })
}

/** Open one share's sheet — the gesture the table offers, and the only one. */
async function openSheet(user: ReturnType<typeof renderApp>['user'], name = 'Zeta Alpha') {
  await waitFor(() =>
    expect(screen.getByRole('group', { name: 'Gain total' })).toHaveTextContent(/460,00/),
  )
  await user.click(screen.getByRole('button', { name }))
  return screen.findByRole('dialog', { name })
}

/** The sheet's own `Gain total` — the page's header carries the same name. */
function sheetHead(sheet: HTMLElement) {
  return within(sheet).getByRole('group', { name: 'Gain total' })
}

describe('ADR-0016’s form, naked', () => {
  it('mounts the three terms **inside** the total rather than beside it', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)
    const head = sheetHead(sheet)

    // The nesting **is** the subordination. In a row there is only the
    // horizontal axis, so a total beside its terms is four numeric figures of
    // equal weight and nothing says the last three are inside the first — the
    // addition ADR-0018 exists to prevent. Here they are literally inside.
    for (const term of ['Plus-value latente', 'Plus-value réalisée', 'Dividendes reçus']) {
      expect(within(head).getByRole('group', { name: term })).toBeInTheDocument()
    }

    // Zeta Alpha: 1 300,00 − 1 000,00 = +300,00 latent, nothing realised,
    // 25,00 of dividends — and their sum is the head, checkable by eye.
    expect(within(head).getByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /300,00/,
    )
    expect(within(head).getByRole('group', { name: 'Dividendes reçus' })).toHaveTextContent(/25,00/)
    expect(head).toHaveTextContent(/325,00/)
  })

  it('states its own scope: this share, and a share of the page’s figure', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)

    await user.click(
      within(sheet).getByRole('button', { name: 'Ce que veut dire Gain total' }),
    )
    // The bubble is portalled beside the sheet, so both are dialogs: the one
    // under test is named by what it says, which is the point of the bubble.
    const bubble = (await screen.findAllByRole('dialog')).find((node) =>
      /ce seul titre/.test(node.textContent ?? ''),
    ) as HTMLElement
    expect(bubble).toBeDefined()
    expect(within(bubble).getByRole('link')).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#total-gain',
    )
  })

  it('drops the position facts to a second rank, behind the gain', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)

    // The five of them, and `Investi` — `Valorisation − latente` — is here
    // precisely because it is not a tenth column in the table.
    for (const fact of ['Cours', 'PRU', 'Détenu', 'Valorisation', 'Investi']) {
      expect(within(sheet).getByRole('group', { name: fact })).toBeInTheDocument()
    }
    expect(within(sheet).getByRole('group', { name: 'Investi' })).toHaveTextContent(/1 000,00/)
    // Behind it: the gain block comes first in the reading order.
    const groups = within(sheet).getAllByRole('group')
    expect(groups.indexOf(sheetHead(sheet))).toBe(0)
  })

  it('has no `Variation` and no per-account backfill readout', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)

    // `Variation` is the percentage already glued to the latent gain in the
    // table, and two announcers for one figure is the defect refused on four
    // pages. `RuntimeDetail` answered a question about the app's own progress on
    // a surface about a security.
    expect(within(sheet).queryByText('Variation')).not.toBeInTheDocument()
    expect(within(sheet).queryByText(/reconstitution|backfill/i)).not.toBeInTheDocument()
    expect(within(sheet).queryByRole('progressbar')).not.toBeInTheDocument()
  })
})

describe('the per-account breakdown', () => {
  it('does not exist at one account', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)

    // It would repeat the block three centimetres above it, line for line.
    expect(within(sheet).queryByRole('table')).not.toBeInTheDocument()
  })

  it('comes back the moment the share is held on two accounts', async () => {
    const { user } = renderShares([
      ...sharesPortfolio(),
      aPosition({ account: 'alpha', symbol: 'ZZF', name: 'Zeta Phi', quantity: 2, cost_basis: 200, price: 110 }),
      aPosition({ account: 'beta', symbol: 'ZZF', name: 'Zeta Phi', quantity: 3, cost_basis: 300, price: 110 }),
    ])
    await waitFor(() =>
      expect(screen.getByRole('group', { name: 'Gain total' })).toHaveTextContent(/510,00/),
    )
    await user.click(screen.getByRole('button', { name: 'Zeta Phi' }))
    const sheet = await screen.findByRole('dialog', { name: 'Zeta Phi' })

    const table = within(sheet).getByRole('table', { name: 'Ce titre, compte par compte' })
    expect(
      within(table).getAllByRole('columnheader').map((cell) => cell.textContent?.trim()),
    ).toEqual(['Compte', 'Détenu', 'PRU', 'Valorisation', 'Latente'])
    // 2 × 110 = 220,00 against 200,00 and 3 × 110 = 330,00 against 300,00.
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent(/alpha/)
    expect(rows[0]).toHaveTextContent(/220,00/)
    expect(rows[1]).toHaveTextContent(/330,00/)
  })
})

describe('the chart, the list and the fundamentals stay', () => {
  it('keeps the four rungs and the one resolution announcer', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)

    const range = within(sheet).getByRole('radiogroup', { name: 'Plage' })
    expect(within(range).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      '1M',
      '1A',
      '2A',
      'MAX',
    ])
    expect(await within(sheet).findByText('Au relevé')).toBeInTheDocument()
  })

  it('lists this share’s events and nobody else’s', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)

    // Five events on ZZA, and the ZZC one of the same day is not among them.
    const list = within(sheet).getByRole('list', { name: 'Événements' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    expect(within(list).getAllByText('Achat')).toHaveLength(4)
    expect(within(list).getAllByText('Dividende')).toHaveLength(1)
  })

  it('shows the instrument’s attributes, and no block at all without them', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)

    expect(within(sheet).getByText('Le titre')).toBeInTheDocument()
    expect(within(sheet).getByText('ZZE')).toBeInTheDocument()
    expect(within(sheet).getByText('21,40')).toBeInTheDocument()
    // A yield already in percent points, not a ratio — 1,75 % and never 175 %.
    expect(within(sheet).getByText('1,75 %')).toBeInTheDocument()

    // Zeta Gamma has never been quoted: *a block with nothing in it does not
    // exist*, so it renders no fundamentals rather than five em dashes.
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Zeta Gamma' }))
    const other = await screen.findByRole('dialog', { name: 'Zeta Gamma' })
    expect(within(other).queryByText('Le titre')).not.toBeInTheDocument()
  })

  it('writes no line for an attribute the market does not publish', async () => {
    // An ETF has no P/E, and `quote_type` beside it is what makes that legible
    // rather than suspicious. The line is simply absent — never an em dash.
    const { user } = renderShares([
      aPosition({
        account: 'alpha',
        symbol: 'ZZA',
        name: 'Zeta Alpha',
        dividends: 25,
        fundamentals: fundamentalsOf({ pe_ratio: null, quote_type: 'ETF' }),
      }),
      ...sharesPortfolio().slice(1),
    ])
    const sheet = await openSheet(user)

    expect(within(sheet).getByText('ETF')).toBeInTheDocument()
    expect(within(sheet).queryByText('PER')).not.toBeInTheDocument()
  })

  it('names a ledger it could not read instead of showing an empty list', async () => {
    server.use(
      http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload(sharesPortfolio()))),
      problemHandler(ROUTES.events, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    const { user } = renderApp({ url: '/titres' })
    const sheet = await openSheet(user)

    expect(await within(sheet).findByRole('status')).toBeInTheDocument()
    expect(within(sheet).queryByText('Événements')).not.toBeInTheDocument()
  })
})

describe('the liaison is a selection, not a hover', () => {
  it('is one marker per day, announcing its count', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)

    const band = await within(sheet).findByRole('group', { name: 'Jours portant un événement' })
    const markers = within(band).getAllByRole('button')
    // Two days on the visible range, never four points — and the one that
    // carries three says so.
    expect(markers.map((marker) => marker.getAttribute('aria-label'))).toEqual([
      '1 événement le 28 févr. 2026',
      '3 événements le 1 mars 2026',
    ])
    expect(band).toHaveTextContent('×3')
  })

  it('selects nothing on hover', async () => {
    // The mechanism changed and the substance did not (#675/D2 as amended by
    // ADR-0016): pointing enriches, it never carries the state.
    const { user } = renderShares()
    const sheet = await openSheet(user)
    const band = await within(sheet).findByRole('group', { name: 'Jours portant un événement' })

    await user.hover(within(band).getAllByRole('button')[1])
    expect(within(sheet).queryAllByRole('button', { pressed: true })).toHaveLength(0)
    expect(within(sheet).queryAllByRole('button', { current: 'date' })).toHaveLength(0)
  })

  it('clicking a line of the list selects its day, and grows its marker', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)
    const band = await within(sheet).findByRole('group', { name: 'Jours portant un événement' })

    // The 28th carries one event, so selecting its line marks exactly that line.
    await user.click(within(sheet).getByText('28 févr. 2026'))
    expect(within(sheet).getAllByRole('button', { current: 'date' })).toHaveLength(1)
    expect(
      within(band).getByRole('button', { name: '1 événement le 28 févr. 2026' }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking a `×3` marker selects **its** lines — all three of them', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)
    const band = await within(sheet).findByRole('group', { name: 'Jours portant un événement' })

    await user.click(within(band).getByRole('button', { name: '3 événements le 1 mars 2026' }))
    // The unit of the selection is the **day**, which is what the marker counts:
    // three lines, and never a third of a marker.
    expect(within(sheet).getAllByRole('button', { current: 'date' })).toHaveLength(3)
  })

  it('selects a day of three from any one of its lines', async () => {
    const { user } = renderShares()
    const sheet = await openSheet(user)
    const band = await within(sheet).findByRole('group', { name: 'Jours portant un événement' })

    // A marker cannot grow for a third of itself, so one line of a `×3` day
    // marks its two neighbours — the truth of what the reader pointed at.
    await user.click(within(sheet).getByText('Dividende'))
    expect(within(sheet).getAllByRole('button', { current: 'date' })).toHaveLength(3)
    expect(
      within(band).getByRole('button', { name: '3 événements le 1 mars 2026' }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('is reachable by keyboard, on both objects', async () => {
    // Hover is the one input that says nothing to a keyboard or a finger, so
    // both halves of the liaison are controls a key can reach and operate.
    const { user } = renderShares()
    const sheet = await openSheet(user)
    const band = await within(sheet).findByRole('group', { name: 'Jours portant un événement' })

    const marker = within(band).getByRole('button', { name: '3 événements le 1 mars 2026' })
    marker.focus()
    expect(marker).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(within(sheet).getAllByRole('button', { current: 'date' })).toHaveLength(3)

    // And back off it, from the list's side, with the space bar.
    const line = within(sheet).getByText('Dividende').closest('button') as HTMLElement
    line.focus()
    await user.keyboard(' ')
    expect(within(sheet).queryAllByRole('button', { current: 'date' })).toHaveLength(0)
  })

  it('forgets the selection when the reader moves to another share', async () => {
    // A day is a day *of a security*: carried over it would mark a line the next
    // share has no event on, and grow a marker that is not there.
    const { user } = renderShares()
    const sheet = await openSheet(user)
    const band = await within(sheet).findByRole('group', { name: 'Jours portant un événement' })
    await user.click(within(band).getByRole('button', { name: '3 événements le 1 mars 2026' }))
    expect(within(sheet).getAllByRole('button', { current: 'date' })).toHaveLength(3)

    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Zeta Gamma' }))
    const other = await screen.findByRole('dialog', { name: 'Zeta Gamma' })
    expect(within(other).queryAllByRole('button', { current: 'date' })).toHaveLength(0)
  })
})
