/**
 * The first run (« Relevé », `Bienvenue-Refonte.dc.html`), at the one seam: the
 * whole app in jsdom, HTTP the only faked edge.
 *
 * Four centred steps, served until a currency is stored: the currency, the tax
 * models of a country, the first account, then three doors. Every case names
 * what it prevents:
 *
 *  - **an app that can be used without a currency** — nothing is converted or
 *    computed without one, so the screen has no cross, no Escape and no click
 *    outside;
 *  - **a wall in front of a trial run** — only the first step is owed: a blank
 *    account writes nothing, no model ticked imports nothing, and the last
 *    step has a « Plus tard »;
 *  - **a half-written setup** — the models are imported all or nothing, and a
 *    refused account stays on its step with the refusal under its field.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ConfigResponse } from '@/features/settings/lib/api'
import { ROUTES } from '@/lib/api'
import { CURRENCIES } from '@/lib/currencies'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aConfig,
  aRegistryItem,
  aTaxationCatalogue,
  aTaxationModel,
  anAccount,
  noAccountsDeclared,
} from '@/test/factories'
import { renderApp, type RenderAppOptions } from '@/test/render'
import { server } from '@/test/server'

/** The one predicate: the reporting currency unanswered. */
function unanswered(): ConfigResponse {
  const config = aConfig()
  return {
    ...config,
    settings: config.settings.map((setting) =>
      setting.key === 'base_currency' ? { ...setting, value: null, stored: false } : setting,
    ),
  }
}

/**
 * The config route, **stateful**: answering the dial has to make the predicate
 * false, and a handler frozen on *unanswered* would re-arm the screen on the
 * refetch that follows the write.
 */
function withNoCurrency() {
  let current = unanswered()
  server.use(
    http.get(ROUTES.config, () => HttpResponse.json(current)),
    http.put(ROUTES.settings, async ({ request }) => {
      const values = (await request.json()) as Record<string, string>
      current = {
        ...current,
        settings: current.settings.map((setting) =>
          setting.key in values
            ? { ...setting, value: values[setting.key], stored: true }
            : setting,
        ),
      }
      return HttpResponse.json({
        settings: current.settings,
        changed: Object.keys(values),
        effect: {},
      })
    }),
  )
}

const PEA = aRegistryItem({
  id: 'fr/pea',
  name: 'Plan d’épargne en actions (PEA)',
  kind: 'aged_flat_realised',
  parameters: {
    rate_before: 0.128,
    rate_after: 0,
    threshold_years: 5,
    age_basis: 'first_payment',
    social_rate: 0.186,
  },
})
const CTO = aRegistryItem({
  id: 'fr/cto',
  name: 'Compte-titres ordinaire (CTO)',
  kind: 'flat_realised',
  parameters: { rate: 0.128, social_rate: 0.186 },
})
const DEPOT = aRegistryItem({ id: 'de/depot', country: 'DE', name: 'Wertpapierdepot' })

/** What the registry route has been asked to import, `null` while nothing was. */
function withRegistry(items = [PEA, CTO, DEPOT]) {
  const asked: { ids: string[] | null } = { ids: null }
  server.use(
    http.post(ROUTES.taxationRegistry, async ({ request }) => {
      const body = (await request.json()) as { ids?: string[] }
      if (body.ids === undefined) return HttpResponse.json({ items })
      asked.ids = body.ids
      return HttpResponse.json({ models: [], skipped: [] }, { status: 201 })
    }),
  )
  return asked
}

function screenOf() {
  return screen.getByRole('dialog')
}

async function firstRun(options: RenderAppOptions = {}) {
  withNoCurrency()
  const rendered = renderApp(options)
  await screen.findByRole('dialog')
  return rendered
}

type Reader = ReturnType<typeof renderApp>['user']

async function next(user: Reader) {
  await user.click(within(screenOf()).getByRole('button', { name: 'Continuer' }))
}

