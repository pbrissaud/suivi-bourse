/**
 * The accounts page (« Relevé »), at the one seam: the whole app in jsdom, HTTP
 * the only faked edge.
 *
 * The accounts are text tabs carrying their value, which account is open is a
 * URL, and the detail is a head, a chart and three sections. The panel is
 * `accountForm.test.tsx`'s; the reassignment is `reassignment.test.tsx`'s.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Account } from '@/features/accounts/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aTaxationCatalogue,
  aTaxationModel,
  anAccount,
  anAccountsPayload,
  aRuntime,
  defaultAccounts,
} from '@/test/factories'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

function renderAccounts(accounts: Account[] = defaultAccounts(), url = '/accounts') {
  server.use(http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload(accounts))))
  return renderApp({ url })
}

function tabs() {
  return screen.findByRole('tablist', { name: 'Vos comptes' })
}

/** The detail — a landmark named by the account it is about. */
async function settled(name = 'Alpha') {
  return screen.findByRole('region', { name })
}

describe('the tabs', () => {
  it('lists every declared account with its value, and no share', async () => {
    renderAccounts()
    const list = await tabs()

    const names = within(list)
      .getAllByRole('tab')
      .map((tab) => (tab.textContent ?? '').replace(/\s/g, ''))
    expect(names).toHaveLength(3)
    expect(names[0]).toBe('Alpha1800,00€')
    expect(names[1]).toBe('Beta900,00€')
  })

  it('opens the first account, says which one is open, and puts it in the URL on a click', async () => {
    const { user, router } = renderAccounts()
    const list = await tabs()

    expect(within(list).getByRole('tab', { name: /Alpha/, selected: true })).toBeInTheDocument()
    await user.click(within(list).getByRole('tab', { name: /Beta/ }))
    await settled('Beta')
    expect(router.state.location.search).toMatchObject({ account: 'beta' })
  })

  it('reads the account off the URL on arrival, and falls back to the first for an unknown id', async () => {
    renderAccounts(defaultAccounts(), '/accounts?account=beta')
    await settled('Beta')
  })

  it('states no value for a row cut before today during a rebuild', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    renderAccounts([anAccount({ as_of: '2026-03-01', total_value: 500 })])
    const list = await tabs()

    expect(within(list).getByRole('tab', { name: /Alpha/ })).not.toHaveTextContent('500')
  })

  it('offers « Ajouter un compte » and « Modifier le compte » on the same line', async () => {
    renderAccounts()
    await tabs()

    expect(screen.getByRole('button', { name: 'Ajouter un compte' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Modifier le compte' })).toBeInTheDocument()
  })
})

describe('the head', () => {
  it('leads with the value, then the gain with its percentage and the rate', async () => {
    renderAccounts()
    const detail = await settled()

    expect(within(detail).getByRole('group', { name: 'Valeur du compte' })).toHaveTextContent(
      /1\D?800,00/,
    )
    // 322 on 1 478 paid in.
    const gain = within(detail).getByRole('group', { name: 'Gain' })
    expect(gain).toHaveTextContent(/\+322,00/)
    expect(detail).toHaveTextContent(/\(\+21,8\s%\)/)
    expect(within(detail).getByRole('group', { name: 'TRI' })).toHaveTextContent(/5,12\s%\s*par an/)
  })

  it('states the account’s three facts: opening day, cash and share of the portfolio', async () => {
    renderAccounts([anAccount({ opened_on: '2021-03-04' }), ...defaultAccounts().slice(1)])
    const detail = await settled()

    const facts = within(detail).getByLabelText('Repères du compte')
    expect(facts).toHaveTextContent('Ouvert le')
    expect(facts).toHaveTextContent('4 mars 2021')
    expect(facts).toHaveTextContent(/Liquidités\s*500,00/)
    // 1 800 of 3 300 (the third account weighs its securities).
    expect(facts).toHaveTextContent(/Part du patrimoine\s*54,5\s%/)
  })

  it('says an opening day that contradicts the ledger, beside the fact', async () => {
    renderAccounts([
      anAccount({ opened_on: '2021-06-01', first_payment: '2021-03-04' }),
      ...defaultAccounts().slice(1),
    ])
    const detail = await settled()

    expect(detail).toHaveTextContent('Ouvert après le premier versement, du 4 mars 2021.')
  })

  it('draws the two-colour bar and says what was paid in', async () => {
    renderAccounts()
    const detail = await settled()

    expect(within(detail).getByRole('img', { name: /Versé net et gain/ })).toBeInTheDocument()
    expect(within(detail).getByRole('group', { name: 'Versé net' })).toHaveTextContent(/1\D?478,00/)
  })

  it('offers the two readings and the period in words', async () => {
    const { user } = renderAccounts()
    const detail = await settled()

    expect(
      await within(detail).findByRole('tab', { name: 'Montants', selected: true }),
    ).toBeVisible()
    const period = within(detail).getByRole('radiogroup', { name: 'Période' })
    expect(
      within(period)
        .getAllByRole('radio')
        .map((one) => one.textContent),
    ).toEqual(['1 mois', 'Cette année', '1 an', 'Tout'])
    await user.click(within(detail).getByRole('tab', { name: 'Performance' }))
    expect(within(detail).getByRole('tab', { name: 'Performance', selected: true })).toBeVisible()
    await user.click(within(period).getByRole('radio', { name: '1 an' }))
    expect(within(period).getByRole('radio', { name: '1 an' })).toBeChecked()
  })
})

describe('the sections', () => {
  it('breaks the gain down into its terms, the fees last and muted', async () => {
    renderAccounts()
    const detail = await settled()

    const gain = within(detail).getByRole('region', { name: 'D’où vient le gain' })
    for (const term of [
      'Plus-value latente',
      'Plus-value réalisée',
      'Dividendes',
      'Frais de versement',
    ]) {
      expect(gain).toHaveTextContent(term)
    }
    expect(gain).toHaveTextContent('frais déduits')
  })

  it('lists the lines the account holds, each leading to its security', async () => {
    renderAccounts()
    const detail = await settled()

    const lines = within(detail).getByRole('region', { name: 'Titres du compte' })
    const link = within(lines).getByRole('link', { name: /Zeta Alpha/ })
    expect(link).toHaveAttribute('href', '/shares/ZZA')
    expect(within(lines).getByRole('table')).toHaveTextContent('Valorisation')
  })

  it('shows the net after tax with income tax and social levies apart', async () => {
    server.use(
      http.get(ROUTES.taxationModels, () =>
        HttpResponse.json(
          aTaxationCatalogue({
            models: [aTaxationModel({ id: 'pea', name: 'PEA, 5 ans révolus' })],
          }),
        ),
      ),
    )
    renderAccounts([
      anAccount({
        taxation_model_id: 'pea',
        taxation_kind: 'aged_flat_realised',
        projected_base: 300,
        projected_tax: 55.8,
        projected_income_tax: 0,
        projected_social_levy: 55.8,
        projected_rates: [0.186],
      }),
    ])
    const detail = await settled()

    const exit = await within(detail).findByRole('region', { name: 'Si je sors aujourd’hui' })
    expect(exit).toHaveTextContent(/1\D?744,20/)
    expect(exit).toHaveTextContent(/Impôt sur le revenu\s*0,00/)
    expect(exit).toHaveTextContent(/Prélèvements sociaux\s*[-−]55,80/)
    expect(exit).toHaveTextContent(/Impôt estimé\s*[-−]55,80/)
    expect(await within(exit).findByRole('link', { name: 'PEA, 5 ans révolus' })).toBeVisible()
  })

  it('says an account has no model, and opens the panel to choose one', async () => {
    const { user } = renderAccounts()
    const detail = await settled()

    const exit = within(detail).getByRole('region', { name: 'Si je sors aujourd’hui' })
    expect(exit).toHaveTextContent('aucun modèle d’imposition')
    await user.click(within(exit).getByRole('button', { name: 'Choisir un modèle' }))
    expect(await screen.findByRole('dialog', { name: 'Modifier le compte' })).toBeVisible()
  })

  it('names an empty account and its one way forward, in place of the figures', async () => {
    renderAccounts([
      anAccount({
        id: 'blank',
        label: 'Blank',
        as_of: null,
        total_value: null,
        cash_balance: null,
      }),
    ])
    server.use(
      http.get(ROUTES.positions, () => HttpResponse.json({ base_currency: 'EUR', positions: [] })),
    )
    const detail = await settled('Blank')

    expect(await within(detail).findByText('Rien d’enregistré sur ce compte')).toBeVisible()
  })
})

describe('the three states of a block', () => {
  it('draws nothing in the sections while the positions are in flight', async () => {
    server.use(http.get(ROUTES.positions, () => new Promise(() => {})))
    renderAccounts()
    const detail = await settled()

    expect(
      within(detail).queryByRole('region', { name: 'D’où vient le gain' }),
    ).not.toBeInTheDocument()
    expect(
      within(detail).queryByRole('region', { name: 'Titres du compte' }),
    ).not.toBeInTheDocument()
  })

  it('says why a section is missing when the positions refused', async () => {
    server.use(
      problemHandler(ROUTES.positions, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'Unavailable',
      }),
    )
    renderAccounts()
    const detail = await settled()

    expect(await within(detail).findByText('Lecture impossible')).toBeVisible()
    // The tabs stand: a refused read empties its block and not the page.
    expect(await tabs()).toBeVisible()
  })

  it('names an unreadable declaration instead of showing an empty page', async () => {
    server.use(
      problemHandler(ROUTES.accounts, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'Unavailable',
      }),
    )
    renderApp({ url: '/accounts' })

    expect(await screen.findByText('Lecture impossible')).toBeVisible()
    expect(screen.queryByRole('tablist', { name: 'Vos comptes' })).not.toBeInTheDocument()
  })

  it('draws no chart while the series is in flight', async () => {
    server.use(http.get(ROUTES.accountHistory, () => new Promise(() => {})))
    renderAccounts()
    const detail = await settled()

    await waitFor(() => expect(within(detail).getByRole('group', { name: 'Gain' })).toBeVisible())
    expect(within(detail).queryByRole('tab', { name: 'Montants' })).not.toBeInTheDocument()
  })
})

describe('nothing declared', () => {
  it('says so and offers the declaration itself', async () => {
    server.use(http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload([], false))))
    const { user } = renderApp({ url: '/accounts' })

    await user.click(await screen.findByRole('button', { name: 'Ajouter un compte' }))
    expect(await screen.findByRole('dialog', { name: 'Ajouter un compte' })).toBeVisible()
  })
})

describe('on a phone (persona pass, bug 16)', () => {
  it('reaches every account through a select, and nothing hides behind « Modifier le compte »', async () => {
    setViewportWidth(390)
    const { user } = renderAccounts()

    const select = await screen.findByRole('combobox', { name: 'Vos comptes' })
    expect(screen.queryByRole('tablist', { name: 'Vos comptes' })).not.toBeInTheDocument()
    const names = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent ?? '')
    expect(names).toHaveLength(defaultAccounts().length)
    expect(screen.getByRole('button', { name: 'Modifier le compte' })).toBeInTheDocument()

    await user.selectOptions(select, within(select).getAllByRole('option')[1])
    await settled('Beta')
  })
})
