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
    accounts: ['pea'],
    portfolio_value: 54_212.8,
    reference_value: 50_000,
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
    expect(screen.getByRole('combobox', { name: 'Référence' })).toBeInTheDocument()
    // And the wait is announced before it is discovered.
    expect(screen.getByText(/la page se remplira toute seule/)).toBeInTheDocument()
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
        inception: '2013-01-02',
        covered_from: '2024-04-02',
      }),
    )

    // Not an absence: the answer is complete and correct over a shorter window,
    // so it is a caption and the figure stays.
    expect(await screen.findByText(/Comparé depuis le .*premier cours de ce fonds/)).toBeInTheDocument()
    expect(screen.getByText(/11 années antérieures ne sont pas dans cet écart/)).toBeInTheDocument()
    expect(within(await head()).getByText('+4 212,80 €')).toBeInTheDocument()
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
