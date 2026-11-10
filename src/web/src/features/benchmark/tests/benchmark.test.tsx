/**
 * The comparison screen (#760) — *the same money, in one fund instead*, in the
 * « Relevé » composition.
 *
 * At the seam every page test here uses: the whole app in jsdom, HTTP the only
 * faked edge, every assertion on the accessible rendering. The arithmetic is
 * the server's and is never recomputed here.
 *
 * What this file is about is the readings the screen has to keep apart:
 *
 *  - **while the fund's history is being rebuilt, no figure at all** — head
 *    included. That is the likeliest shipping bug of the whole ticket, because
 *    a gap over a half-built series looks exactly like a gap;
 *  - **the answer is a sentence**, whose figures are mono and whose gap takes no
 *    sign colour: it is money not made, not money lost;
 *  - **truncation is a caption on a present figure**, not an absence.
 */
import { screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { BenchmarkResponse } from '@/features/benchmark/lib/api'
import { inRange } from '@/features/benchmark/lib/comparison'
import { ROUTES } from '@/lib/api'
import { aBenchmark, aBenchmarkReferences } from '@/test/factories'
import { expectNoBox } from '@/test/noBox'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

function renderBenchmark(payload: Partial<BenchmarkResponse> = {}) {
  server.use(http.get(ROUTES.benchmark, () => HttpResponse.json(aBenchmark(payload))))
  return renderApp({ url: '/benchmark' })
}

/** A comparison that answered, behind by 837,20 € on 41 063 € put in. */
function ready(overrides: Partial<BenchmarkResponse> = {}): Partial<BenchmarkResponse> {
  return {
    state: 'ready',
    reference: 'CW8.PA',
    index: 'MSCI World',
    inception: '2009-06-16',
    followed: ['CW8.PA'],
    ready: ['CW8.PA'],
    covered_from: '2021-03-04',
    covered_to: '2026-11-06',
    ended: null,
    contributed: 41063,
    portfolio_value: 46975.4,
    reference_value: 47812.6,
    gap_gross: -837.2,
    portfolio_return: 0.144,
    reference_return: 0.164,
    ...overrides,
  }
}

/** The region the sentence, the marks and the bars share. */
const head = async () => (await screen.findByText(/dans le MSCI World\./)).closest('[aria-live]')

/** The statement, French spaces normalised so expectations stay readable. */
const sentence = async () =>
  ((await screen.findByText(/dans le MSCI World\./)).textContent ?? '').replace(/[  ]/g, ' ')

const picker = () => screen.findByRole('button', { name: /MSCI World/, expanded: false })

describe('the comparison', () => {
  it('leads with a sentence whose figure is mono, not with a bare amount', async () => {
    renderBenchmark(ready())

    expect(await sentence()).toBe(
      '837,20 € de moins qu’en plaçant le même argent dans le MSCI World.',
    )
    const statement = (await screen.findByText(/dans le MSCI World\./)) as HTMLElement
    expect(statement).toHaveClass('statement')
    expect(within(statement).getByText(/837,20/)).toHaveClass('fig')
    // No hero figure beside the sentence: hero and statement never share a screen.
    expect(document.querySelectorAll('.text-hero')).toHaveLength(0)
  })

  it('says how big the gap is next to the money it is a gap of', async () => {
    renderBenchmark(ready())

    const verdict = await screen.findByText(/investis aux mêmes dates/)
    const said = (verdict.textContent ?? '').replace(/[  ]/g, ' ')
    expect(said).toBe('soit 2,0 % des 41 063,00 € investis aux mêmes dates.')
    expect(within(verdict).getByText('41 063,00 €')).toHaveClass('fig')
  })

  it('explains what « Même argent investi » sums, so a reader can retrace it', async () => {
    renderBenchmark(ready())

    const explanation = await screen.findByText(/« Même argent investi » additionne/)
    expect(explanation).toHaveTextContent(/achats, moins vos ventes et les dividendes encaissés/)
    expect(explanation).toHaveTextContent(/attribution gratuite compte pour sa valeur déclarée/)
    expect(explanation).toHaveTextContent(/versement resté en liquidités n’en fait pas partie/)
  })

  it('reads ahead as « de plus » and a level finish as a plain sentence', async () => {
    const { unmount } = renderBenchmark(ready({ gap_gross: 1200 }))
    expect(await sentence()).toBe(
      '1 200,00 € de plus qu’en plaçant le même argent dans le MSCI World.',
    )
    unmount()

    renderBenchmark(ready({ gap_gross: 0 }))
    expect(
      await screen.findByText(
        'Vos titres et le MSCI World finissent au même montant, à l’euro près.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/investis aux mêmes dates/)).not.toBeInTheDocument()
  })

  it('files the money invested and the two returns apart, each return in its own sign colour', async () => {
    renderBenchmark(ready())

    await head()
    const marks = screen.getByLabelText('Repères')
    expect(within(marks).getByText('Même argent investi')).toBeInTheDocument()
    expect(within(marks).getByText(/41 063,00/)).toHaveClass('fig')
    expect(within(marks).getByText('+14,4 %')).toHaveClass('text-gain')
    expect(within(marks).getByText('+16,4 %')).toHaveClass('text-gain')
    expect(within(marks).getByText('Gain du MSCI World')).toBeInTheDocument()
  })

  it('writes a loss as a loss and a shortfall in the colour of text', async () => {
    renderBenchmark(ready({ portfolio_return: -0.05 }))

    await head()
    expect(within(screen.getByLabelText('Repères')).getByText(/5,0 %/)).toHaveClass('text-loss')
    const statement = await screen.findByText(/dans le MSCI World\./)
    expect(statement).not.toHaveClass('text-loss')
    expect(statement).not.toHaveClass('text-gain')
  })

  it('draws the two values on one scale, in the chart hues', async () => {
    renderBenchmark(ready())

    const region = (await head()) as HTMLElement
    const fills = [...region.querySelectorAll('[data-share-bar] > span')].map((bar) => ({
      fill: bar.getAttribute('style'),
    }))
    expect(fills).toHaveLength(2)
    expect(fills[0].fill).toContain('var(--alloc-1)')
    expect(fills[0].fill).toContain('width: 98.2')
    expect(fills[1].fill).toContain('var(--alloc-5)')
    expect(fills[1].fill).toContain('width: 100%')
    expect(within(region).getByText('46 975,40 €')).toHaveClass('fig')
    expect(within(region).getByText('47 812,60 €')).toHaveClass('fig')
  })

  it('says the covered period in the header, after the page’s name', async () => {
    renderBenchmark(ready())

    await head()
    const header = screen.getByRole('banner')
    expect(
      within(header).getByRole('heading', { level: 1, name: 'Comparaison' }),
    ).toBeInTheDocument()
    expect(within(header).getByText('Comparé du 4 mars 2021 au 6 nov. 2026')).toBeInTheDocument()
  })

  it('writes no period line in the page itself', async () => {
    renderBenchmark(ready())

    await head()
    const main = screen.getByRole('main')
    const lines = Array.from(main.querySelectorAll('*')).filter((node) =>
      node.textContent?.startsWith('Comparé du'),
    )
    expect(lines).toHaveLength(0)
  })

  it('declares no period while the fund is rebuilt, nor with nothing to compare', async () => {
    const { unmount } = renderBenchmark({
      state: 'rebuilding',
      reference: 'CW8.PA',
      index: 'MSCI World',
      covered_from: '2009-06-16',
      covered_to: '2026-09-17',
      rebuild: {
        symbol: 'CW8.PA',
        reached: '2014-03-04',
        target: '2009-06-16',
        ratio: 0.55,
        requested: true,
        failing: false,
      },
    })
    await screen.findByRole('region', { name: /MSCI World en cours de téléchargement/ })
    expect(screen.getByRole('banner')).not.toHaveTextContent(/Comparé du/)
    unmount()

    renderBenchmark({
      state: 'nothing_to_compare',
      reason: 'no_events',
      reference: 'CW8.PA',
      index: 'MSCI World',
      followed: ['CW8.PA'],
      ready: ['CW8.PA'],
      covered_from: '2009-06-16',
      covered_to: '2026-09-17',
    })
    await picker()
    expect(screen.getByRole('banner')).not.toHaveTextContent(/Comparé du/)
  })

  it('puts the fund picker in the line above the sentence', async () => {
    renderBenchmark(ready())

    const trigger = await picker()
    const statement = await screen.findByText(/dans le MSCI World\./)
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    expect(
      trigger.compareDocumentPosition(statement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(trigger.parentElement).toHaveTextContent('Vos titres face au MSCI World')
  })

  it('renders no figure at all while the fund is still being rebuilt', async () => {
    renderBenchmark({
      state: 'rebuilding',
      reference: 'CW8.PA',
      index: 'MSCI World',
      rebuild: {
        symbol: 'CW8.PA',
        reached: '2014-03-04',
        target: '2009-06-16',
        ratio: 0.55,
        requested: true,
        failing: false,
      },
    })

    // The load-bearing rule: a gap computed over half a series is a **wrong**
    // number, not a short one — −38 % that repairs itself an hour later.
    expect(await screen.findByText(/MSCI World en cours de téléchargement/)).toBeInTheDocument()
    expect(screen.queryByText(/de moins qu’en plaçant/)).not.toBeInTheDocument()
    expect(screen.queryByText(/€/)).not.toBeInTheDocument()
  })

  it('withholds the figure when the fund’s splits were never established', async () => {
    renderBenchmark({
      state: 'splits_unknown',
      reference: 'CW8.PA',
      index: 'MSCI World',
      rebuild: {
        symbol: 'CW8.PA',
        reached: '2009-06-16',
        target: '2009-06-16',
        ratio: 1,
        requested: true,
        failing: false,
      },
    })

    // The series is complete and the ratios behind it are not, so a replay
    // counting units could walk through a split it cannot see. Same wait, same
    // panel: a second explanation for one wait is one explanation too many.
    expect(await screen.findByText(/MSCI World en cours de téléchargement/)).toBeInTheDocument()
    expect(screen.queryByText(/de moins qu’en plaçant/)).not.toBeInTheDocument()
  })

  it('sends the owner to the references when nothing is followed', async () => {
    renderBenchmark()

    expect(await screen.findByText('Aucun fonds de comparaison suivi')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Choisir les fonds' })).toHaveAttribute(
      'href',
      '/settings#portfolio-references',
    )
    expect(screen.queryByRole('button', { name: /MSCI World/ })).not.toBeInTheDocument()
    // No numbered steps and no promised duration.
    expect(screen.queryByText(/minutes/)).not.toBeInTheDocument()
  })

  it('names the fund being downloaded, with its bar and a way to the sheet', async () => {
    renderBenchmark({
      state: 'rebuilding',
      reference: 'CW8.PA',
      index: 'MSCI World',
      followed: ['CW8.PA'],
      ready: [],
      rebuild: {
        symbol: 'CW8.PA',
        reached: '2014-03-04',
        target: '2009-06-16',
        ratio: 0.555,
        requested: true,
        failing: false,
      },
    })

    const section = await screen.findByRole('region', {
      name: 'MSCI World en cours de téléchargement',
    })
    // Floored, not rounded: 55,5 % is 55.
    expect(
      within(section).getByText('Remonté jusqu’à mars 2014, sur juin 2009 · 55 %'),
    ).toBeInTheDocument()
    expect(within(section).getByRole('progressbar')).toHaveAttribute('value', '55')
    expect(within(section).getByRole('link', { name: 'Gérer les fonds' })).toHaveAttribute(
      'href',
      '/settings#portfolio-references',
    )
    // Nothing to pick while nothing is ready.
    expect(screen.queryByRole('button', { name: /MSCI World/ })).not.toBeInTheDocument()
  })
})

describe('the fund picker', () => {
  const followedTwo = () =>
    ready({ followed: ['CW8.PA', 'CSPX.AS', 'C40.PA'], ready: ['CW8.PA', 'CSPX.AS'] })

  it('lists the followed funds with their first year, and the way to add one', async () => {
    const { user } = renderBenchmark(followedTwo())

    await user.click(await picker())

    const list = await screen.findByRole('listbox', { name: 'Choisir le fonds de comparaison' })
    const options = within(list).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('CW8MSCI Worlddepuis 2009'),
      expect.stringContaining('CSPXS&P 500depuis 2010'),
      expect.stringContaining('C40CAC 40depuis 2008'),
    ])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('searchbox', { name: 'Rechercher un fonds…' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ajouter un fonds' })).toHaveAttribute(
      'href',
      '/settings#portfolio-references',
    )
    // A fund that is not followed is not a choice.
    expect(screen.queryByRole('option', { name: /Euro Stoxx/ })).not.toBeInTheDocument()
  })

  it('lists a fund still downloading, says how far it is, and cannot pick it', async () => {
    server.use(
      http.get(ROUTES.benchmarkReferences, () =>
        HttpResponse.json(
          aBenchmarkReferences({
            'CW8.PA': { followed: true, ready: true },
            'C40.PA': {
              followed: true,
              reached: '2013-03-01',
              target: '2008-01-02',
              ratio: 0.62,
            },
          }),
        ),
      ),
    )
    const { user } = renderBenchmark(ready({ followed: ['CW8.PA', 'C40.PA'], ready: ['CW8.PA'] }))

    await user.click(await picker())

    const cac = await screen.findByRole('option', { name: /CAC 40/ })
    expect(
      await within(cac.closest('[role="listbox"]') as HTMLElement).findByText(
        /téléchargement, 62 %/,
      ),
    ).toBeInTheDocument()
    expect(cac).toHaveAttribute('aria-disabled', 'true')
  })

  it('writes the chosen fund as the setting and nothing else', async () => {
    let body: unknown = null
    server.use(
      http.put(ROUTES.settings, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ saved: ['benchmark_symbol'], restart_required: [] })
      }),
    )
    const { user } = renderBenchmark(followedTwo())

    await user.click(await picker())
    await user.click(await screen.findByRole('option', { name: /S&P 500/ }))

    await screen.findByRole('button', { name: /MSCI World/, expanded: false })
    expect(body).toEqual({ benchmark_symbol: 'CSPX.AS' })
  })

  it('narrows the list with the search field', async () => {
    const { user } = renderBenchmark(followedTwo())

    await user.click(await picker())
    await user.type(await screen.findByRole('searchbox'), 'cac')

    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /CAC 40/ })).toBeInTheDocument()
  })
})

