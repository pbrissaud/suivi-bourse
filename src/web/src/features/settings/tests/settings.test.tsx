import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { StoreState } from '@/features/settings/lib/api'
import { type HealthState, type InstallationFact, ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aConfig,
  aRegistryItem,
  aRuntime,
  aSetting,
  anAccount,
  anAccountsPayload,
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

  it('is six titled planes, the expert dials last', async () => {
    await openSettings()

    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((one) => one.textContent)).toEqual([
        'Sécurité',
        'Portefeuille',
        'Agent',
        'Notifications',
        'Affichage',
        'Avancé',
      ]),
    )
    expect(screen.queryByText('SB_STORE_DIR')).not.toBeInTheDocument()
  })

  it('keeps every control out of a section’s gutter, and has no Save button', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Avancé' })

    for (const name of ['Sécurité', 'Portefeuille', 'Agent', 'Affichage', 'Avancé']) {
      const gutter = block(name).querySelector('header')
      expect(gutter, name).not.toBeNull()
      expect(within(gutter as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
      expect(within(gutter as HTMLElement).queryByRole('switch')).not.toBeInTheDocument()
      expect(within(block(name)).queryByRole('button', { name: 'Enregistrer' })).toBeNull()
    }
  })

  it('says no sentence under a section’s title', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Avancé' })

    for (const name of ['Sécurité', 'Portefeuille', 'Agent', 'Notifications', 'Affichage']) {
      expect(block(name).querySelector('header p'), name).toBeNull()
    }
  })

  it('lands on the section its address names, with focus', async () => {
    await openSettings(undefined, undefined, undefined, '/settings#advanced')

    await waitFor(() => expect(block('Avancé')).toHaveFocus())
  })
})

