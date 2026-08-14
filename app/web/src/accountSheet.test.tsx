/**
 * The account's panel (#722, ADR-0018, ADR-0016, ADR-0019), at the one seam:
 * the whole app in jsdom, HTTP the only faked edge.
 *
 * Two of its criteria exist nowhere else. *`Gain total` dominates its four
 * terms* is a statement about **nesting** — the terms live inside the total's
 * own group — and it only appears once the real `Stat`, the real catalogue and
 * the real payloads are mounted together. And *the six statistics are absent* is
 * a statement about **two surfaces at once**: the row and the panel it opens,
 * which a component test of either would attest half of.
 *
 * The measured shape the whole ticket rests on is `anAccountGoingNowhere`:
 *
 *     Gain total −0,63 €   =   −47,65 · +60,97 · 0,00 · −13,95
 *
 * Read as a cell that account has done nothing; read as four terms, one sees
 * **why** — an unrealised loss and a realised gain that cancel, and no dividend.
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
  aPositionsPayload,
  defaultAccounts,
  defaultPositions,
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

function table() {
  return screen.getByRole('table', { name: 'Vos comptes, comparés' })
}

/** Open one account's panel — a click anywhere on its row (#721). */
async function openPanel(user: ReturnType<typeof renderApp>['user'], name: string) {
  await waitFor(() => expect(table()).toBeInTheDocument())
  const row = within(table())
    .getAllByRole('row')
    .find((candidate) => (candidate.textContent ?? '').includes(name))!
  await user.click(within(row).getAllByRole('cell')[0])
  return screen.findByRole('dialog')
}

function panelHead(panel: HTMLElement) {
  return within(panel).getByRole('group', { name: 'Gain total' })
}

