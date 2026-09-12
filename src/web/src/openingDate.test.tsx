/**
 * The opening date an account declares (#918, ADR-0006, ADR-0044).
 *
 * At the one seam every page test here uses: the whole app in jsdom, HTTP the
 * only faked edge, and every assertion on the **accessible rendering** or on
 * the request that actually left.
 *
 * Four of the cases name a reading they prevent:
 *
 *  - **it is asked for only where it changes a figure**, so a reader whose
 *    regime has no age threshold is never asked for a date that moves nothing;
 *  - **the pre-fill is an offer of the interface**, and what is stored is what
 *    was submitted — an account edited again does not silently re-derive it;
 *  - **a date earlier than the first payment is normal**, because that is what
 *    a wrapper transferred from another broker looks like;
 *  - **the contradiction is stated, never arbitrated**: one of the two dates is
 *    wrong and the app cannot say which.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { accountPath, ROUTES, type Account } from '@/lib/api'
import {
  aLedgerPayload,
  anAccount,
  anAccountsPayload,
  anAdvisory,
  aTaxationCatalogue,
  aTaxationModel,
  ledgerEvents,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

/** A model whose threshold is counted **from the day the wrapper was opened**. */
const AGED = aTaxationModel({
  id: 'aged',
  name: 'Enveloppe à seuil',
  kind: 'aged_flat_realised',
  parameters: {
    rate_before: 0.3,
    rate_after: 0.172,
    threshold_years: 5,
    age_basis: 'opening',
  },
})

/**
 * The same shape, counted **from the first payment** — which is what the PEA
 * template ships, and what `taxation.py` warns is *not* the opening date.
 *
 * An age threshold and no use whatsoever for this date: the two are not the
 * same question, and a reader on this model must not be asked for a day that
 * moves no figure.
 */
const AGED_FROM_PAYMENT = aTaxationModel({
  id: 'aged-payment',
  name: 'Enveloppe à seuil depuis le versement',
  kind: 'aged_flat_realised',
  parameters: {
    rate_before: 0.3,
    rate_after: 0.172,
    threshold_years: 5,
    age_basis: 'first_payment',
  },
})

function renderAccounts(account: Partial<Account>) {
  server.use(
    http.get(ROUTES.accounts, () =>
      HttpResponse.json(anAccountsPayload([anAccount({ id: 'alpha', label: 'Alpha', ...account })])),
    ),
    http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
    http.get(ROUTES.taxationModels, () =>
      HttpResponse.json(
        aTaxationCatalogue({ models: [aTaxationModel(), AGED, AGED_FROM_PAYMENT] }),
      ),
    ),
  )
  return renderApp({ url: '/accounts' })
}

async function openPanel(user: ReturnType<typeof renderApp>['user']) {
  await user.click(
    within(await screen.findByRole('list', { name: 'Vos comptes' })).getByRole('link', {
      name: /Alpha/,
    }),
  )
  const detail = await screen.findByRole('region', { name: 'Alpha' })
  await user.click(within(detail).getByRole('button', { name: 'Modifier le compte' }))
  const panel = await screen.findByRole('dialog')
  // The catalogue decides whether the field is asked for at all, so nothing is
  // asserted about it before the read has landed (ADR-0026).
  await within(panel).findByLabelText(/Modèle d’imposition/)
  return panel
}

describe('the date is asked for only where it matters', () => {
  it('is absent on an account whose shape has no age-dependent parameter', async () => {
    // A flat rate on the gain has no threshold to count years to, so there is
    // no figure this date could change — and asking for it is asking the
    // reader to work for nothing.
    const { user } = renderAccounts({ taxation_model: 'model-one', first_payment: '2019-03-04' })
    const panel = await openPanel(user)

    expect(within(panel).queryByLabelText(/Ouvert le/)).not.toBeInTheDocument()
  })

  it('is absent on a shape whose age runs from the first payment', async () => {
    // The PEA's own shape. Its five years run from the first payment, so the
    // opening date changes no figure — and the hint under the field would be
    // telling this reader the opposite.
    const { user } = renderAccounts({
      taxation_model: 'aged-payment',
      first_payment: '2019-03-04',
    })
    const panel = await openPanel(user)

    expect(within(panel).queryByLabelText(/Ouvert le/)).not.toBeInTheDocument()
  })

  it('is absent on an account that carries no model at all', async () => {
    const { user } = renderAccounts({ first_payment: '2019-03-04' })
    const panel = await openPanel(user)

    expect(within(panel).queryByLabelText(/Ouvert le/)).not.toBeInTheDocument()
  })

  it('appears the moment an age-dependent shape is chosen', async () => {
    const { user } = renderAccounts({ first_payment: '2019-03-04' })
    const panel = await openPanel(user)

    await user.selectOptions(
      within(panel).getByLabelText(/Modèle d’imposition/),
      within(panel).getByRole('option', { name: 'Enveloppe à seuil' }),
    )

    expect(within(panel).getByLabelText(/Ouvert le/)).toBeInTheDocument()
  })
})

