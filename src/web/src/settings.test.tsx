/**
 * The settings **page** (#724, #794, #830, ADR-0014, ADR-0015, ADR-0020,
 * ADR-0021, ADR-0038), at the one seam: the whole app in jsdom, HTTP the only
 * faked edge.
 *
 * It was the third tab of the data page, and this file was `installation.test.tsx`
 * until ADR-0038 gave the surface an address of its own and took the tab bar
 * with it. What it holds is what that record enumerates: the dials — *stale-price
 * horizon included* — the workloads, the orphans, the store and what the
 * container imposes.
 *
 * Every case below names what it prevents, and three of them are measurements
 * or corrections rather than opinions:
 *
 *  - **79 % of a store's rows purged for zero bytes** — 126,0 Mo before, 126,0
 *    Mo after, the same content rebuilt from scratch fitting in 26,0. That is
 *    why a size and a purge button cannot be shown without the sentence between
 *    them;
 *  - **a greyed-out form that refused** — the environment card is a description,
 *    and the test of that is mechanical: nothing in it is an `input`;
 *  - **a page whose `<h1>` and first `<h2>` read the same word** — *Réglages*
 *    over *Réglages* — which is what the block being lifted out of the tab and
 *    cut into cards repairs.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import type { HealthState, InstallationFact, StoreState } from '@/lib/api'
import {
  aConfig,
  anEnvironmentFact,
  aFrozenScrape,
  aHealth,
  aHealthJobs,
  aRuntime,
  aStore,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

async function openSettings(
  facts?: InstallationFact[],
  store?: StoreState,
  health?: HealthState,
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
  // **The address, and no gesture**: the surface is a page since ADR-0038, so
  // there is no tab to click and nothing between the URL and what it renders.
  return renderApp({ url: '/settings' })
}

function block(name: RegExp | string) {
  return screen.getByRole('region', { name })
}

describe('the page, and the cards it is made of', () => {
  it('is a page: one h1, and no tab anywhere', async () => {
    await openSettings()

    // ADR-0038's whole subject: an address rather than a hash on a bar.
    expect(await screen.findByRole('heading', { level: 1, name: 'Réglages' })).toBeInTheDocument()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('names each card for what it holds, in the order the mock-up reads them', async () => {
    await openSettings(undefined, aStore({ orphans: [{ symbol: 'ZZX', points: 1204 }] }))

    // The defect this ticket repairs is in the first entry: the page's `<h1>`
    // read *Réglages* and so did the `<h2>` under it, which names the page
    // rather than the card.
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((one) => one.textContent)).toEqual([
        'Ce que vous pouvez changer',
        'Les plans de charge',
        'Les titres orphelins',
        'Le magasin',
        'Ce que le conteneur impose',
      ]),
    )
  })

  it('says nothing about the notices, which live behind the bell', async () => {
    await openSettings([anEnvironmentFact()])
    await screen.findByRole('heading', { name: 'Ce que vous pouvez changer' })

    // A notice is prose — a date, an acknowledgement, a link to the events
    // concerned — and a card in a column beside the store has nowhere to say
    // it (ADR-0030, then ADR-0037, which gave it the panel).
    expect(screen.queryByRole('heading', { name: 'Faits d’installation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Acquitter' })).not.toBeInTheDocument()
  })
})


describe('the settings, which are one surface', () => {
  it('has two cards and no separate effective-configuration card', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Ce que vous pouvez changer' })

    expect(block('Ce que vous pouvez changer')).toBeInTheDocument()
    expect(block('Ce que le conteneur impose')).toBeInTheDocument()
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
                required: false,
                stored: false,
              },
            ],
          }),
        ),
      ),
    )
    await openSettings()
    await screen.findByRole('heading', { name: 'Ce que vous pouvez changer' })

    const field = screen.getByLabelText('a_dial_from_the_future')
    expect(field).toHaveAttribute('min', '1')
    expect(field).toHaveAttribute('max', '9')
    expect(screen.getByText('Something a later version added.')).toBeInTheDocument()
  })

  it('carries the five dials and the currency, the mock-up having dropped three', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Ce que vous pouvez changer' })

    // The list is the registry's and the words are the catalogue's, so this is
    // an assertion about *the tab*, not about a hard-written form: the redesign
    // kept two of the six and this is what says the other four came back
    // (#787, #794).
    const settings = block('Ce que vous pouvez changer')
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
  })

  it('keeps the stale-price horizon settable, and says what zero does', async () => {
    const { user } = await openSettings()
    await screen.findByRole('heading', { name: 'Ce que vous pouvez changer' })

    // The dial the redesign dropped and #787 brought back. *Present* is not
    // enough: it has to be **settable**, and the one value with a meaning of
    // its own has to say what it means — `0` disables the sonde altogether,
    // which is the registry's own reading (`settings_registry.py`).
    expect(
      screen.getByText(/0 pour ne jamais signaler/),
    ).toBeInTheDocument()

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

  it('quantifies what a cadence change reaches, and names the retroactive trap', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Ce que vous pouvez changer' })

    // Two markets open, one shut: a portfolio-wide dial that reaches part of
    // the portfolio has to say so, or the other symbols read as misconfigured.
    expect(
      screen.getByText(/S’applique maintenant à 2 titres, et à 1 autre à l’ouverture de son marché/),
    ).toBeInTheDocument()
    // No interface can hide it: the number in the form is the number in the
    // back-off's own formula.
    expect(screen.getByText(/s’applique aussi aux titres déjà en échec/)).toBeInTheDocument()
  })

  it('writes only what moved, and reports what the write reached', async () => {
    const { user } = await openSettings()
    await screen.findByRole('heading', { name: 'Ce que vous pouvez changer' })

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

    await user.clear(screen.getByLabelText('Cadence de relevé'))
    await user.type(screen.getByLabelText('Cadence de relevé'), '300')
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))

    // `reschedule_job` recomputes the next run from *now*, so a save button that
    // posted every field would reset every timer on every click, invisibly.
    await waitFor(() => expect(sent).toEqual({ regular_interval: '300' }))
    // The receipt says what **happened**, in its own words: repeating the
    // forecast verbatim would put two announcers on one fact, one of them in
    // the past tense and one of them not.
    const receipt = await screen.findByRole('status')
    expect(receipt).toHaveTextContent('1 réglage enregistré')
    expect(receipt).toHaveTextContent(/2 titres réarmés/)
    expect(receipt).toHaveTextContent(/1 autre à l’ouverture de son marché/)
  })

  it('renders the container card as a description and never as fields', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Ce que le conteneur impose' })

    // Greyed-out fields invite the click and read as a form that refused.
    const imposed = block('Ce que le conteneur impose')
    expect(within(imposed).queryAllByRole('textbox')).toHaveLength(0)
    expect(imposed.querySelectorAll('input, select, textarea, button')).toHaveLength(0)
    // The list is the API's and never a hard-written one, which is what makes
    // this an assertion about *the page*: three names — the two the exporter
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
    await openSettings()
    await screen.findByRole('heading', { name: 'Le magasin' })

    const store = block('Le magasin')
    expect(store).toHaveTextContent('/data/suivi-bourse.duckdb')
    expect(store).toHaveTextContent(/sur un volume qui survit au conteneur/)
    // French units, from `Intl` — the header of this very file writes them.
    expect(store).toHaveTextContent(/26,0\s*Mo/)
    // The last **write of the ledger**, never the last observed price — that
    // second one is liveness, which the bell answers (#829, ADR-0037).
    expect(store).toHaveTextContent('Dernière écriture du grand livre')
    expect(store).toHaveTextContent(/10 févr\. 2026/)
  })

  it('never shows a size without saying what a purge does not do', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Le magasin' })

    // Measured: 79 % of the rows purged for zero bytes returned. Shown bare
    // beside a purge button, the figure is a lie by juxtaposition.
    expect(
      within(block('Le magasin')).getByText(/libère des lignes, pas des octets/),
    ).toBeInTheDocument()
  })

  it('lets an ephemeral store dominate the block instead of noting it', async () => {
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(aRuntime({ store: { persistence: 'ephemeral', path: '/data/x.duckdb' } })),
      ),
    )
    await openSettings()
    await screen.findByRole('heading', { name: 'Le magasin' })

    // The only screen where a trial run learns that it is a trial run.
    expect(screen.getByText('Ce conteneur ne garde rien')).toBeInTheDocument()
    // And never a notification: its predicate is not acknowledgeable, so
    // acknowledging it would make it go quiet while it was still true — and a
    // badge that never decrements is the noise ADR-0021 wrote its rule against.
    // The panel is where every open entry is counted since #829, so this is
    // asked of the badge itself.
    expect(screen.getByRole('button', { name: /^Notifications/ })).not.toHaveAccessibleName(
      /conteneur/i,
    )
  })

  it('says nothing about persistence it cannot observe', async () => {
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(aRuntime({ store: { persistence: 'unknown', path: '/data/x.duckdb' } })),
      ),
    )
    await openSettings()
    await screen.findByRole('heading', { name: 'Le magasin' })

    // The observation is a property of the kernel: off Linux there is nothing
    // to report, and a reader must not be told either of the other two answers.
    expect(block('Le magasin')).toHaveTextContent(/ne peut pas dire si ce chemin survit/)
    expect(screen.queryByText('Ce conteneur ne garde rien')).not.toBeInTheDocument()
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
    await openSettings()
    await screen.findByRole('heading', { name: 'Le magasin' })

    const store = block('Le magasin')
    expect(store).toHaveTextContent('Où il se trouve')
    expect(within(store).getByText('—')).toBeInTheDocument()
  })

  it('says nothing about the ledger while its own read is in flight', async () => {
    // ADR-0026, #777: *« Rien n’a encore été importé »* is a statement about the
    // reader's own data, and a hanging read has told the app nothing.
    server.use(http.get(ROUTES.store, () => new Promise<never>(() => {})))
    await openSettings()
    await screen.findByRole('heading', { name: 'Le magasin' })

    const store = block('Le magasin')
    // The two facts that ride on `/api/runtime` are why the block does not wait
    // as a whole (#668, #724): they are on screen in flight as in failure.
    expect(store).toHaveTextContent('/data/suivi-bourse.duckdb')
    expect(store).toHaveTextContent(/sur un volume qui survit au conteneur/)
    // What the store itself was to say does not exist yet — the block's own
    // rule applied one notch lower, never a dash and never a sentence.
    expect(store).not.toHaveTextContent('Rien n’a encore été importé')
    expect(store).not.toHaveTextContent('Dernière écriture du grand livre')
    expect(store).not.toHaveTextContent('Taille sur le disque')
  })
})

describe('the orphaned securities', () => {
  it('does not exist at zero', async () => {
    await openSettings()
    await screen.findByRole('heading', { name: 'Le magasin' })

    // It is not a maintenance table: it is the visible consequence of a
    // deletion the reader has just made.
    expect(screen.queryByRole('heading', { name: 'Les titres orphelins' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Purger ces historiques' })).not.toBeInTheDocument()
  })

  it('says the count, names each one with the series it holds, and purges them at once', async () => {
    const { user } = await openSettings(
      undefined,
      aStore({ orphans: [{ symbol: 'ZZX', points: 1204 }] }),
    )
    const orphans = await screen.findByRole('region', { name: 'Les titres orphelins' })

    // The count **said**, rather than left to be inferred from the rows.
    expect(orphans).toHaveTextContent('1 titre que plus rien ne déclare')
    expect(orphans).toHaveTextContent('ZZX')
    expect(orphans).toHaveTextContent('1 204 cours')
    // A sold position is not one of them — its events are still recorded.
    expect(orphans).toHaveTextContent(/Les positions que vous avez soldées ne sont pas concernées/)

    server.use(http.get(ROUTES.store, () => HttpResponse.json(aStore())))
    await user.click(within(orphans).getByRole('button', { name: 'Purger ces historiques' }))

    // The card is the consequence of the gesture, so the gesture takes it away.
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Les titres orphelins' }),
      ).not.toBeInTheDocument(),
    )
  })
})

describe('the workloads, which the bell’s health card develops', () => {
  it('is where the bell’s health card lands, from any page', async () => {
    // ADR-0038: *the status dot's destination changes name, not nature* — and
    // what it leads to has to be the development of what it says, or the link
    // is a link to a repetition. Walked from the dashboard, through the panel,
    // to the card's own control.
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    const { user } = renderApp({ url: '/' })

    await user.click(await screen.findByRole('button', { name: /^Notifications/ }))
    const panel = await screen.findByRole('dialog', { name: 'Notifications' })
    await user.click(within(panel).getByRole('link', { name: 'Voir dans Réglages' }))

    await screen.findByRole('heading', { level: 1, name: 'Réglages' })
    const jobs = await screen.findByRole('region', { name: 'Les plans de charge' })
    expect(jobs).toHaveTextContent(/Cours figés alors que leur marché bouge/)
  })

  it('names the three the body carries, and never a fourth', async () => {
    await openSettings()
    const jobs = await screen.findByRole('region', { name: 'Les plans de charge' })

    // Three and not four: **ingestion is not a job** — it is the boot or a
    // write — so `/health` publishes no last pass for it and this page invents
    // none, the mock-up's four rows notwithstanding.
    expect(within(jobs).getByText('Relevé des cours')).toBeInTheDocument()
    expect(within(jobs).getByText('Reconstruction de l’historique')).toBeInTheDocument()
    expect(within(jobs).getByText('Calcul de la performance')).toBeInTheDocument()
    expect(within(jobs).queryByText(/Écriture du grand livre/)).not.toBeInTheDocument()
    expect(jobs).toHaveTextContent('Tout fonctionne normalement.')
  })

  it('renders a verdict as a sentence, and names the securities it is about', async () => {
    // A writer frozen since Tuesday: the scheduler runs, the store answers, the
    // code is `200` — and this is the surface that says *what* is wrong.
    await openSettings(undefined, undefined, aFrozenScrape())
    const jobs = await screen.findByRole('region', { name: 'Les plans de charge' })

    expect(jobs).toHaveTextContent('Quelque chose demande votre attention.')
    expect(jobs).toHaveTextContent(/Cours figés alors que leur marché bouge/)
    // The server's own word is never rendered raw, and the count alone would
    // leave the one thing the reader cannot look up: which line to go and read.
    expect(jobs).not.toHaveTextContent('frozen')
  })

  it('says a stopped scheduler above the three jobs it would explain', async () => {
    await openSettings(
      undefined,
      undefined,
      aHealth({ status: 'attention', scheduler_running: false }),
    )
    const jobs = await screen.findByRole('region', { name: 'Les plans de charge' })

    // The cause, not a fourth row: it is *why* three jobs with a healthy last
    // pass will never run again.
    expect(jobs).toHaveTextContent(/Le planificateur est arrêté/)
  })

  it('names a pass this process has never seen instead of dashing it', async () => {
    await openSettings(
      undefined,
      undefined,
      aHealth({
        status: 'unknown',
        jobs: aHealthJobs({
          performance: { status: 'unknown', at: null, verdict: 'unknown', error: null },
        }),
      }),
    )
    const jobs = await screen.findByRole('region', { name: 'Les plans de charge' })

    // An em dash is *there is nothing to compute* (ADR-0021), and a container a
    // minute old has plenty to compute and has simply not got there yet.
    expect(jobs).toHaveTextContent('Pas encore passé')
  })

  it('does not exist while the health read is in flight', async () => {
    server.use(http.get(ROUTES.health, () => new Promise<never>(() => {})))
    await openSettings()
    await screen.findByRole('heading', { name: 'Le magasin' })

    // *Everything is running* is a claim about an installation nobody has
    // observed yet (ADR-0026), title included.
    expect(screen.queryByRole('heading', { name: 'Les plans de charge' })).not.toBeInTheDocument()
  })

  it('says why it could not be read where the bell’s link lands', async () => {
    // **The state the bell is loudest in**, and it was the one this page said
    // nothing about: `/health` refuses, `installationState` reads `unreachable`
    // off the failed request, and the panel pins *Le magasin ne répond pas*
    // whose one offer is a link here. A card that vanished on it — a refusal
    // read as a read in flight — would answer *Voir dans Réglages* with a page
    // that does not mention the workloads at all. Walked the way a reader walks
    // it, from the dashboard.
    server.use(
      problemHandler(ROUTES.health, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    const { user } = renderApp({ url: '/' })

    await user.click(await screen.findByRole('button', { name: /^Notifications/ }))
    const panel = await screen.findByRole('dialog', { name: 'Notifications' })
    await user.click(within(panel).getByRole('link', { name: 'Voir dans Réglages' }))

    await screen.findByRole('heading', { level: 1, name: 'Réglages' })
    const jobs = await screen.findByRole('region', { name: 'Les plans de charge' })
    // The card the link named, keeping its name and carrying the reason its
    // three rows are not there — the same rule the dials and the store follow
    // (#829, ADR-0037), one block further along.
    expect(within(jobs).getByText('Lecture impossible')).toBeInTheDocument()
    expect(jobs).toHaveTextContent(/son magasin ne répond pas/)
    // An empty state and never an alert: there is no band anywhere, and what
    // announces the installation is the bell, once.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says the same thing when the answer is a 200 that is not a health payload', async () => {
    // **The other half of `unreachable`, and the one that used to take the
    // route down with it.** `installationState` folds two answers onto that
    // word: a refused request, and a `200` whose body is not this object —
    // a proxy answering with its own JSON, a stale image, the SPA catch-all
    // (ADR-0036, #819). The bell shouts identically in both and lands here in
    // both. Before #830's repair this page read `health.error` alone, so the
    // second answer reached the table, which tabulates three workloads out of
    // `jobs` — and threw on the first row, with no error boundary under it.
    server.use(http.get(ROUTES.health, () => HttpResponse.json({ status: 'ok' })))
    const { user } = renderApp({ url: '/' })

    await user.click(await screen.findByRole('button', { name: /^Notifications/ }))
    const panel = await screen.findByRole('dialog', { name: 'Notifications' })
    await user.click(within(panel).getByRole('link', { name: 'Voir dans Réglages' }))

    // The route renders at all, which is the half that was broken.
    await screen.findByRole('heading', { level: 1, name: 'Réglages' })
    const jobs = await screen.findByRole('region', { name: 'Les plans de charge' })
    expect(within(jobs).getByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('the page’s own reads', () => {
  it('names an unreadable store instead of rendering an empty page', async () => {
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
    renderApp({ url: '/settings' })

    // **Each block says why it is empty, and there is no band** (#829,
    // ADR-0037): the space the dials would have filled carries the reason they
    // are not there, and the store card carries the reason its two figures are
    // not.
    await screen.findAllByText('Lecture impossible')
    expect(screen.getAllByText('Lecture impossible')).toHaveLength(2)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    // The two facts that ride on the runtime survive it, which is why they are
    // there: this is the moment *where did my data go* gets asked.
    expect(block('Le magasin')).toHaveTextContent('/data/suivi-bourse.duckdb')
    expect(block('Le magasin')).toHaveTextContent(/son magasin ne répond pas/)
    // Both halves of the settings read go together: a description of a
    // configuration nobody could read is a description of nothing.
    expect(
      screen.queryByRole('heading', { name: 'Ce que vous pouvez changer' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Ce que le conteneur impose' }),
    ).not.toBeInTheDocument()
  })
})

describe('the page in English', () => {
  it('renders the cards whole', async () => {
    renderApp({ url: '/settings', browserLanguages: ['en-GB'] })

    expect(
      await screen.findByRole('heading', { name: 'What you can change' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'The workloads' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'The store' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'What the container imposes' })).toBeInTheDocument()
    // The catalogue is the source in English, so this is where a key that
    // landed in one file and not the other is caught (ADR-0024).
    expect(screen.getByText('Last write to your ledger')).toBeInTheDocument()
  })
})
