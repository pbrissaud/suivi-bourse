import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import type { StoreState } from '@/features/settings/lib/api'
import { type HealthState, ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { aFrozenScrape, aHealth, aHealthJobs, aRuntime, aStore } from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

const UNAVAILABLE = {
  status: 503,
  type: PROBLEM_TYPES.storageUnavailable,
  title: 'storage unavailable',
}

function openSystem(store?: StoreState, health?: HealthState) {
  if (store) {
    server.use(http.get(ROUTES.store, () => HttpResponse.json(store)))
  }
  if (health) {
    server.use(http.get(ROUTES.health, () => HttpResponse.json(health)))
  }
  return renderApp({ url: '/system' })
}

async function followTheBell() {
  const { user } = renderApp({ url: '/' })
  await user.click(await screen.findByRole('button', { name: /^Notifications/ }))
  const panel = await screen.findByRole('dialog', { name: 'Notifications' })
  await user.click(within(panel).getByRole('link', { name: 'Voir dans Système' }))
  await screen.findByRole('heading', { level: 1, name: 'Système' })
  return screen.findByRole('region', { name: 'Tâches' })
}

describe('the page', () => {
  it('leaves what the installation reports to the status page', async () => {
    await openSystem(aStore({ orphans: [{ symbol: 'ZZX', points: 1204 }] }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Système' })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((one) => one.textContent)).toEqual([
        'Tâches',
        'Titres orphelins',
      ]),
    )
  })

  it('names the rebuild section', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    await openSystem()

    expect(
      await screen.findByRole('region', { name: 'Reconstruction en cours' }),
    ).toBeInTheDocument()
  })
})

describe('the orphaned securities', () => {
  it('do not exist at zero', async () => {
    await openSystem()
    await screen.findByRole('heading', { name: 'Tâches' })

    expect(screen.queryByRole('heading', { name: 'Titres orphelins' })).not.toBeInTheDocument()
  })

  it('are counted, named, and purged at once', async () => {
    const { user } = await openSystem(aStore({ orphans: [{ symbol: 'ZZX', points: 1204 }] }))
    const orphans = await screen.findByRole('region', { name: 'Titres orphelins' })

    expect(orphans).toHaveTextContent('1 titre')
    expect(orphans).toHaveTextContent('ZZX')
    expect(orphans).toHaveTextContent('1 204 cours')

    server.use(http.get(ROUTES.store, () => HttpResponse.json(aStore())))
    await user.click(within(orphans).getByRole('button', { name: 'Purger' }))

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Titres orphelins' })).not.toBeInTheDocument(),
    )
  })
})

describe('the jobs', () => {
  it('are where the bell’s health card lands', async () => {
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))

    expect(await followTheBell()).toHaveTextContent(/Cours figés/)
  })

  it('are the three the health payload carries', async () => {
    await openSystem()
    const jobs = await screen.findByRole('region', { name: 'Tâches' })

    expect(within(jobs).getByText('Relevé des cours')).toBeInTheDocument()
    expect(within(jobs).getByText('Reconstruction de l’historique')).toBeInTheDocument()
    expect(within(jobs).getByText('Calcul de la performance')).toBeInTheDocument()
    expect(jobs).toHaveTextContent('Tout fonctionne.')
  })

  it('render a verdict as a sentence, never the raw word', async () => {
    await openSystem(undefined, aFrozenScrape())
    const jobs = await screen.findByRole('region', { name: 'Tâches' })

    expect(jobs).toHaveTextContent('À vérifier.')
    expect(jobs).toHaveTextContent(/Cours figés/)
    expect(jobs).not.toHaveTextContent('frozen')
  })

  it('say a stopped scheduler', async () => {
    await openSystem(undefined, aHealth({ status: 'attention', scheduler_running: false }))
    const jobs = await screen.findByRole('region', { name: 'Tâches' })

    expect(jobs).toHaveTextContent(/Le planificateur est arrêté/)
  })

  it('name a job that never ran', async () => {
    await openSystem(
      undefined,
      aHealth({
        status: 'unknown',
        jobs: aHealthJobs({
          performance: { status: 'unknown', at: null, verdict: 'unknown', error: null },
        }),
      }),
    )
    const jobs = await screen.findByRole('region', { name: 'Tâches' })

    // Said once, by the verdict, and not again as « Jamais » beside it (#1412).
    expect(jobs).toHaveTextContent(/Calcul de la performance\s*Pas encore exécuté\./)
  })

  it('do not exist while the health read is in flight', async () => {
    server.use(http.get(ROUTES.health, () => new Promise<never>(() => {})))
    await openSystem()
    await screen.findByRole('heading', { level: 1, name: 'Système' })

    expect(screen.queryByRole('heading', { name: 'Tâches' })).not.toBeInTheDocument()
  })

  it('say why they could not be read when /health refuses', async () => {
    server.use(problemHandler(ROUTES.health, UNAVAILABLE))

    const jobs = await followTheBell()
    expect(within(jobs).getByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says it too when a poll fails over a table it already drew (#1180)', async () => {
    // Everywhere else a refetch that failed keeps the figures. Not here: this
    // block is the bell's state in prose, and a red bell must not link to a
    // green table from the last answer.
    const { queryClient } = renderApp({ url: '/system', fakeTimers: true })
    const jobs = await screen.findByRole('region', { name: 'Tâches' })
    expect(within(jobs).queryByText('Lecture impossible')).not.toBeInTheDocument()

    server.use(http.get(ROUTES.health, () => HttpResponse.error()))
    await vi.advanceTimersByTimeAsync(60_000)
    await waitFor(() => expect(queryClient.getQueryState(['health'])?.error).toBeTruthy())
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Tâches' })).getByText('Lecture impossible'),
      ).toBeInTheDocument(),
    )
  })

  it('say the same on a 200 that is not a health payload', async () => {
    server.use(http.get(ROUTES.health, () => HttpResponse.json({ status: 'ok' })))

    const jobs = await followTheBell()
    expect(within(jobs).getByText('Lecture impossible')).toBeInTheDocument()
  })
})

describe('in English', () => {
  it('renders every section', async () => {
    renderApp({ url: '/system', browserLanguages: ['en-GB'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeInTheDocument()
  })
})
