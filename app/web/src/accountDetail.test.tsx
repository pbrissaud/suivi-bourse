/**
 * One account's detail (ADR-0028, ADR-0018, ADR-0019, ADR-0016), at the one
 * seam: the whole app in jsdom, HTTP the only faked edge.
 *
 * Two of its criteria exist nowhere else. *`Gain total` dominates its four
 * terms* is a statement about **nesting** — the terms live inside the total's
 * own group — and it only appears once the real `Stat`, the real catalogue and
 * the real payloads are mounted together. And *one range control drives the
 * curve and the rate beside it* is a statement about **two figures at once**,
 * which a component test of either would attest half of.
 *
 * The measured shape the four terms rest on is `anAccountGoingNowhere`:
 *
 *     Gain total −0,63 €   =   −47,65 · +60,97 · 0,00 · −13,95
 *
 * Read as one figure that account has done nothing; read as four terms, one
 * sees **why** — an unrealised loss and a realised gain that cancel, and no
 * dividend.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import type { Account, Position } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  anAccountGoingNowhere,
  anAccountsPayload,
  anAccountWithoutSeries,
  aLedgerPayload,
  aPosition,
  aPositionsPayload,
  defaultAccounts,
  defaultPositions,
  ledgerEvents,
  positionsGoingNowhere,
  sharesPortfolio,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

function renderAccounts(
  accounts: Account[] = defaultAccounts(),
  positions: Position[] = defaultPositions(),
) {
  server.use(
    http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload(accounts))),
    http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload(positions))),
  )
  return renderApp({ url: '/accounts' })
}

/** Open one account's detail — a click on its rail entry, which is a URL. */
async function open(user: ReturnType<typeof renderApp>['user'], name: string) {
  const rail = await screen.findByRole('list', { name: 'Vos comptes' })
  await user.click(within(rail).getByRole('link', { name: new RegExp(name) }))
  return screen.findByRole('region', { name })
}

/**
 * The head's own gain — **`Gain`, and no longer `Gain total`** (#838). The
 * drawing states it on one line beside the contribution it is a change of,
 * rather than as a 52 px figure with four terms nested under it.
 */
function head(detail: HTMLElement) {
  return within(detail).getByRole('group', { name: 'Gain' })
}

