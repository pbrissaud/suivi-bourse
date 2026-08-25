/**
 * The installation tab (#724, #794, ADR-0014, ADR-0015, ADR-0020, ADR-0021,
 * ADR-0030), at the one seam: the whole app in jsdom, HTTP the only faked edge.
 *
 * **The notices left this tab at #794** and are in `notices.test.tsx`, with the
 * badge that promises them: a notice is prose, and what is left here is what
 * the installation *is* — the settings, the store and its orphans.
 *
 * Every case below names what it prevents, and two of them are measurements
 * rather than opinions:
 *
 *  - **79 % of a store's rows purged for zero bytes** — 126,0 Mo before, 126,0
 *    Mo after, the same content rebuilt from scratch fitting in 26,0. That is
 *    why a size and a purge button cannot be shown without the sentence between
 *    them;
 *  - **a greyed-out form that refused** — the environment half is a description,
 *    and the test of that is mechanical: nothing in it is an `input`.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import type { InstallationFact, StoreState } from '@/lib/api'
import {
  aConfig,
  anEnvironmentFact,
  aRuntime,
  aStore,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

async function openInstallation(facts?: InstallationFact[], store?: StoreState) {
  if (facts) {
    server.use(http.get(ROUTES.installationFacts, () => HttpResponse.json(facts)))
  }
  if (store) {
    server.use(http.get(ROUTES.store, () => HttpResponse.json(store)))
  }
  const rendered = renderApp({ url: '/donnees' })
  await rendered.user.click(await screen.findByRole('tab', { name: /L’installation/ }))
  return rendered
}

function block(name: RegExp | string) {
  return screen.getByRole('region', { name })
}

describe('the two blocks, in one order', () => {
  it('reads Réglages · Le magasin, what you can change before what it is', async () => {
    await openInstallation()

    const headings = await screen.findAllByRole('heading', { level: 2 })
    expect(headings.map((heading) => heading.textContent)).toEqual(['Réglages', 'Le magasin'])
  })

  it('says nothing about the notices, which are a tab of their own', async () => {
    await openInstallation([anEnvironmentFact()])
    await screen.findByRole('heading', { name: 'Réglages' })

    // A notice is prose — a date, an acknowledgement, a link to the events
    // concerned — and a card in a column beside the store has nowhere to say
    // it (ADR-0030).
    expect(screen.queryByRole('heading', { name: 'Faits d’installation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Acquitter' })).not.toBeInTheDocument()
  })
})


describe('the settings, which are one surface', () => {
  it('has two sections and no separate effective-configuration card', async () => {
    await openInstallation()
    await screen.findByRole('heading', { name: 'Réglages' })

    const settings = block('Réglages')
    expect(within(settings).getByText('Ce que vous pouvez changer')).toBeInTheDocument()
    expect(within(settings).getByText('Ce que le conteneur impose')).toBeInTheDocument()
    // It was drawn twice from the same source on the same page, and it answered
    // a precedence problem that no longer exists.
    expect(screen.queryByText(/configuration effective/i)).not.toBeInTheDocument()
  })

  it('draws the form from the registry rather than from a list of its own', async () => {
    server.use(
      http.get(ROUTES.config, () =>
        HttpResponse.json(
          aConfig({
            settings: [
              ...aConfig().settings,
              // A dial the catalogue has never heard of. The form renders it,
              // with its bounds, because the registry is the single list.
              {
                key: 'a_dial_from_the_future',
                value: 7,
                default: 7,
                type: 'integer',
                minimum: 1,
                maximum: 9,
                effect: 'next_cycle',
                doc: 'Something a later version added.',
                stored: false,
              },
            ],
          }),
        ),
      ),
    )
    await openInstallation()
    await screen.findByRole('heading', { name: 'Réglages' })

    const field = screen.getByLabelText('a_dial_from_the_future')
    expect(field).toHaveAttribute('min', '1')
    expect(field).toHaveAttribute('max', '9')
    expect(screen.getByText('Something a later version added.')).toBeInTheDocument()
  })

  it('carries the five dials and the currency, the mock-up having dropped three', async () => {
    await openInstallation()
    await screen.findByRole('heading', { name: 'Réglages' })

    // The list is the registry's and the words are the catalogue's, so this is
    // an assertion about *the tab*, not about a hard-written form: the redesign
    // kept two of the six and this is what says the other four came back
    // (#787, #794).
    const settings = block('Réglages')
    for (const dial of [
      'Cadence de relevé (secondes)',
      'Cadence de reconstruction (secondes)',
      'Délai entre deux requêtes de reconstruction (secondes)',
      'Historique récupéré par requête (jours)',
      'Horizon de cours figé (secondes)',
      'Devise de base',
    ]) {
      expect(within(settings).getByText(dial)).toBeInTheDocument()
    }
  })

  it('quantifies what a cadence change reaches, and names the retroactive trap', async () => {
    await openInstallation()
    await screen.findByRole('heading', { name: 'Réglages' })

    // Two markets open, one shut: a portfolio-wide dial that reaches part of
    // the portfolio has to say so, or the other symbols read as misconfigured.
    expect(
      screen.getByText(/s’applique à 2 titres maintenant, et à 1 autre à l’ouverture de son marché/),
    ).toBeInTheDocument()
    // No interface can hide it: the number in the form is the number in the
    // back-off's own formula.
    expect(screen.getByText(/rééchelonne donc ce délai rétroactivement/)).toBeInTheDocument()
  })

  it('writes only what moved, and reports what the write reached', async () => {
    const { user } = await openInstallation()
    await screen.findByRole('heading', { name: 'Réglages' })

    let sent: Record<string, string> | null = null
    server.use(
      http.put(ROUTES.settings, async ({ request }) => {
        sent = (await request.json()) as Record<string, string>
        return HttpResponse.json({
          settings: aConfig().settings,
          changed: Object.keys(sent),
          effect: { symbols_rescheduled: 2, symbols_at_market_open: 1, jobs_rescheduled: [] },
        })
      }),
    )

    await user.clear(screen.getByLabelText('Cadence de relevé (secondes)'))
    await user.type(screen.getByLabelText('Cadence de relevé (secondes)'), '300')
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))

    // `reschedule_job` recomputes the next run from *now*, so a save button that
    // posted every field would reset every timer on every click, invisibly.
    await waitFor(() => expect(sent).toEqual({ regular_interval: '300' }))
    // The receipt says what **happened**, in its own words: repeating the
    // forecast verbatim would put two announcers on one fact, one of them in
    // the past tense and one of them not.
    const receipt = await screen.findByRole('status')
    expect(receipt).toHaveTextContent('1 réglage enregistré')
    expect(receipt).toHaveTextContent(/2 titres ont été réarmés/)
    expect(receipt).toHaveTextContent(/1 autre lira la nouvelle valeur/)
  })

  it('renders the container half as a description and never as fields', async () => {
    await openInstallation()
    await screen.findByRole('heading', { name: 'Réglages' })

    // Greyed-out fields invite the click and read as a form that refused.
    const settings = block('Réglages')
    const imposed = within(settings).getByText('Ce que le conteneur impose').parentElement as HTMLElement
    expect(within(imposed).queryAllByRole('textbox')).toHaveLength(0)
    expect(imposed.querySelectorAll('input, select, textarea, button')).toHaveLength(0)
    // The list is the API's and never a hard-written one, which is what makes
    // this an assertion about *the tab*: three names — the two the exporter
    // answered for (ADR-0033) and the drop folder's own (ADR-0032) are gone from
    // the payload rather than hidden here.
    for (const name of ['SB_STORE_DIR', 'SB_WEB_PORT', 'LOG_LEVEL']) {
      expect(within(imposed).getByText(name)).toBeInTheDocument()
    }
    expect(within(imposed).queryByText('SB_PROMETHEUS_ENABLED')).not.toBeInTheDocument()
    expect(within(imposed).queryByText('SB_METRICS_PORT')).not.toBeInTheDocument()
    // Written once for the section, never under each of four rows.
    expect(within(imposed).getAllByText(/En changer une, c’est recréer le conteneur/)).toHaveLength(1)
  })
})

describe('the store', () => {
  it('states the path, its persistence, the size and the last ledger write', async () => {
    await openInstallation()
    await screen.findByRole('heading', { name: 'Le magasin' })

    const store = block('Le magasin')
    expect(store).toHaveTextContent('/data/suivi-bourse.duckdb')
    expect(store).toHaveTextContent(/sur un montage qui survit au conteneur/)
    // French units, from `Intl` — the header of this very file writes them.
    expect(store).toHaveTextContent(/26,0\s*Mo/)
    // The last **write of the ledger**, never the last observed price — that
    // second one is liveness and belongs to the banner.
    expect(store).toHaveTextContent('Dernière écriture du grand livre')
    expect(store).toHaveTextContent(/10 févr\. 2026/)
  })

  it('never shows a size without saying what a purge does not do', async () => {
    await openInstallation()
    await screen.findByRole('heading', { name: 'Le magasin' })

    // Measured: 79 % of the rows purged for zero bytes returned. Shown bare
    // beside a purge button, the figure is a lie by juxtaposition.
    expect(
      within(block('Le magasin')).getByText(/retire des lignes, pas des octets/),
    ).toBeInTheDocument()
  })

  it('lets an ephemeral store dominate the block instead of noting it', async () => {
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(aRuntime({ store: { persistence: 'ephemeral', path: '/data/x.duckdb' } })),
      ),
    )
    await openInstallation()
    await screen.findByRole('heading', { name: 'Le magasin' })

    // The only screen where a trial run learns that it is a trial run.
    expect(screen.getByText('Ce conteneur ne garde rien')).toBeInTheDocument()
    // And never a notice: its predicate is not acknowledgeable, so acknowledging
    // it would make it go quiet while it was still true. Since #794 the notices
    // are not even on this tab, and the tab that carries them is asserted on in
    // `notices.test.tsx`.
    expect(screen.getByRole('tab', { name: /Les notices/ })).not.toHaveTextContent(/notices? à lire/)
  })

  it('says nothing about persistence it cannot observe', async () => {
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(aRuntime({ store: { persistence: 'unknown', path: '/data/x.duckdb' } })),
      ),
    )
    await openInstallation()
    await screen.findByRole('heading', { name: 'Le magasin' })

    // The observation is a property of the kernel: off Linux there is nothing
    // to report, and a reader must not be told either of the other two answers.
    expect(block('Le magasin')).toHaveTextContent(/Impossible d’observer d’ici/)
    expect(screen.queryByText('Ce conteneur ne garde rien')).not.toBeInTheDocument()
  })

  it('has no orphan list at zero', async () => {
    await openInstallation()
    await screen.findByRole('heading', { name: 'Le magasin' })

    // It is not a maintenance table: it is the visible consequence of a forget
    // the reader has just made.
    expect(screen.queryByRole('button', { name: 'Purger ces historiques' })).not.toBeInTheDocument()
  })

  it('names each orphan with the series it holds, and purges them all at once', async () => {
    const { user } = await openInstallation(undefined, aStore({ orphans: [{ symbol: 'ZZX', points: 1204 }] }))
    await screen.findByRole('heading', { name: 'Le magasin' })

    const store = block('Le magasin')
    expect(store).toHaveTextContent('1 titre que plus rien ne déclare')
    expect(store).toHaveTextContent('ZZX')
    expect(store).toHaveTextContent('1 204 cours')
    // A sold position is not one of them — its events are still recorded.
    expect(store).toHaveTextContent(/Une position que vous avez soldée n’en fait pas partie/)

    server.use(http.get(ROUTES.store, () => HttpResponse.json(aStore())))
    await user.click(screen.getByRole('button', { name: 'Purger ces historiques' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Purger ces historiques' })).not.toBeInTheDocument(),
    )
  })

  it('keeps the em dash for a process that named no store', async () => {
    // The read **landed** and there is nothing to compute (ADR-0016) — the one
    // state the `??` #777 gated out of the row was legitimately carrying, and
    // the phrase net cannot see it: an em dash carries no word.
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(aRuntime({ store: { persistence: 'unknown', path: null } })),
      ),
    )
    await openInstallation()
    await screen.findByRole('heading', { name: 'Le magasin' })

    const store = block('Le magasin')
    expect(store).toHaveTextContent('Où il se trouve')
    expect(within(store).getByText('—')).toBeInTheDocument()
  })

  it('says nothing about the ledger while its own read is in flight', async () => {
    // ADR-0026, #777: *« Rien n’a encore été importé »* is a statement about the
    // reader's own data, and a hanging read has told the app nothing.
    server.use(http.get(ROUTES.store, () => new Promise<never>(() => {})))
    await openInstallation()
    await screen.findByRole('heading', { name: 'Le magasin' })

    const store = block('Le magasin')
    // The two facts that ride on `/api/runtime` are why the block does not wait
    // as a whole (#668, #724): they are on screen in flight as in failure.
    expect(store).toHaveTextContent('/data/suivi-bourse.duckdb')
    expect(store).toHaveTextContent(/sur un montage qui survit au conteneur/)
    // What the store itself was to say does not exist yet — the block's own
    // rule applied one notch lower, never a dash and never a sentence.
    expect(store).not.toHaveTextContent('Rien n’a encore été importé')
    expect(store).not.toHaveTextContent('Dernière écriture du grand livre')
    expect(store).not.toHaveTextContent('Taille sur le disque')
  })
})

describe('the tab’s own reads', () => {
  it('names an unreadable store instead of rendering an empty installation', async () => {
    server.use(
      problemHandler(ROUTES.config, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
      problemHandler(ROUTES.store, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    const { user } = renderApp({ url: '/donnees' })
    await user.click(await screen.findByRole('tab', { name: /L’installation/ }))

    // `/api/runtime` opens no store, so the shell's banner is silent on exactly
    // this failure — and one band on screen, never two.
    const bands = await screen.findAllByRole('status')
    expect(bands.filter((band) => band.textContent?.includes('son magasin ne répond pas'))).toHaveLength(1)
    // The two facts that ride on the runtime survive it, which is why they are
    // there: this is the moment *where did my data go* gets asked.
    expect(block('Le magasin')).toHaveTextContent('/data/suivi-bourse.duckdb')
    expect(screen.queryByRole('heading', { name: 'Réglages' })).not.toBeInTheDocument()
  })
})

describe('the tab in English', () => {
  it('renders the two blocks whole', async () => {
    const { user } = renderApp({ url: '/donnees', browserLanguages: ['en-GB'] })
    await user.click(await screen.findByRole('tab', { name: /The installation/ }))

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'The store' })).toBeInTheDocument()
    expect(screen.getByText('What the container imposes')).toBeInTheDocument()
  })
})
