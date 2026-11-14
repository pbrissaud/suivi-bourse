/**
 * The account panel (`AccountSheet-Refonte.dc.html`): four fields, a duplicate
 * identifiant said under its field, and a removal through the destructive
 * dialog.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Account } from '@/features/accounts/lib/api'
import { accountPath } from '@/features/accounts/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aTaxationCatalogue,
  aTaxationModel,
  anAccount,
  anAccountsPayload,
  defaultAccounts,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

function renderAccounts(accounts: Account[] = defaultAccounts(), url = '/accounts') {
  server.use(
    http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload(accounts))),
    http.get(ROUTES.taxationModels, () =>
      HttpResponse.json(
        aTaxationCatalogue({
          models: [
            aTaxationModel({ id: 'pea', name: 'Plan d’épargne en actions (PEA)' }),
            aTaxationModel({ id: 'cto', name: 'Compte-titres ordinaire (CTO)' }),
          ],
        }),
      ),
    ),
  )
  return renderApp({ url })
}

async function openCreation(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Ajouter un compte' }))
  return screen.findByRole('dialog', { name: 'Ajouter un compte' })
}

describe('adding an account', () => {
  it('asks for an identifiant, an optional libellé, an opening day and a model', async () => {
    const { user } = renderAccounts()
    const panel = await openCreation(user)

    expect(within(panel).getByLabelText('Identifiant')).toBeVisible()
    expect(within(panel).getByText('Libellé')).toBeVisible()
    expect(within(panel).getAllByText(/facultatif/)).toHaveLength(2)
    expect(within(panel).getByLabelText(/Ouvert le/)).toHaveAttribute('type', 'date')
    expect(
      within(panel)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Aucun modèle', 'Plan d’épargne en actions (PEA)', 'Compte-titres ordinaire (CTO)'])
    // The filled button is the sheet's only primary.
    expect(within(panel).getByRole('button', { name: 'Ajouter' })).toBeVisible()
    expect(within(panel).queryByRole('button', { name: /Supprimer/ })).not.toBeInTheDocument()
  })

  it('sends what was typed, the model and the day included', async () => {
    const { user } = renderAccounts()
    let sent: unknown = null
    server.use(
      http.post(ROUTES.accounts, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(anAccount({ id: 'pea2' }), { status: 201 })
      }),
    )
    const panel = await openCreation(user)

    await user.type(within(panel).getByLabelText('Identifiant'), 'pea2')
    await user.type(within(panel).getByLabelText(/Libellé/), 'PEA Bourse Direct')
    await user.type(within(panel).getByLabelText(/Ouvert le/), '2021-03-04')
    await user.selectOptions(
      within(panel).getByLabelText('Modèle d’imposition'),
      'Plan d’épargne en actions (PEA)',
    )
    await user.click(within(panel).getByRole('button', { name: 'Ajouter' }))

    await waitFor(() =>
      expect(sent).toEqual({
        id: 'pea2',
        label: 'PEA Bourse Direct',
        taxation_model_id: 'pea',
        opened_on: '2021-03-04',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('refuses an empty identifiant before asking the server', async () => {
    const { user } = renderAccounts()
    let posts = 0
    server.use(
      http.post(ROUTES.accounts, () => {
        posts += 1
        return HttpResponse.json(anAccount(), { status: 201 })
      }),
    )
    const panel = await openCreation(user)

    await user.click(within(panel).getByRole('button', { name: 'Ajouter' }))

    expect(await within(panel).findByText('Ce champ est obligatoire.')).toBeVisible()
    expect(posts).toBe(0)
  })

  it('says a duplicate identifiant under its field, on the server’s 409', async () => {
    const { user } = renderAccounts()
    server.use(
      http.post(ROUTES.accounts, () =>
        HttpResponse.json(
          {
            status: 409,
            type: PROBLEM_TYPES.conflict,
            title: 'Conflict',
            detail: "An account 'alpha' already exists",
          },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const panel = await openCreation(user)

    await user.type(within(panel).getByLabelText('Identifiant'), 'alpha')
    await user.click(within(panel).getByRole('button', { name: 'Ajouter' }))

    const field = within(panel).getByLabelText('Identifiant')
    const sentence = await within(panel).findByText(/déjà celui d’un autre compte/)
    expect(field.getAttribute('aria-describedby')).toContain(sentence.id)
    // The panel stays open, with what was typed.
    expect(field).toHaveValue('alpha')
  })
})

describe('editing an account', () => {
  async function openEdition(user: ReturnType<typeof renderApp>['user']) {
    await user.click(await screen.findByRole('button', { name: 'Modifier le compte' }))
    return screen.findByRole('dialog', { name: 'Modifier le compte' })
  }

  it('shows the identifiant as fixed, and what the account carries', async () => {
    const { user } = renderAccounts([anAccount({ opened_on: '2021-03-04' })])
    const panel = await openEdition(user)

    expect(within(panel).getByLabelText('Identifiant')).toHaveAttribute('readonly')
    expect(within(panel).getByLabelText(/Ouvert le/)).toHaveValue('2021-03-04')
    expect(await within(panel).findByText('Ce que porte ce compte')).toBeVisible()
    expect(within(panel).getByText('Événements')).toBeVisible()
    expect(within(panel).getByText('Titres')).toBeVisible()
    expect(within(panel).getByText('Valeur')).toBeVisible()
  })

  it('sends only what moved, and a null to detach the model', async () => {
    const { user } = renderAccounts([anAccount({ taxation_model_id: 'pea' })])
    const sent: unknown[] = []
    server.use(
      http.patch(ROUTES.account, async ({ request }) => {
        sent.push(await request.json())
        return HttpResponse.json(anAccount())
      }),
    )
    const panel = await openEdition(user)

    // Nothing moved: only the libellé, which the panel always sends.
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => expect(sent).toEqual([{ label: 'Alpha' }]))
  })

  it('detaches the model with a null', async () => {
    const { user } = renderAccounts([anAccount({ taxation_model_id: 'pea' })])
    const sent: unknown[] = []
    server.use(
      http.patch(ROUTES.account, async ({ request }) => {
        sent.push(await request.json())
        return HttpResponse.json(anAccount())
      }),
    )
    const panel = await openEdition(user)

    await user.selectOptions(within(panel).getByLabelText('Modèle d’imposition'), 'Aucun modèle')
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() => expect(sent).toEqual([{ label: 'Alpha', taxation_model_id: null }]))
  })

  it('removes an account nothing names, through the destructive dialog', async () => {
    const { user } = renderAccounts([anAccount(), anAccount({ id: 'extra', label: 'Extra' })])
    const removed: string[] = []
    server.use(
      http.delete(ROUTES.account, ({ params }) => {
        removed.push(String(params.id))
        return HttpResponse.json({ id: String(params.id), removed: true })
      }),
    )
    await user.click(await screen.findByRole('tab', { name: /Extra/ }))
    const panel = await openEdition(user)

    await user.click(await within(panel).findByRole('button', { name: 'Supprimer ce compte' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm).toHaveTextContent('Supprimer le compte Extra ?')
    expect(confirm).toHaveTextContent('Irréversible.')
    expect(removed).toEqual([])
    await user.click(within(confirm).getByRole('button', { name: 'Supprimer le compte' }))

    await waitFor(() => expect(removed).toEqual(['extra']))
    expect(accountPath('extra')).toContain('extra')
  })

  it('offers no removal on an account the ledger names, and says why', async () => {
    const { user } = renderAccounts()
    const panel = await openEdition(user)

    expect(await within(panel).findByText(/nomment? ce compte/)).toBeVisible()
    expect(
      within(panel).queryByRole('button', { name: 'Supprimer ce compte' }),
    ).not.toBeInTheDocument()
  })
})
