import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { taxationModelPath, type TaxationModelDraft } from '@/features/accounts/lib/api'
import type { StoreState } from '@/features/settings/lib/api'
import { FIRST_RUN_STORAGE_KEY } from '@/lib/firstRun'
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

  it('is one sequence of titled sections, the expert dials last', async () => {
    await openSettings()

    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((one) => one.textContent)).toEqual([
        'Sur cet appareil',
        'Portefeuille',
        'L’agent',
        'Accès',
        'Fiscalité',
        'Thème',
        'Avancé',
      ]),
    )
    expect(screen.queryByText('SB_STORE_DIR')).not.toBeInTheDocument()
  })

  it('keeps every control out of a section’s gutter, and has no Save button', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Avancé' })

    for (const name of ['Sur cet appareil', 'Portefeuille', 'Avancé']) {
      const gutter = block(name).querySelector('header')
      expect(gutter, name).not.toBeNull()
      expect(within(gutter as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
      expect(within(gutter as HTMLElement).queryByRole('switch')).not.toBeInTheDocument()
      expect(within(block(name)).queryByRole('button', { name: 'Enregistrer' })).toBeNull()
    }
  })

  it('leaves the notices to the bell', async () => {
    await openSettings([anEnvironmentFact()])
    await screen.findByRole('heading', { name: 'Avancé' })

    expect(screen.queryByRole('button', { name: 'Acquitter' })).not.toBeInTheDocument()
  })

  it('lands on the section its address names, with focus', async () => {
    await openSettings(undefined, undefined, undefined, '/settings#advanced')

    await waitFor(() => expect(block('Avancé')).toHaveFocus())
  })

  it('marks only the section in the address as current in the index (#1410)', async () => {
    await openSettings(undefined, undefined, undefined, '/settings#advanced')
    const index = await screen.findByRole('navigation', { name: 'Sections des réglages' })

    await waitFor(() =>
      expect(
        within(index)
          .getAllByRole('link')
          .filter((link) => link.getAttribute('aria-current') === 'page')
          .map((link) => link.textContent),
      ).toEqual(['Avancé']),
    )
  })

  it('lands again on the section already in the address (#1358)', async () => {
    const { user } = await openSettings(undefined, undefined, undefined, '/settings#advanced')
    await waitFor(() => expect(block('Avancé')).toHaveFocus())
    const index = screen.getByRole('navigation', { name: 'Sections des réglages' })
    const link = within(index).getByRole('link', { name: 'Avancé' })
    link.focus()

    await user.click(link)

    await waitFor(() => expect(block('Avancé')).toHaveFocus())
  })
})