describe('the chart', () => {
  const series = [
    { t: '2024-01-01', portfolio: 1000, reference: 1000 },
    { t: '2024-01-02', portfolio: 1100, reference: 1050 },
  ]

  it('opens on the gap and offers the amounts as the other tab', async () => {
    const { user } = renderBenchmark(ready({ series }))

    const tabs = await screen.findByRole('tablist', { name: 'Lecture' })
    const [gap, amounts] = within(tabs).getAllByRole('tab')
    expect(gap).toHaveTextContent('Écart')
    expect(gap).toHaveAttribute('aria-selected', 'true')
    expect(amounts).toHaveTextContent('Montants')
    // The gap is drawn in euros against its zero line, with its own legend.
    expect(screen.getByText(/Écart, en euros, au fil du temps/)).toBeInTheDocument()
    expect(screen.queryByText('MSCI World, même argent investi')).not.toBeInTheDocument()

    await user.click(amounts)

    expect(amounts).toHaveAttribute('aria-selected', 'true')
    // The two curves are named by the index, never by the ticker.
    expect(await screen.findByText('MSCI World, même argent investi')).toBeInTheDocument()
    expect(screen.queryByText(/Écart, en euros, au fil du temps/)).not.toBeInTheDocument()
  })

  it('puts the period in words on the tabs’ rule', async () => {
    renderBenchmark(ready({ series }))

    const range = await screen.findByRole('radiogroup', { name: 'Période' })
    expect(
      within(range)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['1 mois', 'Cette année', '1 an', 'Tout'])
    expect(within(range).getByRole('radio', { name: 'Tout' })).toBeChecked()
  })

  it('narrows the window to the last month of the curve, not of the clock', () => {
    const days = ['2025-12-31', '2026-01-05', '2026-09-30', '2026-10-15', '2026-10-30']
    const points = days.map((t) => ({ t }))

    expect(inRange(points, '1M').map((p) => p.t)).toEqual(days.slice(2))
    expect(inRange(points, 'YTD').map((p) => p.t)).toEqual(days.slice(1))
    expect(inRange(points, '1Y').map((p) => p.t)).toEqual(days)
    expect(inRange(points, 'MAX')).toHaveLength(5)
    expect(inRange([], '1M')).toEqual([])
  })

  it('says it has nothing to draw rather than drawing an empty plot', async () => {
    renderBenchmark(ready({ series: [] }))

    // A fact, not a wait: the payload answered `ready`, so the period exists
    // and holds no drawable day.
    expect(await screen.findByText('Rien à tracer sur cette période.')).toBeInTheDocument()
  })

  it('keeps the plot reachable and says the shape, crossings included', async () => {
    const { user } = renderBenchmark(
      ready({
        // Chosen so the arrival is neither extreme: 1 050 is the last value and
        // must appear nowhere in the sentence, because the head announces today.
        series: [
          { t: '2024-01-02', portfolio: 1000, reference: 1000 },
          { t: '2024-01-03', portfolio: 1200, reference: 1000 },
          { t: '2024-01-04', portfolio: 900, reference: 1000 },
          { t: '2024-01-05', portfolio: 1050, reference: 1000 },
        ],
      }),
    )

    await user.click(await screen.findByRole('tab', { name: 'Montants' }))

    // The legend stays readable.
    const legend = await screen.findByText('MSCI World, même argent investi')
    expect(legend.closest('[aria-hidden]')).toBeNull()

    // The `<figure>` must not be hidden from a reader: the `<svg>` inside it is
    // focusable and its arrows walk the series.
    const figure = document.querySelector('figure')
    expect(figure).not.toBeNull()
    expect(figure?.closest('[aria-hidden]')).toBeNull()

    // French formats with narrow no-break spaces inside its figures.
    const said = (figure?.querySelector('figcaption')?.textContent ?? '').replace(/[  ]/g, ' ')
    expect(said).toContain(
      'Votre portefeuille et l’indice MSCI World, du 2 janv. 2024 au 5 janv. 2024',
    )
    expect(said).toContain('plus haut 1 200,00 € le 3 janv. 2024')
    expect(said).toContain('croise l’indice MSCI World 2 fois, la dernière le 5 janv. 2024')
    // **The arrival is never stated.** The head carries today (#1051).
    expect(said).not.toContain('1 050,00')
  })

  it('reads the gap against its zero line on the first tab', async () => {
    renderBenchmark(
      ready({
        series: [
          { t: '2024-01-02', portfolio: 1000, reference: 1000 },
          { t: '2024-01-03', portfolio: 1200, reference: 1000 },
          { t: '2024-01-04', portfolio: 900, reference: 1000 },
        ],
      }),
    )

    await screen.findByText(/Écart, en euros, au fil du temps/)
    const said = (document.querySelector('figcaption')?.textContent ?? '').replace(/[  ]/g, ' ')
    expect(said).toContain('Écart, du 2 janv. 2024 au 4 janv. 2024')
    expect(said).toContain('plus haut 200,00 € le 3 janv. 2024')
    expect(said).toContain('plus bas -100,00 € le 4 janv. 2024')
  })

  it('announces the head as the result of a gesture, politely', async () => {
    renderBenchmark(ready())

    expect(await head()).toHaveAttribute('aria-live', 'polite')
  })
})

