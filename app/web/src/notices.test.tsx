/**
 * The notices tab (#724, #768, #794, #821, ADR-0021, ADR-0036), at the one
 * seam: the whole app in jsdom, HTTP the only faked edge.
 *
 * It **was** the one place in the product where a block with nothing in it
 * existed, and the reason was the status dot: a destination that came and went
 * with the dot's colour would give one control two addresses, so the tab
 * answered *nothing to report*. The dot does not ask that question — it leads
 * to the installation tab, where one repairs — so the block is ordinary again
 * and the first cases below say the ordinary thing: nothing to say, nothing on
 * screen, the last acknowledgement included.
 *
 * What is **not** withdrawn is ADR-0026: a notice is a claim about this
 * installation, and none is made while the read is in flight. That pairs with
 * the badge, whose three exclusions each have their own reason — the ephemeral
 * store, the orphans and the reconstruction.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES, type InstallationFact } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { anEnvironmentFact, anInstallationFact, aRuntime, aStore } from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

async function openNotices(facts?: InstallationFact[]) {
  if (facts) {
    server.use(http.get(ROUTES.installationFacts, () => HttpResponse.json(facts)))
  }
  const rendered = renderApp({ url: '/donnees' })
  await rendered.user.click(await screen.findByRole('tab', { name: /Les notices/ }))
  return rendered
}

function block(name: RegExp | string) {
  return screen.getByRole('region', { name })
}

/** What the selected tab currently says, in one string. */
function panelSays() {
  return screen.getByRole('tabpanel').textContent
}

