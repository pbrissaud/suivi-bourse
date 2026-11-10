import { act, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import type { JournalRow } from '@/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { someJournalRows } from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

const ERROR: JournalRow = {
  time: '2026-03-02T11:55:00.000Z',
  level: 'error',
  job: 'backfill',
  message: 'backfill failed for ZZX',
  detail: null,
}

/** The journal's rows, wherever the page puts the shell's own lists. */
function lines() {
  return [...document.querySelectorAll<HTMLElement>('section[aria-label] ol > li')]
}

/** What the page asked of `GET /api/logs`, in order. */
function recording(rows: JournalRow[] = someJournalRows([ERROR])) {
  const asked: URL[] = []
  server.use(
    http.get(ROUTES.logs, ({ request }) => {
      asked.push(new URL(request.url))
      return HttpResponse.json({ rows, cursor: 7 })
    }),
  )
  return asked
}

describe('the journal', () => {
  it('is a page of its own, with the way back to Système', async () => {
    recording()
    renderApp({ url: '/journal' })

    expect(await screen.findByRole('heading', { level: 1, name: 'Journal' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Système' })).toHaveAttribute('href', '/system')
    expect(screen.getByRole('link', { name: 'Télécharger' })).toHaveAttribute(
      'href',
      ROUTES.logsDownload,
    )
  })

  it('lists the rows under their day: time, level, task, message', async () => {
    recording()
    renderApp({ url: '/journal' })

    const day = await screen.findByRole('region', { name: /^Aujourd’hui · / })
    const rows = within(day).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent(/^\d{2}:\d{2}erreur/)
    expect(rows[0]).toHaveTextContent('Reconstruction de l’historique')
    // A failing line is a sentence in French; the log's own words wait behind « détail ».
    expect(rows[0]).toHaveTextContent('Reconstruction de l’historique : une étape a échoué.')
    expect(rows[0].querySelector('summary')).not.toHaveTextContent('backfill failed for ZZX')
    expect(rows[0].querySelector('pre')).toHaveTextContent('backfill failed for ZZX')
    expect(rows[1]).toHaveTextContent('avert.')
    expect(rows[1]).toHaveTextContent('Mise à jour des cours')
    expect(rows[2]).toHaveTextContent('info')
    expect(rows[2]).toHaveTextContent('Calcul de la performance')
  })

  it('opens a traceback under a « détail » disclosure', async () => {
    recording()
    const { user } = renderApp({ url: '/journal' })

    const day = await screen.findByRole('region', { name: /^Aujourd’hui · / })
    const disclosure = within(day)
      .getAllByText('détail')
      .map((one) => one.closest('details') as HTMLElement)
      .find((one) => one.textContent?.includes('YFRateLimitError')) as HTMLElement
    expect(disclosure).not.toHaveAttribute('open')
    await user.click(within(disclosure).getByText('détail'))

    expect(disclosure).toHaveAttribute('open')
    expect(disclosure).toHaveTextContent('YFRateLimitError')
  })

  it('counts the warnings and the errors on its tabs and narrows to them', async () => {
    recording()
    const { user } = renderApp({ url: '/journal' })

    const warnings = await screen.findByRole('tab', { name: 'Avertissements 2' })
    expect(screen.getByRole('tab', { name: 'Erreurs 1' })).toBeInTheDocument()
    await user.click(warnings)
    expect(lines()).toHaveLength(2)

    await user.click(screen.getByRole('tab', { name: 'Erreurs 1' }))
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toHaveTextContent('backfill failed for ZZX')
  })

  it('narrows by task and by period on the server', async () => {
    const asked = recording()
    const { user } = renderApp({ url: '/journal' })
    await screen.findByRole('region', { name: /^Aujourd’hui · / })

    expect(asked[0].searchParams.get('job')).toBeNull()
    expect(Date.parse(asked[0].searchParams.get('since') ?? '')).toBe(
      Date.parse('2026-03-02T12:00:00.000Z') - 7 * 86_400_000,
    )

    await user.click(screen.getByRole('button', { name: /Tâche/ }))
    await user.click(await screen.findByRole('option', { name: 'Mise à jour des cours' }))
    await waitFor(() => expect(asked.at(-1)?.searchParams.get('job')).toBe('scrape'))

    await user.click(screen.getByRole('button', { name: /Période/ }))
    await user.click(await screen.findByRole('option', { name: 'Dernières 24 h' }))
    await waitFor(() =>
      expect(Date.parse(asked.at(-1)?.searchParams.get('since') ?? '')).toBe(
        Date.parse('2026-03-02T12:00:00.000Z') - 86_400_000,
      ),
    )
  })

  it('searches the messages once the typing stops', async () => {
    const asked = recording()
    const { user } = renderApp({ url: '/journal' })
    await screen.findByRole('region', { name: /^Aujourd’hui · / })

    await user.type(screen.getByRole('searchbox', { name: 'Rechercher dans le journal' }), '429')

    await waitFor(() => expect(asked.at(-1)?.searchParams.get('q')).toBe('429'))
  })

  it('polls every 5 s with the cursor and puts what came after on top', async () => {
    const asked: URL[] = []
    const fresh: JournalRow = { ...ERROR, message: 'just now', time: '2026-03-02T12:00:03.000Z' }
    server.use(
      http.get(ROUTES.logs, ({ request }) => {
        const url = new URL(request.url)
        asked.push(url)
        return url.searchParams.has('cursor')
          ? HttpResponse.json({ rows: [fresh], cursor: 9 })
          : HttpResponse.json({ rows: someJournalRows(), cursor: 7 })
      }),
    )
    renderApp({ url: '/journal', fakeTimers: true })
    await screen.findByRole('region', { name: /^Aujourd’hui · / })
    expect(screen.queryByText('just now')).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(await screen.findByText('just now')).toBeInTheDocument()
    expect(asked.at(-1)?.searchParams.get('cursor')).toBe('7')
    expect(lines()[0]).toHaveTextContent('just now')
  })

  it('stops asking once « En direct » is switched off', async () => {
    const asked = recording()
    const { user } = renderApp({ url: '/journal', fakeTimers: true })
    await screen.findByRole('region', { name: /^Aujourd’hui · / })

    const live = screen.getByRole('button', { name: 'En direct' })
    expect(live).toHaveAttribute('aria-pressed', 'true')
    await user.click(live)
    await screen.findByRole('region', { name: /^Aujourd’hui · / })
    const before = asked.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })

    expect(asked).toHaveLength(before)
  })

  it('says why it is empty, never over a read in flight', async () => {
    server.use(http.get(ROUTES.logs, () => new Promise<never>(() => {})))
    renderApp({ url: '/journal' })
    await screen.findByRole('heading', { level: 1, name: 'Journal' })

    expect(screen.queryByText('Aucune ligne')).not.toBeInTheDocument()
  })

  it('says it when there is nothing to show', async () => {
    recording([])
    renderApp({ url: '/journal' })

    expect(await screen.findByText('Aucune ligne')).toBeInTheDocument()
  })

  it('says it when the journal could not be read', async () => {
    server.use(
      problemHandler(ROUTES.logs, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp({ url: '/journal' })

    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
  })
})