describe('what the period costs', () => {
  it('captions a truncated history on a figure that is present', async () => {
    renderBenchmark(
      ready({
        reference: 'WPEA.PA',
        index: 'MSCI World',
        inception: '2024-04-02',
        covered_from: '2024-04-02',
        // The server decides who truncated: here the portfolio predates the
        // fund by eleven years, so the fund is the cause and may be named.
        portfolio_from: '2013-01-02',
        truncated_by_fund: true,
      }),
    )

    // Not an absence: the answer is complete and correct over a shorter window,
    // so it is a caption and the sentence stays.
    expect(
      await screen.findByText(/Comparé depuis le .*premier cours de ce fonds/),
    ).toBeInTheDocument()
    expect(screen.getByText(/11 années antérieures ne sont pas dans cet écart/)).toBeInTheDocument()
    expect(await sentence()).toContain('837,20 € de moins')
  })

  it('captions it inside the head, under the verdict', async () => {
    renderBenchmark(
      ready({
        covered_from: '2024-04-02',
        portfolio_from: '2013-01-02',
        truncated_by_fund: true,
      }),
    )

    const region = (await head()) as HTMLElement
    expect(within(region).getByText(/premier cours de ce fonds/)).toBeInTheDocument()
  })

  it('does not blame the fund for a period its own accounts shortened', async () => {
    renderBenchmark(
      ready({
        // The fund is quoted since 2009; the account simply opened in 2024.
        inception: '2009-06-16',
        covered_from: '2024-02-26',
        portfolio_from: '2024-02-26',
        truncated_by_fund: false,
      }),
    )

    await head()
    expect(screen.queryByText(/premier cours de ce fonds/)).not.toBeInTheDocument()
  })

  it('says when the reference ran out rather than carrying a frozen figure', async () => {
    renderBenchmark(ready({ ended: 'exhausted', covered_to: '2019-03-14' }))

    const region = (await head()) as HTMLElement
    expect(
      await within(region).findByText(
        /une sortie de titres à cette date, le fonds n’aurait pas pu la financer/,
      ),
    ).toBeInTheDocument()
  })

  it('counts whole elapsed years and not a difference of year parts', async () => {
    renderBenchmark(
      ready({
        // 31 Dec 2023 → 1 Jan 2024 is one day, not "a year".
        portfolio_from: '2023-12-31',
        covered_from: '2024-01-01',
        truncated_by_fund: true,
      }),
    )

    await head()
    expect(screen.queryByText(/année.* antérieure/)).not.toBeInTheDocument()
  })

  it('counts the year only once it has actually elapsed', async () => {
    renderBenchmark(
      ready({
        portfolio_from: '2013-05-10',
        covered_from: '2024-04-02',
        truncated_by_fund: true,
      }),
    )

    // Ten years and eleven months: ten, not eleven.
    expect(
      await screen.findByText(/10 années antérieures ne sont pas dans cet écart/),
    ).toBeInTheDocument()
  })
})