/** The way past the account step without declaring one. */
async function skip(user: Reader) {
  await user.click(within(screenOf()).getByRole('button', { name: 'Passer cette étape' }))
}

/** Walk past the currency, which is the one owed answer. */
async function pastTheCurrency(user: Reader) {
  await user.selectOptions(within(screenOf()).getByLabelText('Devise'), 'EUR')
  await next(user)
  await within(screenOf()).findByRole('heading', { name: /Comment vos gains sont-ils imposés/ })
}

/** Every request the app makes that is **not a read**, recorded off the wire. */
function writesMade(): string[] {
  const writes: string[] = []
  server.events.on('request:start', ({ request }) => {
    // The registry is read with a POST: it stores nothing unless it carries ids.
    if (request.method !== 'GET' && !request.url.endsWith(ROUTES.taxationRegistry))
      writes.push(`${request.method} ${new URL(request.url).pathname}`)
  })
  return writes
}

afterEach(() => server.events.removeAllListeners())

describe('it stands on a missing currency, wherever the reader landed', () => {
  it('serves the screen on any page, the page being behind it', async () => {
    await firstRun({ url: '/shares' })

    expect(
      within(screenOf()).getByRole('heading', {
        name: 'Dans quelle devise tenez-vous vos comptes ?',
      }),
    ).toBeInTheDocument()
    expect(within(screenOf()).getByText('1 sur 4')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Titres', level: 1, hidden: true }),
    ).toBeInTheDocument()
  })

  it('stays shut on an install that has answered', async () => {
    renderApp()

    await screen.findByRole('heading', { name: 'Tableau de bord', level: 1 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says nothing while the read that would arm it is in flight', async () => {
    server.use(http.get(ROUTES.config, () => new Promise(() => {})))
    renderApp()

    await screen.findByRole('heading', { name: 'Tableau de bord', level: 1 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('has no way out: no cross, no Escape, no click outside', async () => {
    const { user } = await firstRun()

    expect(within(screenOf()).queryByRole('button', { name: 'Fermer' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    if (overlay) await user.click(overlay)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('step 1 — the currency', () => {
  it('offers the closed list, says it is final, and holds « Continuer » until one is chosen', async () => {
    await firstRun({ browserLanguages: ['fr'] })

    const field = within(screenOf()).getByLabelText('Devise')
    expect(within(field).getAllByRole('option')).toHaveLength(CURRENCIES.length + 1)
    expect(within(screenOf()).getByText('Ne se change plus ensuite.')).toBeInTheDocument()
    expect(within(screenOf()).getByRole('button', { name: 'Continuer' })).toBeDisabled()
    expect(within(screenOf()).queryByRole('button', { name: /Retour/ })).toBeNull()
  })

  it('pre-fills the browser’s currency as a suggestion', async () => {
    await firstRun({ browserLanguages: ['fr-FR'] })

    expect(within(screenOf()).getByLabelText('Devise')).toHaveValue('EUR')
  })

  it('writes the dial, receipts it and walks on', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    withRegistry()
    const writes = writesMade()

    await next(user)

    expect(
      await within(screenOf()).findByRole('heading', {
        name: /Comment vos gains sont-ils imposés/,
      }),
    ).toBeInTheDocument()
    expect(within(screenOf()).getByText('2 sur 4')).toBeInTheDocument()
    expect(writes).toContain('PUT /api/settings')
  })

  it('says a refusal on the step and writes nothing more', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    server.use(
      http.put(ROUTES.settings, () =>
        HttpResponse.json(
          { status: 422, type: PROBLEM_TYPES.invalidSetting, title: 'Refused' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )

    await next(user)

    expect(await within(screenOf()).findByText(/a refusé cette valeur/)).toBeInTheDocument()
    expect(within(screenOf()).getByText('1 sur 4')).toBeInTheDocument()
  })
})

describe('step 2 — the tax models of a country', () => {
  it('lists the models of the first country with their rule, unticked', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    withRegistry()
    await next(user)

    const pea = await within(screenOf()).findByRole('checkbox', {
      name: /Plan d’épargne en actions \(PEA\)/,
    })
    expect(pea).not.toBeChecked()
    // The rule is built from the parameters, never typed in the front.
    expect(
      within(screenOf()).getByText(/12,8\s%\spuis 0,0\s%\saprès 5 ans · PS 18,6\s%/),
    ).toBeInTheDocument()
    expect(within(screenOf()).getByText(/Forfaitaire 12,8\s% · PS 18,6\s%/)).toBeInTheDocument()
    // Another country is a choice, and not on the list.
    expect(within(screenOf()).queryByText('Wertpapierdepot')).not.toBeInTheDocument()
    const country = within(screenOf()).getByLabelText('Pays')
    expect(within(country).getAllByRole('option')).toHaveLength(2)
  })

  it('imports the ticked models in one call, all of them or none', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    const asked = withRegistry()
    await next(user)

    await user.click(await within(screenOf()).findByRole('checkbox', { name: /PEA/ }))
    await user.click(within(screenOf()).getByRole('checkbox', { name: /CTO/ }))
    await next(user)

    await within(screenOf()).findByRole('heading', { name: 'Votre premier compte.' })
    expect(asked.ids).toEqual(['fr/pea', 'fr/cto'])
  })

  it('imports nothing when nothing is ticked, and walks on', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    const asked = withRegistry()
    await next(user)
    await within(screenOf()).findByRole('checkbox', { name: /PEA/ })

    await next(user)

    await within(screenOf()).findByRole('heading', { name: 'Votre premier compte.' })
    expect(asked.ids).toBeNull()
  })

  it('says when the catalogue cannot be read, and offers to try again', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    server.use(
      http.post(ROUTES.taxationRegistry, () =>
        HttpResponse.json(
          { status: 502, type: PROBLEM_TYPES.providerRefused, title: 'Refused' },
          { status: 502, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    await next(user)

    expect(await within(screenOf()).findByRole('alert')).toBeInTheDocument()
    expect(within(screenOf()).getByRole('button', { name: 'Réessayer' })).toBeVisible()
    // And the walk is not held: nothing is owed on this step.
    expect(within(screenOf()).getByRole('button', { name: 'Continuer' })).toBeEnabled()
  })

  it('says the docs publish no catalogue yet, without a retry that cannot help', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    server.use(
      http.post(ROUTES.taxationRegistry, () =>
        HttpResponse.json(
          {
            status: 502,
            type: PROBLEM_TYPES.providerRefused,
            title: 'Refused',
            reason: 'unpublished',
          },
          { status: 502, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    await next(user)

    expect(
      await within(screenOf()).findByText(/ne publie pas encore de catalogue fiscal/),
    ).toBeVisible()
    expect(within(screenOf()).queryByRole('button', { name: 'Réessayer' })).toBeNull()
    expect(within(screenOf()).getByRole('button', { name: 'Continuer' })).toBeEnabled()
  })

  it('leads to Réglages to write one’s own model, and leaves the walk', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    withRegistry()
    await next(user)

    await user.click(
      await within(screenOf()).findByRole('link', { name: 'Écrire mon propre modèle' }),
    )

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('step 3 — the first account', () => {
  async function toTheAccount(user: Reader) {
    withRegistry()
    server.use(
      http.get(ROUTES.taxationModels, () =>
        HttpResponse.json(
          aTaxationCatalogue({ models: [aTaxationModel({ id: 'pea', name: 'PEA maison' })] }),
        ),
      ),
    )
    await pastTheCurrency(user)
    await next(user)
    await within(screenOf()).findByRole('heading', { name: 'Votre premier compte.' })
  }

  it('declares the account with the model chosen', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    let sent: unknown = null
    server.use(
      http.post(ROUTES.accounts, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(anAccount({ id: 'pea' }), { status: 201 })
      }),
    )
    await toTheAccount(user)

    await user.type(within(screenOf()).getByLabelText('Identifiant'), 'pea')
    await user.type(within(screenOf()).getByLabelText(/Libellé/), 'PEA Bourse Direct')
    await user.selectOptions(
      await within(screenOf()).findByRole('combobox', { name: 'Modèle d’imposition' }),
      'PEA maison',
    )
    await next(user)

    await within(screenOf()).findByRole('heading', {
      name: /D’où viennent vos premiers événements/,
    })
    expect(sent).toEqual({ id: 'pea', label: 'PEA Bourse Direct', taxation_model_id: 'pea' })
  })

  it('requires the identifiant, as « Ajouter un compte » does, and says the charset inline', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    await toTheAccount(user)
    const writes = writesMade()

    expect(within(screenOf()).getByText(/Lettres, chiffres/)).toBeInTheDocument()
    await next(user)

    expect(await within(screenOf()).findByText('Ce champ est obligatoire.')).toBeInTheDocument()
    expect(within(screenOf()).getByText('3 sur 4')).toBeInTheDocument()
    expect(writes).toEqual([])
  })

  it('writes nothing when the step is skipped', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    await toTheAccount(user)
    const writes = writesMade()

    await skip(user)

    await within(screenOf()).findByRole('heading', {
      name: /D’où viennent vos premiers événements/,
    })
    expect(writes).toEqual([])
  })

  it('says a duplicate identifiant under its field and stays on the step', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    server.use(
      http.post(ROUTES.accounts, () =>
        HttpResponse.json(
          { status: 409, type: PROBLEM_TYPES.conflict, title: 'Conflict' },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    await toTheAccount(user)

    await user.type(within(screenOf()).getByLabelText('Identifiant'), 'pea')
    await next(user)

    expect(await within(screenOf()).findByText(/déjà celui d’un autre compte/)).toBeInTheDocument()
    expect(within(screenOf()).getByText('3 sur 4')).toBeInTheDocument()
  })

  it('refuses an identifiant the URLs cannot carry before asking the server', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    await toTheAccount(user)
    const writes = writesMade()

    await user.type(within(screenOf()).getByLabelText('Identifiant'), 'PEA Mehdi!!')
    await next(user)

    expect(
      await within(screenOf()).findByText(/ne contient que des lettres, des chiffres/),
    ).toBeInTheDocument()
    expect(writes).toEqual([])
  })
})

describe('step 4 — three doors', () => {
  async function toTheDoors(user: Reader) {
    withRegistry()
    await pastTheCurrency(user)
    await next(user)
    await within(screenOf()).findByRole('heading', { name: 'Votre premier compte.' })
    await skip(user)
    await within(screenOf()).findByRole('heading', {
      name: /D’où viennent vos premiers événements/,
    })
  }

  it('offers the import, the event sheet and « Plus tard », and no « Continuer »', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    await toTheDoors(user)

    const doors = within(screenOf()).getAllByRole('link')
    expect(doors.map((door) => door.textContent)).toEqual([
      'Importer un relevéFichier CSV ou Excel',
      'Saisir à la mainUn versement, un achat',
      'Plus tardDepuis le grand livre, quand vous voulez',
    ])
    expect(within(screenOf()).queryByRole('button', { name: 'Continuer' })).not.toBeInTheDocument()
  })

  it('« Saisir à la main » ends the walk where the event is typed', async () => {
    const { user, router } = await firstRun({ browserLanguages: ['fr-FR'] })
    await toTheDoors(user)

    await user.click(within(screenOf()).getByRole('link', { name: /Saisir à la main/ }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Dans quelle|Comment|premier/ })).toBeNull(),
    )
    expect(router.state.location.pathname).toBe('/ledger')
  })

  it('« Plus tard » ends the walk on the dashboard', async () => {
    const { user, router } = await firstRun({ url: '/shares', browserLanguages: ['fr-FR'] })
    await toTheDoors(user)

    await user.click(within(screenOf()).getByRole('link', { name: /Plus tard/ }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })
})

describe('walking back', () => {
  it('leads back to the step before, and is absent on the first', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    withRegistry()
    await pastTheCurrency(user)

    await user.click(within(screenOf()).getByRole('button', { name: /Retour/ }))

    expect(
      await within(screenOf()).findByRole('heading', { name: /Dans quelle devise/ }),
    ).toBeInTheDocument()
    // The currency is stored by now: shown fixed, and « Continuer » walks on.
    expect(within(screenOf()).getByText('EUR')).toBeInTheDocument()
  })
})

describe('the walk can be found again', () => {
  it('reopens past the currency from the palette’s gesture, and spends the address', async () => {
    withRegistry()
    const { router } = renderApp({ url: '/?open=first-run' })

    expect(
      await screen.findByRole('heading', { name: /Comment vos gains sont-ils imposés/ }),
    ).toBeInTheDocument()
    expect(router.state.location.search).toEqual({})
  })

  it('writes nothing to the server when reopened and walked through', async () => {
    withRegistry()
    const writes = writesMade()
    const { user } = renderApp({ url: '/?open=first-run' })
    await screen.findByRole('heading', { name: /Comment vos gains sont-ils imposés/ })

    await next(user)
    await within(screenOf()).findByRole('heading', { name: 'Votre premier compte.' })
    await skip(user)

    await within(screenOf()).findByRole('heading', {
      name: /D’où viennent vos premiers événements/,
    })
    expect(writes).toEqual([])
  })
})

describe('a reload resumes the walk (persona pass, bug 5)', () => {
  /** The install the first step left behind: a currency, and nothing else. */
  function afterTheCurrency(models: ReturnType<typeof aTaxationModel>[] = []) {
    withRegistry()
    server.use(
      http.get(ROUTES.accounts, () => HttpResponse.json(noAccountsDeclared())),
      http.get(ROUTES.events, () => HttpResponse.json([])),
      http.get(ROUTES.taxationModels, () => HttpResponse.json(aTaxationCatalogue({ models }))),
    )
  }

  beforeEach(() => window.localStorage.clear())

  it('resumes on the tax models while none is held', async () => {
    afterTheCurrency()
    renderApp()

    expect(
      await screen.findByRole('heading', { name: /Comment vos gains sont-ils imposés/ }),
    ).toBeInTheDocument()
    expect(
      await within(screenOf()).findByText('Plan d’épargne en actions (PEA)'),
    ).toBeInTheDocument()
  })

  it('resumes on the account once models are held', async () => {
    afterTheCurrency([aTaxationModel({ id: 'pea', name: 'PEA maison' })])
    renderApp()

    expect(
      await screen.findByRole('heading', { name: 'Votre premier compte.' }),
    ).toBeInTheDocument()
  })

  it('does not resume once « Plus tard » was chosen, and the empty ledger offers the way back', async () => {
    afterTheCurrency()
    const { user } = renderApp({ url: '/?open=first-run' })
    await screen.findByRole('heading', { name: /Comment vos gains sont-ils imposés/ })
    await next(user)
    await skip(user)
    await user.click(within(screenOf()).getByRole('link', { name: /Plus tard/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // A reload: the walk was left, so it stays left.
    cleanup()
    const again = renderApp({ url: '/ledger' })
    expect(
      await screen.findByRole('link', { name: 'Reprendre la mise en place' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await again.user.click(screen.getByRole('link', { name: 'Reprendre la mise en place' }))
    expect(
      await screen.findByRole('heading', { name: /Comment vos gains sont-ils imposés/ }),
    ).toBeInTheDocument()
  })

  it('says so when the registry lists nothing for the country', async () => {
    afterTheCurrency()
    server.use(http.post(ROUTES.taxationRegistry, () => HttpResponse.json({ items: [] })))
    renderApp()

    expect(await screen.findByText(/Aucun modèle n’est publié pour ce pays/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })
})
