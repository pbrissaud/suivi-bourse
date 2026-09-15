/**
 * What an account would owe if it were emptied today (#919).
 *
 * At the seam every page test here uses: the whole app in jsdom, HTTP the only
 * faked edge, every assertion on the accessible rendering. The **figure** is the
 * server's and is never recomputed here — what this file is about is the five
 * readings the card exists to keep apart:
 *
 *  - **a declared exemption is not a measured zero.** A `none` model shows
 *    `0,00 €` and says what that model says; an account carrying no model at all
 *    shows no card, and the sentence that says why is raised once as an advisory;
 *  - **the card waits on the positions**, not on its own read, so a tax never
 *    appears beside a gain the panel is still refusing to state;
 *  - **the caveat is body text**, read without a click, because not clicking
 *    would cost the entire epistemic status of the figure;
 *  - **the footing names the rate that produced it**, levy folded in, and the
 *    day it changes where an age threshold is still ahead;
 *  - **a read that refused is not a read in flight.** Two different silences,
 *    two different renderings: the refusal is named in the card's own place,
 *    and the one figure resting on no read at all still stands.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES, type Account } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aLedgerPayload,
  anAccount,
  anAccountsPayload,
  anAdvisory,
  ledgerEvents,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

function renderAccounts(
  account: Partial<Account>,
  { positions = 'answers' }: { positions?: 'answers' | 'inFlight' | 'refused' } = {},
) {
  server.use(
    http.get(ROUTES.accounts, () =>
      HttpResponse.json(anAccountsPayload([anAccount({ id: 'alpha', label: 'Alpha', ...account })])),
    ),
    http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
  )
  if (positions === 'inFlight') {
    // A read that never answers: the panel's figures — and this card with them
    // — stay in flight for the whole test.
    server.use(http.get(ROUTES.positions, () => new Promise(() => {})))
  }
  if (positions === 'refused') {
    // A read that answered *no*. The shell cannot cover it — `/api/runtime`
    // opens no store (#668) — so the panel says it where the figures were.
    server.use(
      problemHandler(ROUTES.positions, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
  }
  return renderApp({ url: '/accounts?account=alpha' })
}

async function theCard() {
  return within(await screen.findByRole('region', { name: 'Alpha' })).findByRole('group', {
    name: 'Impôt projeté',
  })
}

describe('the card is present wherever a model is', () => {
  it('states what the server projected, and says it is not a tax return', async () => {
    renderAccounts({ taxation_kind: 'flat_realised', projected_tax: 96, projected_rates: [0.3] })

    const card = await theCard()

    expect(card).toHaveTextContent('96,00')
    // The caveat is read without a click. A bubble would put the entire
    // epistemic status of the figure behind a gesture nobody has to make.
    expect(
      await screen.findByText(/Rien n’a été cédé, et ceci n’est pas une déclaration/),
    ).toBeInTheDocument()
  })

  it('shows nothing at all for an account carrying no model', async () => {
    renderAccounts({ projected_tax: 96 })  // no `taxation_kind`: no model

    await screen.findByRole('region', { name: 'Alpha' })
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Impôt projeté' })).not.toBeInTheDocument(),
    )
  })

  it('shows a declared zero for an exempt model, in that model’s own words', async () => {
    // `0,00 €` here is **the model saying so**, not arithmetic — which is why
    // the server sends no figure for it and the card states one anyway.
    renderAccounts({ taxation_kind: 'none' })

    const card = await theCard()

    expect(card).toHaveTextContent('0,00')
    expect(await screen.findByText(/Rien n’est dû sur ce compte/)).toBeInTheDocument()
  })

  it('states no realised gain for a model that taxes something else', async () => {
    // **No figure element at all**, not an empty one: a `role="group"` named
    // `Impôt projeté` containing nothing is a region a screen reader announces
    // and then has nothing to read out. The card carries this model's own
    // sentence and no figure node.
    renderAccounts({ taxation_kind: 'withholding_income' })

    const detail = await screen.findByRole('region', { name: 'Alpha' })
    expect(await screen.findByText(/Prélevé sur ce que vous recevez/)).toBeInTheDocument()
    expect(
      within(detail).queryByRole('group', { name: 'Impôt projeté' }),
    ).not.toBeInTheDocument()
  })

  it('states a computed zero as a figure, never as the em dash of an unknown', async () => {
    // An account in aggregate loss owes nothing, and *nothing* is a figure the
    // app computed — not the absence it publishes when the assiette is unknown.
    // This is also the one test that would catch `buildAccountRows` regressing
    // the optional members to the `?? null` idiom its own comment warns against.
    renderAccounts({ taxation_kind: 'flat_realised', projected_tax: 0, projected_rates: [0.3] })

    const card = await theCard()

    expect(card).toHaveTextContent('0,00')
    expect(card).not.toHaveTextContent('—')
  })

  it('renders an em dash where the model projects but the assiette is unknown', async () => {
    // One unvalued line, and the server publishes no member. A zero here would
    // be a claim the app cannot make.
    renderAccounts({ taxation_kind: 'flat_realised', projected_rates: [0.3] })

    expect(await theCard()).toHaveTextContent('—')
  })
})

describe('the card waits on the positions, not on its own read', () => {
  it('states nothing while the read the figure is derived from is in flight', async () => {
    // `projected_tax` rides on the accounts payload and lands **first**. A tax
    // rendered beside a `Gain` the panel is still refusing to state would be a
    // figure derived from a gain it simultaneously declines to give.
    renderAccounts(
      { taxation_kind: 'flat_realised', projected_tax: 96, projected_rates: [0.3] },
      { positions: 'inFlight' },
    )

    await screen.findByRole('region', { name: 'Alpha' })
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Impôt projeté' })).not.toBeInTheDocument(),
    )
    // **The footing waits too.** A rate under a hairline with nothing above it
    // is an orphan rule, and naming the rate that produced a figure the card is
    // refusing to state contradicts the refusal in the same breath.
    expect(screen.queryByRole('group', { name: 'Taux appliqué' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Impôt projeté/)).not.toBeInTheDocument()
  })
})

describe('a read that refused is named, never summed over', () => {
  it('says why the figure is missing instead of stating one derived from nothing', async () => {
    // **In flight and refused are two different silences.** In flight the card
    // does not exist at all (#724); refused, it exists and names the read it
    // could not make — the same sentence the head above it carries, because the
    // tax is derived from the very terms the head is refusing to state.
    renderAccounts(
      { taxation_kind: 'flat_realised', projected_tax: 96, projected_rates: [0.3] },
      { positions: 'refused' },
    )

    // The card is here — its own title, which the in-flight case does not have.
    expect(await screen.findByText('Impôt projeté')).toBeInTheDocument()
    // Twice: once where the head's figures were, once inside this card.
    await waitFor(() => expect(screen.getAllByText('Lecture impossible')).toHaveLength(2))

    // **The footing waits with it.** *Taux appliqué 30 %* under a hairline with
    // nothing above it names the rate that produced a figure the card is
    // refusing to state in the same breath.
    expect(screen.queryByRole('group', { name: 'Taux appliqué' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Impôt projeté' })).not.toBeInTheDocument()
    expect(screen.queryByText(/96,00/)).not.toBeInTheDocument()
  })

  it('states a declared exemption anyway, that zero resting on no read at all', async () => {
    // `none` is the one kind whose figure is not derived from the positions:
    // the model *says* zero. Withholding it because an unrelated read refused
    // would make a declaration wait on evidence it never used.
    renderAccounts({ taxation_kind: 'none' }, { positions: 'refused' })

    expect(await theCard()).toHaveTextContent('0,00')
    expect(await screen.findByText(/Rien n’est dû sur ce compte/)).toBeInTheDocument()
  })
})

describe('the footing names the rate that produced the figure', () => {
  it('folds the levy in on a flat model', async () => {
    renderAccounts({ taxation_kind: 'flat_realised', projected_tax: 96, projected_rates: [0.3] })

    const footing = await screen.findByRole('group', { name: 'Taux appliqué' })

    expect(footing).toHaveTextContent('30')
  })

  it('names the levy alone on a mature wrapper, and no change to come', async () => {
    // The bug the whole feature is shaped around: a PEA past five years is
    // exempt of income tax and still owes 17,2 %. The server folds the levy in,
    // so what is under test here is that the card prints what it was handed —
    // `tests/test_taxation_projection.py` is what pins the arithmetic.
    renderAccounts({
      taxation_kind: 'aged_flat_realised',
      projected_tax: 55.38,
      projected_rates: [0.172],
    })

    const footing = await screen.findByRole('group', { name: 'Taux appliqué' })

    expect(footing).toHaveTextContent('17,2')
    expect(screen.queryByText(/Le taux change le/)).not.toBeInTheDocument()
  })

  it('names the day the rate changes while the threshold is still ahead', async () => {
    // The kink is the most interesting thing the arithmetic knows and is
    // otherwise invisible. The day is the server's — counted from the first
    // payment for a PEA, which is the reversal #919 owns — and the card renders
    // it in the reader's locale.
    renderAccounts({
      taxation_kind: 'aged_flat_realised',
      projected_tax: 96,
      projected_rates: [0.3],
      projected_rate_changes_on: '2104-03-01',
    })

    expect(await screen.findByRole('group', { name: 'Taux appliqué' })).toHaveTextContent('30')
    expect(await screen.findByText(/Le taux change le/)).toHaveTextContent('2104')
  })

  it('names every rung of a ladder, there being no single rate to name', async () => {
    renderAccounts({ taxation_kind: 'bracketed_realised', projected_tax: 400, projected_rates: [0.1, 0.3, 0.42] })

    const footing = await screen.findByRole('group', { name: 'Taux appliqués' })

    expect(footing).toHaveTextContent('10')
    expect(footing).toHaveTextContent('30')
    expect(footing).toHaveTextContent('42')
  })
})

describe('the sentence that says why a modelless account is silent', () => {
  const NO_MODEL = anAdvisory({
    key: 'no_taxation_model:alpha',
    kind: 'no_taxation_model',
    subject: 'accounts',
    message: 'Alpha carries no taxation model.',
    detail: { account: 'alpha', label: 'Alpha', total_value: 5766.22 },
  })

  async function openNotifications(language: readonly string[]) {
    server.use(http.get(ROUTES.advisories, () => HttpResponse.json([NO_MODEL])))
    const rendered = renderApp({ browserLanguages: language })
    await rendered.user.click(await screen.findByRole('button', { name: /^Notifications/ }))
    return screen.findByRole('dialog', { name: 'Notifications' })
  }

  it('names the account, says what is missing, and links back to it', async () => {
    // The card cannot explain its own absence — it would be an empty block on
    // every account for ever. The bell says it once, and the link is the repair
    // the advisory exists to offer: an unknown kind falls back to the server's
    // raw message with no link at all, which is the failure this pins.
    const panel = await openNotifications(['fr-FR'])

    expect(within(panel).getByText(/Alpha · aucun modèle d’imposition/)).toBeInTheDocument()
    expect(panel.textContent).toContain('ne peut donc pas dire ce que vous devriez dessus')
    expect(within(panel).getByRole('link', { name: 'Voir le compte' })).toHaveAttribute(
      'href',
      expect.stringContaining('account=alpha'),
    )
  })

  it('and in English', async () => {
    const panel = await openNotifications(['en-GB'])

    expect(within(panel).getByText(/Alpha · no taxation model/)).toBeInTheDocument()
    expect(panel.textContent).toContain('cannot say what you would owe on it')
  })
})
