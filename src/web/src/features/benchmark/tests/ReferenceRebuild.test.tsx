/**
 * The first sentence of a fund's download (#1336): one that has not had its turn
 * yet says so, and "just started" is kept for one whose first request is out.
 */
import { screen } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { BenchmarkRebuild } from '@/features/benchmark/lib/api'
import { ROUTES } from '@/lib/api'
import { aBenchmark } from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

function renderRebuild(rebuild: Partial<BenchmarkRebuild>) {
  server.use(
    http.get(ROUTES.benchmark, () =>
      HttpResponse.json(
        aBenchmark({
          state: 'rebuilding',
          reference: 'CW8.PA',
          index: 'MSCI World',
          rebuild: {
            symbol: 'CW8.PA',
            reached: null,
            target: '2009-06-16',
            ratio: null,
            requested: false,
            failing: false,
            ...rebuild,
          },
        }),
      ),
    ),
  )
  return renderApp({ url: '/benchmark' })
}

describe('the download sentence', () => {
  it('waits for its turn while nothing has been asked for', async () => {
    renderRebuild({ requested: false })

    expect(await screen.findByText('En attente de son tour…')).toBeInTheDocument()
    expect(screen.queryByText('Le téléchargement vient de commencer.')).toBeNull()
  })

  it('has started once the first request is out and nothing came back', async () => {
    renderRebuild({ requested: true })

    expect(await screen.findByText('Le téléchargement vient de commencer.')).toBeInTheDocument()
    expect(screen.queryByText('En attente de son tour…')).toBeNull()
  })

  it('says a failing download fails, never that it waits, and points to System', async () => {
    renderRebuild({ requested: false, failing: true })

    expect(
      await screen.findByText('Le téléchargement échoue pour l’instant ; il sera retenté.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('En attente de son tour…')).toBeNull()
    expect(
      screen.getByRole('region', { name: 'MSCI World : téléchargement en échec' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Voir la page Système' })).toHaveAttribute(
      'href',
      '/system',
    )
  })

  it('says how far back it got as soon as a close is stored', async () => {
    renderRebuild({ reached: '2014-03-04', ratio: 0.55, requested: true })

    expect(await screen.findByText(/Remonté jusqu’à mars 2014/)).toBeInTheDocument()
    expect(screen.queryByText('Le téléchargement vient de commencer.')).toBeNull()
  })
})