describe('the unit every figure is in', () => {
  it('says why the page is empty from the payload, not from a second read', async () => {
    // The config guard reads a different request. When that one is slow or
    // refuses, the page would render amounts with no unit on the strength of
    // a predicate that never ran — so the comparison's own `base_currency`
    // decides too.
    server.use(http.get(ROUTES.config, () => new Promise(() => {})))
    renderBenchmark(ready({ base_currency: null }))

    expect(await screen.findByText('Aucune devise de base')).toBeInTheDocument()
    expect(screen.queryByText(/de moins qu’en plaçant/)).not.toBeInTheDocument()
    expect(screen.getByRole('banner')).not.toHaveTextContent(/Comparé du/)
  })
})

describe('each account over its own period', () => {
  /** A PEA running since 2021 beside a CTO opened in 2023 — the mockup's case. */
  const TWO_ACCOUNTS = [
    {
      account: 'PEA',
      covered_from: '2021-03-04',
      covered_to: '2026-11-06',
      ended: null,
      contributed: 36285,
      portfolio_value: 41618.79,
      reference_value: 42131.19,
      gap_gross: -512.4,
      portfolio_return: 0.147,
      reference_return: 0.161,
    },
    {
      account: 'Compte-titres',
      covered_from: '2023-09-12',
      covered_to: '2026-11-06',
      ended: null,
      contributed: 4800,
      portfolio_value: 5356.61,
      reference_value: 5681.41,
      gap_gross: -324.8,
      portfolio_return: 0.112,
      reference_return: 0.18,
    },
  ]

  it('states each account’s own period beside its own figures and returns', async () => {
    renderBenchmark(ready({ per_account: TWO_ACCOUNTS }))

    const row = (await screen.findByText('PEA')).closest('tr') as HTMLElement
    expect(within(row).getByText('Du 4 mars 2021 au 6 nov. 2026')).toBeInTheDocument()
    expect(within(row).getByText('41 618,79 €').closest('td')).toHaveClass('fig')
    expect(within(row).getByText('+14,7 %')).toHaveClass('text-xs')
    expect(within(row).getByText('42 131,19 €')).toBeInTheDocument()
    expect(within(row).getByText('+16,1 %')).toBeInTheDocument()
    expect(within(row).getByText('-512,40 €')).toBeInTheDocument()
  })

  it('names the five columns, the fund’s after « Dans le »', async () => {
    renderBenchmark(ready({ per_account: TWO_ACCOUNTS }))

    const table = (await screen.findByText('PEA')).closest('table') as HTMLElement
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Compte', 'Période', 'Vos titres', 'Dans le MSCI World', 'Écart'])
  })

  it('prints the head at the foot of the gaps it is the sum of', async () => {
    renderBenchmark(ready({ per_account: TWO_ACCOUNTS }))

    const total = (await screen.findByText('Ensemble')).closest('tr') as HTMLElement
    expect(within(total).getByText('46 975,40 €')).toBeInTheDocument()
    expect(within(total).getByText('47 812,60 €')).toBeInTheDocument()
    expect(within(total).getByText('-837,20 €')).toBeInTheDocument()
  })

  it('writes each gap in the colour of text, never as a loss', async () => {
    renderBenchmark(ready({ per_account: TWO_ACCOUNTS }))

    for (const gap of ['-512,40 €', '-324,80 €']) {
      const figure = await screen.findByText(gap)
      expect(figure).not.toHaveClass('text-loss')
      expect(figure).not.toHaveClass('text-gain')
    }
  })

  it('says on the row itself why that account’s own period ended early', async () => {
    renderBenchmark(
      ready({
        per_account: [
          { ...TWO_ACCOUNTS[0], ended: 'exhausted', covered_to: '2021-03-14' },
          TWO_ACCOUNTS[1],
        ],
      }),
    )

    // The head ran on — the other account's money funded the withdrawal this
    // one's reference could not — so the reason belongs on the row alone.
    const row = (await screen.findByText('PEA')).closest('tr') as HTMLElement
    expect(within(row).getByText(/Arrêté là/)).toBeInTheDocument()
    const other = (await screen.findByText('Compte-titres')).closest('tr') as HTMLElement
    expect(within(other).queryByText(/Arrêté là/)).toBeNull()
  })

  it('has no total to print where there is no head', async () => {
    renderBenchmark({
      state: 'nothing_to_compare',
      reason: 'no_rate_on_seed',
      reference: 'CW8.PA',
      index: 'MSCI World',
      followed: ['CW8.PA'],
      ready: ['CW8.PA'],
      per_account: TWO_ACCOUNTS,
    })

    const row = (await screen.findByText('PEA')).closest('tr') as HTMLElement
    expect(within(row).getByText('-512,40 €')).toBeInTheDocument()
    expect(screen.queryByText('Ensemble')).not.toBeInTheDocument()
    expect(screen.getByText('Total non comparable')).toBeInTheDocument()
  })

  it('renders nothing on a single account, where the row repeats the head', async () => {
    renderBenchmark(ready({ per_account: [TWO_ACCOUNTS[0]] }))

    await head()
    expect(screen.queryByText('PEA')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Compte par compte' })).not.toBeInTheDocument()
  })
})

describe('nothing to compare', () => {
  it('still sends an empty ledger to the ledger', async () => {
    renderBenchmark({
      state: 'nothing_to_compare',
      reason: 'no_events',
      reference: 'CW8.PA',
      index: 'MSCI World',
      followed: ['CW8.PA'],
      ready: ['CW8.PA'],
    })

    expect(await screen.findByText(/Enregistrez vos premiers événements/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Aller au grand livre' })).toBeInTheDocument()
  })

  // #1207: four causes, and only one of them is an empty ledger.
  it.each([
    ['not_computed', 'Calcul en cours', /pas encore calculées/, false],
    ['nothing_held', 'Rien à comparer', /pas sur les liquidités/, true],
    ['no_rate_on_seed', 'Total non comparable', /un taux de change manque/, false],
    ['never_priced', 'Aucun cours reçu', /aucune courbe à comparer/, false],
    [undefined, 'Rien à comparer pour l’instant', /Enregistrez vos premiers événements/, true],
    ['from_a_newer_server', 'Rien à comparer pour l’instant', /Enregistrez/, true],
  ] as const)('names why there is nothing to compare: %s', async (reason, title, body, link) => {
    renderBenchmark({
      state: 'nothing_to_compare',
      reason: reason as BenchmarkResponse['reason'],
      reference: 'CW8.PA',
      index: 'MSCI World',
      followed: ['CW8.PA'],
      ready: ['CW8.PA'],
    })

    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(screen.getByText(body)).toBeInTheDocument()
    expect(Boolean(screen.queryByRole('link', { name: 'Aller au grand livre' }))).toBe(link)
    if (reason !== undefined && reason !== 'from_a_newer_server') {
      expect(screen.queryByText(/Enregistrez vos premiers événements/)).not.toBeInTheDocument()
    }
  })

  it('sends a reference the market answered empty to the System page, no duration (#1510)', async () => {
    renderBenchmark({
      state: 'nothing_to_compare',
      reason: 'never_priced',
      reference: 'CW8.PA',
      index: 'MSCI World',
      followed: ['CW8.PA'],
      ready: [],
    })

    expect(await screen.findByRole('link', { name: 'Voir la page Système' })).toHaveAttribute(
      'href',
      '/system',
    )
    expect(screen.queryByText(/vient de commencer|retenté/)).not.toBeInTheDocument()
  })
})

describe('the page sits on the ground (#1273)', () => {
  const series = [
    { t: '2024-01-01', portfolio: 1000, reference: 1000 },
    { t: '2024-01-02', portfolio: 1100, reference: 1050 },
  ]
  const per_account = ['PEA', 'CTO'].map((account) => ({
    account,
    covered_from: '2021-03-04',
    covered_to: '2026-11-06',
    ended: null,
    portfolio_value: 48_200,
    reference_value: 43_988,
    gap_gross: 4212,
    portfolio_return: 0.181,
    reference_return: 0.078,
  }))
  const rebuild = {
    symbol: 'CW8.PA',
    reached: '2014-03-04',
    target: '2009-06-16',
    ratio: 0.55,
    requested: true,
    failing: false,
  }

  it('draws only the account breakdown as a section, under the sentence and the chart', async () => {
    renderBenchmark(ready({ series, per_account }))

    const accounts = await screen.findByRole('region', { name: 'Compte par compte' })
    expect(accounts.closest('[data-slot="section"]')).toBe(accounts)
    expect(document.querySelectorAll('[data-slot="section"]')).toHaveLength(1)
    expectNoBox()
  })

  it('draws no box while the fund is rebuilt, and states it in a section', async () => {
    renderBenchmark({ state: 'rebuilding', reference: 'CW8.PA', index: 'MSCI World', rebuild })

    const section = await screen.findByRole('region', {
      name: /MSCI World en cours de téléchargement/,
    })
    expect(within(section).getByRole('progressbar')).toBeInTheDocument()
    expectNoBox()
  })

  it('draws no box with nothing to compare', async () => {
    renderBenchmark({
      state: 'nothing_to_compare',
      reason: 'no_events',
      reference: 'CW8.PA',
      index: 'MSCI World',
      followed: ['CW8.PA'],
      ready: ['CW8.PA'],
      per_account,
    })

    await screen.findByText(/Enregistrez vos premiers événements/)
    expectNoBox()
  })
})
