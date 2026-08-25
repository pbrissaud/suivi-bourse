/**
 * The first run (#726, #823, ADR-0021, ADR-0035, ADR-0005, ADR-0015, ADR-0002),
 * at the one seam: the whole app in jsdom, HTTP the only faked edge.
 *
 * Every case names what it prevents, and four of them are the ticket's own
 * arguments rather than opinions:
 *
 *  - **an onboarding screen reopening on somebody who has used the app for six
 *    months** — which is what three steps *derived from the data they collect*
 *    would have done the day that reader emptied their ledger. The passages are
 *    a sequence inside one predicate, and the predicate is a required dial with
 *    nothing stored;
 *  - **a trial run walled in** — a bare `docker run` is a trial by design, so
 *    the three passages are traversed with nothing supplied and no write leaves
 *    the browser;
 *  - **a wall of bands** — the banner was validated in production on a `503`,
 *    something that happens and passes; two conditions that stand until somebody
 *    acts stack into a wall, so it renders one band or none, in causal order;
 *  - **an escape hatch given the weight of the answer** — no *Later* button
 *    beside *Save*: the cross, `Escape` and the click outside are the *later*.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { ROUTES, type ConfigResponse } from '@/lib/api'
import { CURRENCIES } from '@/lib/currencies'
import { PROBLEM_TYPES } from '@/lib/problem'
import { FIRST_RUN_STORAGE_KEY } from '@/lib/firstRun'
import {
  aConfig,
  aLedgerPayload,
  aRebuilding,
  aRuntime,
  noAccountsDeclared,
} from '@/test/factories'
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

type Reader = ReturnType<typeof renderApp>['user']

/**
 * Walk on, one passage at a time. The control is a **ghost** and the answer is
 * filled, which is ADR-0021's *no escape hatch at the weight of the answer* one
 * control over: continuing is the walk, not a second spelling of the way out.
 */
async function walk(user: Reader, passages = 1) {
  for (let step = 0; step < passages; step += 1) {
    await user.click(within(modal()).getByRole('button', { name: 'Continuer' }))
  }
}

/**
 * Every request the app makes that is **not a read**, recorded off the wire.
 *
 * This is how *no `onboarding_done` row* is asserted: not by inspecting a
 * module, but by watching what the walk sends. A traversal that recorded itself
 * server-side would have to write, and there is nothing on the other end of
 * this list to write to.
 */
function writesMade(): string[] {
  const writes: string[] = []
  server.events.on('request:start', ({ request }) => {
    if (request.method !== 'GET') writes.push(`${request.method} ${new URL(request.url).pathname}`)
  })
  return writes
}

