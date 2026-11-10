import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { JobInfo } from '@/features/settings/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aJobsHistory,
  aJobTrack,
  aRuntime,
  aStore,
  ledgerEvents,
  NOW,
  someJobs,
  someSlots,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

const UNAVAILABLE = {
  status: 503,
  type: PROBLEM_TYPES.storageUnavailable,
  title: 'storage unavailable',
}

function openSystem() {
  return renderApp({ url: '/system' })
}

async function jobsRegion() {
  return screen.findByRole('region', { name: 'Tâches' })
}

describe('the page', () => {
  it('has a fixed title and three sections', async () => {
    openSystem()

    expect(await screen.findByRole('heading', { level: 1, name: 'Système' })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((one) => one.textContent)).toEqual([
        'Tâches',
        'Données',
        'Installation',
      ]),
    )
  })

  it('names the rebuild band while the history is being rebuilt', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    openSystem()

    const band = await screen.findByRole('status')
    expect(band).toHaveTextContent('Reconstruction en cours')
    expect(within(band).queryByRole('link')).toBeNull()
  })

  it('is where the bell’s footer lands', async () => {
    const { user } = renderApp({ url: '/' })
    await user.click(await screen.findByRole('button', { name: /^Notifications/ }))
    const panel = await screen.findByRole('dialog', { name: 'Notifications' })
    await user.click(within(panel).getByRole('link', { name: 'Système' }))

    expect(await jobsRegion()).toBeInTheDocument()
  })
})