describe('the four terms explain the total', () => {
  it('mounts them **inside** the total rather than beside it', async () => {
    const { user } = renderAccounts()
    const panel = await openPanel(user, 'Alpha')
    const head = await waitFor(() => {
      const group = panelHead(panel)
      expect(group).toHaveTextContent(/322,00/)
      return group
    })

    // The nesting **is** the subordination, and it is the other half of
    // ADR-0016's rule rather than an exception to it: a table row has the
    // horizontal axis and nothing else, so the terms had to leave the table —
    // a block is the only place they can be *inside* the total.
    for (const term of ['Plus-value latente', 'Plus-value réalisée', 'Dividendes reçus']) {
      expect(within(head).getByRole('group', { name: term })).toBeInTheDocument()
    }
    // Alpha: +300,00 latent, nothing realised, 25,00 of dividends, −3,00 of
    // transfer fees — and their sum is the head, checkable by eye.
    expect(within(head).getByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /300,00/,
    )
    expect(within(head).getByRole('group', { name: 'Dividendes reçus' })).toHaveTextContent(/25,00/)
    expect(within(head).getByRole('group', { name: /Frais/ })).toHaveTextContent(/3,00/)
  })

  it('reads an account that went nowhere while its terms did not', async () => {
    // The measurement the ticket is written on. `−0,63 €` in the row says the
    // account did nothing; the four terms say why, and none of them is small.
    const { user } = renderAccounts(
      [...defaultAccounts(), anAccountGoingNowhere()],
      [...defaultPositions(), ...positionsGoingNowhere()],
    )
    const panel = await openPanel(user, 'Nowhere')
    const head = await waitFor(() => {
      const group = panelHead(panel)
      expect(group).toHaveTextContent(/-0,63/)
      return group
    })

    expect(within(head).getByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /-47,65/,
    )
    expect(within(head).getByRole('group', { name: 'Plus-value réalisée' })).toHaveTextContent(
      /60,97/,
    )
    expect(within(head).getByRole('group', { name: 'Dividendes reçus' })).toHaveTextContent(/0,00/)
    expect(within(head).getByRole('group', { name: /Frais/ })).toHaveTextContent(/13,95/)
  })

  it('carries this account’s fees and never the portfolio’s', async () => {
    // `−5,00` is the global fourth term, and it is the sum of three accounts'.
    // Read here it would make the panel of one account state another's cost.
    const { user } = renderAccounts()
    const panel = await openPanel(user, 'Beta')
    const head = await waitFor(() => {
      const group = panelHead(panel)
      expect(group).toHaveTextContent(/48,00/)
      return group
    })

    expect(within(head).getByRole('group', { name: /Frais/ })).toHaveTextContent(/2,00/)
    expect(head).not.toHaveTextContent(/5,00/)
  })

  it('drops the fourth term where the broker took nothing', async () => {
    // ADR-0018: an install whose transfers are free reads three terms and never
    // learns the fourth exists. `0,00 €` there is not a figure worth a line.
    const { user } = renderAccounts()
    const panel = await openPanel(user, 'Gamma')
    const head = await waitFor(() => {
      const group = panelHead(panel)
      expect(group).toHaveTextContent(/0,00/)
      return group
    })

    expect(within(head).queryByRole('group', { name: /Frais/ })).not.toBeInTheDocument()
  })

  it('computes the head instead of reading the figure written beside it', async () => {
    // ADR-0018: the sum **is** the definition. A `gain_absolu` that disagrees
    // is the same number written down elsewhere, and it changes nothing here.
    const { user } = renderAccounts(
      defaultAccounts().map((account) =>
        account.id === 'alpha' ? { ...account, gain_absolu: 99999 } : account,
      ),
    )
    const panel = await openPanel(user, 'Alpha')

    await waitFor(() => expect(panelHead(panel)).toHaveTextContent(/322,00/))
    expect(within(panel).queryByText(/99 999/)).not.toBeInTheDocument()
  })

  it('names the read it could not make rather than summing nothing', async () => {
    // Three of the four terms come off `/api/positions`, and the shell cannot
    // cover that failure: `/api/runtime` opens no store. A silent `0,00 €` here
    // would be a figure invented out of a request that did not answer.
    server.use(
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload())),
      problemHandler(ROUTES.positions, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    const { user } = renderApp({ url: '/comptes' })
    const panel = await openPanel(user, 'Alpha')

    expect(await within(panel).findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    expect(within(panel).queryByRole('group', { name: 'Gain total' })).not.toBeInTheDocument()
  })

  it('writes none of the four while the positions have not answered', async () => {
    // The same rule as the branch above, on the state the file did **not**
    // hold it for: a request in flight. `?? []` summed the three position
    // terms over nothing and rendered them as `0,00 €` beside a real fourth
    // term read off the account row, so a panel opened cold announced
    // `Gain total −3,00 €` — contradicting the very cell it was opened from —
    // and then swapped it for `+322,00 €`.
    //
    // It is **integral on a cold open** and invisible from `/titres`, where the
    // `['positions']` cache is already warm: arriving straight on `/comptes` is
    // the ordinary case, and it is the one this test mounts.
    //
    // There is no `waitFor` on a total here, deliberately — that is the shape
    // the six tests above share, and it is why not one of them saw this.
    server.use(
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload())),
      // Never settles: the read is in flight for the whole of the test.
      http.get(ROUTES.positions, () => new Promise<never>(() => {})),
    )
    const { user } = renderApp({ url: '/comptes' })
    const panel = await openPanel(user, 'Alpha')

    // The panel is open and its other reads *have* landed — the curve is drawn
    // from `/api/accounts/alpha/history`, which answers. So what follows is an
    // absence under a rendered panel, not a panel that has not rendered yet.
    expect(
      await within(panel).findByRole('heading', { name: 'Valeur face à ce que vous avez versé' }),
    ).toBeInTheDocument()

    expect(within(panel).queryByRole('group', { name: 'Gain total' })).not.toBeInTheDocument()
    for (const term of [
      'Plus-value latente',
      'Plus-value réalisée',
      'Dividendes reçus',
      'Frais de versement',
    ]) {
      expect(within(panel).queryByRole('group', { name: term })).not.toBeInTheDocument()
    }
    // Nothing failed, so nothing is named either: the band belongs to the read
    // that answered a problem, and a request still in flight has said nothing.
    expect(within(panel).queryByRole('status')).not.toBeInTheDocument()
    // The link counts the same rows, so it waits at the same door.
    expect(within(panel).queryByRole('link', { name: /position/ })).not.toBeInTheDocument()
  })
})

