/**
 * The taxation model on the account's panel (#752, ADR-0042, ADR-0043).
 *
 * At the one seam, like every page test here: the whole app in jsdom, HTTP the
 * only faked edge, and every assertion on the **accessible rendering** or on the
 * request that actually left.
 *
 * Four of the cases below name a reading they prevent:
 *
 *  - **the shortcut is nested**, so a reader whose regime has no age threshold
 *    never meets the word *PEA* — which is the objection ADR-0043 was tested
 *    against, the shortcut being French and the product not;
 *  - **the abbreviation is expanded and the country is in the label**, because a
 *    bare sigle leans on knowledge a reader outside France does not have (WCAG
 *    3.1.4);
 *  - **no model is an ordinary answer** and nothing is fabricated to stand in
 *    for it;
 *  - **the refusal names the accounts**, because *it is in use* sends its reader
 *    through every panel they own.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { accountPath, ROUTES, taxationModelPath, type TaxationModelDraft } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aLedgerPayload,
  anAccount,
  anAccountsPayload,
  aTaxationCatalogue,
  aTaxationModel,
  ledgerEvents,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

function renderAccounts(accounts = anAccountsPayload([anAccount({ id: 'alpha', label: 'Alpha' })])) {
  server.use(
    http.get(ROUTES.accounts, () => HttpResponse.json(accounts)),
    http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
  )
  return renderApp({ url: '/accounts' })
}

async function openPanel(user: ReturnType<typeof renderApp>['user'], name = 'Alpha') {
  await user.click(
    within(await screen.findByRole('list', { name: 'Vos comptes' })).getByRole('link', {
      name: new RegExp(name),
    }),
  )
  const detail = await screen.findByRole('region', { name })
  await user.click(within(detail).getByRole('button', { name: 'Modifier le compte' }))
  return screen.findByRole('dialog')
}

/** The field's own `<select>`, once the catalogue has landed. */
async function modelField(panel: HTMLElement) {
  return within(panel).findByLabelText(/Modèle d’imposition/)
}

describe('the model an account carries', () => {
  it('opens on no model, which is an ordinary answer', async () => {
    // Nothing is fabricated for an account that carries none — no *not set*, no
    // model invented to fill the control. #919 publishes nothing for it either.
    const { user } = renderAccounts()
    const panel = await openPanel(user)

    expect(await modelField(panel)).toHaveValue('')
    expect(within(panel).getByRole('option', { name: 'Aucun modèle' })).toBeInTheDocument()
  })

  it('renders the model the account already carries', async () => {
    const { user } = renderAccounts(
      anAccountsPayload([anAccount({ id: 'alpha', label: 'Alpha', taxation_model: 'model-one' })]),
    )
    const panel = await openPanel(user)

    expect(await modelField(panel)).toHaveValue('model-one')
  })

  it('sends nothing about the model when the reader did not move it', async () => {
    // A rename is a rename: the member is absent, which the server reads as
    // *leave it alone*, and an account keeps what it carries.
    const { user } = renderAccounts(
      anAccountsPayload([anAccount({ id: 'alpha', label: 'Alpha', taxation_model: 'model-one' })]),
    )
    const panel = await openPanel(user)
    await modelField(panel)

    let sent: unknown = null
    server.use(
      http.patch(accountPath('alpha'), async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(anAccount({ id: 'alpha', label: 'Renamed' }))
      }),
    )

    await user.clear(within(panel).getByLabelText('Nom'))
    await user.type(within(panel).getByLabelText('Nom'), 'Renamed')
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer ce compte' }))

    await waitFor(() => expect(sent).toEqual({ label: 'Renamed' }))
  })

  it('detaches the model it carries, and says so with a null', async () => {
    const { user } = renderAccounts(
      anAccountsPayload([anAccount({ id: 'alpha', label: 'Alpha', taxation_model: 'model-one' })]),
    )
    const panel = await openPanel(user)

    let sent: unknown = null
    server.use(
      http.patch(accountPath('alpha'), async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(anAccount({ id: 'alpha', label: 'Alpha' }))
      }),
    )

    await user.selectOptions(await modelField(panel), '')
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer ce compte' }))

    await waitFor(() => expect(sent).toEqual({ label: 'Alpha', taxation_model: null }))
  })
})