describe('the block does not exist when it is empty', () => {
  it('says nothing at all when the installation has nothing to say', async () => {
    // The wire is what is waited on, and it has to be: a tab whose read has not
    // landed and a tab whose read came back empty are the **same screen** now,
    // which is the member ADR-0026 holds on the source rather than through the
    // net. Waiting for a rendering that never comes would assert nothing.
    let landed = 0
    server.use(
      http.get(ROUTES.installationFacts, () => {
        landed += 1
        return HttpResponse.json([])
      }),
    )
    await openNotices()
    await waitFor(() => expect(landed).toBeGreaterThan(0))

    // *Rien à signaler* is gone with the exception that carried it: the dot
    // leads to the installation tab and never asked this tab's question, so a
    // permanent empty state answered nobody.
    expect(screen.queryByText('Rien à signaler')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Faits d’installation' })).not.toBeInTheDocument()
    // The tab itself is not the block: it stays where the reader put themselves.
    expect(screen.getByRole('tab', { name: /Les notices/ })).toHaveAttribute('aria-selected', 'true')
    expect(panelSays()).toBe('')
  })

  it('renders nothing while the read is in flight, title included', async () => {
    // ADR-0026 is not what is withdrawn. The default install has a notice
    // standing, so this screen is silent because the read is hanging and not
    // because there is nothing — and neither the title nor a frame around an
    // empty list is written before the answer arrives.
    server.use(http.get(ROUTES.installationFacts, () => new Promise<never>(() => {})))
    await openNotices()

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Les notices/ })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    )
    expect(screen.queryByRole('heading', { name: 'Faits d’installation' })).not.toBeInTheDocument()
    expect(panelSays()).toBe('')
  })

  it('names an unreadable store instead of an ordinary silence', async () => {
    // The notices live in the store, so *this installation has nothing to tell
    // you* and *the store cannot be read* must never be the same screen — and a
    // silence is what the first of them now looks like. One band or none.
    server.use(
      problemHandler(ROUTES.installationFacts, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    await openNotices()

    expect(await screen.findByRole('status')).toHaveTextContent(/magasin/i)
    expect(screen.queryByRole('region', { name: 'Faits d’installation' })).not.toBeInTheDocument()
  })

  it('takes the surface away when the last fact is acknowledged', async () => {
    const { user } = await openNotices([anEnvironmentFact()])
    await screen.findByRole('heading', { name: 'Faits d’installation' })

    server.use(
      http.get(ROUTES.installationFacts, () =>
        HttpResponse.json([
          anEnvironmentFact({ acknowledged: true, acknowledged_at: '2026-03-02T12:00:00.000Z' }),
        ]),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Acquitter' }))

    // This was the exception's own second argument — the surface vanishing
    // under the reader at the exact moment they finished with it — and it is
    // the intended behaviour now: the block goes, the tab stays, and the reader
    // is left on a tab with nothing on it because there is nothing.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Faits d’installation' })).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('tab', { name: /Les notices/ })).toHaveAttribute('aria-selected', 'true')
    expect(panelSays()).toBe('')
  })
})

describe('the badge on the tab', () => {
  it('counts unacknowledged notices and nothing else', async () => {
    server.use(
      http.get(ROUTES.installationFacts, () =>
        HttpResponse.json([
          anInstallationFact(),
          anEnvironmentFact(),
          // Acknowledged: gone from the block, so gone from the count.
          anEnvironmentFact({
            acknowledged: true,
            acknowledged_at: '2026-02-01T00:00:00.000Z',
          }),
          // The reconstruction has exactly **one** announcer, and it is the
          // block the dot leads to. Counted here it would be a second one;
          // shown in the block and not counted, the badge would under-count
          // what is on screen.
          anInstallationFact({ key: 'reconstruction_running', message: 'Rebuild in progress' }),
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

    // On the tab the notices are on, which is what makes a badge a promise
    // rather than a hunt.
    const tab = await screen.findByRole('tab', { name: /Les notices/ })
    expect(await within(tab).findByLabelText('2 notices à lire')).toBeInTheDocument()
  })

  it('is absent when there is nothing to read', async () => {
    server.use(http.get(ROUTES.installationFacts, () => HttpResponse.json([])))
    renderApp({ url: '/donnees' })

    const tab = await screen.findByRole('tab', { name: /Les notices/ })
    await waitFor(() => expect(tab).toHaveTextContent('Les notices'))
    expect(within(tab).queryByLabelText(/notices? à lire/)).not.toBeInTheDocument()
  })
})

describe('the notices', () => {
  it('offers no « acknowledge all », whatever the count', async () => {
    await openNotices([anInstallationFact(), anEnvironmentFact()])

    await screen.findByRole('heading', { name: 'Faits d’installation' })
    // Five at the very most, and a bulk acknowledgement is exactly how the one
    // notice the app cannot recompute gets swept away unread.
    expect(within(block('Faits d’installation')).getAllByRole('button', { name: 'Acquitter' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /tout acquitter/i })).not.toBeInTheDocument()
  })

  it('makes an acknowledged notice disappear rather than grey it out', async () => {
    const { user } = await openNotices([anEnvironmentFact()])

    await screen.findByRole('heading', { name: 'Faits d’installation' })
    server.use(
      http.get(ROUTES.installationFacts, () =>
        HttpResponse.json([
          anEnvironmentFact({ acknowledged: true, acknowledged_at: '2026-03-02T12:00:00.000Z' }),
        ]),
      ),
    )

    await user.click(screen.getByRole('button', { name: 'Acquitter' }))

    // Kept greyed out, the notice of somebody who decided to keep their
    // `config.yaml` for ever would be a permanent fixture of their screen. The
    // *tab* stays — a tab is not a block — and the block shows what is left.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Faits d’installation' })).not.toBeInTheDocument(),
    )
  })

  it('re-arms when its predicate becomes true again', async () => {
    const { user } = await openNotices([anEnvironmentFact()])
    await screen.findByRole('heading', { name: 'Faits d’installation' })

    server.use(
      http.get(ROUTES.installationFacts, () =>
        HttpResponse.json([anEnvironmentFact({ acknowledged: true })]),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Acquitter' }))
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Faits d’installation' })).not.toBeInTheDocument(),
    )

    // The file comes back. The server drops the row and arms a fresh one, and
    // the block shows it again — an acknowledgement of a fact that stopped
    // being true must not make its next occurrence invisible.
    server.use(
      http.get(ROUTES.installationFacts, () =>
        HttpResponse.json([anEnvironmentFact({ first_seen_at: '2026-03-02T11:00:00.000Z' })]),
      ),
    )
    await user.click(screen.getByRole('tab', { name: /Le grand livre/ }))
    await user.click(screen.getByRole('tab', { name: /Les notices/ }))

    expect(await screen.findByRole('heading', { name: 'Faits d’installation' })).toBeInTheDocument()
  })

  it('leads to the events a notice names, in the ledger, already reduced', async () => {
    const { user } = await openNotices([anInstallationFact()])
    await screen.findByRole('heading', { name: 'Faits d’installation' })

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
    // step further on. The names are enumerated in the reader's language (#768),
    // not joined on a comma: this is a sentence, and French closes it on *et*.
    expect(screen.getByText(/Réduit à 3 titres : ZZA, ZZB et ZZC/)).toBeInTheDocument()

    // The cash movement names no security, so a reduction to securities drops
    // it; clearing brings it back, which is what makes the reduction reversible
    // rather than a shorter ledger.
    expect(cells.some((text) => text.includes('Virement entrant'))).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Afficher de nouveau tous les titres' }))
    expect(await screen.findByText(/Virement entrant/)).toBeInTheDocument()
  })


  it('gives a notice about the environment no button it cannot honour', async () => {
    await openNotices([anEnvironmentFact()])
    await screen.findByRole('heading', { name: 'Faits d’installation' })

    // A variable in the container's environment is outside the app's reach, and
    // the sentence — which names this installation's own — says what to do out
    // there.
    const notices = block('Faits d’installation')
    expect(within(notices).queryByRole('button', { name: /Voir les événements/ })).not.toBeInTheDocument()
    expect(notices).toHaveTextContent('SB_EXECUTOR_POOL')
  })
})

/**
 * The notices are read in the reader's language (#768, ADR-0024).
 *
 * `InstallationFactsBlock` rendered `fact.message` verbatim, and those sentences
 * are built in English by `installation_facts.py` — so the **whole content** of the
 * block was English on a French installation, framed by a title, a date and a
 * button that were not. The tests below are at the same seam as the rest of the
 * file: the whole app in jsdom, HTTP the only faked edge, and the language taken
 * from the browser because it defaults to `auto`.
 */
describe('the language of a notice', () => {
  async function inLanguage(facts: InstallationFact[], browserLanguages: readonly string[]) {
    server.use(http.get(ROUTES.installationFacts, () => HttpResponse.json(facts)))
    const rendered = renderApp({ url: '/donnees', browserLanguages })
    const tab = browserLanguages[0].startsWith('fr') ? /Les notices/ : /The notices/
    await rendered.user.click(await screen.findByRole('tab', { name: tab }))
    return rendered
  }

  it('reads French for a French reader, and never the server’s English', async () => {
    await inLanguage([anEnvironmentFact(), anInstallationFact()], ['fr-FR'])

    const notices = block('Faits d’installation')
    // The variable is the server's — it names *this* installation — and
    // everything around it is the catalogue's.
    expect(notices).toHaveTextContent(
      /1 variable d’environnement est définie et n’est lue par rien : SB_EXECUTOR_POOL/,
    )
    expect(notices).toHaveTextContent(/Vos montants ont été lus en EUR/)
    // Plurals through ICU, and an enumeration the language closes on *et* —
    // never `4 event(s)` and never `ZZA, ZZB, ZZC`.
    expect(notices).toHaveTextContent(/4 événements sur 3 lignes cotées en GBP et USD \(ZZA, ZZB et ZZC\)/)
    expect(notices).not.toHaveTextContent('event(s)')
    expect(notices).not.toHaveTextContent('Your amounts were read as EUR')
  })

  it('reads English for an English reader, plurals and list included', async () => {
    await inLanguage([anEnvironmentFact(), anInstallationFact()], ['en-GB'])

    const notices = screen.getByRole('region', { name: 'Installation facts' })
    expect(notices).toHaveTextContent(
      /1 environment variable is set and read by nothing: SB_EXECUTOR_POOL/,
    )
    expect(notices).toHaveTextContent(/4 events on 3 lines quoted in GBP and USD \(ZZA, ZZB and ZZC\)/)
    // The English catalogue is the source, not a copy of the payload: the `(s)`
    // and the `', '.join(...)` are the log line's, and they stay there.
    expect(notices).not.toHaveTextContent('event(s)')
    expect(notices).not.toHaveTextContent('line(s)')
  })

  it('says the two the block owns, and each of them in French', async () => {
    // Not only the one that is easy to provoke. The third key,
    // `reconstruction_running`, has exactly one announcer and it is the banner
    // (#724) — its sentence is in the same catalogue and composed by the same
    // function, pinned in `lib/installationFacts.test.ts` in both languages. It was
    // four until ADR-0032 took the two that watched a folder.
    await inLanguage(
      [
        anEnvironmentFact({
          detail: { variables: ['SB_PERF_INTERVAL', 'INFLUXDB_TOKEN'] },
        }),
        anInstallationFact(),
      ],
      ['fr-FR'],
    )

    const notices = block('Faits d’installation')
    expect(notices).toHaveTextContent(
      /2 variables d’environnement sont définies et ne sont lues par rien : SB_PERF_INTERVAL et INFLUXDB_TOKEN/,
    )
    expect(notices).toHaveTextContent(/Vos montants ont été lus en EUR/)
  })

  it('says what the notice *is* when this process observed nothing', async () => {
    // `detail: null` is #709's third answer — a runtime that cannot see the
    // source — and the server does the same thing one level up, falling back to
    // `FactSpec.doc`. A paragraph with `undefined` where a list belongs
    // would be the alternative.
    await inLanguage([anEnvironmentFact({ detail: null })], ['fr-FR'])

    const notices = block('Faits d’installation')
    expect(notices).toHaveTextContent(
      'Des variables d’environnement sont définies et cette version n’en lit aucune.',
    )
    expect(notices).not.toHaveTextContent('undefined')
  })
})