describe('the device section', () => {
  it('sets the language from a select', async () => {
    const { user } = await openSettings()

    await user.click(await screen.findByRole('combobox', { name: 'Langue' }))
    await user.click(screen.getByRole('option', { name: 'English' }))

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
})

describe('the portfolio section', () => {
  it('shows the base currency as an answer, with its chip, once it is fixed', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Portefeuille' })

    const section = block('Portefeuille')
    expect(await within(section).findByText('Figée')).toBeInTheDocument()
    expect(within(section).queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('saves the currency the moment it is chosen, while nobody has answered', async () => {
    // The walk is closed: it is what normally takes the question.
    window.localStorage.setItem(FIRST_RUN_STORAGE_KEY, 'dismissed')
    server.use(
      http.get(ROUTES.config, () =>
        HttpResponse.json(
          aConfig({
            settings: aConfig().settings.map((setting) =>
              setting.key === 'base_currency'
                ? { ...setting, value: null, stored: false }
                : setting,
            ),
          }),
        ),
      ),
    )
    let sent: unknown = null
    server.use(
      http.put(ROUTES.settings, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json({ settings: aConfig().settings, changed: ['base_currency'] })
      }),
    )
    const { user } = await openSettings()
    const currency = await screen.findByLabelText('Devise de base')
    await user.selectOptions(currency, 'CHF')

    await waitFor(() => expect(sent).toEqual({ base_currency: 'CHF' }))
    expect(await within(block('Portefeuille')).findByRole('status')).toHaveTextContent('Enregistré')
  })
})

describe('the advanced section', () => {
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
    await screen.findByRole('heading', { name: 'Avancé' })

    const field = await screen.findByLabelText('a_dial_from_the_future')
    expect(field).toHaveAttribute('min', '1')
    expect(field).toHaveAttribute('max', '9')
    expect(screen.getByText('Something a later version added.')).toBeInTheDocument()
  })

  it('carries the five dials and the release switch, not the currency or the benchmark', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Avancé' })

    const advanced = block('Avancé')
    await within(advanced).findByText('Cadence de relevé')
    for (const dial of [
      'Cadence de relevé',
      'Cadence de reconstruction',
      'Délai entre deux requêtes',
      'Historique par requête',
      'Horizon de cours figé',
      'Signaler les nouvelles versions',
    ]) {
      expect(within(advanced).getByText(dial)).toBeInTheDocument()
    }
    expect(within(advanced).queryByText('Devise de base')).not.toBeInTheDocument()
    expect(within(advanced).queryByText('Référence de comparaison')).not.toBeInTheDocument()
  })

  it('says what a cadence change reaches, and that it is retroactive', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Avancé' })

    expect(
      await screen.findByText(
        /S’applique maintenant à 2 titres, et à 1 autre à l’ouverture de son marché/,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/y compris ceux déjà en échec/)).toBeInTheDocument()
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

  it('on Enter, only what moved, and says so on its own row', async () => {
    const writes = recordWrites()
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Cadence de relevé')

    await user.clear(field)
    await user.type(field, '300{Enter}')

    await waitFor(() => expect(writes).toEqual([{ regular_interval: '300' }]))
    expect(await within(block('Avancé')).findByRole('status')).toHaveTextContent('✓ Enregistré')

    // Leaving the field moves nothing, and the receipt stays.
    await user.tab()
    expect(within(block('Avancé')).getByRole('status')).toHaveTextContent('✓ Enregistré')
  })

  it('on blur, and a blur right after Enter sends nothing more', async () => {
    const writes = recordWrites()
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Horizon de cours figé')
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
    const field = await screen.findByLabelText('Cadence de relevé')

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
    const field = await screen.findByLabelText('Cadence de relevé')

    await user.clear(field)
    await user.type(field, '300{Enter}')

    expect(await within(block('Avancé')).findByRole('status')).toHaveTextContent('Enregistrement…')
    held.open()
    await waitFor(() =>
      expect(within(block('Avancé')).getByRole('status')).toHaveTextContent('✓ Enregistré'),
    )
  })

  it('keeps what was typed when it is refused, says why, and gives the stored value back on Escape', async () => {
    server.use(
      http.put(ROUTES.settings, () =>
        HttpResponse.json(
          { status: 422, type: PROBLEM_TYPES.invalidSetting, title: 'refused' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Historique par requête')

    await user.clear(field)
    await user.type(field, '99999{Enter}')

    expect(await within(block('Avancé')).findByRole('alert')).toHaveTextContent(
      '3 650 au plus. Valeur en place : 365.',
    )
    expect(field).toHaveValue(99999)
    expect(field).toHaveAttribute('aria-invalid', 'true')

    await user.keyboard('{Escape}')
    expect(field).toHaveValue(365)
    expect(field).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
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
    const field = await screen.findByLabelText('Cadence de relevé')

    await user.clear(field)
    await user.type(field, '300{Enter}')

    expect((await within(block('Avancé')).findByRole('alert')).textContent).toBe(
      'Non enregistré : l’application ne répond pas. Valeur en place : 120.',
    )
    expect(field).toHaveValue(300)

    refuse = false
    await user.tab()

    await waitFor(() =>
      expect(within(block('Avancé')).getByRole('status')).toHaveTextContent('✓ Enregistré'),
    )
    expect(writes).toEqual([{ regular_interval: '300' }, { regular_interval: '300' }])
  })

  it('leaves another row alone while one saves', async () => {
    const held = gate()
    server.use(
      http.put(ROUTES.settings, async () => {
        await held.opened
        return HttpResponse.json(okAnswer(['update_check']))
      }),
    )
    const { user } = await openSettings()

    await user.click(await screen.findByRole('switch', { name: 'Signaler les nouvelles versions' }))
    const field = screen.getByLabelText('Cadence de relevé')
    await user.clear(field)
    await user.type(field, '300')
    held.open()

    await waitFor(() => expect(within(block('Avancé')).getByRole('status')).toBeInTheDocument())
    expect(field).toHaveValue(300)
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
    const field = await screen.findByLabelText('Cadence de relevé')

    await user.clear(field)
    await user.type(field, '300{Enter}')

    await waitFor(() => expect(within(block('Avancé')).getByRole('status')).toBeInTheDocument())
    expect(field).toHaveValue(300)
    expect(screen.getByLabelText('Délai entre deux requêtes')).toHaveValue(10)
  })

  it('sends nothing for a blank field and shows the stored value again', async () => {
    const writes = recordWrites()
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Cadence de relevé')

    await user.clear(field)
    await user.tab()

    await waitFor(() => expect(field).toHaveValue(120))
    expect(writes).toEqual([])
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
    const field = await screen.findByLabelText('Historique par requête')

    await user.clear(field)
    await user.type(field, '0{Enter}')

    expect(await within(block('Avancé')).findByRole('alert')).toHaveTextContent(
      '1 au moins. Valeur en place : 365.',
    )
  })

  it('sends a value typed during a failed save, and clears the alert when it lands', async () => {
    const held = gate()
    const writes: unknown[] = []
    server.use(
      http.put(ROUTES.settings, async ({ request }) => {
        writes.push(await request.json())
        if (writes.length === 1) {
          await held.opened
          return HttpResponse.error()
        }
        return HttpResponse.json(okAnswer(['regular_interval']))
      }),
    )
    const { user } = await openSettings()
    const field = await screen.findByLabelText('Cadence de relevé')

    await user.clear(field)
    await user.type(field, '300{Enter}')
    await waitFor(() => expect(writes).toHaveLength(1))
    await user.clear(field)
    await user.type(field, '400{Enter}')
    held.open()

    await waitFor(() =>
      expect(writes).toEqual([{ regular_interval: '300' }, { regular_interval: '400' }]),
    )
    await waitFor(() =>
      expect(within(block('Avancé')).getByRole('status')).toHaveTextContent('✓ Enregistré'),
    )
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
    const field = await screen.findByLabelText('Cadence de relevé')

    await user.clear(field)
    await user.type(field, '300{Enter}{Escape}')
    await user.tab()
    held.open()

    await waitFor(() => expect(within(block('Avancé')).getByRole('status')).toBeInTheDocument())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(writes).toEqual([{ regular_interval: '300' }])
  })
})

describe('the release switch (#1237)', () => {
  const toggle = () => screen.findByRole('switch', { name: 'Signaler les nouvelles versions' })

  /** A server that remembers: the config it serves follows the last write. */
  function statefulServer(hold?: () => Promise<void>) {
    let on = true
    const writes: unknown[] = []
    server.use(
      http.get(ROUTES.config, () => {
        const config = aConfig()
        return HttpResponse.json({
          ...config,
          settings: config.settings.map((setting) =>
            setting.key === 'update_check' ? { ...setting, value: on } : setting,
          ),
        })
      }),
      http.put(ROUTES.settings, async ({ request }) => {
        const body = (await request.json()) as { update_check: boolean }
        writes.push(body)
        await hold?.()
        on = body.update_check
        const config = aConfig()
        return HttpResponse.json({
          settings: config.settings.map((setting) =>
            setting.key === 'update_check' ? { ...setting, value: on } : setting,
          ),
          changed: ['update_check'],
        })
      }),
    )
    return writes
  }

  it('saves at once, and says so on its row', async () => {
    const writes = statefulServer()
    const { user } = await openSettings()

    const control = await toggle()
    expect(control).toBeChecked()
    await user.click(control)

    await waitFor(() => expect(writes).toEqual([{ update_check: false }]))
    await waitFor(() =>
      expect(within(block('Avancé')).getByRole('status')).toHaveTextContent('✓ Enregistré'),
    )
    expect(control).not.toBeChecked()
  })

  it('ends on « on » after on, off, on, whichever answer comes back first', async () => {
    const gates: (() => void)[] = []
    const writes = statefulServer(
      () =>
        new Promise<void>((resolve) => {
          gates.push(resolve)
        }),
    )
    const { user } = await openSettings()

    const control = await toggle()
    await user.click(control) // off, in flight
    await user.click(control) // on, waits its turn
    expect(writes).toEqual([{ update_check: false }])

    gates[0]()
    await waitFor(() => expect(writes).toEqual([{ update_check: false }, { update_check: true }]))
    gates[1]()

    await waitFor(() => expect(control).toBeChecked())
    await waitFor(() =>
      expect(within(block('Avancé')).getByRole('status')).toHaveTextContent('✓ Enregistré'),
    )
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

    expect(await within(block('Avancé')).findByRole('alert')).toHaveTextContent('Non enregistré :')
  })
})

describe('an unreadable store', () => {
  it('is said in the sections it feeds, with a way to read again, and the rest still works', async () => {
    server.use(problemHandler(ROUTES.config, UNAVAILABLE))
    renderApp({ url: '/settings' })

    expect(await screen.findAllByRole('button', { name: 'Réessayer' })).toHaveLength(3)
    expect(within(block('Portefeuille')).queryByLabelText('Devise de base')).toBeNull()
    // Whether a code is set cannot be told either (#1418).
    expect(screen.queryByRole('switch', { name: 'Code d’accès' })).toBeNull()
    expect(within(block('Accès')).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
    expect(block('Sur cet appareil')).toBeInTheDocument()
    expect(screen.queryByLabelText('Cadence de relevé')).not.toBeInTheDocument()
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

    expect(await screen.findByLabelText('Cadence de relevé')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument()
  })
})

describe('the currency row', () => {
  it('says a refusal on its own row', async () => {
    window.localStorage.setItem(FIRST_RUN_STORAGE_KEY, 'dismissed')
    server.use(
      http.get(ROUTES.config, () =>
        HttpResponse.json(
          aConfig({
            settings: aConfig().settings.map((setting) =>
              setting.key === 'base_currency'
                ? { ...setting, value: null, stored: false }
                : setting,
            ),
          }),
        ),
      ),
      http.put(ROUTES.settings, () => HttpResponse.error()),
    )
    const { user } = renderApp({ url: '/settings' })

    await user.selectOptions(await screen.findByLabelText('Devise de base'), 'CHF')

    expect((await within(block('Portefeuille')).findByRole('alert')).textContent).toBe(
      'Non enregistré : l’application ne répond pas.',
    )
  })
})

describe('in English', () => {
  it('renders every section', async () => {
    const { unmount } = renderApp({ url: '/settings', browserLanguages: ['en-GB'] })
    expect(await screen.findByRole('heading', { name: 'Advanced' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Taxation' })).toBeInTheDocument()
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

    await screen.findByText('5.1.0')
    await waitFor(() => expect(screen.queryByRole('link', notes('5.1.0'))).not.toBeInTheDocument())
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
  const REFUSED = {
    type: PROBLEM_TYPES.providerRefused,
    title: 'Provider refused',
    status: 502,
    detail: 'taxation-registry: GitHub answered 403',
    provider: 'taxation-registry',
    reason: 'refused',
  }

  function registryRefusing(problem: typeof REFUSED) {
    return http.post(ROUTES.taxationRegistry, () =>
      HttpResponse.json(problem, {
        status: problem.status,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    )
  }

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

  it('opens the list on the field itself, before anything is typed', async () => {
    await openImport()

    expect(
      await screen.findByRole('listbox', { name: 'Enveloppes de la documentation' }),
    ).toBeInTheDocument()
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

    expect((await within(taxation).findByRole('alert')).textContent).toBe(
      'Le registre a refusé : OSError: HTTP 503',
    )
    expect(taxation).toHaveTextContent('Vous pouvez aussi écrire un modèle.')
    expect(within(taxation).getByRole('button', { name: 'Nouveau modèle' })).toBeEnabled()

    await user.click(within(taxation).getByRole('button', { name: 'Réessayer' }))
    await waitFor(() => expect(within(taxation).queryByRole('alert')).toBeNull())
    expect(answer).toBe(2)
    // The button went away while reading: focus comes back to the field, on the open list.
    const field = within(taxation).getByLabelText('Importer pour mon pays')
    await waitFor(() => expect(field).toHaveFocus())
    expect(field).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps focus on the field when the registry refuses again', async () => {
    server.use(registryRefusing(REFUSED))
    const { user, taxation } = await openImport()

    await user.click(await within(taxation).findByRole('button', { name: 'Réessayer' }))

    const field = within(taxation).getByLabelText('Importer pour mon pays')
    await waitFor(() => expect(field).toHaveFocus())
    expect(await within(taxation).findByRole('alert')).toBeInTheDocument()
  })

  it('says the registry refused, in a sentence that stands alone without a reason', async () => {
    server.use(registryRefusing({ ...REFUSED, detail: '' }))
    const { taxation } = await openImport()

    expect((await within(taxation).findByRole('alert')).textContent).toBe(
      'Le registre a refusé la demande.',
    )
  })

  it('says the documentation site publishes no registry yet on a 404, and keeps Retry', async () => {
    server.use(
      registryRefusing({
        ...REFUSED,
        detail:
          'taxation-registry: HTTPError: HTTP Error 404 (https://docs.example.net/taxation.json)',
        reason: 'unpublished',
      }),
    )
    const { taxation } = await openImport()

    expect((await within(taxation).findByRole('alert')).textContent).toBe(
      'Le site de documentation ne publie pas encore de registre fiscal pour cette version.',
    )
    expect(within(taxation).getByRole('button', { name: 'Réessayer' })).toBeEnabled()
  })

  it('blames the app, not the registry, when the app does not answer', async () => {
    let answer = 0
    server.use(
      http.post(ROUTES.taxationRegistry, () => {
        answer += 1
        return answer === 1 ? HttpResponse.error() : HttpResponse.json({ items: [aRegistryItem()] })
      }),
    )
    const { user, taxation } = await openImport()

    expect((await within(taxation).findByRole('alert')).textContent).toBe(
      'L’application ne répond pas.',
    )

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
