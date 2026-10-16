import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import { taxationModelPath } from '@/features/accounts/lib/api'
import type { StoreState } from '@/features/settings/lib/api'
import { type HealthState, type InstallationFact, ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aConfig,
  anAccount,
  anAccountsPayload,
  anEnvironmentFact,
  aFrozenScrape,
  aHealth,
  aHealthJobs,
  aRuntime,
  aStore,
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

async function followTheBell() {
  const { user } = renderApp({ url: '/' })
  await user.click(await screen.findByRole('button', { name: /^Notifications/ }))
  const panel = await screen.findByRole('dialog', { name: 'Notifications' })
  await user.click(within(panel).getByRole('link', { name: 'Voir dans Système' }))
  await screen.findByRole('heading', { level: 1, name: 'Système' })
  return screen.findByRole('region', { name: 'Tâches' })
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
        'Général',
        'L’agent',
        'Accès',
        'Fiscalité',
      ]),
    )
    expect(screen.queryByText('SB_STORE_DIR')).not.toBeInTheDocument()
  })

  it('leaves what the installation reports to the status page', async () => {
    await openSystem(aStore({ orphans: [{ symbol: 'ZZX', points: 1204 }] }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Système' })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((one) => one.textContent)).toEqual([
        'Tâches',
        'Titres orphelins',
      ]),
    )
  })

  it('names the rebuild section', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    await openSystem()

    expect(
      await screen.findByRole('region', { name: 'Reconstruction en cours' }),
    ).toBeInTheDocument()
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
    expect(await screen.findByRole('status')).toHaveTextContent('1 réglage enregistré.')
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

describe('the orphaned securities', () => {
  it('do not exist at zero', async () => {
    await openSystem()
    await screen.findByRole('heading', { name: 'Tâches' })

    expect(screen.queryByRole('heading', { name: 'Titres orphelins' })).not.toBeInTheDocument()
  })

  it('are counted, named, and purged at once', async () => {
    const { user } = await openSystem(aStore({ orphans: [{ symbol: 'ZZX', points: 1204 }] }))
    const orphans = await screen.findByRole('region', { name: 'Titres orphelins' })

    expect(orphans).toHaveTextContent('1 titre')
    expect(orphans).toHaveTextContent('ZZX')
    expect(orphans).toHaveTextContent('1 204 cours')

    server.use(http.get(ROUTES.store, () => HttpResponse.json(aStore())))
    await user.click(within(orphans).getByRole('button', { name: 'Purger' }))

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Titres orphelins' })).not.toBeInTheDocument(),
    )
  })
})

describe('the jobs', () => {
  it('are where the bell’s health card lands', async () => {
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))

    expect(await followTheBell()).toHaveTextContent(/Cours figés/)
  })

  it('are the three the health payload carries', async () => {
    await openSystem()
    const jobs = await screen.findByRole('region', { name: 'Tâches' })

    expect(within(jobs).getByText('Relevé des cours')).toBeInTheDocument()
    expect(within(jobs).getByText('Reconstruction de l’historique')).toBeInTheDocument()
    expect(within(jobs).getByText('Calcul de la performance')).toBeInTheDocument()
    expect(jobs).toHaveTextContent('Tout fonctionne.')
  })

  it('render a verdict as a sentence, never the raw word', async () => {
    await openSystem(undefined, aFrozenScrape())
    const jobs = await screen.findByRole('region', { name: 'Tâches' })

    expect(jobs).toHaveTextContent('À vérifier.')
    expect(jobs).toHaveTextContent(/Cours figés/)
    expect(jobs).not.toHaveTextContent('frozen')
  })

  it('say a stopped scheduler', async () => {
    await openSystem(undefined, aHealth({ status: 'attention', scheduler_running: false }))
    const jobs = await screen.findByRole('region', { name: 'Tâches' })

    expect(jobs).toHaveTextContent(/Le planificateur est arrêté/)
  })

  it('name a job that never ran', async () => {
    await openSystem(
      undefined,
      aHealth({
        status: 'unknown',
        jobs: aHealthJobs({
          performance: { status: 'unknown', at: null, verdict: 'unknown', error: null },
        }),
      }),
    )
    const jobs = await screen.findByRole('region', { name: 'Tâches' })

    expect(jobs).toHaveTextContent('Jamais')
  })

  it('do not exist while the health read is in flight', async () => {
    server.use(http.get(ROUTES.health, () => new Promise<never>(() => {})))
    await openSystem()
    await screen.findByRole('heading', { level: 1, name: 'Système' })

    expect(screen.queryByRole('heading', { name: 'Tâches' })).not.toBeInTheDocument()
  })

  it('say why they could not be read when /health refuses', async () => {
    server.use(problemHandler(ROUTES.health, UNAVAILABLE))

    const jobs = await followTheBell()
    expect(within(jobs).getByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says it too when a poll fails over a table it already drew (#1180)', async () => {
    // Everywhere else a refetch that failed keeps the figures. Not here: this
    // block is the bell's state in prose, and a red bell must not link to a
    // green table from the last answer.
    const { queryClient } = renderApp({ url: '/system', fakeTimers: true })
    const jobs = await screen.findByRole('region', { name: 'Tâches' })
    expect(within(jobs).queryByText('Lecture impossible')).not.toBeInTheDocument()

    server.use(http.get(ROUTES.health, () => HttpResponse.error()))
    await vi.advanceTimersByTimeAsync(60_000)
    await waitFor(() => expect(queryClient.getQueryState(['health'])?.error).toBeTruthy())
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Tâches' })).getByText('Lecture impossible'),
      ).toBeInTheDocument(),
    )
  })

  it('say the same on a 200 that is not a health payload', async () => {
    server.use(http.get(ROUTES.health, () => HttpResponse.json({ status: 'ok' })))

    const jobs = await followTheBell()
    expect(within(jobs).getByText('Lecture impossible')).toBeInTheDocument()
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

    renderApp({ url: '/system', browserLanguages: ['en-GB'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeInTheDocument()
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