describe('writing a model', () => {
  it('asks for the shape first, and the rate is typed as a percentage', async () => {
    // The app ships no rates (ADR-0042), so every one of them is typed — and it
    // is typed the way a tax schedule says it. `0.3` is what is stored.
    const { user } = renderAccounts()
    const panel = await openPanel(user)

    let sent: TaxationModelDraft | null = null
    server.use(
      http.post(ROUTES.taxationModels, async ({ request }) => {
        sent = (await request.json()) as TaxationModelDraft
        return HttpResponse.json(aTaxationModel({ id: 'written' }), { status: 201 })
      }),
    )

    await user.selectOptions(await modelField(panel), [
      within(panel).getByRole('option', { name: 'Écrire un modèle…' }),
    ])
    await user.type(within(panel).getByLabelText('Le nom de ce modèle'), 'Mon CTO')
    await user.selectOptions(
      within(panel).getByLabelText('Forme'),
      within(panel).getByRole('option', { name: 'Un taux unique sur la plus-value' }),
    )
    await user.type(within(panel).getByLabelText(/^Taux/), '30')
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer ce modèle' }))

    await waitFor(() =>
      expect(sent).toEqual({
        name: 'Mon CTO',
        kind: 'flat_realised',
        // **The optional one is absent, never zero** (#845): *no social charge*
        // is not *a social charge of nothing*.
        parameters: { rate: 0.3 },
      }),
    )
  })

  it('offers the known wrappers under the one shape that has any structure', async () => {
    // Nested, so a reader whose regime has no age threshold never meets it: no
    // Danish regime has one, and that owner crosses no screen saying *PEA*.
    const { user } = renderAccounts()
    const panel = await openPanel(user)

    await user.selectOptions(await modelField(panel), [
      within(panel).getByRole('option', { name: 'Écrire un modèle…' }),
    ])
    const shape = within(panel).getByLabelText('Forme')

    await user.selectOptions(
      shape,
      within(panel).getByRole('option', { name: 'Un taux unique sur la plus-value' }),
    )
    expect(within(panel).queryByLabelText('Une enveloppe connue')).not.toBeInTheDocument()
    expect(within(panel).queryByText(/PEA/)).not.toBeInTheDocument()

    await user.selectOptions(
      shape,
      within(panel).getByRole('option', {
        name: 'Un taux qui change avec l’âge de l’enveloppe',
      }),
    )
    expect(within(panel).getByLabelText('Une enveloppe connue')).toBeInTheDocument()
  })

  it('expands the abbreviation, names the country, and names the escape hatch', async () => {
    // WCAG 3.1.4 argues for expanding rather than for tagging, and GOV.UK's rule
    // for a closed list is that the way out is named rather than left empty.
    const { user } = renderAccounts()
    const panel = await openPanel(user)

    await user.selectOptions(await modelField(panel), [
      within(panel).getByRole('option', { name: 'Écrire un modèle…' }),
    ])
    await user.selectOptions(
      within(panel).getByLabelText('Forme'),
      within(panel).getByRole('option', {
        name: 'Un taux qui change avec l’âge de l’enveloppe',
      }),
    )

    const wrappers = within(panel).getByLabelText('Une enveloppe connue')
    expect(
      within(wrappers).getByRole('option', {
        name: 'Plan d’épargne en actions (PEA) — France · 5 ans depuis le premier versement',
      }),
    ).toBeInTheDocument()
    expect(
      within(wrappers).getByRole('option', { name: /Aucune de celles-ci/ }),
    ).toBeInTheDocument()
  })

  it('fills the two structural fields and carries no money with them', async () => {
    // A template is **not stored** and does not survive the submission: what is
    // written is the taxation model, and the two fields it filled are in it.
    const { user } = renderAccounts()
    const panel = await openPanel(user)

    let sent: TaxationModelDraft | null = null
    server.use(
      http.post(ROUTES.taxationModels, async ({ request }) => {
        sent = (await request.json()) as TaxationModelDraft
        return HttpResponse.json(aTaxationModel({ id: 'written' }), { status: 201 })
      }),
    )

    await user.selectOptions(await modelField(panel), [
      within(panel).getByRole('option', { name: 'Écrire un modèle…' }),
    ])
    await user.selectOptions(
      within(panel).getByLabelText('Forme'),
      within(panel).getByRole('option', {
        name: 'Un taux qui change avec l’âge de l’enveloppe',
      }),
    )
    await user.selectOptions(within(panel).getByLabelText('Une enveloppe connue'), 'fr_pea')

    // The structure arrived; the money is still empty, which is the whole point.
    expect(within(panel).getByLabelText(/^Seuil, en années/)).toHaveValue(5)
    expect(within(panel).getByLabelText('Compté depuis')).toHaveValue('first_payment')
    expect(within(panel).getByLabelText(/^Taux avant le seuil/)).toHaveValue(null)

    await user.type(within(panel).getByLabelText('Le nom de ce modèle'), 'Mon PEA')
    await user.type(within(panel).getByLabelText(/^Taux avant le seuil/), '12.8')
    await user.type(within(panel).getByLabelText(/^Taux après le seuil/), '0')
    await user.type(within(panel).getByLabelText(/^Prélèvements sociaux/), '18.6')
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer ce modèle' }))

    await waitFor(() =>
      expect(sent).toEqual({
        name: 'Mon PEA',
        kind: 'aged_flat_realised',
        parameters: {
          rate_before: 0.128,
          rate_after: 0,
          threshold_years: 5,
          age_basis: 'first_payment',
          social_rate: 0.186,
        },
      }),
    )
  })

  it('corrects a model it already holds, in the units it was typed in', async () => {
    // `0.3` came back as `30 %`, which is what was typed; a rate and a count of
    // years are both numbers, and only the kind says which one is a percentage.
    const { user } = renderAccounts()
    const panel = await openPanel(user)

    let sent: TaxationModelDraft | null = null
    server.use(
      http.patch(taxationModelPath('model-one'), async ({ request }) => {
        sent = (await request.json()) as TaxationModelDraft
        return HttpResponse.json(aTaxationModel({ id: 'model-one' }))
      }),
    )

    await user.selectOptions(await modelField(panel), 'model-one')
    await user.click(within(panel).getByRole('button', { name: 'Corriger ce modèle' }))

    expect(within(panel).getByLabelText(/^Taux/)).toHaveValue(30)

    await user.clear(within(panel).getByLabelText(/^Taux/))
    await user.type(within(panel).getByLabelText(/^Taux/), '28')
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer ce modèle' }))

    await waitFor(() =>
      expect(sent).toEqual({
        name: 'A flat model',
        kind: 'flat_realised',
        parameters: { rate: 0.28 },
      }),
    )
  })
})