describe('the head states the account, and the curve is in it', () => {
  it('leads with the value, and puts the two figures it is a change of under it', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/322,00/))

    // **What the drawing leads an account with** (#838): what it is worth, then
    // — one rung down and on one line — what was paid in and what that has
    // become. The four-term list that used to be nested in a 52 px `Gain total`
    // is gone with the figure: the dividends have a card of their own on this
    // page, the fees are the line below, and the latent gain is a column of the
    // lines table further down.
    expect(within(detail).getByRole('group', { name: 'Valeur totale' })).toHaveTextContent(
      /1\s?800,00/,
    )
    expect(within(detail).getByRole('group', { name: 'Versé net' })).toHaveTextContent(
      /1\s?478,00/,
    )
    expect(within(detail).queryByRole('group', { name: 'Gain total' })).not.toBeInTheDocument()
    expect(
      within(detail).queryByRole('group', { name: 'Plus-value latente' }),
    ).not.toBeInTheDocument()
  })

  it('states the fees this account paid, and what they are of what was paid in', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/322,00/))

    // ADR-0018's fourth term belongs to no security, so it is the one the head
    // says in its own words rather than in a column — and it says it against
    // the same denominator the ratio beside it divides.
    const fees = within(detail).getByRole('group', { name: /Frais/ })
    expect(fees).toHaveTextContent(/3,00/)
    expect(fees).toHaveTextContent(/du versé/)
  })

  it('reads an account that went nowhere, and says so with the gain and not a term', async () => {
    const { user } = renderAccounts(
      [...defaultAccounts(), anAccountGoingNowhere()],
      [...defaultPositions(), ...positionsGoingNowhere()],
    )
    const detail = await open(user, 'Nowhere')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/-0,63/))

    // The four terms are not on this page any more (#838) — what stays is that
    // the gain is **computed** from them and never read off `gain_absolu`, and
    // that the fees this account paid are its own.
    expect(within(detail).getByRole('group', { name: /Frais/ })).toHaveTextContent(/13,95/)
  })

  it('carries this account’s fees and never the portfolio’s', async () => {
    // `−5,00` is the global fourth term, and it is the sum of three accounts'.
    // Read here it would make the detail of one account state another's cost.
    const { user } = renderAccounts()
    const detail = await open(user, 'Beta')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/48,00/))

    expect(within(detail).getByRole('group', { name: /Frais/ })).toHaveTextContent(/2,00/)
    expect(within(detail).queryByText(/5,00\s?€/)).not.toBeInTheDocument()
  })

  it('drops the fourth term where the broker took nothing', async () => {
    // ADR-0018: an install whose transfers are free reads three terms and never
    // learns the fourth exists. `0,00 €` there is not a figure worth a line.
    const { user } = renderAccounts()
    const detail = await open(user, 'Gamma')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/0,00/))

    expect(within(detail).queryByRole('group', { name: /Frais/ })).not.toBeInTheDocument()
  })

  it('computes the head instead of reading the figure written beside it', async () => {
    // ADR-0018: the sum **is** the definition. A `gain_absolu` that disagrees
    // is the same number written down elsewhere, and it changes nothing here.
    const { user } = renderAccounts(
      defaultAccounts().map((account) =>
        account.id === 'alpha' ? { ...account, gain_absolu: 99999 } : account,
      ),
    )
    const detail = await open(user, 'Alpha')

    await waitFor(() => expect(head(detail)).toHaveTextContent(/322,00/))
    expect(within(detail).queryByText(/99 999/)).not.toBeInTheDocument()
  })

  it('refuses a four-term total rendered from three (#775)', async () => {
    // `transfer_fees: null` is the server's own sentence — *no day to bound the
    // fees by*, so no coherent statement to make (#722) — and a total missing a
    // term is not that total (ADR-0018). **And the term renders, as a dash**: a
    // headline that goes out with no visible cause under it is worse than the
    // wrong number it replaces.
    const { user } = renderAccounts([anAccountWithoutSeries(), ...defaultAccounts().slice(1)])
    const detail = await open(user, 'Alpha')

    // **And the term renders, as a dash**: a headline that goes out with no
    // visible cause under it is worse than the wrong number it replaces. The
    // fees line is dropped at **zero** and never at `null`, which is the
    // server's own *no day to bound them by*.
    const fees = await within(detail).findByRole('group', { name: /Frais/ })
    expect(fees).toHaveTextContent('—')
    // The three terms it does hold sum to `+325,00`, and that figure is exactly
    // what must **not** be written under the name of a total whose fourth term
    // nobody could state.
    expect(head(detail)).not.toHaveTextContent(/325,00/)
  })
})

