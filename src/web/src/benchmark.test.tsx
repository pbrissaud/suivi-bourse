/**
 * The comparison screen (#760) — *the same money, in one fund instead*.
 *
 * At the seam every page test here uses: the whole app in jsdom, HTTP the only
 * faked edge, every assertion on the accessible rendering. The arithmetic is
 * the server's and is never recomputed here.
 *
 * What this file is about is the five readings the screen has to keep apart:
 *
 *  - **while the fund's history is being rebuilt, no figure at all** — head
 *    included. That is the likeliest shipping bug of the whole ticket, because
 *    a gap over a half-built series looks exactly like a gap;
 *  - **the verdict is the gross one**, and the after-tax reading is a second
 *    look at the same slot rather than a second verdict;
 *  - **the inversion line is silent unless the two signs actually differ** —
 *    not on *the accounts have different rates*, which is true of nearly every
 *    French owner and would be a permanent warning nobody reads;
 *  - **truncation is a caption on a present figure**, not an absence;
 *  - **no after-tax figure at all when one account cannot project**, and that
 *    account is named. A net short by one wrapper reads like a net that is
 *    right.
 */
import { screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES, type BenchmarkResponse } from '@/lib/api'
import { aBenchmark } from '@/test/factories'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

function renderBenchmark(payload: Partial<BenchmarkResponse> = {}) {
  server.use(http.get(ROUTES.benchmark, () => HttpResponse.json(aBenchmark(payload))))
  return renderApp({ url: '/benchmark' })
}

/** A comparison that answered, ahead by 4 210 € over 2009–2026. */
function ready(overrides: Partial<BenchmarkResponse> = {}): Partial<BenchmarkResponse> {
  return {
    state: 'ready',
    reference: 'CW8.PA',
    index: 'MSCI World',
    inception: '2009-06-16',
    consulted: ['CW8.PA'],
    covered_from: '2009-06-16',
    covered_to: '2026-09-17',
    ended: null,
    gap_gross: 4212.8,
    gap_net: 3000,
    net_unavailable: [],
    portfolio_tax: 1500,
    reference_tax: 287.2,
    portfolio_return: 0.112,
    reference_return: 0.048,
    excluded_accounts: [],
    ...overrides,
  }
}

const head = () => screen.findByRole('group', { name: /MSCI World/ })

/** The ticker as the reader meets it: without the venue suffix of the fetch. */
const EYEBROW = /MSCI World\s*·\s*CW8$/

describe('the comparison', () => {
  it('leads with the euro and files the percentages one weight down', async () => {
    renderBenchmark(ready())

    // The euro and the percentage never share a line: the head answers *how
    // much is left*, and the gap in points sits in the terms row under it.
    expect(within(await head()).getByText('+4 212,80 €')).toBeInTheDocument()
    within(screen.getByRole('group', { name: 'Écart en points' })).getByText('+6,4 %')
    within(screen.getByRole('group', { name: 'Votre portefeuille' })).getByText('+11,2 %')
    within(screen.getByRole('group', { name: 'La référence' })).getByText('+4,8 %')
  })

  it('says the gap was made with the same contributions, which is the whole claim', async () => {
    renderBenchmark(ready())

    // Drop the trailing clause and the screen lies without a line of wrong
    // code: the reader takes the gap for a difference of returns, and it is a
    // replay of their own flows.
    expect(
      await screen.findByText(/de plus que le MSCI World, sur la même période/),
    ).toBeInTheDocument()
    expect(screen.getByText(/avec les mêmes versements/)).toBeInTheDocument()
  })

  it('states the covered period, always', async () => {
    renderBenchmark(ready())

    expect(await screen.findByText(/Comparé du .* au /)).toBeInTheDocument()
  })

  it('names the fund by its index, with the ticker subordinate and unsuffixed', async () => {
    renderBenchmark(ready())

    // `.PA` is where the fetch goes, not what the fund is called. The selector
    // already drops it, and the eyebrow is the one place the reader meets it.
    // Read off the head's own accessible name, which **is** the eyebrow: the
    // selector renders the same string one row down, and asserting on the
    // document would not say which of the two was checked.
    expect((await head()).getAttribute('aria-label')).toMatch(EYEBROW)
  })

  it('renders no figure at all while the fund is still being rebuilt', async () => {
    renderBenchmark({
      state: 'rebuilding',
      reference: 'CW8.PA',
      index: 'MSCI World',
      rebuild: { symbol: 'CW8.PA', reached: '2014-03-04', target: '2009-06-16', ratio: 0.55 },
    })

    // The load-bearing rule: a gap computed over half a series is a **wrong**
    // number, not a short one — −38 % that repairs itself an hour later.
    expect(await screen.findByText(/Reconstitution de l’historique de CW8.PA/)).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /MSCI World/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/€/)).not.toBeInTheDocument()
  })

  it('withholds the figure when the fund’s splits were never established', async () => {
    renderBenchmark({
      state: 'splits_unknown',
      reference: 'CW8.PA',
      index: 'MSCI World',
      rebuild: { symbol: 'CW8.PA', reached: '2009-06-16', target: '2009-06-16', ratio: 1 },
    })

    // The series is complete and the ratios behind it are not, so a replay
    // counting units could walk through a split it cannot see. Same wait, same
    // panel: a second explanation for one wait is one explanation too many.
    expect(await screen.findByText(/Reconstitution de l’historique de CW8.PA/)).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /MSCI World/ })).not.toBeInTheDocument()
  })

  it('offers the selector as the empty state’s own action', async () => {
    renderBenchmark()

    expect(await screen.findByText('Aucune référence choisie')).toBeInTheDocument()
    // The one way out **is** the control, not a link to where the control is.
    // Named for what it is a reference **for**: *Référence* alone is the page's
    // own title, and a control sharing its page's name says nothing.
    expect(
      screen.getByRole('combobox', { name: 'Référence de comparaison' }),
    ).toBeInTheDocument()
    // And the wait is announced before it is discovered.
    expect(screen.getByText(/la page se remplira toute seule/)).toBeInTheDocument()
  })
})