describe('the pre-fill is the interface’s offer', () => {
  it('offers the account’s earliest declared payment where it has declared none', async () => {
    const { user } = renderAccounts({ taxation_model: 'aged', first_payment: '2019-03-04' })
    const panel = await openPanel(user)

    expect(within(panel).getByLabelText(/Ouvert le/)).toHaveValue('2019-03-04')
  })

  it('shows the declared day rather than the offer, once there is one', async () => {
    // Accepted, the offer became a declaration and stopped moving: the stored
    // value is what the owner submitted, and nothing re-derives it.
    const { user } = renderAccounts({
      taxation_model: 'aged',
      opened_on: '2015-06-01',
      first_payment: '2019-03-04',
    })
    const panel = await openPanel(user)

    expect(within(panel).getByLabelText(/Ouvert le/)).toHaveValue('2015-06-01')
  })

  it('is empty where the account has no payment on record', async () => {
    const { user } = renderAccounts({ taxation_model: 'aged' })
    const panel = await openPanel(user)

    expect(within(panel).getByLabelText(/Ouvert le/)).toHaveValue('')
  })
})

describe('what the panel sends', () => {
  async function sentBy(account: Partial<Account>, act: (panel: HTMLElement) => Promise<void>) {
    const { user } = renderAccounts(account)
    const panel = await openPanel(user)
    let sent: unknown = null
    server.use(
      http.patch(accountPath('alpha'), async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(anAccount({ id: 'alpha', label: 'Alpha' }))
      }),
    )
    await act(panel)
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer ce compte' }))
    await waitFor(() => expect(sent).not.toBeNull())
    return sent
  }

  it('writes the offered day when the reader submits on it', async () => {
    // Submitting **is** accepting: the offer is what the owner will take nine
    // times out of ten, and it becomes their declaration the moment they do.
    const sent = await sentBy(
      { taxation_model: 'aged', first_payment: '2019-03-04' },
      async () => {},
    )

    expect(sent).toEqual({ label: 'Alpha', opened_on: '2019-03-04' })
  })

  it('says nothing about a declared day the reader did not touch', async () => {
    const sent = await sentBy(
      { taxation_model: 'aged', opened_on: '2015-06-01', first_payment: '2019-03-04' },
      async () => {},
    )

    expect(sent).toEqual({ label: 'Alpha' })
  })

  it('sends a null when the reader empties it, which takes the declaration away', async () => {
    const { user } = renderAccounts({
      taxation_model: 'aged',
      opened_on: '2015-06-01',
      first_payment: '2019-03-04',
    })
    const panel = await openPanel(user)

    let sent: unknown = null
    server.use(
      http.patch(accountPath('alpha'), async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(anAccount({ id: 'alpha', label: 'Alpha' }))
      }),
    )
    await user.clear(within(panel).getByLabelText(/Ouvert le/))
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer ce compte' }))

    await waitFor(() => expect(sent).toEqual({ label: 'Alpha', opened_on: null }))
  })

  it('says nothing about a date it never asked for', async () => {
    // The field is not shown on this shape, so the panel answers no question
    // about it — a payment date must not reach the store because a reader
    // renamed an account.
    const sent = await sentBy(
      { taxation_model: 'model-one', first_payment: '2019-03-04' },
      async (panel) => {
        await within(panel).findByLabelText('Nom')
      },
    )

    expect(sent).toEqual({ label: 'Alpha' })
  })
})

describe('the contradiction, said out loud', () => {
  const CONTRADICTED = anAdvisory({
    key: 'opened_after_first_payment:alpha',
    kind: 'opened_after_first_payment',
    message: 'Alpha is declared as opened on 2021-01-01, and it received a payment on 2019-03-04.',
    detail: {
      account: 'alpha',
      label: 'Alpha',
      opened_on: '2021-01-01',
      first_payment: '2019-03-04',
    },
  })

  async function openNotifications(language: readonly string[]) {
    server.use(http.get(ROUTES.advisories, () => HttpResponse.json([CONTRADICTED])))
    const rendered = renderApp({ browserLanguages: language })
    await rendered.user.click(await screen.findByRole('button', { name: /^Notifications/ }))
    return screen.findByRole('dialog', { name: 'Notifications' })
  }

  it('names the account, both dates, and where to go — in French', async () => {
    const panel = await openNotifications(['fr-FR'])

    expect(within(panel).getByText(/Alpha · ouvert après son premier versement/)).toBeInTheDocument()
    expect(panel.textContent).toContain('déclaré ce compte ouvert le 2021-01-01')
    expect(panel.textContent).toContain('versement le 2019-03-04')
    // It states the contradiction and does not decide which side is wrong.
    expect(panel.textContent).toContain('l’application ne peut pas dire laquelle')
    expect(within(panel).getByRole('link', { name: 'Voir le compte' })).toHaveAttribute(
      'href',
      expect.stringContaining('account=alpha'),
    )
  })

  it('and in English', async () => {
    const panel = await openNotifications(['en-GB'])

    expect(within(panel).getByText(/Alpha · opened after its first payment/)).toBeInTheDocument()
    expect(panel.textContent).toContain('opened on 2021-01-01')
    expect(panel.textContent).toContain('payment on 2019-03-04')
    expect(within(panel).getByRole('link', { name: 'See the account' })).toBeInTheDocument()
  })
})
