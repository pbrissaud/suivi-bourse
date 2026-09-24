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
 *  - **one reading and one verdict** since #1018 took the tax out: both sides
 *    sit in the same wrapper, so the tax answered a question about the wrapper;
 *  - **truncation is a caption on a present figure**, not an absence.
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

  it('says the gap was made with the same money invested, which is the whole claim', async () => {
    renderBenchmark(ready())

    // Drop the trailing clause and the screen lies without a line of wrong
    // code: the reader takes the gap for a difference of returns, and it is a
    // replay of their own purchases.
    expect(
      await screen.findByText(/de plus que le MSCI World, sur la même période/),
    ).toBeInTheDocument()
    expect(screen.getByText(/avec le même argent investi/)).toBeInTheDocument()
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
    expect(await screen.findByText('MSCI World, même argent investi')).toBeInTheDocument()
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

describe('what the head says, and only that', () => {
  it('prints the gap alone, with no second statement under it', async () => {
    renderBenchmark(ready())

    // #1020 printed the date effect under the verdict; the redesign took it
    // off the screen and #1048 took it out of the payload.
    expect(within(await head()).getByText('+4 212,80 €')).toBeInTheDocument()
    expect(screen.queryByText(/Vos dates/)).not.toBeInTheDocument()
  })

  it('keeps the selector on a page that answered', async () => {
    renderBenchmark(ready())

    await head()
    expect(screen.getByRole('combobox', { name: 'Référence de comparaison' })).toBeInTheDocument()
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
      await screen.findByText(/une sortie de titres à cette date, la référence n’aurait pas pu la financer/),
    ).toBeInTheDocument()
  })

  it('names the grant, and not just the account, that left the perimeter', async () => {
    renderBenchmark(
      ready({
        excluded_accounts: [
          { account: 'pee', reason: 'undeclared_grant', symbols: 'ACME,WIDGET' },
        ],
      }),
    )

    // The account alone is not actionable: the reader has to know which line
    // to go and price.
    expect(
      await screen.findByText(/pee.*ACME, WIDGET.*sans prix déclaré/),
    ).toBeInTheDocument()
  })
})


describe('the contract a non-visual reader gets', () => {
  it('reads the head back when the reference changes', async () => {
    renderBenchmark(ready())

    // The result of a **gesture**, not an ambient state — so it is announced,
    // and politely: the reader is already looking at the control they pressed
    // and an assertive region would interrupt them mid-sentence.
    const card = (await head()).closest('[aria-live]')
    expect(card).toHaveAttribute('aria-live', 'polite')
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
    const legend = await screen.findByText('MSCI World, même argent investi')
    expect(legend.closest('[aria-hidden]')).toBeNull()
    expect(document.querySelector('.recharts-wrapper')?.closest('[aria-hidden]')).not.toBeNull()
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

describe('each account over its own period', () => {
  /** A PEA running since 2019 beside a CTO opened in 2024 — the ticket's case. */
  const TWO_ACCOUNTS = [
    {
      account: 'PEA.LCL',
      covered_from: '2019-10-30',
      covered_to: '2026-09-17',
      ended: null,
      portfolio_value: 48_200,
      reference_value: 43_988,
      gap_gross: 4212,
      portfolio_return: 0.181,
      reference_return: 0.078,
    },
    {
      account: 'CTO.BD',
      covered_from: '2024-02-26',
      covered_to: '2026-09-17',
      ended: null,
      portfolio_value: 9_100,
      reference_value: 9_800,
      gap_gross: -700,
      portfolio_return: 0.021,
      reference_return: 0.055,
    },
  ]

  it('gives the older account back the years the younger one cut off the head', async () => {
    renderBenchmark(ready({ covered_from: '2024-02-26', per_account: TWO_ACCOUNTS }))

    // The head compares from February 2024 because a second account exists,
    // and that is 63 % of this owner's investing life outside the only screen
    // that judges it. The row says 2019.
    const row = (await screen.findByText('PEA.LCL')).closest('tr') as HTMLElement
    expect(within(row).getByText(/2019/)).toBeInTheDocument()
    expect(within(row).getByText('+4 212,00 €')).toBeInTheDocument()
    expect(within(row).getByText('+18,1 %')).toBeInTheDocument()
    expect(within(row).getByText('+7,8 %')).toBeInTheDocument()
  })

  it('leaves the head on the aggregate, which still names one period', async () => {
    renderBenchmark(ready({ per_account: TWO_ACCOUNTS }))

    // A row may legitimately disagree with the head — here one account is
    // ahead and the other behind — and it must never be read as the head
    // having changed.
    expect(within(await head()).getByText('+4 212,80 €')).toBeInTheDocument()
    const row = (await screen.findByText('CTO.BD')).closest('tr') as HTMLElement
    expect(within(row).getByText('-700,00 €')).toBeInTheDocument()
  })

  it('says on the row itself why that account’s own period ended early', async () => {
    renderBenchmark(
      ready({
        ended: null,
        per_account: [
          { ...TWO_ACCOUNTS[0], ended: 'exhausted', covered_to: '2021-03-14' },
          TWO_ACCOUNTS[1],
        ],
      }),
    )

    // The head's reason belongs to the account that closed the *aggregate*.
    // Read off the head, this row would name the wrong wrapper.
    const row = (await screen.findByText('PEA.LCL')).closest('tr') as HTMLElement
    expect(within(row).getByText(/Arrêté là/)).toBeInTheDocument()
    const other = (await screen.findByText('CTO.BD')).closest('tr') as HTMLElement
    expect(within(other).queryByText(/Arrêté là/)).toBeNull()
  })

  it('compares each account even when they share no single day', async () => {
    renderBenchmark({
      state: 'nothing_to_compare',
      reference: 'CW8.PA',
      index: 'MSCI World',
      consulted: ['CW8.PA'],
      excluded_accounts: [],
      per_account: [
        { ...TWO_ACCOUNTS[0], covered_from: '2019-10-30', covered_to: '2023-01-12' },
        TWO_ACCOUNTS[1],
      ],
    })

    // The head has no period to state — one closed before the other opened —
    // and that is the whole of what the state says. Sending the owner to a
    // ledger that is already full would be the ticket's own bug at its worst:
    // here the empty intersection hides *every* account entirely.
    expect(await screen.findByText(/Aucune période commune/)).toBeInTheDocument()
    expect(screen.queryByText(/Enregistrez vos premiers événements/)).not.toBeInTheDocument()
    const row = (await screen.findByText('PEA.LCL')).closest('tr') as HTMLElement
    expect(within(row).getByText('+4 212,00 €')).toBeInTheDocument()
  })

  it('still sends an empty ledger to the ledger', async () => {
    renderBenchmark({
      state: 'nothing_to_compare',
      reference: 'CW8.PA',
      index: 'MSCI World',
      consulted: ['CW8.PA'],
      excluded_accounts: [],
      per_account: [],
    })

    // Nothing replayed at all is a different emptiness, and it keeps its way out.
    expect(await screen.findByText(/Enregistrez vos premiers événements/)).toBeInTheDocument()
    expect(screen.queryByText(/Aucune période commune/)).not.toBeInTheDocument()
  })

  it('renders nothing on a single account, where the row repeats the head', async () => {
    renderBenchmark(ready({ per_account: [TWO_ACCOUNTS[0]] }))

    await head()
    // One window means no divergence between windows, and the table exists
    // only to show one.
    expect(screen.queryByText('PEA.LCL')).not.toBeInTheDocument()
  })
})

describe('the shared period, per account (#1032)', () => {
  /** The ticket's own case: a PEA since 2019 beside a CTO opened in 2024. */
  const OWN = [
    {
      account: 'PEA.LCL',
      covered_from: '2019-11-21',
      covered_to: '2026-09-22',
      ended: null,
      portfolio_value: 7_131.12,
      reference_value: 3_613.25,
      gap_gross: 3_517.87,
      portfolio_return: 0.0298,
      reference_return: -0.4785,
    },
    {
      account: 'CTO.TR',
      covered_from: '2024-02-26',
      covered_to: '2026-09-22',
      ended: null,
      portfolio_value: 7_918.17,
      reference_value: 8_590.45,
      gap_gross: -672.28,
      portfolio_return: 0.1549,
      reference_return: 0.2529,
    },
  ]

  /** The same two accounts read on the shared day, after the re-seed. */
  const SHARED = [
    {
      account: 'PEA.LCL',
      portfolio_value: 7_131.12,
      reference_value: 10_649.0,
      contributed: 8_222.57,
      gap_gross: -3_517.88,
    },
    {
      account: 'CTO.TR',
      portfolio_value: 7_918.17,
      reference_value: 8_590.45,
      contributed: 6_856.33,
      gap_gross: -672.28,
    },
  ]

  const both = () =>
    ready({
      covered_from: '2024-02-26',
      covered_to: '2026-09-22',
      gap_gross: -4_190.16,
      per_account: OWN,
      per_account_shared: SHARED,
    })

  it('gives each account the head’s own period beside its own', async () => {
    renderBenchmark(both())

    // The row that made the ticket: over its own life since 2019 the PEA is
    // ahead, over the period the head names it is 3 518 € behind. Both are
    // true, and a table that publishes only the first reads as a breakdown of
    // a figure it contradicts.
    const row = (await screen.findByText('PEA.LCL')).closest('tr') as HTMLElement
    expect(within(row).getByText('-3 517,88 €')).toBeInTheDocument()
    expect(within(row).getByText('+3 517,87 €')).toBeInTheDocument()
    expect(within(row).getByText(/2019/)).toBeInTheDocument()
  })

  it('adds the shared column up to the head figure, at the foot of that column', async () => {
    renderBenchmark(both())

    // −3 517,88 − 672,28 = −4 190,16, which is the head. The point of the
    // total row is that the reader can check the addition without leaving the
    // table — and that adding the *other* column is visibly a different sum.
    const total = (await screen.findByText('Ensemble des comptes')).closest('tr') as HTMLElement
    expect(within(total).getByText('-4 190,16 €')).toBeInTheDocument()
    expect(within(await head()).getByText('-4 190,16 €')).toBeInTheDocument()
  })

  it('drops the column where there is no shared period to state', async () => {
    renderBenchmark({
      state: 'nothing_to_compare',
      reference: 'CW8.PA',
      index: 'MSCI World',
      consulted: ['CW8.PA'],
      excluded_accounts: [],
      per_account: OWN,
    })

    // No intersection, no head, nothing to sum to: #1014's table stands alone
    // rather than growing an empty column of em dashes.
    const row = (await screen.findByText('PEA.LCL')).closest('tr') as HTMLElement
    expect(within(row).getByText('+3 517,87 €')).toBeInTheDocument()
    expect(screen.queryByText('Ensemble des comptes')).not.toBeInTheDocument()
  })
})
