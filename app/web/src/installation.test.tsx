/**
 * The installation tab (#724, ADR-0014, ADR-0015, ADR-0020, ADR-0021), at the
 * one seam: the whole app in jsdom, HTTP the only faked edge.
 *
 * Every case below names what it prevents, and three of them are measurements
 * rather than opinions:
 *
 *  - **79 % of a store's rows purged for zero bytes** — 126,0 Mo before, 126,0
 *    Mo after, the same content rebuilt from scratch fitting in 26,0. That is
 *    why a size and a purge button cannot be shown without the sentence between
 *    them;
 *  - **a badge that promises something and leaves the reader hunting** — the
 *    three things it must not count are the ephemeral store, the orphans and
 *    the reconstruction, and each for its own reason;
 *  - **a greyed-out form that refused** — the environment half is a description,
 *    and the test of that is mechanical: nothing in it is an `input`.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import type { Advisory, StoreState } from '@/lib/api'
import {
  aConfig,
  aLegacyFileAdvisory,
  anAdvisory,
  aRuntime,
  aStore,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

async function openInstallation(advisories?: Advisory[], store?: StoreState) {
  if (advisories) {
    server.use(http.get(ROUTES.advisories, () => HttpResponse.json(advisories)))
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

describe('the three blocks, in one order', () => {
  it('reads Avis · Réglages · Le magasin, and an empty block does not exist', async () => {
    await openInstallation()

    const headings = await screen.findAllByRole('heading', { level: 2 })
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'Avis',
      'Réglages',
      'Le magasin',
    ])
  })

  it('drops the notices block entirely when nothing is standing', async () => {
    await openInstallation([])

    // The layout shifts when a notice appears, and that is the point: a badge
    // that promised something and left the reader hunting for it is the failure.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Réglages' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('heading', { name: 'Avis' })).not.toBeInTheDocument()
  })
})

describe('the badge on the tab', () => {
  it('counts unacknowledged notices and nothing else', async () => {
    server.use(
      http.get(ROUTES.advisories, () =>
        HttpResponse.json([
          anAdvisory(),
          aLegacyFileAdvisory(),
          // Acknowledged: gone from the block, so gone from the count.
          aLegacyFileAdvisory({
            key: 'legacy_settings_file',
            acknowledged: true,
            acknowledged_at: '2026-02-01T00:00:00.000Z',
          }),
          // The reconstruction has exactly **one** announcer, and it is the
          // banner. Counted here it would be a second one; shown in the block
          // and not counted, the badge would under-count what is on screen.
          anAdvisory({ key: 'reconstruction_running', message: 'Rebuild in progress' }),
        ]),
      ),
      // Neither of these is a notice: the ephemeral store's predicate is never
      // acknowledgeable, and an orphan is a choice rather than a waste.
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(aRuntime({ store: { persistence: 'ephemeral', path: '/data/x.duckdb' } })),
      ),
      http.get(ROUTES.store, () =>
        HttpResponse.json(aStore({ orphans: [{ symbol: 'ZZX', points: 1204 }] })),
      ),
    )
    renderApp({ url: '/donnees' })

    const tab = await screen.findByRole('tab', { name: /L’installation/ })
    expect(await within(tab).findByLabelText('2 avis à lire')).toBeInTheDocument()
  })

  it('is absent when there is nothing to read', async () => {
    server.use(http.get(ROUTES.advisories, () => HttpResponse.json([])))
    renderApp({ url: '/donnees' })

    const tab = await screen.findByRole('tab', { name: /L’installation/ })
    await waitFor(() => expect(tab).toHaveTextContent('L’installation'))
    expect(within(tab).queryByLabelText(/avis à lire/)).not.toBeInTheDocument()
  })
})

describe('the notices', () => {
  it('offers no « acknowledge all », whatever the count', async () => {
    await openInstallation([anAdvisory(), aLegacyFileAdvisory()])

    await screen.findByRole('heading', { name: 'Avis' })
    // Five at the very most, and a bulk acknowledgement is exactly how the one
    // notice the app cannot recompute gets swept away unread.
    expect(within(block('Avis')).getAllByRole('button', { name: 'Acquitter' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /tout acquitter/i })).not.toBeInTheDocument()
  })

  it('makes an acknowledged notice disappear rather than grey it out', async () => {
    const { user } = await openInstallation([aLegacyFileAdvisory()])

    await screen.findByRole('heading', { name: 'Avis' })
    server.use(
      http.get(ROUTES.advisories, () =>
        HttpResponse.json([
          aLegacyFileAdvisory({ acknowledged: true, acknowledged_at: '2026-03-02T12:00:00.000Z' }),
        ]),
      ),
    )

    await user.click(screen.getByRole('button', { name: 'Acquitter' }))

    // Kept greyed out, the notice of somebody who decided to keep their
    // `config.yaml` for ever would be a permanent fixture of their screen.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Avis' })).not.toBeInTheDocument(),
    )
  })

  it('re-arms when its predicate becomes true again', async () => {
    const { user } = await openInstallation([aLegacyFileAdvisory()])
    await screen.findByRole('heading', { name: 'Avis' })

    server.use(
      http.get(ROUTES.advisories, () =>
        HttpResponse.json([aLegacyFileAdvisory({ acknowledged: true })]),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Acquitter' }))
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Avis' })).not.toBeInTheDocument(),
    )

    // The file comes back. The server drops the row and arms a fresh one, and
    // the block shows it again — an acknowledgement of a fact that stopped
    // being true must not make its next occurrence invisible.
    server.use(
      http.get(ROUTES.advisories, () =>
        HttpResponse.json([aLegacyFileAdvisory({ first_seen_at: '2026-03-02T11:00:00.000Z' })]),
      ),
    )
    await user.click(screen.getByRole('tab', { name: /Le grand livre/ }))
    await user.click(screen.getByRole('tab', { name: /L’installation/ }))

    expect(await screen.findByRole('heading', { name: 'Avis' })).toBeInTheDocument()
  })

  it('leads to the events a notice names, in the ledger, already reduced', async () => {
    const { user } = await openInstallation([anAdvisory()])
    await screen.findByRole('heading', { name: 'Avis' })

    await user.click(screen.getByRole('button', { name: 'Voir les événements concernés' }))

    // **Every security the sentence enumerated, not the first of them.** The
    // notice named ZZA, ZZB and ZZC; a gesture keeping one would land the reader
    // on a ledger stating a repair perimeter smaller than the one they have just
    // read, with nothing on screen saying the other two were dropped.
    const rows = await screen.findAllByRole('row')
    const cells = rows.map((row) => row.textContent ?? '')
    expect(cells.filter((text) => text.includes('ZZA'))).toHaveLength(2)
    expect(cells.filter((text) => text.includes('ZZC'))).toHaveLength(1)
    // And the reduction is *stated*, with all three names, and can be undone —
    // a ledger silently shorter than the reader expects is the same defect one
    // step further on.
    expect(screen.getByText(/Réduit à 3 titres : ZZA, ZZB, ZZC/)).toBeInTheDocument()

    // The cash movement names no security, so a reduction to securities drops
    // it; clearing brings it back, which is what makes the reduction reversible
    // rather than a shorter ledger.
    expect(cells.some((text) => text.includes('Virement entrant'))).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Afficher de nouveau tous les titres' }))
    expect(await screen.findByText(/Virement entrant/)).toBeInTheDocument()
  })


  it('gives a notice about a file on disk no button it cannot honour', async () => {
    await openInstallation([aLegacyFileAdvisory()])
    await screen.findByRole('heading', { name: 'Avis' })

    // A file on disk is outside the app's reach, and the sentence — which names
    // this installation's own path — says what to do out there.
    const notices = block('Avis')
    expect(within(notices).queryByRole('button', { name: /Voir les événements/ })).not.toBeInTheDocument()
    expect(notices).toHaveTextContent('/config/config.yaml')
  })
})

/**
 * The notices are read in the reader's language (#768, ADR-0024).
 *
 * `AdvisoriesBlock` rendered `advisory.message` verbatim, and those sentences
 * are built in English by `advisories.py` — so the **whole content** of the
 * block was English on a French installation, framed by a title, a date and a
 * button that were not. The tests below are at the same seam as the rest of the
 * file: the whole app in jsdom, HTTP the only faked edge, and the language taken
 * from the browser because it defaults to `auto`.
 */