describe('the two curves', () => {
  const series = [
    { t: '2024-01-01', portfolio: 1000, reference: 1000 },
    { t: '2024-01-02', portfolio: 1100, reference: 1050 },
  ]

  it('names the index and never the ticker', async () => {
    renderBenchmark(ready({ series }))

    // `CW8.PA` is an address; the MSCI World is what the owner is being
    // compared against, and the legend is what pairs a curve to its name. The
    // trailing clause is the same one the verdict carries — read off the chart
    // rather than off the sentence, the two curves would otherwise look like
    // two returns.
    expect(await screen.findByText('MSCI World, mêmes versements')).toBeInTheDocument()
    // The portfolio's own name is deliberately the one the terms row already
    // uses: one thing, one name, twice on the screen.
    expect(screen.getAllByText('Votre portefeuille').length).toBeGreaterThan(1)
  })

  it('says it has nothing to draw rather than drawing an empty plot', async () => {
    renderBenchmark(ready({ series: [] }))

    // A fact, not a wait: the payload answered `ready`, so the period exists
    // and holds no drawable day.
    expect(await screen.findByText('Rien à tracer sur cette période.')).toBeInTheDocument()
  })
})

describe('the after-tax reading', () => {
  it('is a second look at the same slot, and the verdict stays the gross one', async () => {
    const { user } = renderBenchmark(ready())

    expect(within(await head()).getByText('+4 212,80 €')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Net d’impôt' }))

    expect(within(await head()).getByText('+3 000,00 €')).toBeInTheDocument()
  })

  it('warns that the ranking flips, on the gross verdict the reader is looking at', async () => {
    renderBenchmark(ready({ gap_gross: 4212.8, gap_net: -900 }))

    // The verdict stays the gross one, and the line is the warning that it
    // does not survive tax — said **beside** the figure it qualifies rather
    // than hidden behind the toggle that would reveal it.
    expect(within(await head()).getByText('+4 212,80 €')).toBeInTheDocument()
    expect(
      screen.getByText(/le classement s’inverse : vous passez derrière/),
    ).toBeInTheDocument()
  })

  it('stays silent when both readings agree, whatever the rates behind them', async () => {
    const { user } = renderBenchmark(ready({ gap_gross: 4212.8, gap_net: 3000 }))
    await head()
    await user.click(screen.getByRole('button', { name: 'Net d’impôt' }))

    // Two accounts at two rates is nearly every French owner. Said here it
    // would be a permanent warning, which is a warning nobody reads.
    expect(screen.queryByText(/le classement s’inverse/)).not.toBeInTheDocument()
  })

  it('is absent entirely when one account cannot project, and names it', async () => {
    const { user } = renderBenchmark(
      ready({ gap_net: null, net_unavailable: [{ account: 'cto', reason: 'no_model' }] }),
    )

    // The gross side is untouched — the account's own figures are not in doubt.
    expect(within(await head()).getByText('+4 212,80 €')).toBeInTheDocument()
    expect(screen.getByText(/cto/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Net d’impôt' }))

    // A net summed over the accounts that happened to project is a figure the
    // owner reads as their own and that is short by a wrapper.
    expect(within(await head()).getByText('—')).toBeInTheDocument()
  })
})

describe('what the period costs, and what the comparison did not account for', () => {
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
    // so it is a caption and the figure stays.
    expect(await screen.findByText(/Comparé depuis le .*premier cours de ce fonds/)).toBeInTheDocument()
    expect(screen.getByText(/11 années antérieures ne sont pas dans cet écart/)).toBeInTheDocument()
    expect(within(await head()).getByText('+4 212,80 €')).toBeInTheDocument()
  })

  it('does not blame the fund for a period its own accounts shortened', async () => {
    renderBenchmark(
      ready({
        // The fund is quoted since 2009; the account simply opened in 2024.
        // Same date on screen, and *this fund's first close* would send the
        // reader hunting for a history that is sitting right there.
        inception: '2009-06-16',
        covered_from: '2024-02-26',
        portfolio_from: '2024-02-26',
        truncated_by_fund: false,
      }),
    )

    expect(await screen.findByText(/Comparé du .* au /)).toBeInTheDocument()
    expect(screen.queryByText(/premier cours de ce fonds/)).not.toBeInTheDocument()
  })

  it('says when the reference ran out rather than carrying a frozen figure', async () => {
    renderBenchmark(ready({ ended: 'exhausted', covered_to: '2019-03-14' }))

    expect(
      await screen.findByText(/un retrait de cette date, la référence n’aurait pas pu le financer/),
    ).toBeInTheDocument()
  })

  it('names the idle cash rather than correcting the comparison for it', async () => {
    renderBenchmark(ready({ idle_cash: 12_000 }))

    // The replay puts every euro to work the day it lands. Hiding the
    // difference would let the comparison look unfair with nothing saying why.
    expect(await screen.findByText(/de liquidités/)).toBeInTheDocument()
  })

  it('names an account a grant with no declared price took out of the perimeter', async () => {
    renderBenchmark(
      ready({
        excluded_accounts: [{ account: 'pee', reason: 'undeclared_grant', symbols: 'ACME' }],
      }),
    )

    expect(await screen.findByText(/pee.*exclu.*sans prix déclaré/)).toBeInTheDocument()
  })
})


describe('the contract a non-visual reader gets', () => {
  it('reads the head back when the reference or the reading changes', async () => {
    const { user } = renderBenchmark(ready())

    // The result of a **gesture**, not an ambient state — so it is announced,
    // and politely: the reader is already looking at the control they pressed
    // and an assertive region would interrupt them mid-sentence.
    const card = (await head()).closest('[aria-live]')
    expect(card).toHaveAttribute('aria-live', 'polite')

    await user.click(screen.getByRole('button', { name: 'Net d’impôt' }))

    expect(within(await head()).getByText('+3 000,00 €')).toBeInTheDocument()
  })

  it('hides the plot and leaves the legend readable', async () => {
    renderBenchmark(
      ready({
        series: [
          { t: '2024-01-01', portfolio: 1000, reference: 1000 },
          { t: '2024-01-02', portfolio: 1100, reference: 1050 },
        ],
      }),
    )

    // Honest here and only here: the whole answer is in the head, in prose and
    // in figures, so what is lost is the shape. The legend is what says which
    // curve was which, and it stays.
    const legend = await screen.findByText('MSCI World, mêmes versements')
    expect(legend.closest('[aria-hidden]')).toBeNull()
    expect(document.querySelector('.recharts-wrapper')?.closest('[aria-hidden]')).not.toBeNull()
  })

  it('names the toggle as a switch between two readings, not as a setting', async () => {
    renderBenchmark(ready())
    await head()

    // `aria-pressed` and not a radiogroup: it swaps what the slot below draws,
    // and the page has no other setting for it to be one of.
    const gross = screen.getByRole('button', { name: 'Brut' })
    expect(gross).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })
})

describe('what truncation is counted in', () => {
  it('counts whole elapsed years and not a difference of year parts', async () => {
    renderBenchmark(
      ready({
        // 31 Dec 2023 → 1 Jan 2024 is one day, not "a year": subtracting the
        // year parts would tell the owner a whole year of their history is
        // outside a gap that misses a day of it.
        portfolio_from: '2023-12-31',
        covered_from: '2024-01-01',
        truncated_by_fund: true,
      }),
    )

    expect(await screen.findByText(/Comparé du .* au /)).toBeInTheDocument()
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
    expect(screen.queryByRole('group', { name: /MSCI World/ })).not.toBeInTheDocument()
  })
})