afterEach(() => server.events.removeAllListeners())

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

    await waitFor(() => expect(within(modal()).getByLabelText('Devise de base')).toBeInTheDocument())
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

    const field = within(modal()).getByLabelText('Devise de base')
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

    const field = within(modal()).getByLabelText('Devise de base') as HTMLSelectElement
    expect(field.value).toBe('CHF')
    // A suggestion poses nothing: the reservation is on screen where it applies.
    expect(within(modal()).getByText(/il nomme un pays, pas un portefeuille/)).toBeInTheDocument()
  })

  it('drops the pre-filled note the moment the reader overrides the suggestion', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })

    const field = within(modal()).getByLabelText('Devise de base')
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

    await user.selectOptions(within(modal()).getByLabelText('Devise de base'), 'CHF')
    expect(within(modal()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('opens empty rather than guessing when the locale names no currency it can offer', async () => {
    await firstRun({ browserLanguages: ['fr'] })

    const field = within(modal()).getByLabelText('Devise de base') as HTMLSelectElement
    expect(field.value).toBe('')
    expect(within(modal()).queryByText(/il nomme un pays/)).not.toBeInTheDocument()
  })

  it('says where the choice is made that answering it is what fixes it', async () => {
    // The one sentence the reader has to have before they answer, and the one
    // the screen used to get wrong: *you can still change this, your ledger is
    // empty* over a dial whose second answer re-reads three years of euros as
    // dollars. The window that sentence described is real on the server and it
    // is not one the app offers (#794, `CONTEXT.md`).
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload([]))))
    await firstRun()

    await waitFor(() =>
      expect(within(modal()).getByText(/Elle est fixée dès que vous y répondez/)).toBeInTheDocument(),
    )
    expect(within(modal()).queryByText(/^Fixée /)).not.toBeInTheDocument()
  })

  it('is still asked on a full ledger, this dial having never been answered', async () => {
    // The modal's whole population, and the v4 arrival is the ordinary case of
    // it: files carrying no `base_currency` column (#710) leave the dial
    // unanswered under hundreds of events. It is the *answer* that fixes it, so
    // the question is still asked here — and it is asked in a field.
    await firstRun()

    await waitFor(() =>
      expect((within(modal()).getByLabelText('Devise de base') as HTMLElement).tagName).toBe(
        'SELECT',
      ),
    )
  })

  it('stops being drawn as a field on the installation tab once it is answered', async () => {
    // Greyed out, a field invites the click and reads as a form that refused;
    // open, it lets a reader choose a code the write will not take. What is
    // left is the answer and the sentence that says it cannot be taken back.
    const { user } = renderApp({ url: '/donnees' })
    await user.click(await screen.findByRole('tab', { name: /L’installation/ }))

    expect(await screen.findByText(/Fixée : vos montants y sont enregistrés/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Devise de base')).not.toBeInTheDocument()
    expect(screen.getByText('Devise de base')).toBeInTheDocument()
  })

  it('shows a code another road stored, and names it as being outside the list', async () => {
    // Two roads reach the dial without this field: a headless `curl` on
    // `PUT /api/settings` (ADR-0015's one non-interactive path) and #710's
    // import column. **What is closed is what the field offers, not what it can
    // show**: the stored answer is rendered whatever it is, and named as one the
    // field would not have offered.
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

    expect(await screen.findByText(/AED — enregistrée hors de cette liste/)).toBeInTheDocument()
  })

  it('answering it writes the dial, receipts the gesture and walks on', async () => {
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })

    await user.click(within(modal()).getByRole('button', { name: 'Enregistrer' }))

    // `findAllBy`: a toast renders its text twice, once drawn and once in the
    // live region that announces it.
    expect(await screen.findAllByText(/Devise de base enregistrée : EUR/)).not.toHaveLength(0)
    // **The answer no longer closes anything** (ADR-0035). It made the predicate
    // false, and the predicate is what *armed* the modal rather than what holds
    // it open — otherwise the two passages after the question would be
    // unreachable to everybody who answers it, which is everybody it is for.
    expect(await within(modal()).findByRole('heading', { name: 'Vos comptes' })).toBeInTheDocument()
    expect(within(modal()).queryByLabelText('Devise de base')).not.toBeInTheDocument()
  })
})

