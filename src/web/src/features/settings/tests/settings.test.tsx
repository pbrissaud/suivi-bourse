import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { taxationModelPath, type TaxationModelDraft } from '@/features/accounts/lib/api'
import type { StoreState } from '@/features/settings/lib/api'
import { type HealthState, type InstallationFact, ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aConfig,
  aRegistryItem,
  anAccount,
  anAccountsPayload,
  anEnvironmentFact,
  aRuntime,
  aTaxationCatalogue,
  aTaxationModel,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

const UNAVAILABLE = {
  status: 503,
  type: PROBLEM_TYPES.storageUnavailable,
  title: 'storage unavailable',
}

async function openSettings(
  facts?: InstallationFact[],
  store?: StoreState,
  health?: HealthState,
  url = '/settings',
) {
  if (facts) {
    server.use(http.get(ROUTES.installationFacts, () => HttpResponse.json(facts)))
  }
  if (store) {
    server.use(http.get(ROUTES.store, () => HttpResponse.json(store)))
  }
  if (health) {
    server.use(http.get(ROUTES.health, () => HttpResponse.json(health)))
  }
  return renderApp({ url })
}

function openSystem(store?: StoreState, health?: HealthState) {
  return openSettings(undefined, store, health, '/system')
}

function block(name: RegExp | string) {
  return screen.getByRole('region', { name })
}

describe('the page', () => {
  it('is one h1 and no tabs', async () => {
    await openSettings()

    expect(await screen.findByRole('heading', { level: 1, name: 'Réglages' })).toBeInTheDocument()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('holds what the owner sets, without the environment variables', async () => {
    await openSettings()

    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((one) => one.textContent)).toEqual([
        'Sur cet appareil',
        'Général',
        'L’agent',
        'Thème',
        'Accès',
        'Fiscalité',
      ]),
    )
    expect(screen.queryByText('SB_STORE_DIR')).not.toBeInTheDocument()
  })

  it('leaves the notices to the bell', async () => {
    await openSettings([anEnvironmentFact()])
    await screen.findByRole('heading', { name: 'Général' })

    expect(screen.queryByRole('button', { name: 'Acquitter' })).not.toBeInTheDocument()
  })
})

describe('the settings form', () => {
  it('is drawn from the registry, unknown dials included', async () => {
    server.use(
      http.get(ROUTES.config, () =>
        HttpResponse.json(
          aConfig({
            settings: [
              ...aConfig().settings,
              {
                key: 'a_dial_from_the_future',
                value: 7,
                default: 7,
                type: 'integer',
                minimum: 1,
                maximum: 9,
                effect: 'next_cycle',
                doc: 'Something a later version added.',
                required: false,
                stored: false,
              },
            ],
          }),
        ),
      ),
    )
    await openSettings()
    await screen.findByRole('heading', { name: 'Général' })

    const field = screen.getByLabelText('a_dial_from_the_future')
    expect(field).toHaveAttribute('min', '1')
    expect(field).toHaveAttribute('max', '9')
    expect(screen.getByText('Something a later version added.')).toBeInTheDocument()
  })

  it('carries the five dials and the currency, not the benchmark', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Général' })

    const settings = block('Général')
    for (const dial of [
      'Cadence de relevé',
      'Cadence de reconstruction',
      'Délai entre deux requêtes',
      'Historique par requête',
      'Horizon de cours figé',
      'Devise de base',
    ]) {
      expect(within(settings).getByText(dial)).toBeInTheDocument()
    }
    expect(within(settings).queryByText('Référence de comparaison')).not.toBeInTheDocument()
  })

  it('accepts 0 on the stale-price horizon', async () => {
    const { user } = await openSettings()
    await screen.findByRole('heading', { name: 'Général' })
    expect(screen.getByText(/0 pour ne jamais signaler/)).toBeInTheDocument()

    let sent: Record<string, string> | null = null
    server.use(
      http.put(ROUTES.settings, async ({ request }) => {
        sent = (await request.json()) as Record<string, string>
        return HttpResponse.json({ settings: aConfig().settings, changed: Object.keys(sent) })
      }),
    )

    const field = screen.getByLabelText('Horizon de cours figé')
    expect(field).toHaveAttribute('min', '0')
    await user.clear(field)
    await user.type(field, '0')
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() => expect(sent).toEqual({ staleness_horizon: '0' }))
  })

  it('says what a cadence change reaches, and that it is retroactive', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Général' })

    expect(
      screen.getByText(
        /S’applique maintenant à 2 titres, et à 1 autre à l’ouverture de son marché/,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/y compris ceux déjà en échec/)).toBeInTheDocument()
  })

  it('writes only what moved', async () => {
    const { user } = await openSettings()
    await screen.findByRole('heading', { name: 'Général' })

    let sent: Record<string, string> | null = null
    server.use(
      http.put(ROUTES.settings, async ({ request }) => {
        sent = (await request.json()) as Record<string, string>
        return HttpResponse.json({ settings: aConfig().settings, changed: Object.keys(sent) })
      }),
    )

    await user.clear(screen.getByLabelText('Cadence de relevé'))
    await user.type(screen.getByLabelText('Cadence de relevé'), '300')
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() => expect(sent).toEqual({ regular_interval: '300' }))
    expect(await within(block('Général')).findByRole('status')).toHaveTextContent(
      '1 réglage enregistré.',
    )
  })
})