describe('the fifth bubble', () => {
  it('states the scope of a figure the table states in a cell', async () => {
    const { user } = renderAccounts()
    const panel = await openPanel(user, 'Alpha')
    await waitFor(() => expect(panelHead(panel)).toHaveTextContent(/322,00/))

    // *One per figure and per surface*: the table's four are on its column
    // heads, read scrolled with this panel shut. This is the fifth.
    await user.click(within(panel).getByRole('button', { name: 'Ce que veut dire Gain total' }))
    const bubble = (await screen.findAllByRole('dialog')).find((node) =>
      /leur somme est le total/.test(node.textContent ?? ''),
    ) as HTMLElement
    expect(bubble).toBeDefined()
    expect(within(bubble).getByRole('link')).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#total-gain',
    )
  })
})

describe('what the panel no longer carries', () => {
  it('repeats none of the six figures already read one line higher', async () => {
    const { user } = renderAccounts()
    const panel = await openPanel(user, 'Alpha')
    await waitFor(() => expect(panelHead(panel)).toHaveTextContent(/322,00/))

    // A panel that repeats its own row is a second announcer of six figures at
    // once — and the row is still on screen behind it.
    for (const label of ['Valeur totale', 'Titres', 'Liquidités', 'Versé net', 'TRI', 'perf']) {
      expect(within(panel).queryByRole('group', { name: label })).not.toBeInTheDocument()
    }
    // `Valeur totale` and `Versé net` are the curve's two legends, which is a
    // different object: they name two lines, not two statistics.
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument()
  })

  it('replaces the positions table with a link to the shares page, reduced', async () => {
    const { user } = renderAccounts()
    const panel = await openPanel(user, 'Alpha')

    const link = await within(panel).findByRole('link', {
      name: 'Voir la position détenue sur ce compte',
    })
    expect(link).toHaveAttribute('href', '/titres?compte=alpha')
  })

  it('counts the symbols the page it leads to will show', async () => {
    const { user } = renderAccounts(defaultAccounts(), [
      ...defaultPositions(),
      { ...defaultPositions()[0], symbol: 'ZZX', name: 'Zeta Xi' },
    ])
    const panel = await openPanel(user, 'Alpha')

    // A row of that page is a **symbol**, whatever the number of accounts on
    // it, so the count has to be one of symbols too.
    expect(
      await within(panel).findByRole('link', { name: 'Voir les 2 positions détenues sur ce compte' }),
    ).toBeInTheDocument()
  })

  it('offers no link at all where there is nothing to lead to', async () => {
    // A reduction onto an empty page is a dead end with a count on it.
    const { user } = renderAccounts(defaultAccounts(), [defaultPositions()[0]])
    const panel = await openPanel(user, 'Gamma')
    await waitFor(() => expect(panelHead(panel)).toHaveTextContent(/0,00/))

    expect(within(panel).queryByRole('link', { name: /position/ })).not.toBeInTheDocument()
  })
})

describe('the curve that exists per account and nowhere else', () => {
  it('draws value against contributed, and names its two lines', async () => {
    const { user } = renderAccounts()
    const panel = await openPanel(user, 'Alpha')

    expect(
      await within(panel).findByRole('heading', { name: 'Valeur face à ce que vous avez versé' }),
    ).toBeInTheDocument()
    expect(within(panel).getByText('Valeur totale')).toBeInTheDocument()
    expect(within(panel).getByText('Versé net')).toBeInTheDocument()
  })

  it('is absent where the account has no value to draw', async () => {
    // A block with nothing in it does not exist: `gamma` has no cash event, so
    // no `total_value` on any day, and its row has already named that reason
    // one line higher.
    const { user } = renderAccounts()
    const panel = await openPanel(user, 'Gamma')
    await waitFor(() => expect(panelHead(panel)).toHaveTextContent(/0,00/))

    expect(
      within(panel).queryByRole('heading', { name: 'Valeur face à ce que vous avez versé' }),
    ).not.toBeInTheDocument()
  })
})