describe('the five blocks', () => {
  it('splits what the account holds between securities and cash', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')

    // A total and its terms never share a row: the two are subordinate to the
    // value, and each is its own figure.
    const total = await within(detail).findByRole('group', { name: 'Valeur totale' })
    expect(total).toHaveTextContent(/1\s?800,00/)
    expect(within(detail).getByRole('group', { name: 'Titres' })).toHaveTextContent(/1\s?300,00/)
    expect(within(detail).getByRole('group', { name: 'Liquidités' })).toHaveTextContent(/500,00/)
  })

  it('states the annualised rate, which has no window to narrow', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')

    // Money-weighted since the origin: the range control above it moves the
    // other rate and never this one, and the bubble is what says so.
    expect(await within(detail).findByRole('group', { name: 'TRI' })).toHaveTextContent(/\+5,12/)
  })

  it('promotes the dividends this account has actually paid', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')

    // The very term the block above decomposes, read once and rendered at two
    // altitudes: *what has this account paid me* is the one term that answers a
    // question on its own.
    expect(await within(detail).findByRole('group', { name: 'Encaissés' })).toHaveTextContent(
      /25,00/,
    )
  })

  it('states what the dividends are worth against what was paid in', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')

    // 25,00 / 1 478,00 = 1,69 %. It divides the **contribution**, which is what
    // the two rates on this page already divide — a third base would be a
    // second denominator for one page to explain. And it wears no sign: a share
    // is not a change (`lib/format.ts`).
    expect(await within(detail).findByRole('group', { name: 'Sur le versé' })).toHaveTextContent(
      /^Sur le versé1,69\s?%$/,
    )
  })

  it('says nothing to compute where nothing was ever paid in', async () => {
    // `gamma` has no cash movement at all, so there is no contribution to
    // divide — the em dash's own sentence, and not a zero.
    const { user } = renderAccounts()
    const detail = await open(user, 'Gamma')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/0,00/))

    expect(within(detail).getByRole('group', { name: 'Sur le versé' })).toHaveTextContent('—')
  })

  it('names the securities that pay the dividends, and states their extent', async () => {
    const { user } = renderAccounts(defaultAccounts(), sharesPortfolio())
    const detail = await open(user, 'Alpha')

    const payers = await within(detail).findByRole('list', { name: 'Titres distributeurs' })
    const rows = within(payers).getAllByRole('listitem')
    // Biggest payer first, the line that was sold kept what it paid, and the
    // two shares close the whole: 25,00 and 10,00 of 35,00.
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent(/ZZA/)
    expect(rows[0]).toHaveTextContent(/71,43\s?%/)
    expect(rows[1]).toHaveTextContent(/ZZD/)
    expect(rows[1]).toHaveTextContent(/28,57\s?%/)
    // **Its own extent, and not the range control's**: `position.dividends` is
    // a lifetime total, so a block sitting silently under that control would
    // borrow a window it does not obey (ADR-0028).
    expect(detail).toHaveTextContent('Depuis l’ouverture de ce compte')
  })

  it('has no distributing-securities block where no line has ever paid', async () => {
    // A block with nothing in it does not exist — and every line at `0,00 €`
    // answers *which lines pay me* with the whole portfolio.
    const { user } = renderAccounts()
    const detail = await open(user, 'Gamma')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/0,00/))

    expect(
      within(detail).queryByRole('list', { name: 'Titres distributeurs' }),
    ).not.toBeInTheDocument()
  })

  it('draws the weight of each line beside the figure that states it', async () => {
    const { user } = renderAccounts(defaultAccounts(), [
      ...defaultPositions(),
      aPosition({ account: 'alpha', symbol: 'ZZF', name: 'Zeta Phi', quantity: 2, cost_basis: 200 }),
    ])
    const detail = await open(user, 'Alpha')

    const lines = await within(detail).findByRole('list', { name: 'Titres du compte' })
    const rows = within(lines).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    // 1 300,00 of 1 560,00, then 260,00 of it. The figure is written out, which
    // is what lets the bar beside it be `aria-hidden` (#800) — and the word
    // that says *which* percentage it is, this row carrying three, is
    // announced.
    expect(rows[0]).toHaveTextContent(/83,33\s?%/)
    expect(rows[1]).toHaveTextContent(/16,67\s?%/)
    expect(within(rows[0]).getByText('Poids')).toBeInTheDocument()
  })

  it('lists the lines it holds, and leads to the page reduced to this account', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')

    const lines = await within(detail).findByRole('list', { name: 'Titres du compte' })
    expect(within(lines).getAllByRole('listitem')).toHaveLength(1)
    expect(lines).toHaveTextContent('ZZA')
    // The link counts what the page it leads to shows — **symbols**, closed
    // lines included, since that page folds them rather than filtering them
    // (ADR-0017) — which is why it says *lines* and not *held positions*: the
    // list above it is the held ones and the two counts are two subjects. And
    // the reduction is a URL, so it survives a reload.
    expect(
      within(detail).getByRole('link', { name: 'Voir la ligne de ce compte dans Titres' }),
    ).toHaveAttribute('href', '/shares?account=alpha')
  })

  it('has no lines block at all where the account holds nothing', async () => {
    // A block with nothing in it does not exist — and a reduction onto an empty
    // page is a dead end with a count on it.
    const { user } = renderAccounts(defaultAccounts(), [defaultPositions()[0]])
    const detail = await open(user, 'Gamma')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/0,00/))

    expect(within(detail).queryByRole('list', { name: 'Titres du compte' })).not.toBeInTheDocument()
    expect(within(detail).queryByRole('link', { name: /ligne/ })).not.toBeInTheDocument()
  })

  it('shows the last events that name the account, and leads to the ledger', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')

    const events = await within(detail).findByRole('list', { name: 'Derniers événements' })
    // Newest first, and the four the fixture's ledger names `alpha` with.
    expect(within(events).getAllByRole('listitem')).toHaveLength(4)
    expect(within(events).getAllByRole('listitem')[0]).toHaveTextContent('10 févr. 2026')
    expect(
      within(detail).getByRole('link', { name: 'Voir tout le grand livre' }),
    ).toHaveAttribute('href', '/ledger')
  })

  it('has no events block where no event names the account', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Beta')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/48,00/))

    // The fixture's ledger names `alpha` on every row, so this is a landed
    // payload with nothing in it for this account — not a read in flight.
    expect(
      within(detail).queryByRole('list', { name: 'Derniers événements' }),
    ).not.toBeInTheDocument()
  })

  it('reads a blank account as the seeded row', async () => {
    // An install that recorded events before declaring anything writes them
    // under a row nobody named (ADR-0013), and the payload reports the blank it
    // resolved.
    server.use(
      http.get(ROUTES.events, () =>
        HttpResponse.json(aLedgerPayload(ledgerEvents().map((event) => ({ ...event, account: '' })))),
      ),
    )
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/322,00/))

    expect(
      within(detail).queryByRole('list', { name: 'Derniers événements' }),
    ).not.toBeInTheDocument()
  })
})

