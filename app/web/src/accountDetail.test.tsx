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
  aPositionsPayload,
  defaultAccounts,
  defaultPositions,
  ledgerEvents,
  positionsGoingNowhere,
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
  return renderApp({ url: '/comptes' })
}

/** Open one account's detail — a click on its rail entry, which is a URL. */
async function open(user: ReturnType<typeof renderApp>['user'], name: string) {
  const rail = await screen.findByRole('list', { name: 'Vos comptes' })
  await user.click(within(rail).getByRole('link', { name: new RegExp(name) }))
  return screen.findByRole('region', { name })
}

function head(detail: HTMLElement) {
  return within(detail).getByRole('group', { name: 'Gain total' })
}

describe('the four terms explain the total', () => {
  it('mounts them **inside** the total rather than beside it', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')
    const group = await waitFor(() => {
      const found = head(detail)
      expect(found).toHaveTextContent(/322,00/)
      return found
    })

    // The nesting **is** the subordination, and it is the other half of
    // ADR-0016's rule rather than an exception to it: a table row has the
    // horizontal axis and nothing else, so the terms had to leave the table —
    // a block is the only place they can be *inside* the total.
    for (const term of ['Plus-value latente', 'Plus-value réalisée', 'Dividendes reçus']) {
      expect(within(group).getByRole('group', { name: term })).toBeInTheDocument()
    }
    expect(within(group).getByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /300,00/,
    )
    expect(within(group).getByRole('group', { name: 'Dividendes reçus' })).toHaveTextContent(/25,00/)
    expect(within(group).getByRole('group', { name: /Frais/ })).toHaveTextContent(/3,00/)
  })

  it('keeps the contribution out of the four, being the denominator and not a term', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')
    const group = await waitFor(() => {
      const found = head(detail)
      expect(found).toHaveTextContent(/322,00/)
      return found
    })

    // 1 800,00 − 322,00. It is what makes a gain legible as *this account went
    // nowhere* rather than as a typo — and it is not one of the four, so it
    // does not live inside the total's own group.
    const contributed = within(detail).getByRole('group', { name: 'Versé net' })
    expect(contributed).toHaveTextContent(/1\s?478,00/)
    expect(within(group).queryByRole('group', { name: 'Versé net' })).not.toBeInTheDocument()
  })

  it('reads an account that went nowhere while its terms did not', async () => {
    const { user } = renderAccounts(
      [...defaultAccounts(), anAccountGoingNowhere()],
      [...defaultPositions(), ...positionsGoingNowhere()],
    )
    const detail = await open(user, 'Nowhere')
    const group = await waitFor(() => {
      const found = head(detail)
      expect(found).toHaveTextContent(/-0,63/)
      return found
    })

    expect(within(group).getByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /-47,65/,
    )
    expect(within(group).getByRole('group', { name: 'Plus-value réalisée' })).toHaveTextContent(
      /60,97/,
    )
    expect(within(group).getByRole('group', { name: 'Dividendes reçus' })).toHaveTextContent(/0,00/)
    expect(within(group).getByRole('group', { name: /Frais/ })).toHaveTextContent(/13,95/)
  })

  it('carries this account’s fees and never the portfolio’s', async () => {
    // `−5,00` is the global fourth term, and it is the sum of three accounts'.
    // Read here it would make the detail of one account state another's cost.
    const { user } = renderAccounts()
    const detail = await open(user, 'Beta')
    const group = await waitFor(() => {
      const found = head(detail)
      expect(found).toHaveTextContent(/48,00/)
      return found
    })

    expect(within(group).getByRole('group', { name: /Frais/ })).toHaveTextContent(/2,00/)
    expect(group).not.toHaveTextContent(/5,00/)
  })

  it('drops the fourth term where the broker took nothing', async () => {
    // ADR-0018: an install whose transfers are free reads three terms and never
    // learns the fourth exists. `0,00 €` there is not a figure worth a line.
    const { user } = renderAccounts()
    const detail = await open(user, 'Gamma')
    const group = await waitFor(() => {
      const found = head(detail)
      expect(found).toHaveTextContent(/0,00/)
      return found
    })

    expect(within(group).queryByRole('group', { name: /Frais/ })).not.toBeInTheDocument()
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

    const group = await waitFor(() => {
      const found = head(detail)
      expect(within(found).getByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
        /300,00/,
      )
      return found
    })
    expect(within(group).getByRole('group', { name: /Frais/ })).toHaveTextContent('—')
    // The three terms it does hold sum to `+325,00`, and that figure is exactly
    // what must **not** be written under the name of a total whose fourth term
    // nobody could state.
    expect(group).not.toHaveTextContent(/325,00/)
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

  it('lists the lines it holds, and leads to the page reduced to this account', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')

    const lines = await within(detail).findByRole('list', { name: 'Lignes détenues' })
    expect(within(lines).getAllByRole('listitem')).toHaveLength(1)
    expect(lines).toHaveTextContent('ZZA')
    // The link counts what the page it leads to shows — **symbols**, closed
    // lines included, since that page folds them rather than filtering them
    // (ADR-0017) — which is why it says *lines* and not *held positions*: the
    // list above it is the held ones and the two counts are two subjects. And
    // the reduction is a URL, so it survives a reload.
    expect(
      within(detail).getByRole('link', { name: 'Voir la ligne de ce compte dans Titres' }),
    ).toHaveAttribute('href', '/titres?compte=alpha')
  })

  it('has no lines block at all where the account holds nothing', async () => {
    // A block with nothing in it does not exist — and a reduction onto an empty
    // page is a dead end with a count on it.
    const { user } = renderAccounts(defaultAccounts(), [defaultPositions()[0]])
    const detail = await open(user, 'Gamma')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/0,00/))

    expect(within(detail).queryByRole('list', { name: 'Lignes détenues' })).not.toBeInTheDocument()
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
    ).toHaveAttribute('href', '/donnees')
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