describe('the build', () => {
  const footer = () => screen.findByTitle(/·|Version|commit|Dépôt|Inconnue/)

  it('names the release at the foot of the navigation', async () => {
    await openSystem()

    const line = await footer()
    expect(line).toHaveTextContent('Version : 5.0.0')
    expect(line).toHaveAttribute('title', expect.stringContaining('8f0a02e1c0ff'))
  })

  it('falls back to the short revision on a build from a commit', async () => {
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(
          aRuntime({ build: { version: null, revision: '8f0a02e1c0ffee00', source: 'commit' } }),
        ),
      ),
    )
    await openSystem()

    const line = await footer()
    expect(line).toHaveTextContent('8f0a02e')
    expect(line).toHaveAttribute(
      'title',
      expect.stringContaining('Image construite depuis un commit'),
    )
  })

  it('says nothing when nothing stamped the build', async () => {
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(
          aRuntime({ build: { version: null, revision: null, source: 'unknown' } }),
        ),
      ),
    )
    await openSystem()
    await screen.findByRole('heading', { name: 'Tâches' })

    expect(screen.queryByText(/^Version :/)).not.toBeInTheDocument()
  })
})

describe('a newer release (#1237)', () => {
  const NOTES = 'https://github.com/pbrissaud/suivi-bourse/releases/tag/v5.1.0'
  const notes = (version: string) => ({ name: `Notes de la version ${version} (nouvel onglet)` })

  function answering(response: () => Response) {
    const asked = { count: 0 }
    server.use(
      http.get(ROUTES.release, () => {
        asked.count += 1
        return response()
      }),
    )
    return asked
  }

  it('links a newer release to its notes, in a new tab', async () => {
    answering(() => HttpResponse.json({ latest: { version: '5.1.0', url: NOTES } }))
    await openSystem()

    const link = await screen.findByRole('link', notes('5.1.0'))
    expect(link).toHaveTextContent('Version 5.1.0 disponible')
    expect(link).toHaveAttribute('href', NOTES)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  it.each([
    ['is up to date', () => HttpResponse.json({ latest: null })],
    ['could not be checked', () => new HttpResponse(null, { status: 500 })],
  ])('says nothing when the install %s', async (_, response) => {
    const asked = answering(response)
    await openSystem()

    await waitFor(() => expect(asked.count).toBe(1))
    await screen.findByText(/^Version :/)
    expect(screen.queryByText(/disponible/)).not.toBeInTheDocument()
  })

  it('never asks on a build with no version to compare', async () => {
    const asked = answering(() => HttpResponse.json({ latest: { version: '5.1.0', url: NOTES } }))
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(
          aRuntime({ build: { version: null, revision: '8f0a02e1c0ffee00', source: 'commit' } }),
        ),
      ),
    )
    await openSystem()

    await screen.findByText(/^Version :/)
    expect(asked.count).toBe(0)
    expect(screen.queryByRole('link', notes('5.1.0'))).not.toBeInTheDocument()
  })

  it('asks again once the container is upgraded', async () => {
    answering(() => HttpResponse.json({ latest: { version: '5.1.0', url: NOTES } }))
    const { queryClient } = await openSystem()
    await screen.findByRole('link', notes('5.1.0'))

    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(
          aRuntime({
            build: { version: '5.1.0', revision: '8f0a02e1c0ffee00', source: 'release' },
          }),
        ),
      ),
    )
    answering(() => HttpResponse.json({ latest: null }))
    await queryClient.invalidateQueries({ queryKey: ['runtime'] })

    await screen.findByText('5.1.0')
    await waitFor(() => expect(screen.queryByRole('link', notes('5.1.0'))).not.toBeInTheDocument())
  })
})