describe('no range control, and a cumulative ratio in its place', () => {
  it('reads the whole gain against what was paid in', async () => {
    // 322,00 of 1 478,00 — the head's own total divided by the contribution
    // one line above it, which is what `Performance totale` is. It is a
    // **change**, so it carries its sign, where the *sur versé* under the
    // dividends is a share and carries none.
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')

    const figure = await within(detail).findByRole('group', { name: 'Performance totale' })
    await waitFor(() => expect(figure).toHaveTextContent(/\+21,79\s?%/))
  })

  it('says nothing to compute where nothing was ever paid in', async () => {
    // `gamma` has no cash movement at all, so there is no contribution to
    // divide by — the em dash's own sentence, and not a ratio of zero.
    const { user } = renderAccounts()
    const detail = await open(user, 'Gamma')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/0,00/))

    expect(
      within(detail).getByRole('group', { name: 'Performance totale' }),
    ).toHaveTextContent('—')
  })

  it('offers no window to read it over, on this page or anywhere in it', async () => {
    // ADR-0028 corrected: the control is the dashboard accounts card's, and the
    // detail draws one series on one axis — where the rule the control keeps is
    // about several spans read side by side. The maquette this page takes its
    // form from defines its presets and renders them nowhere.
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/322,00/))

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(within(detail).queryByRole('group', { name: 'perf' })).not.toBeInTheDocument()
  })

  it('states on the drawing itself the extent it covers', async () => {
    // ADR-0028's sparkline clause is *carry the period or carry no figure*, and
    // with no control above the chart the legend is the one place it is said.
    // What is drawn is the account's history end to end.
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')

    await waitFor(() =>
      expect(detail).toHaveTextContent('Dessiné sur toute l’histoire de ce compte'),
    )
    expect(
      within(detail).getByRole('region', { name: 'Valeur face à ce que vous avez versé' }),
    ).toBeInTheDocument()
  })

  it('draws nothing where the account has no value to draw', async () => {
    // A block with nothing in it does not exist: `gamma` has no cash event, so
    // no `total_value` on any day, and the rail has already named that reason.
    const { user } = renderAccounts()
    const detail = await open(user, 'Gamma')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/0,00/))

    expect(
      within(detail).queryByRole('region', { name: 'Valeur face à ce que vous avez versé' }),
    ).not.toBeInTheDocument()
  })
})

