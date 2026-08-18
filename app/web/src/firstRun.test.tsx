/**
 * The first run (#726, ADR-0021, ADR-0005, ADR-0015, ADR-0002), at the one
 * seam: the whole app in jsdom, HTTP the only faked edge.
 *
 * Every case names what it prevents, and three of them are the ticket's own
 * arguments rather than opinions:
 *
 *  - **an onboarding screen reopening on somebody who has used the app for six
 *    months** — which is what three independent steps on three predicates would
 *    have done the day they revoked their imports. One predicate, and it is the
 *    only dial with no default;
 *  - **a wall of bands** — the banner was validated in production on a `503`,
 *    something that happens and passes; two conditions that stand until somebody
 *    acts stack into a wall, so it renders one band or none, in causal order;
 *  - **an escape hatch given the weight of the answer** — no *Later* button
 *    beside *Save*: the cross, `Escape` and the click outside are the *later*.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES, type ConfigResponse } from '@/lib/api'
import { CURRENCIES } from '@/lib/currencies'
import { PROBLEM_TYPES } from '@/lib/problem'
import { FIRST_RUN_STORAGE_KEY } from '@/lib/firstRun'
import { aConfig, aLedgerPayload, aRuntime } from '@/test/factories'
import { renderApp, type RenderAppOptions } from '@/test/render'
import { server } from '@/test/server'

/** The one predicate: the reporting currency unanswered. */
function unanswered(overrides: Partial<ConfigResponse> = {}): ConfigResponse {
  const config = aConfig(overrides)
  return {
    ...config,
    settings: config.settings.map((setting) =>
      setting.key === 'base_currency' ? { ...setting, value: null, stored: false } : setting,
    ),
  }
}

/**
 * The config route, **stateful**: answering the dial has to make the predicate
 * false, and a handler frozen on *unanswered* would re-arm the modal on the
 * refetch that follows the write — testing the fixture rather than the app.
 */