describe('one range control, two figures', () => {
  function range() {
    return screen.getByRole('radiogroup', { name: 'Plage' })
  }

  it('drives the rate and the curve beside it from one gesture', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')

    // One year: 171,5 / 150 − 1. One month: 171,5 / 165 − 1. Both figures
    // correct, and only the control says which period is being read.
    await waitFor(() =>
      expect(within(detail).getByRole('group', { name: 'perf' })).toHaveTextContent(/\+14,33/),
    )
    expect(
      within(detail).getByRole('heading', { name: 'Valeur face à ce que vous avez versé' }),
    ).toBeInTheDocument()

    await user.click(within(range()).getByRole('radio', { name: '1M' }))
    await waitFor(() =>
      expect(within(detail).getByRole('group', { name: 'perf' })).toHaveTextContent(/\+3,94/),
    )
  })

  it('bounds the longest window at the account’s own opening, never at MAX', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')
    await waitFor(() =>
      expect(within(detail).getByRole('group', { name: 'perf' })).toHaveTextContent(/\+14,33/),
    )

    // From 2019-10-30, base 100: the stored index is 171,5, so the account is
    // up 71,50 % — a figure that is only readable **with** its period, which is
    // why the control carries it and no sentence repeats it.
    await user.click(within(range()).getByRole('radio', { name: 'Depuis l’ouverture' }))
    await waitFor(() =>
      expect(within(detail).getByRole('group', { name: 'perf' })).toHaveTextContent(/\+71,50/),
    )
    expect(within(range()).queryByRole('radio', { name: 'MAX' })).not.toBeInTheDocument()
  })

  it('keeps the control where the window it asks for holds nothing', async () => {
    // `windowStart` answers `null` on `SINCE_OPENING` alone, and it means this
    // account's series carries no index at all (#708) — a fact, not a read in
    // flight. Folded into the same branch the card vanished **with its control**,
    // so the reader who clicked *depuis l'ouverture* on an account with no cash
    // ledger lost the very radio that would have brought them back.
    const { user } = renderAccounts()
    const detail = await open(user, 'Gamma')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/0,00/))

    await user.click(within(range()).getByRole('radio', { name: 'Depuis l’ouverture' }))
    expect(within(range()).getByRole('radio', { name: '1M' })).toBeInTheDocument()
    expect(within(detail).getByRole('group', { name: 'perf' })).toHaveTextContent('—')
  })

  it('draws nothing where the account has no value to draw', async () => {
    // A block with nothing in it does not exist: `gamma` has no cash event, so
    // no `total_value` on any day, and the rail has already named that reason.
    const { user } = renderAccounts()
    const detail = await open(user, 'Gamma')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/0,00/))

    expect(
      within(detail).queryByRole('heading', { name: 'Valeur face à ce que vous avez versé' }),
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
    const { user } = renderApp({ url: '/comptes' })
    const detail = await open(user, 'Alpha')

    // The detail's other reads *have* landed — the curve comes from
    // `/api/accounts/alpha/history`, which answers. So what follows is an
    // absence under a rendered detail, not a detail that has not rendered.
    expect(
      await within(detail).findByRole('heading', {
        name: 'Valeur face à ce que vous avez versé',
      }),
    ).toBeInTheDocument()

    expect(within(detail).queryByRole('group', { name: 'Gain total' })).not.toBeInTheDocument()
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

  it('draws neither curve nor rate while the series has not answered', async () => {
    server.use(http.get(ROUTES.accountHistory, () => new Promise<never>(() => {})))
    const { user } = renderApp({ url: '/comptes' })
    const detail = await open(user, 'Alpha')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/322,00/))

    // The whole card, control and title included: a range control offering four
    // windows onto nothing is an announcer of a period nobody has read.
    expect(screen.queryByRole('radiogroup', { name: 'Plage' })).not.toBeInTheDocument()
    expect(within(detail).queryByRole('group', { name: 'perf' })).not.toBeInTheDocument()
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
    renderApp({ url: '/comptes' })

    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    expect(screen.queryByRole('group', { name: 'Gain total' })).not.toBeInTheDocument()
  })
})

describe('the bubbles', () => {
  it('states the scope of the total on the figure itself', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')
    await waitFor(() => expect(head(detail)).toHaveTextContent(/322,00/))

    await user.click(within(detail).getByRole('button', { name: 'Ce que veut dire Gain total' }))
    const bubble = (await screen.findAllByRole('dialog')).find((node) =>
      /leur somme est le total/.test(node.textContent ?? ''),
    ) as HTMLElement
    expect(bubble).toBeDefined()
    expect(within(bubble).getByRole('link')).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#total-gain',
    )
  })

  it('lets the rate warn against its own figure, and opens on click and not on hover', async () => {
    const { user } = renderAccounts()
    const detail = await open(user, 'Alpha')
    const trigger = await within(detail).findByRole('button', { name: 'Ce que veut dire perf' })

    await user.hover(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(trigger)
    const bubble = await screen.findByRole('dialog')
    // The one bubble in the product that warns against its own figure.
    expect(bubble).toHaveTextContent(/s’inversent quatre fois sur sept plages/)
    expect(bubble).toHaveTextContent(
      /Les rendements sont calculés à partir des dates de vos événements\./,
    )
  })
})