describe('the jobs', () => {
  it('are named by the glossary, each with its state and one « Lancer »', async () => {
    openSystem()
    const jobs = await jobsRegion()

    for (const name of [
      'Mise à jour des cours',
      'Reconstruction de l’historique',
      'Calcul de la performance',
      'Relecture du grand livre',
    ]) {
      const row = await within(jobs).findByRole('group', { name })
      expect(within(row).getByText('À jour')).toBeInTheDocument()
      expect(within(row).getAllByRole('button')).toHaveLength(1)
      expect(within(row).getByRole('button', { name: `Lancer : ${name}` })).toHaveTextContent(
        'Lancer',
      )
    }
  })

  it('say the last pass, the next one or the cadence', async () => {
    const withTimes: JobInfo[] = someJobs().map((job) =>
      job.id === 'scrape'
        ? { ...job, last_run_at: '2026-03-02T11:55:00.000Z', next_run_at: NOW }
        : job.id === 'performance'
          ? { ...job, last_run_at: '2026-03-02T11:56:00.000Z', cadence: { on_write: true } }
          : job,
    )
    server.use(http.get(ROUTES.jobs, () => HttpResponse.json(withTimes)))
    openSystem()
    const jobs = await jobsRegion()

    const scrape = await within(jobs).findByRole('group', { name: 'Mise à jour des cours' })
    expect(scrape).toHaveTextContent(/\d{2}:\d{2} · prochain \d{2}:\d{2}/)
    const performance = within(jobs).getByRole('group', { name: 'Calcul de la performance' })
    expect(performance).toHaveTextContent(/\d{2}:\d{2} · à chaque écriture/)
  })

  it('draw no strip, and no legend, on a fresh install that has run nothing', async () => {
    const blank = () => aJobTrack({ slots: someSlots(), passes: [], last: null })
    server.use(
      http.get(ROUTES.jobsHistory, () =>
        HttpResponse.json(
          aJobsHistory({
            jobs: { backfill: blank(), performance: blank(), ingestion: blank() },
            scrape: { AAPL: blank() },
            scrape_recent: [],
          }),
        ),
      ),
    )
    openSystem()
    const jobs = await jobsRegion()
    await within(jobs).findByRole('group', { name: 'Mise à jour des cours' })

    expect(jobs.querySelectorAll('[data-tone]')).toHaveLength(0)
    expect(within(jobs).queryByText(/Une barre par heure/)).not.toBeInTheDocument()
  })

  it('draw one tick an hour, named by their counts', async () => {
    server.use(
      http.get(ROUTES.jobsHistory, () =>
        HttpResponse.json(
          aJobsHistory({
            jobs: {
              ...aJobsHistory().jobs,
              backfill: aJobTrack({
                slots: someSlots({
                  21: { passes: 2, attentions: 1, duration: 3 },
                  23: { passes: 1, errors: 1, duration: 1 },
                }),
              }),
            },
          }),
        ),
      ),
    )
    openSystem()
    const jobs = await jobsRegion()

    const strip = await within(jobs).findByRole('img', {
      name: 'Reconstruction de l’historique, dernières 24 h : 3 passages, 1 erreur, 1 à vérifier',
    })
    expect(strip.children).toHaveLength(24)
    expect(strip.querySelectorAll('[data-tone="error"]')).toHaveLength(1)
    expect(strip.querySelectorAll('[data-tone="attention"]')).toHaveLength(1)
  })

  it('run one pass on « Lancer » and ask again for the state', async () => {
    let started: string | null = null
    server.use(
      http.post(ROUTES.jobRun, ({ params }) => {
        started = String(params.job)
        return HttpResponse.json({ id: started, started: true }, { status: 202 })
      }),
    )
    const { user } = openSystem()
    const jobs = await jobsRegion()

    await user.click(
      await within(jobs).findByRole('button', { name: 'Lancer : Relecture du grand livre' }),
    )

    await waitFor(() => expect(started).toBe('ingestion'))
  })

  it('keep « Lancer » busy until the job reports, then show the new pass', async () => {
    let reported = false
    server.use(
      http.get(ROUTES.jobs, () =>
        HttpResponse.json(
          someJobs().map((job) =>
            job.id === 'ingestion' && reported
              ? { ...job, last_run_at: '2026-03-02T11:59:00.000Z' }
              : job,
          ),
        ),
      ),
      http.post(ROUTES.jobRun, () =>
        HttpResponse.json({ id: 'ingestion', started: true }, { status: 202 }),
      ),
    )
    const { user } = openSystem()
    const jobs = await jobsRegion()
    const run = await within(jobs).findByRole('button', {
      name: 'Lancer : Relecture du grand livre',
    })

    await user.click(run)
    await waitFor(() => expect(run).toBeDisabled())
    expect(run).toHaveTextContent('En cours…')

    reported = true
    await waitFor(() => expect(run).toBeEnabled(), { timeout: 5000 })
    expect(run).toHaveTextContent('Lancer')
    const row = within(jobs).getByRole('group', { name: 'Relecture du grand livre' })
    expect(row).toHaveTextContent(/\d{2}:\d{2}/)
  })

  it('say a refused « Lancer » beside the job', async () => {
    server.use(
      http.post(ROUTES.jobRun, () =>
        HttpResponse.json(
          { status: 404, type: PROBLEM_TYPES.notFound, title: 'no such job' },
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = openSystem()
    const jobs = await jobsRegion()

    await user.click(
      await within(jobs).findByRole('button', { name: 'Lancer : Calcul de la performance' }),
    )

    expect(await within(jobs).findByRole('status')).toBeInTheDocument()
  })

  it('keep their place, empty, while the read is in flight', async () => {
    server.use(http.get(ROUTES.jobs, () => new Promise<never>(() => {})))
    openSystem()
    const jobs = await jobsRegion()

    expect(within(jobs).queryByRole('group')).not.toBeInTheDocument()
    expect(jobs.querySelector('[data-empty]')).toBeNull()
  })

  it('say why they could not be read', async () => {
    server.use(problemHandler(ROUTES.jobs, UNAVAILABLE))
    openSystem()
    const jobs = await jobsRegion()

    expect(await within(jobs).findByText('Lecture impossible')).toBeInTheDocument()
  })

  it('say once that the history is unreadable, and keep the rows', async () => {
    server.use(problemHandler(ROUTES.jobsHistory, UNAVAILABLE))
    openSystem()
    const jobs = await jobsRegion()

    expect(await within(jobs).findByText('Lecture impossible')).toBeInTheDocument()
    expect(within(jobs).getByRole('group', { name: 'Mise à jour des cours' })).toBeInTheDocument()
  })
})

describe('the followed titles', () => {
  const followed = [
    {
      symbol: 'CW8.PA',
      name: 'Amundi MSCI World',
      state: 'ok',
      stale_since: null,
      stale_passes: 0,
    },
    {
      symbol: 'PUST.PA',
      name: 'Amundi PEA Nasdaq-100',
      state: 'stale',
      stale_since: '2026-03-02T11:25:00.000Z',
      stale_passes: 6,
    },
  ] as const

  it('are folded when every one is up to date', async () => {
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(aRuntime({ followed: followed.slice(0, 1).map((one) => ({ ...one })) })),
      ),
    )
    openSystem()
    const jobs = await jobsRegion()

    const summary = await within(jobs).findByText('1 titre suivi, à jour')
    expect(summary.closest('details')).not.toHaveAttribute('open')
  })

  it('open on a frozen one, say since when, and offer no action', async () => {
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(aRuntime({ followed: followed.map((one) => ({ ...one })) })),
      ),
    )
    openSystem()
    const jobs = await jobsRegion()

    const summary = await within(jobs).findByText('2 titres suivis · PUST.PA à vérifier')
    const list = summary.closest('details')
    expect(list).toHaveAttribute('open')
    const rows = within(list as HTMLElement).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('CW8.PA')
    expect(rows[0]).toHaveTextContent('Amundi MSCI World')
    expect(rows[0]).toHaveTextContent('à jour')
    expect(rows[1]).toHaveTextContent(/figé depuis \d{2}:\d{2}, 6 passages/)
    expect(within(list as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('the data', () => {
  it('count the events and give the size of the database', async () => {
    openSystem()
    const data = await screen.findByRole('region', { name: 'Données' })

    await waitFor(() => expect(data).toHaveTextContent(`Événements${ledgerEvents().length}`))
    expect(data).toHaveTextContent(/Base de données26[,.]0\s?Mo/)
  })

  it('show no orphan at zero', async () => {
    openSystem()
    await jobsRegion()

    expect(screen.queryByText(/Historiques orphelins/)).not.toBeInTheDocument()
  })

  it('count the orphans, name them, and purge them after a confirmation', async () => {
    server.use(
      http.get(ROUTES.store, () =>
        HttpResponse.json(aStore({ orphans: [{ symbol: 'ZZX', points: 1204 }] })),
      ),
    )
    const { user } = openSystem()
    const data = await screen.findByRole('region', { name: 'Données' })

    expect(await within(data).findByText('Historiques orphelins · 1')).toBeInTheDocument()
    expect(data).toHaveTextContent('ZZX')
    expect(data).toHaveTextContent('1 204 cours')

    server.use(http.get(ROUTES.store, () => HttpResponse.json(aStore())))
    await user.click(within(data).getByRole('button', { name: 'Purger' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Purger 1 historique ?' })
    expect(dialog).toHaveTextContent('Irréversible.')
    await user.click(within(dialog).getByRole('button', { name: 'Purger' }))

    await waitFor(() => expect(screen.queryByText(/Historiques orphelins/)).not.toBeInTheDocument())
  })

  it('say why they could not be read', async () => {
    server.use(problemHandler(ROUTES.store, UNAVAILABLE))
    openSystem()

    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Données' })).toHaveTextContent('Lecture impossible')
  })
})

describe('the installation', () => {
  it('names the version, since when it runs and the source of the quotes', async () => {
    openSystem()
    const installation = await screen.findByRole('region', { name: 'Installation' })

    await waitFor(() => expect(installation).toHaveTextContent('Version5.0.0 · à jour'))
    expect(installation).toHaveTextContent(/En marche depuis2 mars 2026/)
    expect(installation).toHaveTextContent('Source des coursyfinance · répond en 1,4 s')
  })

  it('says a newer version is available', async () => {
    server.use(
      http.get(ROUTES.release, () =>
        HttpResponse.json({ latest: { version: '5.1.0', url: 'https://example.test/notes' } }),
      ),
    )
    openSystem()
    const installation = await screen.findByRole('region', { name: 'Installation' })

    await waitFor(() => expect(installation).toHaveTextContent('5.0.0 · 5.1.0 disponible'))
  })

  it('saves the switch at once', async () => {
    const written: unknown[] = []
    server.use(
      http.put(ROUTES.settings, async ({ request }) => {
        written.push(await request.json())
        return HttpResponse.json({ settings: [], changed: ['update_check'], effect: {} })
      }),
    )
    const { user } = openSystem()
    const installation = await screen.findByRole('region', { name: 'Installation' })

    const toggle = await within(installation).findByRole('switch', {
      name: 'Signaler les nouvelles versions',
    })
    expect(toggle).toBeChecked()
    await user.click(toggle)

    await waitFor(() => expect(written).toEqual([{ update_check: false }]))
  })

  it('leads to the journal', async () => {
    openSystem()
    const installation = await screen.findByRole('region', { name: 'Installation' })

    expect(await within(installation).findByRole('link', { name: 'Ouvrir' })).toHaveAttribute(
      'href',
      '/system/logs',
    )
  })
})

describe('in English', () => {
  it('renders every section', async () => {
    renderApp({ url: '/system', browserLanguages: ['en-GB'] })

    expect(await screen.findByRole('region', { name: 'Tasks' })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Data' })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Installation' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Run: Quote update' })).toBeInTheDocument()
  })
})