describe('removing a model', () => {
  it('says which accounts carry it rather than that it is in use', async () => {
    const { user } = renderAccounts()
    const panel = await openPanel(user)

    server.use(
      http.delete(taxationModelPath('model-one'), () =>
        HttpResponse.json(
          {
            type: PROBLEM_TYPES.taxationModelInUse,
            title: 'Taxation model in use',
            status: 409,
            accounts: ['alpha', 'beta'],
          },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )

    await user.selectOptions(await modelField(panel), 'model-one')
    await user.click(within(panel).getByRole('button', { name: 'Supprimer ce modèle' }))

    expect(await within(panel).findByText(/les comptes alpha, beta portent encore/)).toBeInTheDocument()
  })

  it('removes one nothing carries, and the account stops pointing at it', async () => {
    const { user } = renderAccounts(
      anAccountsPayload([anAccount({ id: 'alpha', label: 'Alpha', taxation_model: 'model-one' })]),
    )
    const panel = await openPanel(user)

    server.use(
      http.get(ROUTES.taxationModels, () =>
        HttpResponse.json(aTaxationCatalogue({ models: [] })),
      ),
    )

    await user.click(within(panel).getByRole('button', { name: 'Supprimer ce modèle' }))

    await waitFor(async () => expect(await modelField(panel)).toHaveValue(''))
  })
})

describe('the two hazards of a form inside a form', () => {
  it('saves the model on Enter, and never the account', async () => {
    // The editor sits inside `AccountForm`'s own `<form>` — a nested one is not
    // HTML — so an unguarded Enter triggers that form's implicit submission: the
    // account is declared, the panel shuts, and the half-typed model is lost.
    const { user } = renderAccounts()
    const panel = await openPanel(user)

    let declared = false
    let written: TaxationModelDraft | null = null
    server.use(
      http.patch(accountPath('alpha'), () => {
        declared = true
        return HttpResponse.json(anAccount({ id: 'alpha', label: 'Alpha' }))
      }),
      http.post(ROUTES.taxationModels, async ({ request }) => {
        written = (await request.json()) as TaxationModelDraft
        return HttpResponse.json(aTaxationModel({ id: 'written' }), { status: 201 })
      }),
    )

    await user.selectOptions(await modelField(panel), [
      within(panel).getByRole('option', { name: 'Écrire un modèle…' }),
    ])
    await user.type(within(panel).getByLabelText('Le nom de ce modèle'), 'Mon CTO')
    await user.selectOptions(
      within(panel).getByLabelText('Forme'),
      within(panel).getByRole('option', { name: 'Un taux unique sur la plus-value' }),
    )
    await user.type(within(panel).getByLabelText(/^Taux/), '30{Enter}')

    await waitFor(() => expect(written).not.toBeNull())
    expect(declared).toBe(false)
  })

  it('leaves the buttons their own Enter, and Cancel writes nothing', async () => {
    // The guard above sits on the block, so it also catches an Enter that
    // bubbled from a button — and a button activates itself *on* that keydown.
    // Swallowed, the reader who pressed Enter on Cancel would have saved.
    const { user } = renderAccounts()
    const panel = await openPanel(user)

    let writes = 0
    server.use(
      http.post(ROUTES.taxationModels, () => {
        writes += 1
        return HttpResponse.json(aTaxationModel({ id: 'written' }), { status: 201 })
      }),
    )

    await user.selectOptions(await modelField(panel), [
      within(panel).getByRole('option', { name: 'Écrire un modèle…' }),
    ])
    await user.type(within(panel).getByLabelText('Le nom de ce modèle'), 'Mon CTO')

    // The account's own footer carries an *Annuler* too — this is the editor's.
    const buttons = within(panel).getByRole('button', { name: 'Enregistrer ce modèle' })
      .parentElement as HTMLElement
    within(buttons).getByRole('button', { name: 'Annuler' }).focus()
    await user.keyboard('{Enter}')

    await waitFor(() => expect(within(panel).queryByLabelText('Le nom de ce modèle')).toBeNull())
    expect(writes).toBe(0)
  })

  it('sends a blank bracket bound as nothing, never as a zero', async () => {
    // `Number('')` is `0`, and `0` is a perfectly valid bound — so a coerced
    // blank would be stored as *up to 0 €* and the server would take it. The
    // scalar fields are skipped when blank; a ladder has no skip.
    const { user } = renderAccounts()
    const panel = await openPanel(user)

    let written: TaxationModelDraft | null = null
    server.use(
      http.post(ROUTES.taxationModels, async ({ request }) => {
        written = (await request.json()) as TaxationModelDraft
        return HttpResponse.json(aTaxationModel({ id: 'written' }), { status: 201 })
      }),
    )

    await user.selectOptions(await modelField(panel), [
      within(panel).getByRole('option', { name: 'Écrire un modèle…' }),
    ])
    await user.selectOptions(
      within(panel).getByLabelText('Forme'),
      within(panel).getByRole('option', { name: 'Un barème sur la plus-value' }),
    )
    await user.type(within(panel).getByLabelText('Le nom de ce modèle'), 'Mon barème')
    await user.click(within(panel).getByRole('button', { name: 'Ajouter une tranche' }))

    // The bound of the lower rung is left blank; only its rate is typed.
    await user.type(within(panel).getAllByLabelText('Taux de cette tranche')[0], '20')
    await user.type(within(panel).getAllByLabelText('Taux de cette tranche')[1], '30')
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer ce modèle' }))

    await waitFor(() =>
      expect(written).toEqual({
        name: 'Mon barème',
        kind: 'bracketed_realised',
        parameters: {
          brackets: [
            { upper_bound: null, rate: 0.2 },
            { upper_bound: null, rate: 0.3 },
          ],
        },
      }),
    )
  })
})
