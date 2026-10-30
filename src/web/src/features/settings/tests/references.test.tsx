/**
 * The ETFs the comparison follows (#1312): a row in Portfolio, and the sheet
 * that turns each one on. The download itself is a server job, so what is
 * attested here is what the owner sees and what the page sends.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { BenchmarkReference } from '@/features/benchmark/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { aBenchmarkReferences, aConfig, aSetting } from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const SHEET = /Références de comparaison/

/** The progress read, and the `PUT`s it receives, as one server would answer. */
function serve(references: BenchmarkReference[], followed: string[] = []) {
  const puts: unknown[] = []
  server.use(
    http.get(ROUTES.benchmarkReferences, () => HttpResponse.json(references)),
    http.get(ROUTES.config, () =>
      HttpResponse.json(
        aConfig({
          settings: [
            aSetting({
              key: 'benchmark_symbols',
              value: followed,
              default: [],
              type: 'symbols',
              minimum: null,
              maximum: null,
              effect: 'next_cycle',
            }),
          ],
        }),
      ),
    ),
    http.put(ROUTES.settings, async ({ request }) => {
      const body = (await request.json()) as { benchmark_symbols: string[] }
      puts.push(body)
      return HttpResponse.json({
        settings: [
          aSetting({
            key: 'benchmark_symbols',
            value: body.benchmark_symbols,
            default: [],
            type: 'symbols',
            minimum: null,
            maximum: null,
            effect: 'next_cycle',
          }),
        ],
        changed: ['benchmark_symbols'],
        effect: {},
      })
    }),
  )
  return puts
}

const row = (name: RegExp | string) => screen.findByRole('switch', { name })