describe('a read in flight is not an absence', () => {
  it('writes none of the four terms while the positions have not answered', async () => {
    // `?? []` summed the three position terms over nothing and rendered them as
    // `0,00 €` beside a real fourth term read off the account row, so a detail
    // opened cold announced a `Gain total` the rail beside it contradicted.
    server.use(
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload())),
      // Never settles: the read is in flight for the whole of the test.
      http.get(ROUTES.positions, () => new Promise<never>(() => {})),
    )
    const { user } = renderApp({ url: '/accounts' })
    const detail = await open(user, 'Alpha')

    // The detail's other reads *have* landed — the curve comes from
    // `/api/accounts/alpha/history`, which answers. So what follows is an
    // absence under a rendered detail, not a detail that has not rendered.
    expect(
      await within(detail).findByRole('region', {
        name: 'Valeur face à ce que vous avez versé',
      }),
    ).toBeInTheDocument()

    expect(within(detail).queryByRole('group', { name: 'Gain' })).not.toBeInTheDocument()
    for (const term of [
      'Plus-value latente',
      'Plus-value réalisée',
      'Dividendes reçus',
      'Frais de versement',
    ]) {
      expect(within(detail).queryByRole('group', { name: term })).not.toBeInTheDocument()
    }
    // The dividends block reads the same term, so it waits at the same door.
    expect(within(detail).queryByRole('group', { name: 'Dividendes' })).not.toBeInTheDocument()
    // The link counts the same rows, so it waits there too.
    expect(within(detail).queryByRole('link', { name: /ligne/ })).not.toBeInTheDocument()
    // Nothing failed, so nothing is named either.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('draws no curve while the series has not answered, and keeps the ratio', async () => {
    server.use(http.get(ROUTES.accountHistory, () => new Promise<never>(() => {})))
    const { user } = renderApp({ url: '/accounts' })
    const detail = await open(user, 'Alpha')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/322,00/))

    // The whole card, its title included: a drawing of a series nobody has read
    // is not a drawing that is loading, it is a claim about the reader's data.
    expect(
      within(detail).queryByRole('region', { name: 'Valeur face à ce que vous avez versé' }),
    ).not.toBeInTheDocument()
    // And the head figure stands, because it reads none of that: `Performance
    // totale` divides the four terms by the contribution, both of which landed.
    // A read that failed never costs the reader a block that did answer.
    expect(within(detail).getByRole('group', { name: 'Performance totale' })).toHaveTextContent(
      /\+21,79\s?%/,
    )
  })

  it('names the read it could not make rather than summing nothing', async () => {
    // Three of the four terms come off `/api/positions`, and the shell cannot
    // cover that failure: `/api/runtime` opens no store (#668). A silent
    // `0,00 €` here would be a figure invented out of a request that did not
    // answer.
    server.use(
      problemHandler(ROUTES.positions, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp({ url: '/accounts' })

    // Said where the detail would have been, as an empty state (#829,
    // ADR-0037): there is no band left at the top of the column, and the rail
    // beside it keeps what it did read.
    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.getByText(/son magasin ne répond pas/)).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Gain' })).not.toBeInTheDocument()
  })
})

describe('the bubbles', () => {
  it('states the scope of the total on the figure itself', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/322,00/))

    await user.click(within(detail).getByRole('button', { name: 'Ce que veut dire Gain' }))
    const bubble = (await screen.findAllByRole('dialog')).find((node) =>
      /positions soldées de ce compte/.test(node.textContent ?? ''),
    ) as HTMLElement
    expect(bubble).toBeDefined()
    expect(within(bubble).getByRole('link')).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#total-gain',
    )
  })

  it('says the ratio covers the whole life and no window, on click and not on hover', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')
    const trigger = await within(detail).findByRole('button', {
      name: 'Ce que veut dire Performance totale',
    })

    await user.hover(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(trigger)
    const bubble = await screen.findByRole('dialog')
    // What the figure is **not**, which is the whole reason it can stand with no
    // range beside it: a cumulative ratio, not annualised, saying nothing about
    // when the money went in.
    expect(bubble).toHaveTextContent(/ce n’est pas un taux annuel/)
    expect(bubble).toHaveTextContent(/toute la vie du compte/)
    expect(within(bubble).getByRole('link')).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#total-performance',
    )
  })
})