describe('the banner, with the currency unanswered', () => {
  it('renders one band and it is the currency, gesture included', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    const { user } = await firstRun()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const bands = await screen.findAllByRole('status')
    expect(bands).toHaveLength(1)
    expect(bands[0]).toHaveTextContent(/Aucune devise de base n’a encore été choisie/)
    // Its gesture is a link to its own field — never an acknowledgement — and
    // it is followed rather than merely inspected: an `href` asserted alone
    // passes on a link that lands on the wrong tab, which is what it did.
    await user.click(within(bands[0]).getByRole('link', { name: 'La choisir' }))
    expect(await screen.findByLabelText('Devise de base')).toBeInTheDocument()
    // And still one band, never two: the gesture landed on the tab where the
    // reconstruction's own block lives, and that block is not a band. Since
    // #787 the rule holds by construction rather than by ordering — the rebuild
    // stopped competing for the slot at all.
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent(/Aucune devise de base/)
  })

  it('frees the slot the moment the question is answered, and hands it to nobody', async () => {
    // The causal order still holds — it is simply one condition shorter. What
    // used to take the slot next is the reconstruction, and it no longer
    // competes for one.
    server.use(
      http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))),
      // The dot reads `/health` since #819: same fact, the backfill's verdict.
      http.get(ROUTES.health, () => HttpResponse.json(aRebuilding())),
    )
    const { user } = await firstRun({ browserLanguages: ['fr-FR'] })

    await user.click(within(modal()).getByRole('button', { name: 'Enregistrer' }))
    // The walk goes on after the answer, and a modal hides the page behind it
    // from the accessibility tree — so the bands are read once the reader is out.
    expect(await within(modal()).findByRole('heading', { name: 'Vos comptes' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    // The fact is not lost: the dot carries it, and it is a link.
    expect(
      screen.getByRole('link', { name: /L’historique est en cours de reconstruction/ }),
    ).toBeInTheDocument()
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
    const field = await screen.findByLabelText('Devise de base')
    expect((field as HTMLSelectElement).value).toBe('')
    // And it is an *encart with a gesture*, never an acknowledgeable notice:
    // acknowledging *I have no currency* means nothing (ADR-0021). The notices
    // are a tab of their own since #794, so this is asked where they are.
    await user.click(await screen.findByRole('tab', { name: /Les notices/ }))
    const notices = await screen.findByRole('region', { name: 'Faits d’installation' })
    expect(within(notices).queryByText(/devise de base/i)).not.toBeInTheDocument()
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

describe('the walk is three passages, and they are walked in order', () => {
  it('names each one as the reader arrives on it', async () => {
    const { user } = await firstRun()

    // One: what the app has to be told, which is one thing and has no default.
    expect(within(modal()).getByText('Passage 1 sur 3')).toBeInTheDocument()
    expect(
      within(modal()).getByRole('heading', { name: 'Les réglages obligatoires' }),
    ).toBeInTheDocument()
    expect(within(modal()).getByLabelText('Devise de base')).toBeInTheDocument()

    // Two: the accounts, so the notion exists **before** a file naming them is
    // handed over, which is the whole reason it comes second and not third.
    await walk(user)
    expect(await within(modal()).findByText('Passage 2 sur 3')).toBeInTheDocument()
    expect(within(modal()).getByRole('heading', { name: 'Vos comptes' })).toBeInTheDocument()

    // Three: the events, named for the events and never for the import.
    await walk(user)
    expect(await within(modal()).findByText('Passage 3 sur 3')).toBeInTheDocument()
    expect(
      within(modal()).getByRole('heading', { name: 'Vos premiers événements' }),
    ).toBeInTheDocument()
    // Named for the events and **not** for the import: *premier import* would
    // tell a reader with no file that they cannot come in, and ADR-0005 decided
    // the opposite. The file is one of two doors inside the passage, never the
    // passage itself.
    expect(
      within(modal()).queryByRole('heading', { name: /premier import/i }),
    ).not.toBeInTheDocument()
  })

  it('walks back, the sequence being one and not three tabs', async () => {
    const { user } = await firstRun()

    // The first passage has no way back, so nothing offers one there.
    expect(within(modal()).queryByRole('button', { name: 'Revenir' })).not.toBeInTheDocument()

    await walk(user, 2)
    await user.click(within(modal()).getByRole('button', { name: 'Revenir' }))
    expect(await within(modal()).findByRole('heading', { name: 'Vos comptes' })).toBeInTheDocument()
  })

  it('is satisfied on the accounts by the seeded row, and asks for nothing', async () => {
    // The install that has declared nothing — which is every install on its
    // first day, and the one this passage must not wall in. The seeded row is a
    // declaration the owner may decline to add to, so the passage names it and
    // offers no field at all.
    server.use(http.get(ROUTES.accounts, () => HttpResponse.json(noAccountsDeclared())))
    const { user } = await firstRun()
    await walk(user)

    const passage = within(modal())
    expect(await passage.findByText('Non affecté')).toBeInTheDocument()
    expect(passage.queryByRole('textbox')).not.toBeInTheDocument()
    expect(passage.getByRole('button', { name: 'Continuer' })).toBeEnabled()
  })

  it('says nothing about the accounts while that read is in flight', async () => {
    // ADR-0026, on the one read this walk added: *what this installation holds*
    // is a claim about the reader's own install, and a read that has not landed
    // is not an absence. The passage's own two sentences are about the product
    // and stand; the block that names rows does not exist yet.
    server.use(http.get(ROUTES.accounts, () => new Promise<never>(() => {})))
    const { user } = await firstRun()
    await walk(user)

    const passage = within(modal())
    expect(await passage.findByRole('heading', { name: 'Vos comptes' })).toBeInTheDocument()
    expect(passage.queryByText(/Ce que cette installation possède/)).not.toBeInTheDocument()
    expect(passage.queryByText('Non affecté')).not.toBeInTheDocument()
  })
})

describe('the third passage is the ledger’s own pair of entrances', () => {
  it('mounts the same component, at equal weight and with no primary action', async () => {
    const { user } = await firstRun()
    await walk(user, 2)

    const pair = within(modal())
    expect(await pair.findByRole('region', { name: 'Importer un fichier' })).toBeInTheDocument()
    expect(pair.getByRole('region', { name: 'Saisir un premier événement' })).toBeInTheDocument()
    // Both entries are **available**, and that is a property of the product
    // rather than of this install (#811, ADR-0032): a file is handed to the app
    // by a gesture, so there is no mount left whose absence could take an
    // entrance away — and the sentence names no folder, there being none left
    // to name.
    expect(pair.getByText(/Remettez à l’application un .csv ou un .xlsx/)).toBeInTheDocument()
    expect(pair.queryByText(/\/import/)).not.toBeInTheDocument()
    // No primary action: a filled button beside an outlined one is a
    // recommendation, and it would be wrong for whichever reader it misses. Both
    // doors are outlined, which is what *equal weight* is made of.
    expect(pair.getByRole('link', { name: 'Saisir un événement' }).className).toContain('border')
    expect(pair.getByRole('link', { name: 'Remettre un fichier' }).className).toContain('border')
  })

  it('states no emptiness: it offers two doors before anything has been read', async () => {
    const { user } = await firstRun()
    await walk(user, 2)

    // `data-empty` is the mount's and not the component's — here nothing is
    // being claimed about the reader's own data.
    await within(modal()).findByRole('region', { name: 'Importer un fichier' })
    expect(modal().querySelector('[data-empty]')).toBeNull()
  })

  it('is traversed by the file door, which lands where a file is handed over', async () => {
    const { user } = await firstRun()
    await walk(user, 2)

    await user.click(await within(modal()).findByRole('link', { name: 'Remettre un fichier' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // Not merely `/donnees`: the target the file is actually handed to, which is
    // reached by its own label rather than by a rectangle a pointer must find.
    expect(await screen.findByLabelText('Choisir un fichier')).toBeInTheDocument()
    // The walk is over however it ended, and the browser holds that.
    expect(window.localStorage.getItem(FIRST_RUN_STORAGE_KEY)).toBe('dismissed')
  })

  it('is traversed by the typed event, ADR-0005 having decided that is a way in', async () => {
    const { user } = await firstRun()
    await walk(user, 2)

    await user.click(await within(modal()).findByRole('link', { name: 'Saisir un événement' }))

    // The door opens the form itself and not a page with a button on it: a
    // reader with no file must be able to record a first purchase from here,
    // because typing a position *is* creating dated events.
    expect(await screen.findByRole('dialog', { name: /événement/i })).toBeInTheDocument()
    expect(window.localStorage.getItem(FIRST_RUN_STORAGE_KEY)).toBe('dismissed')
  })
})

describe('mandatory means traversed, never answered', () => {
  it('lets a bare docker run through the three without supplying anything', async () => {
    // The install ADR-0015 designs for: no volume, nothing declared, an empty
    // ledger. A screen that will not release this reader without a CSV in hand
    // turns the trial into a wall, so the three passages are walked and the
    // only thing that happens is that they end.
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(
          aRuntime({ store: { persistence: 'ephemeral', path: '/data/suivi-bourse.duckdb' } }),
        ),
      ),
      http.get(ROUTES.accounts, () => HttpResponse.json(noAccountsDeclared())),
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload([]))),
    )
    const writes = writesMade()
    const { user } = await firstRun()

    await walk(user, 2)
    await user.click(await within(modal()).findByRole('button', { name: 'Terminer' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // **Nothing was extracted, and nothing was recorded server-side.** No dial
    // was answered, no account declared, no event written — and no
    // `onboarding_done` either, there being no write at all to carry one.
    expect(writes).toEqual([])
    expect(window.localStorage.getItem(FIRST_RUN_STORAGE_KEY)).toBe('dismissed')
  })

  it('keeps the walk out of the store: the memory is the browser’s, and only that', async () => {
    const writes = writesMade()
    const { user, unmount } = await firstRun()

    await walk(user, 2)
    await user.click(await within(modal()).findByRole('button', { name: 'Terminer' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes).toEqual([])
    unmount()

    // It holds between two mounts, the server having answered nothing new.
    withNoCurrency()
    renderApp()
    await screen.findByRole('heading', { name: 'Tableau de bord', level: 1 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not reopen on a ledger emptied after six months', async () => {
    // #726's refusal, answered on its merits. What used to reopen the screen was
    // not the number of steps: it was deriving its existence from the data it is
    // about to collect. Nothing here reads the ledger, so emptying one — which
    // the bulk delete makes an ordinary gesture — changes nothing.
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload([]))))
    renderApp({ url: '/donnees' })

    await screen.findByRole('heading', { name: 'Données', level: 1 })
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Importer un fichier' })).toBeInTheDocument(),
    )
    // The ledger is empty on screen, and the walk is nowhere.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('re-poses the question on a wiped store, nothing there having remembered', async () => {
    // The other half of the same property. The traversal is the browser's, so
    // there is no row to survive the volume: an install whose store is gone
    // answers *unanswered* again, and every reader who has not been through in
    // this browser is walked through the three again.
    const { user, unmount } = await firstRun()
    await walk(user, 2)
    await user.click(await within(modal()).findByRole('button', { name: 'Terminer' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    unmount()

    window.localStorage.clear()
    withNoCurrency()
    renderApp()

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(within(modal()).getByText('Passage 1 sur 3')).toBeInTheDocument()
  })
})