describe('the row in Portfolio', () => {
  it('says nothing is followed', async () => {
    serve(aBenchmarkReferences())
    renderApp({ url: '/settings' })

    expect(await screen.findByText('Aucune référence suivie.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Gérer' })).toBeInTheDocument()
  })

  it('names what the Benchmark page offers and what is still downloading', async () => {
    serve(
      aBenchmarkReferences({
        'CW8.PA': { followed: true, ready: true },
        'CSPX.AS': { followed: true, ready: true },
        'C40.PA': { followed: true, reached: '2013-03-01', target: '2008-01-02', ratio: 0.629 },
      }),
      ['CW8.PA', 'CSPX.AS', 'C40.PA'],
    )
    renderApp({ url: '/settings' })

    expect(
      await screen.findByText(
        'MSCI World et S&P 500 sont proposés sur la page Référence. CAC 40 en téléchargement, 62 %.',
      ),
    ).toBeInTheDocument()
  })

  it('names the ETF being downloaded even before it has a percentage', async () => {
    serve(aBenchmarkReferences({ 'C40.PA': { followed: true } }), ['C40.PA'])
    renderApp({ url: '/settings' })

    expect(await screen.findByText('CAC 40 en téléchargement.')).toBeInTheDocument()
  })

  it('opens the sheet from #portfolio-references, with the first switch focused', async () => {
    serve(aBenchmarkReferences())
    renderApp({ url: '/settings#portfolio-references' })

    const dialog = await screen.findByRole('dialog', { name: SHEET })
    expect(await within(dialog).findByRole('switch', { name: 'Suivre MSCI World' })).toHaveFocus()
  })

  it('removes the hash when the sheet closes, so Back does not reopen it', async () => {
    serve(aBenchmarkReferences())
    const { user, router } = renderApp({ url: '/settings#portfolio-references' })
    await screen.findByRole('dialog', { name: SHEET })

    await user.click(screen.getByRole('button', { name: 'Fermer' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(router.state.location.hash).toBe('')
  })

  it('opens the sheet from « Gérer »', async () => {
    serve(aBenchmarkReferences())
    const { user } = renderApp({ url: '/settings' })

    await user.click(await screen.findByRole('button', { name: 'Gérer' }))

    expect(await screen.findByRole('dialog', { name: SHEET })).toBeInTheDocument()
  })
})

describe('the sheet', () => {
  it('lists the five, each named for what its switch does', async () => {
    serve(aBenchmarkReferences())
    renderApp({ url: '/settings#portfolio-references' })

    const dialog = await screen.findByRole('dialog', { name: SHEET })
    const switches = await within(dialog).findAllByRole('switch')
    expect(switches.map((one) => one.getAttribute('aria-label'))).toEqual([
      'Suivre MSCI World',
      'Suivre S&P 500',
      'Suivre Euro Stoxx 50',
      'Suivre CAC 40',
      'Suivre MSCI Emerging Markets',
    ])
    expect(within(dialog).getByText('Coté depuis 2009')).toBeInTheDocument()
    // No Save button: a switch is saved on click.
    expect(within(dialog).queryByRole('button', { name: /Enregistrer/ })).not.toBeInTheDocument()
  })

  it('follows an ETF with the list built from the latest answer, the new one last', async () => {
    const puts = serve(aBenchmarkReferences({ 'CW8.PA': { followed: true, ready: true } }), [
      'CW8.PA',
    ])
    const { user } = renderApp({ url: '/settings#portfolio-references' })

    await user.click(await row('Suivre CAC 40'))

    await waitFor(() => expect(puts).toEqual([{ benchmark_symbols: ['CW8.PA', 'C40.PA'] }]))
  })

  it('unfollows by sending the list without it', async () => {
    const puts = serve(
      aBenchmarkReferences({
        'CW8.PA': { followed: true, ready: true },
        'C40.PA': { followed: true, ready: true },
      }),
      ['CW8.PA', 'C40.PA'],
    )
    const { user } = renderApp({ url: '/settings#portfolio-references' })

    await user.click(await row('Suivre MSCI World'))

    await waitFor(() => expect(puts).toEqual([{ benchmark_symbols: ['C40.PA'] }]))
  })

  it('shows the bar of the ETF being downloaded and the queue of the next', async () => {
    serve(
      aBenchmarkReferences({
        'CSPX.AS': { followed: true, reached: '2013-03-01', target: '2010-01-04', ratio: 0.62 },
        'C40.PA': { followed: true, waiting: 'queued', after: 'CSPX.AS' },
      }),
      ['CSPX.AS', 'C40.PA'],
    )
    renderApp({ url: '/settings#portfolio-references' })

    const dialog = await screen.findByRole('dialog', { name: SHEET })
    expect(
      await within(dialog).findByText('Remonté jusqu’à mars 2013, sur janvier 2010 · 62 %'),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('progressbar')).toHaveAttribute('value', '62')
    expect(within(dialog).getByText('en attente, après S&P 500')).toBeInTheDocument()
  })

  it('says an empty ledger has no period yet, and sends to the ledger', async () => {
    serve(aBenchmarkReferences({ 'CW8.PA': { followed: true, waiting: 'no_events' } }), ['CW8.PA'])
    renderApp({ url: '/settings#portfolio-references' })

    const dialog = await screen.findByRole('dialog', { name: SHEET })
    expect(await within(dialog).findByText(/Pas encore de période/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Enregistrer un événement' })).toHaveAttribute(
      'href',
      '/ledger',
    )
    expect(within(dialog).queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('offers to stop keeping an unfollowed history, and to cancel that', async () => {
    let freed = false
    server.use(
      http.put(ROUTES.benchmarkReference, async ({ request }) => {
        freed = !((await request.json()) as { kept: boolean }).kept
        return HttpResponse.json(
          aBenchmarkReferences({ 'CW8.PA': freed ? { freed: true } : { kept: true } }),
        )
      }),
    )
    server.use(
      http.get(ROUTES.benchmarkReferences, () =>
        HttpResponse.json(aBenchmarkReferences({ 'CW8.PA': { kept: true } })),
      ),
    )
    const { user } = renderApp({ url: '/settings#portfolio-references' })

    await user.click(await screen.findByRole('button', { name: 'Ne plus conserver l’historique' }))

    expect(
      await screen.findByText(/Historique libéré : il partira au prochain nettoyage/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(
      await screen.findByRole('button', { name: 'Ne plus conserver l’historique' }),
    ).toBeInTheDocument()
  })

  it('says a refusal once, and the switch stays where the server holds it', async () => {
    serve(aBenchmarkReferences(), [])
    server.use(
      http.put(ROUTES.settings, () =>
        HttpResponse.json(
          { type: PROBLEM_TYPES.invalidSetting, title: 'Invalid setting', status: 422 },
          { status: 422 },
        ),
      ),
    )
    const { user } = renderApp({ url: '/settings#portfolio-references' })

    await user.click(await row('Suivre CAC 40'))

    await waitFor(() => expect(document.querySelector('[data-slot="alert"]')).not.toBeNull())
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Suivre CAC 40' })).toHaveAttribute(
        'aria-checked',
        'false',
      ),
    )
  })

  it('forgets a refusal when the sheet is closed', async () => {
    serve(aBenchmarkReferences(), [])
    server.use(
      http.put(ROUTES.settings, () =>
        HttpResponse.json(
          { type: PROBLEM_TYPES.invalidSetting, title: 'Invalid setting', status: 422 },
          { status: 422 },
        ),
      ),
    )
    const { user } = renderApp({ url: '/settings#portfolio-references' })
    await user.click(await row('Suivre CAC 40'))
    await waitFor(() => expect(document.querySelector('[data-slot="alert"]')).not.toBeNull())

    await user.click(screen.getByRole('button', { name: 'Fermer' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Gérer' }))

    await screen.findByRole('dialog', { name: SHEET })
    expect(document.querySelector('[data-slot="alert"]')).toBeNull()
  })

  it('says a failed read with Unreadable and no skeleton', async () => {
    server.use(
      http.get(ROUTES.benchmarkReferences, () =>
        HttpResponse.json(
          { type: PROBLEM_TYPES.storageUnavailable, title: 'storage unavailable', status: 503 },
          { status: 503 },
        ),
      ),
    )
    renderApp({ url: '/settings#portfolio-references' })

    const dialog = await screen.findByRole('dialog', { name: SHEET })
    await waitFor(() => expect(dialog.querySelector('[data-empty]')).not.toBeNull())
    expect(within(dialog).queryAllByRole('switch')).toHaveLength(0)
  })
})