describe('the language of a notice', () => {
  async function openNotices(advisories: Advisory[], browserLanguages: readonly string[]) {
    server.use(http.get(ROUTES.advisories, () => HttpResponse.json(advisories)))
    const rendered = renderApp({ url: '/donnees', browserLanguages })
    const tab = browserLanguages[0].startsWith('fr') ? /L’installation/ : /The installation/
    await rendered.user.click(await screen.findByRole('tab', { name: tab }))
    return rendered
  }

  it('reads French for a French reader, and never the server’s English', async () => {
    await openNotices([aLegacyFileAdvisory(), anAdvisory()], ['fr-FR'])

    const notices = block('Avis')
    // The path is the server's — it names *this* installation — and everything
    // around it is the catalogue's.
    expect(notices).toHaveTextContent(
      /\/config\/config\.yaml est toujours là et cette version ne le lit pas/,
    )
    expect(notices).toHaveTextContent(/Vos montants ont été lus en EUR/)
    // Plurals through ICU, and an enumeration the language closes on *et* —
    // never `4 event(s)` and never `ZZA, ZZB, ZZC`.
    expect(notices).toHaveTextContent(/4 événements sur 3 lignes cotées en GBP et USD \(ZZA, ZZB et ZZC\)/)
    expect(notices).not.toHaveTextContent('event(s)')
    expect(notices).not.toHaveTextContent('Your amounts were read as EUR')
  })

  it('reads English for an English reader, plurals and list included', async () => {
    await openNotices([aLegacyFileAdvisory(), anAdvisory()], ['en-GB'])

    const notices = screen.getByRole('region', { name: 'Notices' })
    expect(notices).toHaveTextContent(
      /\/config\/config\.yaml is still there and this version does not read it/,
    )
    expect(notices).toHaveTextContent(/4 events on 3 lines quoted in GBP and USD \(ZZA, ZZB and ZZC\)/)
    // The English catalogue is the source, not a copy of the payload: the `(s)`
    // and the `', '.join(...)` are the log line's, and they stay there.
    expect(notices).not.toHaveTextContent('event(s)')
    expect(notices).not.toHaveTextContent('line(s)')
  })

  it('says the four the block owns, and each of them in French', async () => {
    // Not only the one that is easy to provoke. The fifth key,
    // `reconstruction_running`, has exactly one announcer and it is the banner
    // (#724) — its sentence is in the same catalogue and composed by the same
    // function, pinned in `lib/advisories.test.ts` in both languages.
    await openNotices(
      [
        aLegacyFileAdvisory(),
        aLegacyFileAdvisory({
          key: 'legacy_settings_file',
          detail: { path: '/config/settings.yaml' },
        }),
        anAdvisory({
          key: 'unread_environment',
          detail: { variables: ['SB_PERF_INTERVAL', 'INFLUXDB_TOKEN'] },
        }),
        anAdvisory(),
      ],
      ['fr-FR'],
    )

    const notices = block('Avis')
    expect(notices).toHaveTextContent(/un grand livre d’événements datés/)
    expect(notices).toHaveTextContent(/les comptes se déclarent par un fichier/)
    expect(notices).toHaveTextContent(
      /2 variables d’environnement sont définies et ne sont lues par rien : SB_PERF_INTERVAL et INFLUXDB_TOKEN/,
    )
    expect(notices).toHaveTextContent(/Vos montants ont été lus en EUR/)
  })

  it('says what the notice *is* when this process observed nothing', async () => {
    // `detail: null` is #709's third answer — a runtime that cannot see the
    // source — and the server does the same thing one level up, falling back to
    // `AdvisorySpec.doc`. A paragraph with `undefined` where a path belongs
    // would be the alternative.
    await openNotices([aLegacyFileAdvisory({ detail: null })], ['fr-FR'])

    const notices = block('Avis')
    expect(notices).toHaveTextContent(
      'Un config.yaml de la v4 se trouve dans le dossier de configuration et n’est pas lu.',
    )
    expect(notices).not.toHaveTextContent('undefined')
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
    expect(within(imposed).getByText('SB_STORE_DIR')).toBeInTheDocument()
    // Written once for the section, never under each of six rows.
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
    expect(store).toHaveTextContent('26,0 MB')
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
    // it would make it go quiet while it was still true.
    expect(screen.queryByRole('heading', { name: 'Avis' })?.parentElement).not.toHaveTextContent(
      'Ce conteneur ne garde rien',
    )
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
  it('renders the three blocks whole', async () => {
    const { user } = renderApp({ url: '/donnees', browserLanguages: ['en-GB'] })
    await user.click(await screen.findByRole('tab', { name: /The installation/ }))

    expect(await screen.findByRole('heading', { name: 'Notices' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'The store' })).toBeInTheDocument()
    expect(screen.getByText('What the container imposes')).toBeInTheDocument()
  })
})