describe('the release switch (#1237)', () => {
  const toggle = () => screen.findByRole('switch', { name: 'Signaler les nouvelles versions' })

  it('saves at once, and holds still while it does', async () => {
    let sent: unknown = null
    let release: () => void = () => {}
    server.use(
      http.put(ROUTES.settings, async ({ request }) => {
        sent = await request.json()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return HttpResponse.json({ settings: aConfig().settings, changed: ['update_check'] })
      }),
    )
    const { user } = await openSettings()

    const control = await toggle()
    expect(control).toBeChecked()
    await user.click(control)

    await waitFor(() => expect(sent).toEqual({ update_check: false }))
    expect(control).toBeDisabled()
    release()
    await waitFor(() => expect(control).toBeEnabled())
  })

  it('says so when the write is refused', async () => {
    server.use(
      http.put(ROUTES.settings, () =>
        HttpResponse.json(
          { status: 422, title: 'refused' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = await openSettings()

    await user.click(await toggle())

    expect(await screen.findByRole('alert')).toHaveTextContent('rien n’a été enregistré')
  })

  it('keeps an unsaved dial when it is toggled', async () => {
    let off = false
    server.use(
      http.get(ROUTES.config, () => {
        const config = aConfig()
        return HttpResponse.json({
          ...config,
          settings: config.settings.map((setting) =>
            setting.key === 'update_check' ? { ...setting, value: !off } : setting,
          ),
        })
      }),
      http.put(ROUTES.settings, () => {
        off = true
        return HttpResponse.json({ settings: aConfig().settings, changed: ['update_check'] })
      }),
    )
    const { user } = await openSettings()

    const field = await screen.findByLabelText('Cadence de relevé')
    await user.clear(field)
    await user.type(field, '300')
    await user.click(await toggle())

    await waitFor(async () => expect(await toggle()).not.toBeChecked())
    expect(screen.getByLabelText('Cadence de relevé')).toHaveValue(300)
  })
})

describe('an unreadable store', () => {
  it('is said in place of the dials', async () => {
    server.use(problemHandler(ROUTES.config, UNAVAILABLE))
    renderApp({ url: '/settings' })

    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Général' })).not.toBeInTheDocument()
  })
})

describe('in English', () => {
  it('renders every section', async () => {
    const { unmount } = renderApp({ url: '/settings', browserLanguages: ['en-GB'] })
    expect(await screen.findByRole('heading', { name: 'General' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Taxation' })).toBeInTheDocument()
    unmount()
  })
})

describe('taxation', () => {
  it('lists each model with its rates and the accounts that carry it', async () => {
    server.use(
      http.get(ROUTES.taxationModels, () =>
        HttpResponse.json(
          aTaxationCatalogue({
            models: [
              aTaxationModel({
                id: 'pea',
                name: 'PEA',
                kind: 'aged_flat_realised',
                parameters: {
                  rate_before: 0.128,
                  rate_after: 0,
                  threshold_years: 5,
                  age_basis: 'first_payment',
                  social_rate: 0.172,
                },
              }),
            ],
          }),
        ),
      ),
    )
    await openSettings()
    const taxation = await screen.findByRole('region', { name: 'Fiscalité' })

    expect(taxation).toHaveTextContent('PEA')
    expect(taxation).toHaveTextContent(/12,8\s%, puis 0\s% après 5 ans/)
    expect(taxation).toHaveTextContent(/prélèvements sociaux 17,2\s%/)
  })

  it('writes a new model from the settings page', async () => {
    let sent: unknown = null
    server.use(
      http.post(ROUTES.taxationModels, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(aTaxationModel({ id: 'written' }), { status: 201 })
      }),
    )
    const { user } = await openSettings()
    const taxation = await screen.findByRole('region', { name: 'Fiscalité' })

    await user.click(within(taxation).getByRole('button', { name: 'Nouveau modèle' }))
    const sheet = await screen.findByRole('dialog', { name: 'Nouveau modèle' })
    await user.type(within(sheet).getByLabelText('Le nom de ce modèle'), 'CTO')
    await user.selectOptions(within(sheet).getByLabelText('Forme'), 'flat_realised')
    await user.type(within(sheet).getByLabelText('Taux'), '30')
    await user.click(within(sheet).getByRole('button', { name: 'Enregistrer ce modèle' }))

    await waitFor(() =>
      expect(sent).toEqual({ name: 'CTO', kind: 'flat_realised', parameters: { rate: 0.3 } }),
    )
  })

  it('names the accounts that block a removal', async () => {
    server.use(
      http.delete(taxationModelPath('model-one'), () =>
        HttpResponse.json(
          {
            type: PROBLEM_TYPES.taxationModelInUse,
            title: 'Taxation model in use',
            status: 409,
            accounts: ['alpha'],
          },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = await openSettings()
    const taxation = await screen.findByRole('region', { name: 'Fiscalité' })

    await user.click(within(taxation).getByRole('button', { name: 'Supprimer A flat model' }))
    const confirm = await screen.findByRole('dialog', { name: 'Supprimer « A flat model » ?' })
    await user.click(within(confirm).getByRole('button', { name: 'Supprimer' }))

    expect(await within(confirm).findByText(/alpha/)).toBeInTheDocument()
  })

  it('does not offer to remove a model an account carries', async () => {
    server.use(
      http.get(ROUTES.accounts, () =>
        HttpResponse.json(
          anAccountsPayload([
            anAccount({ id: 'alpha', label: 'Alpha', taxation_model: 'model-one' }),
          ]),
        ),
      ),
    )
    await openSettings()
    const taxation = await screen.findByRole('region', { name: 'Fiscalité' })

    await waitFor(() => expect(taxation).toHaveTextContent('Utilisé par 1 compte'))
    expect(within(taxation).getByRole('button', { name: 'Supprimer A flat model' })).toBeDisabled()
  })
})

describe('importing a taxation model', () => {
  async function openImport() {
    const view = await openSettings()
    const taxation = await screen.findByRole('region', { name: 'Fiscalité' })
    await view.user.click(within(taxation).getByLabelText('Importer pour mon pays'))
    return { ...view, taxation }
  }

  it('reads nothing until the owner reaches for the control', async () => {
    let reads = 0
    server.use(
      http.post(ROUTES.taxationRegistry, () => {
        reads += 1
        return HttpResponse.json({ items: [] })
      }),
    )
    const { user } = await openSettings()
    const taxation = await screen.findByRole('region', { name: 'Fiscalité' })
    expect(reads).toBe(0)

    await user.click(within(taxation).getByLabelText('Importer pour mon pays'))
    await waitFor(() => expect(reads).toBe(1))
  })

  it('lists the wrappers grouped by country, searchable', async () => {
    const { user, taxation } = await openImport()
    await user.keyboard('pea')

    const list = await screen.findByRole('listbox', { name: 'Enveloppes de la documentation' })
    expect(
      within(list)
        .getAllByRole('group')
        .map((group) => group.textContent),
    ).toEqual([expect.stringContaining('France')])
    expect(within(list).getByRole('option', { name: /PEA/ })).toBeInTheDocument()
    expect(within(list).queryByRole('option', { name: /Wertpapierdepot/ })).toBeNull()
    expect(taxation).toHaveTextContent('Les enveloppes gardent leur nom d’origine.')
  })

  it('stores a wrapper no model carries the name of, then opens it with its source', async () => {
    let sent: TaxationModelDraft | null = null
    server.use(
      http.post(ROUTES.taxationModels, async ({ request }) => {
        sent = (await request.json()) as TaxationModelDraft
        return HttpResponse.json(aTaxationModel({ ...sent, id: 'written' }), { status: 201 })
      }),
    )
    const { user } = await openImport()
    await user.keyboard('cto')
    await user.click(await screen.findByRole('option', { name: /CTO/ }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(sent).toEqual({
      name: 'Compte-titres ordinaire (CTO)',
      kind: 'flat_realised',
      parameters: { rate: 0.3 },
    })
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByLabelText('Le nom de ce modèle')).toHaveFocus()
    expect(
      within(sheet).getByRole('link', { name: /Vérifiez les taux à la source/ }),
    ).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/taxation-models-in-europe#fr-cto',
    )
    // The sheet's own close button, and the editor's, which says Fermer until a field moves.
    expect(within(sheet).getAllByRole('button', { name: 'Fermer' })).toHaveLength(2)
  })

  it('asks before replacing the rates of a name already stored, and names the carriers', async () => {
    server.use(
      http.get(ROUTES.taxationModels, () =>
        HttpResponse.json(
          aTaxationCatalogue({
            models: [
              aTaxationModel({
                id: 'mine',
                name: 'Compte-titres ordinaire (CTO)',
                parameters: { rate: 0.25 },
              }),
            ],
          }),
        ),
      ),
      http.get(ROUTES.accounts, () =>
        HttpResponse.json(
          anAccountsPayload([anAccount({ id: 'alpha', label: 'Alpha', taxation_model: 'mine' })]),
        ),
      ),
    )
    let created = 0
    const patched: unknown[] = []
    server.use(
      http.post(ROUTES.taxationModels, () => {
        created += 1
        return HttpResponse.json(aTaxationModel(), { status: 201 })
      }),
      http.patch(taxationModelPath('mine'), async ({ request }) => {
        patched.push(await request.json())
        return HttpResponse.json(aTaxationModel({ id: 'mine' }))
      }),
    )
    const { user, taxation } = await openImport()
    await user.keyboard('cto')
    await user.click(await screen.findByRole('option', { name: /CTO/ }))

    const card = await within(taxation).findByRole('region', {
      name: /Remplacer les taux de « Compte-titres ordinaire \(CTO\) »/,
    })
    expect(card).toHaveTextContent('Porté par Alpha.')
    expect(within(card).getByRole('button', { name: 'Annuler' })).toHaveFocus()
    expect(patched).toEqual([])

    await user.keyboard('{Escape}')
    expect(within(taxation).queryByRole('region', { name: /Remplacer/ })).toBeNull()

    await user.keyboard('cto')
    await user.click(await screen.findByRole('option', { name: /CTO/ }))
    await user.click(await within(taxation).findByRole('button', { name: 'Remplacer' }))

    await waitFor(() =>
      expect(patched).toEqual([
        { name: 'Compte-titres ordinaire (CTO)', kind: 'flat_realised', parameters: { rate: 0.3 } },
      ]),
    )
    expect(created).toBe(0)
  })

  it('says why the registry could not be read, and reads it again on request', async () => {
    let answer = 0
    server.use(
      http.post(ROUTES.taxationRegistry, () => {
        answer += 1
        return answer === 1
          ? HttpResponse.json(
              {
                type: PROBLEM_TYPES.providerRefused,
                title: 'Provider refused',
                status: 502,
                detail: 'taxation-registry: OSError: HTTP 503',
                provider: 'taxation-registry',
                reason: 'unreachable',
              },
              { status: 502, headers: { 'Content-Type': 'application/problem+json' } },
            )
          : HttpResponse.json({ items: [aRegistryItem()] })
      }),
    )
    const { user, taxation } = await openImport()

    expect(await within(taxation).findByRole('alert')).toHaveTextContent(
      'Registre injoignable : OSError: HTTP 503.',
    )
    expect(taxation).toHaveTextContent('Vous pouvez aussi écrire un modèle.')
    expect(within(taxation).getByRole('button', { name: 'Nouveau modèle' })).toBeEnabled()

    await user.click(within(taxation).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(within(taxation).queryByRole('alert')).toBeNull())
    expect(answer).toBe(2)
  })

  it('shows a wrapper this app refuses, disabled, with its reason', async () => {
    server.use(
      http.post(ROUTES.taxationRegistry, () =>
        HttpResponse.json({
          items: [
            aRegistryItem({
              id: 'xx/new',
              country: 'FR',
              name: 'Enveloppe future',
              kind: 'a_kind_from_later',
              refused: "'a_kind_from_later' is not a taxation model kind",
            }),
          ],
        }),
      ),
    )
    const { user } = await openImport()
    await user.keyboard('future')

    const line = await screen.findByRole('option', { name: /Enveloppe future/ })
    expect(line).toHaveAttribute('aria-disabled', 'true')
    expect(line).toHaveTextContent('nécessite une version plus récente de l’app')
    await user.click(line)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the registry for the page: a second opening reads nothing', async () => {
    let reads = 0
    server.use(
      http.post(ROUTES.taxationRegistry, () => {
        reads += 1
        return HttpResponse.json({ items: [aRegistryItem()] })
      }),
    )
    const { user, taxation } = await openImport()
    await waitFor(() => expect(reads).toBe(1))
    await user.click(within(taxation).getByRole('button', { name: 'Nouveau modèle' }))
    await user.keyboard('{Escape}')
    await user.click(within(taxation).getByLabelText('Importer pour mon pays'))
    expect(reads).toBe(1)
  })
})
