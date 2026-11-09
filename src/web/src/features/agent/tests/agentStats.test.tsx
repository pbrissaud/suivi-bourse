/**
 * The agent's statistics page and the pure arithmetic under it (« Relevé »).
 */
import { screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { holdsAlready } from '@/features/agent/lib/eventProposals'
import { chartTop, monthTicks, sharesOf } from '@/features/agent/lib/statsView'
import { compactTokens, groupThreads, monthName } from '@/features/agent/lib/threads'
import { agentOn, aStats } from '@/features/agent/tests/agentFixtures'
import { ROUTES } from '@/lib/api'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

async function openStats() {
  setViewportWidth(1280)
  const view = renderApp({ url: '/agent/stats' })
  await screen.findByRole('heading', { level: 1, name: 'Statistiques' })
  return { ...view, main: screen.getByRole('main') }
}

describe('the statistics page', () => {
  it('leads with the tokens exchanged, then the split, the weeks and the two tables', async () => {
    agentOn()
    server.use(http.get(ROUTES.agentStats, () => HttpResponse.json(aStats())))
    const { main } = await openStats()

    expect(await within(main).findByText('1 000 k')).toBeInTheDocument()
    expect(
      within(main).getByText(
        /^Tokens échangés avec Anthropic et Ollama depuis le 1\S* janv\. 2026$/,
      ),
    ).toBeInTheDocument()
    expect(
      within(main).getByRole('img', {
        name: /^Entrée relue du cache 71\s%, entrée nouvelle 22\s%, sortie 7\s%$/,
      }),
    ).toBeInTheDocument()
    expect(within(main).getByRole('heading', { name: 'Par modèle' })).toBeInTheDocument()
    expect(within(main).getByText('claude-sonnet-5-5')).toBeInTheDocument()
    expect(within(main).getByText('74 %')).toBeInTheDocument()
    expect(within(main).getByRole('link', { name: /Dividendes d’octobre/ })).toHaveAttribute(
      'href',
      '/agent/t1',
    )
    // No price anywhere: the server counts tokens and nothing else.
    expect(within(main).queryByText(/€/)).not.toBeInTheDocument()
  })

  it('asks the server for the period chosen', async () => {
    agentOn()
    const asked: (string | null)[] = []
    server.use(
      http.get(ROUTES.agentStats, ({ request }) => {
        asked.push(new URL(request.url).searchParams.get('range'))
        return HttpResponse.json(aStats())
      }),
    )
    const { user, main } = await openStats()
    await within(main).findByText('1 000 k')
    await user.click(within(main).getByRole('radio', { name: 'Tout' }))
    await screen.findByText('1 000 k')
    expect(asked).toEqual(['YTD', 'MAX'])
  })

  it('says why it is empty, and says a failed read', async () => {
    agentOn()
    server.use(
      http.get(ROUTES.agentStats, () =>
        HttpResponse.json(
          aStats({
            totals: {
              tokens: 0,
              input: 0,
              output: 0,
              cache_read: 0,
              fresh: 0,
              threads: 0,
              requests: 0,
              tool_calls: 0,
            },
            weeks: [],
            models: [],
            threads: [],
          }),
        ),
      ),
    )
    const { main } = await openStats()
    expect(await within(main).findByText('Aucun échange')).toBeInTheDocument()
  })
})

describe('the arithmetic', () => {
  it('shares the bar, rounds the chart top up, and names the months', () => {
    expect(sharesOf(aStats().totals).cache).toBeCloseTo(0.71)
    expect(sharesOf({ ...aStats().totals, cache_read: 0, fresh: 0, output: 0 })).toEqual({
      cache: 0,
      fresh: 0,
      output: 0,
    })
    expect(chartTop(0)).toBe(3)
    expect(chartTop(58_000)).toBe(60_000)
    expect(chartTop(41_000)).toBe(60_000)
    expect(monthTicks(aStats().weeks).map((t) => t.week)).toEqual(['2026-01-05', '2026-02-02'])
  })

  it('writes tokens compactly', () => {
    expect(compactTokens(912, 'fr-FR')).toBe('912')
    expect(compactTokens(283_400, 'fr-FR')).toBe('283 k')
  })

  it('groups threads by day, then month, and names a past year', () => {
    const now = new Date('2026-03-02T12:00:00Z')
    const thread = (id: string, at: string) => ({
      id,
      title: id,
      created_at: null,
      updated_at: at,
    })
    const groups = groupThreads(
      [
        thread('a', '2026-03-02T09:00:00Z'),
        thread('b', '2026-03-01T20:00:00Z'),
        thread('c', '2026-02-10T09:00:00Z'),
        thread('d', '2026-02-01T09:00:00Z'),
        thread('e', '2025-11-03T09:00:00Z'),
      ],
      now,
    )
    expect(groups.map((g) => [g.key, g.threads.length])).toEqual([
      ['today', 1],
      ['yesterday', 1],
      ['2026-02', 2],
      ['2025-11', 1],
    ])
    expect(monthName(groups[2].month as Date, now, 'fr-FR')).toBe('Février')
    expect(monthName(groups[3].month as Date, now, 'fr-FR')).toBe('Novembre 2025')
  })

  it('pairs a proposed line with the stored row it repeats, once each', () => {
    const line = (
      symbol: string | null,
      amount: number | null,
      quantity: number | null = null,
    ) => ({
      date: '2026-10-01',
      event_type: symbol ? 'BUY' : 'DEPOSIT',
      symbol,
      amount,
      quantity,
    })
    const stored = { ...line('CW8.PA', null, 10), duplicate_of: 'e1' }
    const held = holdsAlready(
      [line('CW8.PA', null, 10), line('CW8.PA', null, 10), line(null, 100), line('X', null, 1)],
      [stored, { ...line(null, 100), duplicate_of: null }] as never,
    )
    // One stored row answers for one line; a repeat inside the file is no duplicate.
    expect(held).toEqual([true, false, false, false])
  })
})