describe('the display section', () => {
  it('sets the language from its values', async () => {
    const { user } = await openSettings()

    const group = await screen.findByRole('radiogroup', { name: 'Langue' })
    await user.click(within(group).getByRole('radio', { name: 'English' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
  })

  it('names the appearance, and offers automatic, light and dark', async () => {
    await openSettings()

    const group = await screen.findByRole('radiogroup', { name: 'Apparence' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((one) => one.textContent),
    ).toEqual(['Automatique', 'Clair', 'Sombre'])
  })

  it('names the theme and leads to its page', async () => {
    await openSettings()

    const section = await screen.findByRole('region', { name: 'Affichage' })
    expect(await within(section).findByText('Atelier')).toBeInTheDocument()
    expect(within(section).getByRole('link', { name: 'Personnaliser' })).toHaveAttribute(
      'href',
      '/settings/theme',
    )
  })
})

describe('the portfolio section', () => {
  it('states the currency once it is fixed, and offers no field', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Portefeuille' })

    const section = block('Portefeuille')
    expect(await within(section).findByText(/fixée au premier lancement/)).toBeInTheDocument()
    expect(within(section).queryByRole('combobox')).not.toBeInTheDocument()
  })
})

describe('the advanced section', () => {
  it('draws the five dials, a clause and its default under each, and no release switch', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Avancé' })

    const advanced = block('Avancé')
    await within(advanced).findByText('Fréquence des cours')
    for (const dial of [
      'Fréquence des cours',
      'Fréquence de recalcul',
      'Pause entre deux requêtes',
      'Profondeur d’historique',
      'Seuil de cours figé',
    ]) {
      expect(within(advanced).getByText(dial)).toBeInTheDocument()
    }
    // The cadences are stored in seconds and read in minutes.
    expect(screen.getByLabelText('Fréquence des cours')).toHaveValue(2)
    expect(screen.getByLabelText('Seuil de cours figé')).toHaveValue(15)
    expect(screen.getByLabelText('Pause entre deux requêtes')).toHaveValue(10)
    expect(
      within(advanced).getByText('Rafraîchissement des cours, marchés ouverts.', { exact: false }),
    ).toHaveTextContent('Par défaut 2 min')
    expect(within(advanced).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(advanced).queryByText('Devise de référence')).not.toBeInTheDocument()
    expect(within(advanced).queryByText('Fonds de comparaison')).not.toBeInTheDocument()
  })

  it('draws a dial from the registry that the page does not know by name', async () => {
    server.use(
      http.get(ROUTES.config, () =>
        HttpResponse.json(
          aConfig({
            settings: [
              ...aConfig().settings,
              aSetting({
                key: 'a_dial_from_the_future',
                value: 7,
                default: 7,
                minimum: 1,
                maximum: 9,
                effect: 'next_cycle',
                doc: 'Something a later version added.',
              }),
            ],
          }),
        ),
      ),
    )
    await openSettings()
    await screen.findByRole('heading', { name: 'Avancé' })

    const field = await screen.findByLabelText('a_dial_from_the_future')
    expect(field).toHaveAttribute('min', '1')
    expect(field).toHaveAttribute('max', '9')
    expect(screen.getByText(/Something a later version added\./)).toBeInTheDocument()
  })

  it('puts a modified dial back to its default', async () => {
    const writes: unknown[] = []
    server.use(
      http.get(ROUTES.config, () =>
        HttpResponse.json(
          aConfig({
            settings: aConfig().settings.map((setting) =>
              setting.key === 'staleness_horizon' ? { ...setting, value: 1800 } : setting,
            ),
          }),
        ),
      ),
      http.put(ROUTES.settings, async ({ request }) => {
        writes.push(await request.json())
        return HttpResponse.json({ settings: aConfig().settings, changed: ['staleness_horizon'] })
      }),
    )
    const { user } = await openSettings()
    expect(await screen.findByLabelText('Seuil de cours figé')).toHaveValue(30)

    await user.click(await within(block('Avancé')).findByRole('button', { name: 'Rétablir' }))

    await waitFor(() => expect(writes).toEqual([{ staleness_horizon: '900' }]))
  })
})

describe('a number saves itself', () => {
  /** The `PUT`s the page sent, in order, answering with `answer` once released. */
  function recordWrites(answer: () => Response = () => HttpResponse.json(okAnswer(['x']))) {
    const writes: Record<string, unknown>[] = []
    server.use(
      http.put(ROUTES.settings, async ({ request }) => {
        writes.push((await request.json()) as Record<string, unknown>)
        return answer()
      }),
    )
    return writes
  }
  const okAnswer = (changed: string[]) => ({ settings: aConfig().settings, changed })

  /** A promise made before the request, so opening it can never come too early. */
  function gate() {
    let open: () => void = () => {}
    const opened = new Promise<void>((resolve) => {
      open = resolve
    })
    return { opened, open }
  }

  it('on Enter, in the registry’s unit, only what moved, and says so on its own row', async () => {
    const writes = recordWrites()
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Fréquence des cours')

    await user.clear(field)
    await user.type(field, '5{Enter}')

    // Five minutes are 300 seconds on the wire.
    await waitFor(() => expect(writes).toEqual([{ regular_interval: '300' }]))
    expect(await within(block('Avancé')).findByRole('status')).toHaveTextContent('✓ Enregistré')

    // Leaving the field moves nothing, and the receipt stays.
    await user.tab()
    expect(within(block('Avancé')).getByRole('status')).toHaveTextContent('✓ Enregistré')
  })

  it('on blur, and a blur right after Enter sends nothing more', async () => {
    const writes = recordWrites()
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Seuil de cours figé')
    expect(field).toHaveAttribute('min', '0')

    await user.clear(field)
    await user.type(field, '0{Enter}')
    await user.tab()

    await waitFor(() => expect(writes).toEqual([{ staleness_horizon: '0' }]))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(writes).toHaveLength(1)
  })

  it('sends nothing when the value did not move', async () => {
    const writes = recordWrites()
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Fréquence des cours')

    await user.click(field)
    await user.tab()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(writes).toEqual([])
  })

  it('says « Enregistrement… » while it saves', async () => {
    const held = gate()
    server.use(
      http.put(ROUTES.settings, async () => {
        await held.opened
        return HttpResponse.json(okAnswer(['regular_interval']))
      }),
    )
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Fréquence des cours')

    await user.clear(field)
    await user.type(field, '5{Enter}')

    expect(await within(block('Avancé')).findByRole('status')).toHaveTextContent('Enregistrement…')
    held.open()
    await waitFor(() =>
      expect(within(block('Avancé')).getByRole('status')).toHaveTextContent('✓ Enregistré'),
    )
  })

  it('keeps what was typed when it is refused, says why in the field’s unit, and gives the stored value back on Escape', async () => {
    server.use(
      http.put(ROUTES.settings, () =>
        HttpResponse.json(
          { status: 422, type: PROBLEM_TYPES.invalidSetting, title: 'refused' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Fréquence des cours')

    await user.clear(field)
    await user.type(field, '99999{Enter}')

    // 86 400 seconds are 1 440 minutes, and the stored value 120 s is 2.
    expect(await within(block('Avancé')).findByRole('alert')).toHaveTextContent(
      '1 440 au plus. Valeur en place : 2.',
    )
    expect(field).toHaveValue(99999)
    expect(field).toHaveAttribute('aria-invalid', 'true')

    await user.keyboard('{Escape}')
    expect(field).toHaveValue(2)
    expect(field).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says the lower bound as well', async () => {
    server.use(
      http.put(ROUTES.settings, () =>
        HttpResponse.json(
          { status: 422, type: PROBLEM_TYPES.invalidSetting, title: 'refused' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Profondeur d’historique')

    await user.clear(field)
    await user.type(field, '0{Enter}')

    expect(await within(block('Avancé')).findByRole('alert')).toHaveTextContent(
      '1 au moins. Valeur en place : 365.',
    )
  })

  it('says any other failure on its row, keeps the value, and retries on the next blur', async () => {
    let refuse = true
    const writes: unknown[] = []
    server.use(
      http.put(ROUTES.settings, async ({ request }) => {
        writes.push(await request.json())
        if (refuse) return HttpResponse.error()
        return HttpResponse.json(okAnswer(['regular_interval']))
      }),
    )
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Fréquence des cours')

    await user.clear(field)
    await user.type(field, '5{Enter}')

    expect((await within(block('Avancé')).findByRole('alert')).textContent).toBe(
      'Non enregistré : l’application ne répond pas. Valeur en place : 2.',
    )
    expect(field).toHaveValue(5)

    refuse = false
    await user.tab()

    await waitFor(() =>
      expect(within(block('Avancé')).getByRole('status')).toHaveTextContent('✓ Enregistré'),
    )
    expect(writes).toEqual([{ regular_interval: '300' }, { regular_interval: '300' }])
  })

  it('writes only its own row into the cache, so another row’s newer value survives', async () => {
    // The answer carries the whole list, and another row's entry in it is only
    // as new as this request: it must not be written over what the page holds.
    server.use(
      http.put(ROUTES.settings, () =>
        HttpResponse.json({
          settings: aConfig().settings.map((setting) =>
            setting.key === 'regular_interval'
              ? { ...setting, value: 300 }
              : setting.key === 'backfill_delay'
                ? { ...setting, value: 99 }
                : setting,
          ),
          changed: ['regular_interval'],
        }),
      ),
    )
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Fréquence des cours')

    await user.clear(field)
    await user.type(field, '5{Enter}')

    await waitFor(() => expect(within(block('Avancé')).getByRole('status')).toBeInTheDocument())
    expect(field).toHaveValue(5)
    expect(screen.getByLabelText('Pause entre deux requêtes')).toHaveValue(10)
  })

  it('sends nothing for a blank field and shows the stored value again', async () => {
    const writes = recordWrites()
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Fréquence des cours')

    await user.clear(field)
    await user.tab()

    await waitFor(() => expect(field).toHaveValue(2))
    expect(writes).toEqual([])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not take back a value already on its way: Escape then blur sends nothing more', async () => {
    const held = gate()
    const writes: unknown[] = []
    server.use(
      http.put(ROUTES.settings, async ({ request }) => {
        writes.push(await request.json())
        await held.opened
        return HttpResponse.json(okAnswer(['regular_interval']))
      }),
    )
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Fréquence des cours')

    await user.clear(field)
    await user.type(field, '5{Enter}{Escape}')
    await user.tab()
    held.open()

    await waitFor(() => expect(within(block('Avancé')).getByRole('status')).toBeInTheDocument())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(writes).toEqual([{ regular_interval: '300' }])
  })
})

describe('an unreadable store', () => {
  it('is said in the sections it feeds, with a way to read again, and the rest still works', async () => {
    server.use(problemHandler(ROUTES.config, UNAVAILABLE))
    renderApp({ url: '/settings' })

    expect(await screen.findAllByRole('button', { name: 'Réessayer' })).toHaveLength(3)
    expect(within(block('Portefeuille')).queryByLabelText('Devise de référence')).toBeNull()
    // Whether a code is set cannot be told either (#1418).
    expect(within(block('Sécurité')).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
    expect(block('Affichage')).toBeInTheDocument()
    expect(screen.queryByLabelText('Fréquence des cours')).not.toBeInTheDocument()
  })

  it('reads again on request, and the rows come back', async () => {
    let refuse = true
    server.use(
      http.get(ROUTES.config, () =>
        refuse
          ? HttpResponse.json(UNAVAILABLE, {
              status: 503,
              headers: { 'Content-Type': 'application/problem+json' },
            })
          : HttpResponse.json(aConfig()),
      ),
    )
    const { user } = renderApp({ url: '/settings' })

    const retry = await screen.findAllByRole('button', { name: 'Réessayer' })
    refuse = false
    await user.click(retry[0])

    expect(await screen.findByLabelText('Fréquence des cours')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument()
  })
})

describe('in English', () => {
  it('renders every section', async () => {
    const { unmount } = renderApp({ url: '/settings', browserLanguages: ['en-GB'] })
    expect(await screen.findByRole('heading', { name: 'Advanced' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Display' })).toBeInTheDocument()
    unmount()
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

    // The version is on the navigation's foot and on Système › Installation.
    await screen.findAllByText('5.1.0')
    await waitFor(() => expect(screen.queryByRole('link', notes('5.1.0'))).not.toBeInTheDocument())
  })
})

describe('tax models', () => {
  const PEA = aTaxationModel({
    id: 'pea',
    name: 'PEA',
    kind: 'aged_flat_realised',
    parameters: {
      rate_before: 0.128,
      rate_after: 0,
      threshold_years: 5,
      age_basis: 'first_payment',
      social_rate: 0.186,
    },
  })

  function withModels(models = [PEA], accounts = [anAccount({ id: 'pea', label: 'PEA' })]) {
    server.use(
      http.get(ROUTES.taxationModels, () => HttpResponse.json(aTaxationCatalogue({ models }))),
      http.get(ROUTES.accounts, () =>
        HttpResponse.json(
          anAccountsPayload(accounts.map((account) => ({ ...account, taxation_model_id: 'pea' }))),
        ),
      ),
    )
  }

  async function openList() {
    const view = await openSettings()
    const section = await screen.findByRole('region', { name: 'Portefeuille' })
    const list = await within(section).findByRole('list', { name: 'Modèles d’imposition' })
    return { ...view, list }
  }

  it('lists each model with its rates and the accounts that carry it, one « Modifier » each', async () => {
    withModels()
    const { list } = await openList()

    const row = await within(list).findByText('PEA', { selector: 'div' })
    const item = row.closest('li') as HTMLElement
    expect(item).toHaveTextContent(/12,8\s%, puis 0\s% après 5 ans/)
    expect(item).toHaveTextContent(/prélèvements sociaux 18,6\s%/)
    expect(item).toHaveTextContent('PEA', { normalizeWhitespace: true })
    expect(within(item).getAllByRole('button')).toHaveLength(1)
    expect(within(list).getByRole('button', { name: 'Ajouter un modèle' })).toBeInTheDocument()
  })

  it('corrects a model in a side panel, and names the accounts that carry it', async () => {
    withModels()
    let sent: unknown = null
    server.use(
      http.patch(ROUTES.taxationModel, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(PEA)
      }),
    )
    const { user, list } = await openList()

    await user.click(await within(list).findByRole('button', { name: 'Modifier PEA' }))
    const sheet = await screen.findByRole('dialog', { name: 'PEA' })
    expect(within(sheet).getByText('Comptes qui le portent')).toBeInTheDocument()
    const name = sheet.querySelector('#taxation-name') as HTMLInputElement
    await user.clear(name)
    await user.type(name, 'PEA 2026')
    await user.click(within(sheet).getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() =>
      expect(sent).toMatchObject({ name: 'PEA 2026', kind: 'aged_flat_realised' }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('writes a model of its own from the second tab', async () => {
    let sent: unknown = null
    server.use(
      http.post(ROUTES.taxationModels, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(aTaxationModel({ id: 'written' }), { status: 201 })
      }),
    )
    const { user, list } = await openList()

    await user.click(await within(list).findByRole('button', { name: 'Ajouter un modèle' }))
    const sheet = await screen.findByRole('dialog', { name: 'Ajouter un modèle d’imposition' })
    await user.click(within(sheet).getByRole('tab', { name: 'Écrire le mien' }))
    await user.type(sheet.querySelector('#taxation-name') as HTMLInputElement, 'CTO')
    await user.selectOptions(within(sheet).getByLabelText('Forme'), 'flat_realised')
    await user.type(within(sheet).getByLabelText('Taux'), '30')
    await user.click(within(sheet).getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() =>
      expect(sent).toEqual({ name: 'CTO', kind: 'flat_realised', parameters: { rate: 0.3 } }),
    )
  })

  it('imports a wrapper of the registry for the reader’s country, and says it is imported', async () => {
    let sent: unknown = null
    let stored = false
    server.use(
      http.get(ROUTES.taxationModels, () =>
        HttpResponse.json(
          aTaxationCatalogue({
            models: stored
              ? [aTaxationModel({ id: 'cto', name: 'Compte-titres ordinaire (CTO)' })]
              : [],
          }),
        ),
      ),
      http.post(ROUTES.taxationRegistry, async ({ request }) => {
        const body = (await request.json()) as { ids?: string[] }
        if (body.ids === undefined) {
          return HttpResponse.json({
            items: [
              aRegistryItem(),
              aRegistryItem({ id: 'de/depot', country: 'DE', name: 'Wertpapierdepot' }),
            ],
          })
        }
        sent = body
        stored = true
        return HttpResponse.json({ models: [], skipped: [] }, { status: 201 })
      }),
    )
    const { user, list } = await openList()

    await user.click(await within(list).findByRole('button', { name: 'Ajouter un modèle' }))
    const sheet = await screen.findByRole('dialog', { name: 'Ajouter un modèle d’imposition' })
    // The search starts on the reader’s own country.
    expect(within(sheet).getByRole('searchbox')).toHaveValue('France')
    expect(await within(sheet).findByText('Compte-titres ordinaire (CTO)')).toBeInTheDocument()
    expect(within(sheet).queryByText('Wertpapierdepot')).not.toBeInTheDocument()

    await user.click(
      within(sheet).getByRole('button', { name: 'Importer Compte-titres ordinaire (CTO)' }),
    )

    await waitFor(() => expect(sent).toEqual({ ids: ['fr/cto'] }))
    expect(await within(sheet).findByText('déjà importé')).toBeInTheDocument()
  })

  it('says why the registry could not be read, and reads it again on request', async () => {
    let fail = true
    server.use(
      http.post(ROUTES.taxationRegistry, () =>
        fail
          ? HttpResponse.json(
              {
                type: PROBLEM_TYPES.providerRefused,
                title: 'Provider refused',
                status: 502,
                detail: 'taxation-registry: GitHub answered 403',
                provider: 'taxation-registry',
                reason: 'refused',
              },
              { status: 502, headers: { 'Content-Type': 'application/problem+json' } },
            )
          : HttpResponse.json({ items: [aRegistryItem()] }),
      ),
    )
    const { user, list } = await openList()

    await user.click(await within(list).findByRole('button', { name: 'Ajouter un modèle' }))
    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Le catalogue a refusé')

    fail = false
    await user.click(within(sheet).getByRole('button', { name: 'Réessayer' }))
    expect(await within(sheet).findByText('Compte-titres ordinaire (CTO)')).toBeInTheDocument()
  })

  it('deletes a model through the confirmation, and not while an account carries it', async () => {
    withModels([PEA], [])
    const removed: string[] = []
    server.use(
      http.delete(ROUTES.taxationModel, ({ params }) => {
        removed.push(String(params.id))
        return HttpResponse.json({ id: String(params.id), removed: true })
      }),
    )
    const { user, list } = await openList()

    await user.click(await within(list).findByRole('button', { name: 'Modifier PEA' }))
    const sheet = await screen.findByRole('dialog', { name: 'PEA' })
    await user.click(within(sheet).getByRole('button', { name: 'Supprimer ce modèle' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm).toHaveTextContent('Irréversible.')
    await user.click(within(confirm).getByRole('button', { name: 'Supprimer' }))

    await waitFor(() => expect(removed).toEqual(['pea']))
  })

  it('does not offer to delete a model an account carries', async () => {
    withModels()
    const { user, list } = await openList()

    await user.click(await within(list).findByRole('button', { name: 'Modifier PEA' }))
    const sheet = await screen.findByRole('dialog', { name: 'PEA' })

    expect(within(sheet).getByRole('button', { name: 'Supprimer ce modèle' })).toBeDisabled()
  })
})
