import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aHealth,
  aHealthJobs,
  aJobPass,
  aJobsHistory,
  aJobTrack,
  NOW,
  someSlots,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

async function jobs() {
  const rendered = renderApp({ url: '/system' })
  const region = await screen.findByRole('region', { name: 'Tâches' })
  return { ...rendered, region }
}

const FAILED = aJobTrack({
  slots: someSlots({
    20: { passes: 30, errors: 2, duration: 30, last_error: 'old', last_error_at: NOW },
    23: {
      passes: 1,
      errors: 1,
      duration: 4,
      last_error: 'TimeoutError: no answer',
      last_error_at: NOW,
    },
  }),
  passes: [
    aJobPass({
      outcome: 'error',
      error: 'TimeoutError: no answer',
      duration: 4,
      lines: [{ level: 'WARNING', logger: 'yfinance', message: 'AAPL: possibly delisted' }],
      overflow: 3,
    }),
  ],
  last: aJobPass({ outcome: 'error', error: 'TimeoutError: no answer' }),
})

describe('the job history (#1236)', () => {
  it('draws one 24-hour strip per job, the ingestion included', async () => {
    const { region } = await jobs()

    for (const name of [
      'Relevé des cours',
      'Reconstruction de l’historique',
      'Calcul de la performance',
      'Relecture du registre',
    ]) {
      const strip = await within(region).findByRole('listbox', { name })
      expect(within(strip).getAllByRole('option')).toHaveLength(24)
    }
    expect(
      within(region).getByRole('listbox', { name: 'Relevé des cours · AAPL' }),
    ).toBeInTheDocument()
    expect(region).toHaveTextContent(/depuis le démarrage/)
  })

  it('names each hour by its passes and its faults', async () => {
    server.use(
      http.get(ROUTES.jobsHistory, () =>
        HttpResponse.json(
          aJobsHistory({
            started: '2026-02-28T00:00:00.000Z',
            jobs: { ...aJobsHistory().jobs, performance: FAILED },
          }),
        ),
      ),
    )
    const { region } = await jobs()
    const strip = await within(region).findByRole('listbox', { name: 'Calcul de la performance' })
    const options = within(strip).getAllByRole('option')

    expect(options[0]).toHaveAccessibleName(/aucun passage$/)
    expect(options[20]).toHaveAccessibleName(/30 passages, 2 erreurs, durée moyenne 1(,0)? s$/)
    expect(options[23]).toHaveAccessibleName(/1 passage, 1 erreur, durée moyenne 4(,0)? s$/)
  })

  it('moves the open hour with the arrows, Home and End', async () => {
    const { region, user } = await jobs()
    const strip = await within(region).findByRole('listbox', { name: 'Calcul de la performance' })
    const options = within(strip).getAllByRole('option')
    strip.focus()

    await user.keyboard('{ArrowRight}')
    expect(options[23]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowLeft}')
    expect(options[22]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(strip).toHaveAttribute('aria-activedescendant', options[0].id)
    await user.keyboard('{End}')
    expect(options[23]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Escape}')
    expect(strip).not.toHaveAttribute('aria-activedescendant')
  })

  it('opens the faulty hour of a flagged job with its error and its log lines', async () => {
    server.use(
      http.get(ROUTES.health, () =>
        HttpResponse.json(
          aHealth({
            status: 'attention',
            jobs: aHealthJobs({
              performance: { status: 'attention', at: NOW, verdict: 'failed', error: 'x' },
            }),
          }),
        ),
      ),
      http.get(ROUTES.jobsHistory, () =>
        HttpResponse.json(aJobsHistory({ jobs: { ...aJobsHistory().jobs, performance: FAILED } })),
      ),
    )
    const { region } = await jobs()
    const strip = await within(region).findByRole('listbox', { name: 'Calcul de la performance' })

    expect(within(strip).getAllByRole('option')[23]).toHaveAttribute('aria-selected', 'true')
    expect(region).toHaveTextContent(/Dernière erreur à .* : TimeoutError: no answer/)
    expect(region).toHaveTextContent('WARNING yfinance: AAPL: possibly delisted')
    expect(region).toHaveTextContent('3 autres lignes')
  })

  it('says an older hour keeps its counts but not its passes', async () => {
    server.use(
      http.get(ROUTES.jobsHistory, () =>
        HttpResponse.json(aJobsHistory({ jobs: { ...aJobsHistory().jobs, performance: FAILED } })),
      ),
    )
    const { region, user } = await jobs()
    const strip = await within(region).findByRole('listbox', { name: 'Calcul de la performance' })

    await user.click(within(strip).getAllByRole('option')[20])

    expect(region).toHaveTextContent('Le détail n’est gardé que pour les 20 derniers passages.')
    expect(region).toHaveTextContent(/30 passages · 2 erreurs · durée moyenne 1(,0)? s/)
  })

  it('opens five symbols, the worst first, and unfolds the others', async () => {
    const quiet = aJobTrack()
    const scrape = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((s) => [s, quiet]))
    scrape.G = FAILED
    server.use(http.get(ROUTES.jobsHistory, () => HttpResponse.json(aJobsHistory({ scrape }))))
    const { region, user } = await jobs()
    await within(region).findByRole('listbox', { name: 'Relevé des cours · G' })

    expect(
      within(region).queryByRole('listbox', { name: 'Relevé des cours · F' }),
    ).not.toBeInTheDocument()
    await user.click(within(region).getByRole('button', { name: 'Voir les 2 autres titres' }))
    expect(
      within(region).getByRole('listbox', { name: 'Relevé des cours · F' }),
    ).toBeInTheDocument()
  })

  it('names the symbol of each pass in the scrape, which mixes them', async () => {
    server.use(
      http.get(ROUTES.jobsHistory, () =>
        HttpResponse.json(
          aJobsHistory({
            scrape: { AAPL: aJobTrack(), MSFT: FAILED },
            scrape_recent: [{ ...FAILED.passes[0], symbol: 'MSFT' }, aJobPass({ symbol: 'AAPL' })],
          }),
        ),
      ),
    )
    const { region, user } = await jobs()
    const strip = await within(region).findByRole('listbox', { name: 'Relevé des cours' })

    await user.click(within(strip).getAllByRole('option')[23])

    const detail = strip.nextElementSibling as HTMLElement
    expect(within(detail).getByText('MSFT')).toBeInTheDocument()
    expect(within(detail).getByText('AAPL')).toBeInTheDocument()
    expect(detail).toHaveTextContent('2 passages · 1 erreur')
  })

  it('says a failed ingestion and opens its hour, and never for one that did not run', async () => {
    server.use(
      http.get(ROUTES.jobsHistory, () =>
        HttpResponse.json(aJobsHistory({ jobs: { ...aJobsHistory().jobs, ingestion: FAILED } })),
      ),
    )
    const { region, unmount } = await jobs()
    const strip = await within(region).findByRole('listbox', { name: 'Relecture du registre' })

    expect(region).toHaveTextContent('Échec de la dernière relecture')
    expect(within(strip).getAllByRole('option')[23]).toHaveAttribute('aria-selected', 'true')
    unmount()

    server.use(
      http.get(ROUTES.jobsHistory, () =>
        HttpResponse.json(
          aJobsHistory({
            jobs: {
              ...aJobsHistory().jobs,
              ingestion: aJobTrack({ slots: someSlots(), passes: [], last: null }),
            },
          }),
        ),
      ),
    )
    const again = await jobs()
    await within(again.region).findByRole('listbox', { name: 'Relecture du registre' })
    expect(again.region).toHaveTextContent(/Relecture du registreJamais/)
  })

  it('says the last 24 hours once the process is older than a day', async () => {
    server.use(
      http.get(ROUTES.jobsHistory, () =>
        HttpResponse.json(aJobsHistory({ started: '2026-02-28T00:00:00.000Z' })),
      ),
    )
    const { region } = await jobs()
    await within(region).findByRole('listbox', { name: 'Calcul de la performance' })

    expect(region).toHaveTextContent('Dernières 24 h.')
    expect(region).not.toHaveTextContent(/depuis le démarrage/)
  })

  it('draws no histogram under two hours of history, and says so', async () => {
    const started = new Date(Date.parse(NOW) - 3_600_000).toISOString()
    server.use(http.get(ROUTES.jobsHistory, () => HttpResponse.json(aJobsHistory({ started }))))
    const { region } = await jobs()

    expect(await within(region).findByText(/s’affiche après deux heures/)).toBeInTheDocument()
    expect(within(region).queryByRole('listbox')).not.toBeInTheDocument()
    // The date and the verdict of each job stay.
    expect(region).toHaveTextContent('Relevé des cours')
  })

  it('draws no mark for an hour before the process started', async () => {
    const started = new Date(Date.parse(NOW) - 3 * 3_600_000).toISOString()
    server.use(http.get(ROUTES.jobsHistory, () => HttpResponse.json(aJobsHistory({ started }))))
    const { region, user } = await jobs()
    const strip = await within(region).findByRole('listbox', { name: 'Calcul de la performance' })
    const options = within(strip).getAllByRole('option')

    expect(options).toHaveLength(24)
    expect(options[0]).toHaveAccessibleName(/l’application ne tournait pas$/)
    expect(options[0].querySelector('.border-dashed')).toBeNull()
    expect(options[19].querySelector('.border-dashed')).toBeNull()
    // Opening it states the app was not running, and no pass totals.
    await user.click(options[0])
    expect(await within(region).findByText(/l’application ne tournait pas/)).toBeInTheDocument()
    expect(region).not.toHaveTextContent(/aucun passage/)
    // The first hour after the start, with no pass, keeps its dashed mark.
    expect(options[20].querySelector('.border-dashed')).not.toBeNull()
  })

  it('still dates the last replay once it has left the 24 hours', async () => {
    server.use(
      http.get(ROUTES.jobsHistory, () =>
        HttpResponse.json(
          aJobsHistory({
            jobs: {
              ...aJobsHistory().jobs,
              ingestion: aJobTrack({
                slots: someSlots(),
                passes: [],
                last: aJobPass({ at: '2026-02-20T09:00:00.000Z' }),
              }),
            },
          }),
        ),
      ),
    )
    const { region } = await jobs()
    await within(region).findByRole('listbox', { name: 'Relecture du registre' })

    expect(region).not.toHaveTextContent(/Relecture du registreJamais/)
    expect(region).toHaveTextContent(/Relecture du registre.*À jour\./)
  })

  it('keeps the open hour when the window moves an hour on', async () => {
    const { region, user, queryClient } = await jobs()
    const strip = await within(region).findByRole('listbox', { name: 'Calcul de la performance' })
    await user.click(within(strip).getAllByRole('option')[20])
    const opened = within(strip).getAllByRole('option')[20].getAttribute('aria-label')

    const later = aJobsHistory()
    const shifted = {
      ...later.jobs.performance,
      slots: [
        ...later.jobs.performance.slots.slice(1),
        { ...later.jobs.performance.slots[23], hour: '2026-03-02T13:00:00.000Z' },
      ],
    }
    queryClient.setQueryData(['jobs-history'], {
      ...later,
      jobs: { ...later.jobs, performance: shifted },
    })

    await waitFor(() =>
      expect(within(strip).getAllByRole('option')[19]).toHaveAttribute('aria-selected', 'true'),
    )
    expect(within(strip).getAllByRole('option')[19].getAttribute('aria-label')).toBe(opened)
  })

  it('keeps an empty place and no strip while the history is in flight', async () => {
    server.use(http.get(ROUTES.jobsHistory, () => new Promise<never>(() => {})))
    const { region } = await jobs()

    expect(within(region).getByText('Calcul de la performance')).toBeInTheDocument()
    expect(within(region).queryByRole('listbox')).not.toBeInTheDocument()
    expect(within(region).queryByRole('status')).not.toBeInTheDocument()
  })

  it('says once that the history is unreadable, and keeps the rows', async () => {
    server.use(
      problemHandler(ROUTES.jobsHistory, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'Storage unavailable',
      }),
    )
    const { region } = await jobs()

    await waitFor(() => expect(within(region).getAllByText('Lecture impossible')).toHaveLength(1))
    expect(region).toHaveTextContent('Tout fonctionne.')
    expect(within(region).queryByRole('listbox')).not.toBeInTheDocument()
  })
})