function withNoCurrency(config: ConfigResponse = unanswered()) {
  let current = config
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

function modal() {
  return screen.getByRole('dialog')
}

async function firstRun(options: RenderAppOptions = {}) {
  withNoCurrency()
  const rendered = renderApp(options)
  await screen.findByRole('dialog')
  return rendered
}

describe('the modal opens on a predicate, never on a moment', () => {
  it('opens wherever the reader landed, because first run is not a place', async () => {
    await firstRun({ url: '/titres' })

    expect(within(modal()).getByRole('heading', { name: /une question/ })).toBeInTheDocument()
    // The page the reader asked for is behind it — no route of its own, and no
    // redirection conditioned on the data. `hidden`, because a modal dialog
    // hides the rest of the document from the accessibility tree.
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
})

describe('what it says, and what it refuses to say', () => {
  it('carries three sentences about what the app is and no rule of calculation', async () => {
    await firstRun()

    const described = within(modal())
    expect(described.getByText(/grand livre d’événements datés/)).toBeInTheDocument()
    expect(described.getByText(/va chercher les cours toute seule/)).toBeInTheDocument()
    expect(described.getByText(/une seule devise/)).toBeInTheDocument()
    // ADR-0016 gives a rule its own surface, beside the figure it governs.
    expect(described.queryByText(/PRU|prix de revient|moyen pondéré/i)).not.toBeInTheDocument()
  })

  it('warns that an ephemeral container keeps nothing, being the only surface every trial user meets', async () => {
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(aRuntime({ store: { persistence: 'ephemeral', path: '/data/x.duckdb' } })),
      ),
    )
    await firstRun()

    await waitFor(() =>
      expect(within(modal()).getByText(/Ce conteneur ne garde rien/)).toBeInTheDocument(),
    )
  })

  it('says nothing about persistence on a mounted store', async () => {
    await firstRun()

    await waitFor(() => expect(within(modal()).getByLabelText('Devise de report')).toBeInTheDocument())
    expect(within(modal()).queryByText(/ne garde rien/)).not.toBeInTheDocument()
  })
})

describe('closing it', () => {
  it('offers no Later button — the cross, Échap and the click outside are the later', async () => {
    const { user } = await firstRun()

    const buttons = within(modal())
      .getAllByRole('button')
      .map((button) => button.textContent?.trim())
    expect(buttons).not.toContain('Plus tard')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes on the click outside, the third of the three ways', async () => {
    const { user } = await firstRun()

    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(overlay).not.toBeNull()
    await user.click(overlay as Element)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes on the cross and leaves an app that works', async () => {
    const { user } = await firstRun({ url: '/donnees' })

    await user.click(within(modal()).getByRole('button', { name: 'Fermer' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // The ledger is writable: the app runs, it scrapes in the security's own
    // currency, and what waits is the conversion — which the band then says.
    await user.click(await screen.findByRole('button', { name: 'Saisir un événement' }))
    expect(await screen.findByRole('dialog', { name: /événement/i })).toBeInTheDocument()
  })

  it('remembers the closing in the browser alone, so a wiped volume re-arms it', async () => {
    const { user, unmount } = await firstRun()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(window.localStorage.getItem(FIRST_RUN_STORAGE_KEY)).toBe('dismissed')
    unmount()

    // Same browser, same server: still shut.
    withNoCurrency()
    const again = renderApp()
    await screen.findByRole('heading', { name: 'Tableau de bord', level: 1 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    again.unmount()

    // Another browser — nothing on the server changed, and the question is back.
    window.localStorage.clear()
    withNoCurrency()
    renderApp()
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})

describe('the currency itself', () => {
  it('is a closed list bounded by what the rate source quotes', async () => {
    await firstRun()

    const field = within(modal()).getByLabelText('Devise de report')
    expect(field.tagName).toBe('SELECT')
    const offered = within(field as HTMLSelectElement)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
    expect(offered).toEqual(['', ...CURRENCIES])
    // Shape-valid and never quoted: the field cannot express it at all.
    expect(offered).not.toContain('XYZ')
  })

  it('is pre-filled from the browser locale as a suggestion and not as an answer', async () => {
    await firstRun({ browserLanguages: ['fr-CH'] })

    const field = within(modal()).getByLabelText('Devise de report') as HTMLSelectElement
    expect(field.value).toBe('CHF')
    // A suggestion poses nothing: the reservation is on screen where it applies.
    expect(within(modal()).getByText(/il nomme un pays, pas un portefeuille/)).toBeInTheDocument()
  })

  it('drops the pre-filled note the moment the reader overrides the suggestion', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })

    const field = within(modal()).getByLabelText('Devise de report')
    expect(within(modal()).getByText(/il nomme un pays, pas un portefeuille/)).toBeInTheDocument()

    await user.selectOptions(field, 'CHF')
    // The reservation is about a value the browser named. Left standing over a
    // code the reader chose, it says something that is simply not true of it.
    expect(within(modal()).queryByText(/il nomme un pays/)).not.toBeInTheDocument()
  })

  it('does not attach a past refusal to the code just picked', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })
    // Registered after the harness's own writer, which `use` would otherwise
    // shadow: the last handler installed is the one that answers.
    server.use(
      http.put(ROUTES.settings, () =>
        HttpResponse.json(
          { type: PROBLEM_TYPES.badRequest, title: 'refused', status: 422 },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    )

    await user.click(within(modal()).getByRole('button', { name: 'Enregistrer' }))
    expect(await within(modal()).findByRole('alert')).toHaveTextContent(/a refusé cette valeur/)

    await user.selectOptions(within(modal()).getByLabelText('Devise de report'), 'CHF')
    expect(within(modal()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('opens empty rather than guessing when the locale names no currency it can offer', async () => {
    await firstRun({ browserLanguages: ['fr'] })

    const field = within(modal()).getByLabelText('Devise de report') as HTMLSelectElement
    expect(field.value).toBe('')
    expect(within(modal()).queryByText(/il nomme un pays/)).not.toBeInTheDocument()
  })

  it('says where the choice is made that it is still free on an empty ledger', async () => {
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload([]))))
    await firstRun()

    await waitFor(() =>
      expect(within(modal()).getByText(/votre grand livre est vide/)).toBeInTheDocument(),
    )
  })

  it('stays free on a full ledger, this dial having never been answered', async () => {
    // The modal's whole population, and the v4 arrival is the ordinary case of
    // it: files carrying no `base_currency` column (#710) leave the dial
    // unanswered under hundreds of events. The server returns early on
    // *never answered* one clause before it counts them, so *« elle est fixée »*
    // here is a refusal the app does not make — over a form whose save works.
    await firstRun()

    await waitFor(() =>
      expect(within(modal()).getByText(/Vous pouvez encore la changer/)).toBeInTheDocument(),
    )
    expect(within(modal()).queryByText(/Elle est désormais fixée/)).not.toBeInTheDocument()
  })

  it('is fixed on the installation tab once it has been answered and events exist', async () => {
    const { user } = renderApp({ url: '/donnees' })
    await user.click(await screen.findByRole('tab', { name: /L’installation/ }))

    expect(await screen.findByText(/Elle est désormais fixée/)).toBeInTheDocument()
  })

  it('shows a code another road stored, rather than reading it as unanswered', async () => {
    // Two roads reach the dial without this field: a headless `curl` on
    // `PUT /api/settings` (ADR-0015's one non-interactive path) and #710's
    // import column. A controlled `select` with no matching option falls back
    // to the empty one, and the screen would state the question is unanswered
    // over a store that holds the answer.
    const config = aConfig()
    server.use(
      http.get(ROUTES.config, () =>
        HttpResponse.json({
          ...config,
          settings: config.settings.map((setting) =>
            setting.key === 'base_currency' ? { ...setting, value: 'AED' } : setting,
          ),
        }),
      ),
    )
    const { user } = renderApp({ url: '/donnees' })
    await user.click(await screen.findByRole('tab', { name: /L’installation/ }))

    const field = (await screen.findByLabelText('Devise de report')) as HTMLSelectElement
    expect(field.value).toBe('AED')
    expect(within(field).getByRole('option', { name: /AED/ })).toBeInTheDocument()
  })

  it('answering it writes the dial, receipts the gesture and closes the modal', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })

    await user.click(within(modal()).getByRole('button', { name: 'Enregistrer' }))

    // `findAllBy`: a toast renders its text twice, once drawn and once in the
    // live region that announces it.
    expect(await screen.findAllByText(/Devise de report enregistrée : EUR/)).not.toHaveLength(0)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('the banner, with both conditions true at once', () => {
  it('renders one band and it is the currency, gesture included', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    const { user } = await firstRun()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const bands = await screen.findAllByRole('status')
    expect(bands).toHaveLength(1)
    expect(bands[0]).toHaveTextContent(/Aucune devise de report n’a encore été choisie/)
    // Its gesture is a link to its own field — never an acknowledgement — and
    // it is followed rather than merely inspected: an `href` asserted alone
    // passes on a link that lands on the wrong tab, which is what it did.
    await user.click(within(bands[0]).getByRole('link', { name: 'La choisir' }))
    expect(await screen.findByLabelText('Devise de report')).toBeInTheDocument()
    // And never the reconstruction beside it: two bands is the wall.
    expect(screen.queryByText(/en cours de reconstruction/)).not.toBeInTheDocument()
  })

  it('hands the slot to the reconstruction once the currency is answered', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })

    await user.click(within(modal()).getByRole('button', { name: 'Enregistrer' }))

    expect(await screen.findByText(/en cours de reconstruction/)).toBeInTheDocument()
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })
})

describe('the ceiling loses nothing: what does not fit the slot is held by the panel', () => {
  it('keeps the currency answerable on the installation tab, and posts no notice about it', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    const { user } = await firstRun({ url: '/donnees' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(await screen.findByRole('tab', { name: /L’installation/ }))

    // The same field the modal mounts, still there — the panel holds it anyway,
    // which is what licenses capping the banner at one band.
    const field = await screen.findByLabelText('Devise de report')
    expect((field as HTMLSelectElement).value).toBe('')
    // And it is an *encart with a gesture*, never an acknowledgeable notice:
    // acknowledging *I have no currency* means nothing (ADR-0021).
    const notices = screen.getByRole('region', { name: 'Avis' })
    expect(within(notices).queryByText(/devise de report/i)).not.toBeInTheDocument()
  })
})

describe('the status dot is a state and a link, and the link arrives', () => {
  it('opens the installation tab from any page, which is a trial user’s only hold', async () => {
    const { user } = renderApp({ url: '/titres' })

    await user.click(await screen.findByRole('link', { name: /État de l’installation/ }))

    // Not merely `/donnees`: the tab the sentence about the container lives on.
    expect(await screen.findByRole('heading', { name: 'Le magasin', level: 2 })).toBeInTheDocument()
  })
})

describe('the last step is the ledger’s own pair of entrances', () => {
  it('mounts the same component, at equal weight and with no primary action', async () => {
    await firstRun()

    const pair = within(modal())
    expect(pair.getByRole('region', { name: 'Déposer un fichier' })).toBeInTheDocument()
    expect(pair.getByRole('region', { name: 'Saisir un premier événement' })).toBeInTheDocument()
    // The unavailable entry keeps its place and says why: an unmounted drop
    // folder is an ordinary state, and a pair rendering as one entry reads as
    // a breakage.
    expect(pair.getByText(/montage optionnel/)).toBeInTheDocument()
    // No primary action: a filled button beside an outlined one is a
    // recommendation, and it would be wrong for whichever reader it misses.
    const entry = pair.getByRole('link', { name: 'Saisir un événement' })
    expect(entry.className).toContain('border')
  })

  it('states no emptiness: it offers two doors before anything has been read', async () => {
    await firstRun()

    // `data-empty` is the mount's and not the component's — here nothing is
    // being claimed about the reader's own data.
    expect(modal().querySelector('[data-empty]')).toBeNull()
  })
})
