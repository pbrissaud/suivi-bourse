/**
 * The head of the dashboard, and the three primitives it is the first surface
 * to need (#718).
 *
 * Every case below names the wrong figure it prevents. The four terms sum to a
 * gain the reader can check by hand — `+300,00 + 50,00 + 25,00 − 5,00 = 370,00`
 * — and the year-to-date pair is the measured one, `+40,69 €` against
 * `−1,25 %`, of opposite signs over the same period and both correct.
 *
 * Assertions are on the accessible rendering: a role, a name, a text. Amounts
 * are matched with regular expressions rather than literals because `fr-FR`
 * groups with a narrow no-break space, and a test that hard-coded a plain one
 * would be asserting the wrong thing about the right number.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, delay, http } from 'msw'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

import type { BenchmarkResponse } from '@/features/benchmark/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aBenchmark,
  aBenchmarkAccountRow,
  aClosedPosition,
  anAccount,
  anAccountsPayload,
  aMover,
  aMoversPayload,
  aPosition,
  aPerfPoint,
  aPortfolioHistory,
  aPositionsPayload,
  aRebuilding,
  aRhythm,
  aRuntime,
  aTotals,
  aTotalsPayload,
  defaultPositions,
  NOW,
} from '@/test/factories'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

/** One figure and everything subordinate to it, by the name it wears. */
function figure(name: string) {
  return screen.getByRole('group', { name })
}

/**
 * The hero: the portfolio's value, the gain total under it, and a row of three
 * figures — the year, today, and the IRR (#1149, #1280). The gain's four terms are not in it; they
 * are on the breakdown card, under the `Gain total` they add up to.
 */
function hero() {
  return screen.findByRole('group', { name: 'Valeur du portefeuille' })
}

function totalsOf(overrides: Parameters<typeof aTotals>[0]) {
  return http.get(ROUTES.portfolioTotals, () =>
    HttpResponse.json(aTotalsPayload(aTotals(overrides))),
  )
}

/**
 * The chart's own card, taken by the one control that is only ever on it — the
 * chart's range radios. A legend assertion has to say **which card** it is
 * about.
 */
async function chartCard(): Promise<HTMLElement> {
  // The chart is under the hero since the dashboard grid (17A / D25): the
  // frame is the hero's chart slot, found from the **reading** selector — the
  // group where there are two readings, the heading where there is only one.
  // The chart has no card of its own.
  const anchor = await waitFor(() => {
    const found =
      screen.queryByRole('group', { name: 'Lecture' }) ??
      screen.queryByRole('heading', { name: 'Montants' })
    if (found === null) throw new Error('the chart slot has not landed')
    return found
  })
  return anchor.closest('[data-hero-chart]') as HTMLElement
}

describe('the value is the hero (direction 1a)', () => {
  it('answers *how much is it worth* first, in the colour of text', async () => {
    renderApp()
    const head = await hero()

    // The value at hero size, the gain as its subtitle — and no sign colour on
    // the value: a value is not a direction.
    expect(head).toHaveTextContent(/2\D?800,00/)
    expect(head).toHaveTextContent(/\+370,00\D?€\s*de gain total/)
    const value = head.querySelector('.text-hero')
    expect(value).toHaveTextContent(/2\D?800,00/)
    expect(value?.className).not.toMatch(/text-(gain|loss)/)
    // `Valeur totale` left the row of statistics: it is the hero now.
    expect(screen.queryByRole('group', { name: 'Valeur totale' })).not.toBeInTheDocument()
    // The cash is named under the value, as a line rather than a statistic
    // (#1174), and no sign colour: a balance is not a direction.
    const cash = within(head).getByText(/^dont 500,00\D?€ de liquidités$/)
    expect(cash.className).not.toMatch(/text-(gain|loss)/)
    // No statistics row under the chart (#1174): `Versé net` is the chart's
    // dashed curve, `Titres` the value less the cash.
    for (const name of ['Versé net', 'Titres', 'Liquidités', 'Gain depuis le 1ᵉʳ janvier']) {
      expect(screen.queryByRole('group', { name })).not.toBeInTheDocument()
    }
    expect(within(await chartCard()).getByText('Versé net')).toBeInTheDocument()
    // One performance figure per screen (#1112): the TWR is not a statistic.
    expect(screen.queryByRole('group', { name: 'TWR' })).not.toBeInTheDocument()
  })

  it('says no cash where there is no cash ledger, and a zero where it is empty', async () => {
    server.use(totalsOf({ cash_balance: null }))
    const { unmount } = renderApp()
    const head = await hero()
    expect(head).not.toHaveTextContent(/liquidités/)
    unmount()

    server.use(totalsOf({ cash_balance: 0 }))
    renderApp()
    expect(await hero()).toHaveTextContent(/dont 0,00\D?€ de liquidités/)
  })

  it('names no cash under a hero that is the securities alone', async () => {
    server.use(totalsOf({ total_value: null, cash_balance: 500 }))
    renderApp()

    const head = await screen.findByRole('group', { name: 'Titres' })
    expect(head).not.toHaveTextContent(/liquidités/)
  })

  it('draws nothing for the year where only its gain member is missing', async () => {
    // A present `ytd` with a null `gain` is not computable on this install:
    // neither a pill nor a sentence about a rebuild.
    server.use(totalsOf({ ytd: { gain: null, twr: 0.01 } }))
    renderApp()

    const head = await hero()
    await waitFor(() => expect(head).toHaveTextContent(/Aujourd’hui/))
    expect(head).not.toHaveTextContent(/1ᵉʳ janvier/)
  })

  it('says nothing of tax, whatever the accounts declare, and reads none of them', async () => {
    // The tax model is one reading among others, and its figures are not
    // certain enough to sit under the hero (#1174): the accounts page owns it.
    const requested: string[] = []
    server.events.on('request:start', ({ request }) => {
      requested.push(new URL(request.url).pathname)
    })
    server.use(
      http.get(ROUTES.accounts, () =>
        HttpResponse.json(
          anAccountsPayload([
            anAccount({ id: 'cto', taxation_kind: 'flat_realised', projected_tax: 1200 }),
          ]),
        ),
      ),
    )
    renderApp()
    await hero()
    await screen.findByRole('list', { name: 'Mouvements' })

    expect(screen.queryByText(/net d.impôt/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Il vous resterait/)).not.toBeInTheDocument()
    expect(requested).not.toContain(ROUTES.accounts)
    server.events.removeAllListeners()
  })

  // Replaces « draws a sparkline and keeps the full chart one click away »
  // (#1099, direction 1a): the dashboard grid's 17A / D25 put the real chart
  // back on the page, under the value, and the dialog went with the sparkline.
  it('draws the real chart under the value, with its readings and one range control', async () => {
    renderApp()
    await hero()

    expect(await screen.findByRole('group', { name: 'Lecture' })).toBeInTheDocument()
    expect(screen.getAllByRole('radiogroup', { name: 'Plage' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Voir la courbe' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('puts the four terms in a section of their own, under the total they add up to', async () => {
    renderApp()
    await hero()

    const card = within(await screen.findByRole('region', { name: 'D’où vient le gain' }))
    expect(card.getByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(/300,00/)
    expect(card.getByRole('group', { name: 'Plus-value réalisée' })).toHaveTextContent(/50,00/)
    expect(card.getByRole('group', { name: 'Dividendes reçus' })).toHaveTextContent(/25,00/)
    expect(card.getByRole('group', { name: 'Frais de virement' })).toHaveTextContent(/5,00/)
    expect(card.getByRole('group', { name: 'Gain total' })).toHaveTextContent(/370,00/)
  })

  it('no longer compares the accounts here, and reads none of their series', async () => {
    const requested: string[] = []
    server.events.on('request:start', ({ request }) => {
      requested.push(new URL(request.url).pathname)
    })
    renderApp()
    await hero()
    await screen.findByRole('list', { name: 'Mouvements' })

    expect(screen.queryByText('Vos comptes, comparés')).not.toBeInTheDocument()
    expect(requested.some((path) => /\/api\/accounts\/[^/]+\/history/.test(path))).toBe(false)
    server.events.removeAllListeners()
  })

  it('names the securities as the hero where there is no cash ledger', async () => {
    // #708: no cash event, so `total_value` is `NULL` and `holdings_value` is
    // the one money figure there is. It is said under its own name, once.
    server.use(
      totalsOf({
        total_value: null,
        cash_balance: null,
        net_contributed: null,
        twr_index: null,
        ytd: null,
      }),
    )
    renderApp()

    const head = await screen.findByRole('group', { name: 'Titres' })
    expect(head).toHaveTextContent(/2\D?300,00/)
    expect(screen.getAllByRole('group', { name: 'Titres' })).toHaveLength(1)
    expect(screen.queryByRole('group', { name: 'Valeur du portefeuille' })).not.toBeInTheDocument()
  })
})

describe('the gain is computed, never read', () => {
  it('adds its four terms up and ignores a divergent `gain_absolu`', async () => {
    // Two producers for one figure is what the shares page spent a session
    // dismantling. The payload is handed a total that is off by an order of
    // magnitude; the head does not blink.
    server.use(totalsOf({ gain_absolu: 99999 }))
    renderApp()

    const head = await hero()
    expect(head).toHaveTextContent(/370,00/)
    expect(head).not.toHaveTextContent(/99\D?999/)
    expect(screen.queryByText(/99\D?999/)).not.toBeInTheDocument()
  })

  it('shows the four terms on their own row, never on the head’s', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    expect(await screen.findByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /300,00/,
    )
    expect(figure('Plus-value réalisée')).toHaveTextContent(/50,00/)
    expect(figure('Dividendes reçus')).toHaveTextContent(/25,00/)
    expect(figure('Frais de virement')).toHaveTextContent(/5,00/)

    // A total and its terms never share a line: the terms are not inside the
    // head's group, or the form would invite adding them to it.
    const head = figure('Gain total')
    expect(within(head).queryByRole('group')).not.toBeInTheDocument()
  })

  it('puts the value on the gain’s instant when prices moved since the pass (#1049)', async () => {
    // The pass wrote `2 800 − 2 430 = 370`; the scrape has since lifted the line
    // from 130 to 140, so the gain is 470 — and the value read beside it has to
    // be the one that makes `value − contributed` that gain, not the pass's.
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload([
            aPosition({ price: 140, dividends: 25 }),
            ...defaultPositions().slice(1),
          ]),
        ),
      ),
    )
    renderApp()

    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/470,00/)
    expect(figure('Valeur du portefeuille')).toHaveTextContent(/2\D?900,00/)
    // The cash takes no drift: it is the pass's balance, to the cent.
    expect(figure('Valeur du portefeuille')).toHaveTextContent(/dont 500,00\D?€ de liquidités/)
  })

  it('says a negative cash balance with its minus sign, in the colour of text', async () => {
    server.use(totalsOf({ cash_balance: -120 }))
    renderApp()

    const cash = await within(await hero()).findByText(/de liquidités/)
    expect(cash).toHaveTextContent(/dont [-−]120,00/)
    expect(cash.outerHTML).not.toMatch(/text-(gain|loss)/)
  })

  it('never mentions the fourth term to an install whose transfers are free', async () => {
    server.use(totalsOf({ transfer_fees: 0, gain_absolu: 375 }))
    renderApp()

    // Three terms, and the gain is their sum — not `370,00 − 0,00` written out.
    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/375,00/)
    expect(screen.queryByRole('group', { name: 'Frais de virement' })).not.toBeInTheDocument()
    expect(screen.queryByText('Frais de virement')).not.toBeInTheDocument()
  })
})

describe('the breakdown is a statement, with no drawing and no window (#1175)', () => {
  const breakdown = async () => {
    const card = await screen.findByRole('region', { name: 'D’où vient le gain' })
    await within(card).findByRole('group', { name: 'Gain total' })
    return card
  }
  const TERMS = [
    'Plus-value latente',
    'Plus-value réalisée',
    'Dividendes reçus',
    'Frais de virement',
  ]
  /** `+1 234,56 €` → 1234.56, whatever spaces and minus sign `fr-FR` writes. */
  const amountOf = (text: string) =>
    Number(
      text
        .replace(/[^\d,−-]/g, '')
        .replace('−', '-')
        .replace(',', '.'),
    )

  it('writes four rows and the total as text, and draws nothing', async () => {
    renderApp()
    const card = await breakdown()

    expect(
      within(card)
        .getAllByRole('group')
        .map((group) => group.getAttribute('aria-label')),
    ).toEqual([...TERMS, 'Gain total'])
    // The ⓘ's icon is the one svg, inside its button.
    expect([...card.querySelectorAll('svg')].every((svg) => svg.closest('button'))).toBe(true)
    expect(card.querySelector('[data-cascade-step]')).toBeNull()
    expect(card.querySelector('[style*="width"]')).toBeNull()
    expect(within(card).queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('adds its four rows up to its total', async () => {
    renderApp()
    const card = await breakdown()

    const figure = (name: string) =>
      amountOf(within(card).getByRole('group', { name }).lastElementChild?.textContent ?? '')
    const sum = TERMS.reduce((acc, name) => acc + figure(name), 0)
    expect(sum).toBeCloseTo(370, 2)
    expect(figure('Gain total')).toBeCloseTo(sum, 2)
  })

  it('dashes the fee row and the total when the fees have no bound', async () => {
    server.use(totalsOf({ transfer_fees: null }))
    renderApp()
    const card = await breakdown()

    expect(within(card).getByRole('group', { name: 'Frais de virement' })).toHaveTextContent(/—/)
    expect(within(card).getByRole('group', { name: 'Gain total' })).toHaveTextContent(/—/)
  })

  it('names a pending rate on the latent row and the total', async () => {
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload([aPosition({ price: 125, currency: 'USD', rate: null })]),
        ),
      ),
    )
    renderApp()
    const card = await breakdown()

    for (const name of ['Plus-value latente', 'Gain total']) {
      expect(within(card).getByRole('group', { name })).toHaveTextContent(/en attente du taux/)
    }
  })

  it('names a rebuild on the latent row and the total', async () => {
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload(
            defaultPositions().map((position) => ({
              ...position,
              terminal: false,
              price: null,
              converted: null,
            })),
          ),
        ),
      ),
    )
    renderApp()
    const card = await breakdown()

    for (const name of ['Plus-value latente', 'Gain total']) {
      expect(within(card).getByRole('group', { name })).toHaveTextContent(
        /historique en cours de reconstitution/,
      )
    }
  })

  it('asks for no window, even when a saved layout still carries one', async () => {
    const asked: string[] = []
    const record = ({ request }: { request: Request }) => {
      asked.push(new URL(request.url).pathname)
    }
    server.events.on('request:start', record)
    onTestFinished(() => server.events.removeListener('request:start', record))
    server.use(
      http.get(ROUTES.dashboardLayout, () =>
        HttpResponse.json({
          version: 1,
          blocks: [{ id: 'gain-breakdown', width: 'half', hidden: false, period: 'ytd' }],
        }),
      ),
    )
    renderApp()
    await breakdown()

    expect(asked.some((path) => path.endsWith('-baseline'))).toBe(false)
  })
})

describe('the year-to-date is two figures that do not touch', () => {
  it('puts the euro in the row and the percentage inside the IRR’s bubble', async () => {
    const { user } = renderApp()

    const head = await hero()

    // `+40,69 €` and `−1,25 %` are of opposite signs over the same period and
    // both correct: the portfolio grew by deposits while its holdings lost.
    // Side by side they read as a contradiction.
    const ytd = within(head).getByText('Depuis le 1ᵉʳ janvier').parentElement as HTMLElement
    expect(ytd).toHaveTextContent(/^Depuis le 1ᵉʳ janvier\+40,69\D?€$/)
    expect(within(ytd).getByText(/^\+40,69/)).toHaveClass('text-gain')
    expect(head).not.toHaveTextContent(/1,25/)

    await user.click(screen.getByRole('button', { name: 'Ce que veut dire TRI' }))
    const bubble = await screen.findByRole('dialog')
    expect(bubble).toHaveTextContent(/1,25\D?% depuis le 1ᵉʳ janvier/)
    expect(bubble).not.toHaveTextContent(/40,69/)
  })

  it('leaves the head **no** range control, and gives each figure one', async () => {
    renderApp()
    const head = await hero()

    // The delta is fixed to year-to-date. The `1S / 1M / 1A / —` selector was a
    // *second* range control **on the head**, and two sibling controls read as
    // two settings of the same thing — so the head carries none (#718, #727).
    expect(within(head).queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: '1S' })).not.toBeInTheDocument()

    // **One on the page**, and it is the chart's own (#838, then #1155 closed).
    await waitFor(() =>
      expect(
        screen.getAllByRole('radiogroup').map((group) => group.getAttribute('aria-label')),
      ).toEqual(['Plage']),
    )
  })

  it('never puts a delta on the money-weighted return, which is annualised', async () => {
    renderApp()
    const xirr = await screen.findByRole('group', { name: 'TRI' })
    expect(xirr).toHaveTextContent(/\+3,22\D?%/)
    expect(xirr).not.toHaveTextContent(/janvier/)
  })
})

describe('the total gain, then the year, today and the IRR (#1149, #1174, #1280)', () => {
  it('puts the gain first, then the row, the IRR last with its unit', async () => {
    renderApp()
    const head = await hero()

    const xirr = within(head).getByRole('group', { name: 'TRI' })
    expect(xirr).toHaveTextContent(/\+3,22\D?%/)
    expect(xirr).toHaveTextContent('/ an')
    await waitFor(() => expect(head).toHaveTextContent(/Aujourd’hui/))
    const text = head.textContent ?? ''
    const gain = text.indexOf('de gain total')
    const ytd = text.indexOf('Depuis le 1ᵉʳ janvier')
    const today = text.indexOf('Aujourd’hui')
    expect(gain).toBeGreaterThan(-1)
    expect(ytd).toBeGreaterThan(gain)
    expect(today).toBeGreaterThan(ytd)
    expect(text.indexOf('TRI')).toBeGreaterThan(today)
  })

  it('draws the figures on the ground, with the sign on the figure', async () => {
    server.use(totalsOf({ xirr: -0.05 }))
    renderApp()
    const head = await hero()

    await waitFor(() =>
      expect(within(head).getByRole('group', { name: 'TRI' })).toBeInTheDocument(),
    )
    expect(head.querySelector('[class*="bg-"], [class*="rounded-lg"]')).toBeNull()
    expect(within(head).getByText(/^\+370,00/)).toHaveClass('text-gain')
    expect(within(within(head).getByRole('group', { name: 'TRI' })).getByText(/5,00/)).toHaveClass(
      'text-loss',
    )
  })

  // An IRR of +0,00003 % reads `0,00 %`: the colour and the arrow follow the
  // figure shown, not the raw value (#1286).
  it.each([0.0000003, -0.0000003])(
    'gives an IRR of %s, which reads as zero, no sign',
    async (xirr) => {
      server.use(totalsOf({ xirr }))
      renderApp()
      const head = await hero()

      const pill = await within(head).findByRole('group', { name: 'TRI' })
      const figure = within(pill).getByText(/^0,00\s%$/)
      expect(figure).toHaveClass('text-foreground')
      expect(figure.querySelector('svg')).toBeNull()
    },
  )

  it('sets the total gain on its own line, on the Section title rung', async () => {
    renderApp()
    const head = await hero()

    const gain = (await within(head).findByText(/^\+370,00/)).closest('p') as HTMLElement
    expect(gain).toHaveClass('text-2xl')
    expect(gain).toHaveTextContent(/de gain total$/)
    // Its words are not the Section title's: the line is a paragraph, not a heading.
    expect(within(head).queryByRole('heading', { name: /gain total/ })).not.toBeInTheDocument()
    for (const label of ['Depuis le 1ᵉʳ janvier', 'Aujourd’hui', 'TRI']) {
      await waitFor(() => expect(within(head).getByText(label)).toBeInTheDocument())
    }
  })

  it('draws no row at all when no figure of it exists', async () => {
    server.use(
      totalsOf({ xirr: null, ytd: { gain: null, twr: null } }),
      http.get(ROUTES.portfolioTotalsHistory, () => HttpResponse.json(aPortfolioHistory([]))),
    )
    renderApp()
    const head = await hero()

    await within(head).findByText(/^\+370,00/)
    expect(head.querySelector('.flex-wrap.gap-x-5')).toBeNull()
  })

  it('says an unknown total in a sentence, without the 20 px line', async () => {
    server.use(totalsOf({ transfer_fees: null }))
    renderApp()
    const head = await hero()

    expect(await within(head).findByText(/^Gain total :/)).toHaveClass('text-sm')
    expect(head.querySelector('.text-2xl')).toBeNull()
  })

  it('draws no IRR figure when there is no IRR', async () => {
    server.use(totalsOf({ xirr: null }))
    renderApp()
    const head = await hero()
    await waitFor(() => expect(head).toHaveTextContent(/Aujourd’hui/))

    expect(screen.queryByRole('group', { name: 'TRI' })).not.toBeInTheDocument()
  })
})

describe('the two periods of the total', () => {
  /** One day of the global series, at a stated value and contribution. */
  const perfDay = (t: string, totalValue: number, contributed: number) => ({
    ...aPerfPoint(t, 100),
    total_value: totalValue,
    net_contributed: contributed,
  })

  it('keeps them with the total and out of the row of four terms', async () => {
    renderApp()
    const head = await hero()

    // A period is the same figure through another window; a term is a *part* of
    // it.
    await waitFor(() => expect(head).toHaveTextContent(/Aujourd’hui/))
    for (const term of [
      'Plus-value latente',
      'Plus-value réalisée',
      'Dividendes reçus',
      'Frais de virement',
    ]) {
      expect(figure(term)).not.toHaveTextContent(/Aujourd’hui|janvier/)
    }
  })

  it('counts the movement of the gain, which a deposit made today does not move', async () => {
    // 500,00 paid in today lifts the value and the contributions by the same
    // amount; what is left is the +30,00 the holdings did. It is `_ytd`'s own
    // definition over a one-day window, which is what makes the two pills two
    // periods of **one** figure rather than two figures.
    server.use(
      http.get(ROUTES.portfolioTotalsHistory, () =>
        HttpResponse.json(
          aPortfolioHistory([perfDay('2026-03-01', 1800, 1380), perfDay('2026-03-02', 2330, 1880)]),
        ),
      ),
    )
    renderApp()

    const head = await hero()
    await waitFor(() => expect(head).toHaveTextContent(/Aujourd’hui\+30,00\D?€/))
  })

  it('says nothing about today while the series has not reached today', async () => {
    // A series stopping short is a reconstruction in progress, and *today* is
    // then a claim nothing on the wire supports. The head above is untouched:
    // the day's move is a window on the total, never a term of it.
    server.use(
      http.get(ROUTES.portfolioTotalsHistory, () =>
        HttpResponse.json(
          aPortfolioHistory([perfDay('2026-02-28', 1800, 1380), perfDay('2026-03-01', 1830, 1380)]),
        ),
      ),
    )
    renderApp()

    const head = await hero()
    expect(head).toHaveTextContent(/370,00/)
    await waitFor(() => expect(head).not.toHaveTextContent(/Aujourd’hui/))
    expect(head).toHaveTextContent(/Depuis le 1ᵉʳ janvier\+40,69\D?€/)
  })
})

describe('one performance figure, and the TWR behind it (#1112)', () => {
  it('files the TWR inside the IRR’s bubble, with why the two differ', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    const { user } = renderApp()
    await hero()

    expect(screen.queryByRole('group', { name: 'TWR' })).not.toBeInTheDocument()
    expect(screen.queryByText(/\+102,89/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Ce que veut dire TRI' }))
    const bubble = await screen.findByRole('dialog')
    expect(bubble).toHaveTextContent(/Ce que vos versements ont réellement rapporté/)
    // Dated with the payload's own `twr_since`: the day moves while a backfill
    // runs, and an undated figure would change sign with nothing else changed.
    expect(aTotals().twr_since).toBe('2019-10-30')
    expect(bubble).toHaveTextContent(
      /La performance de vos placements, \+102,89\D?% depuis le 30 oct\. 2019/,
    )
    expect(bubble).toHaveTextContent(/peuvent même être de signes opposés/)
    expect(bubble).not.toHaveTextContent(/TWR/)
  })

  it('keeps the plain IRR text where the series has no start day', async () => {
    server.use(totalsOf({ twr_since: null }))
    const { user } = renderApp()
    await hero()

    await user.click(screen.getByRole('button', { name: 'Ce que veut dire TRI' }))
    const bubble = await screen.findByRole('dialog')
    expect(bubble).toHaveTextContent(/Ce que vos versements ont réellement rapporté/)
    expect(bubble).not.toHaveTextContent(/performance de vos placements/)
  })

  it('names one measure once in English: the bubble never says IRR', async () => {
    const { user } = renderApp({ browserLanguages: ['en-GB'] })
    await screen.findByRole('group', { name: 'Total P&L' })

    await user.click(screen.getByRole('button', { name: 'What Money-weighted return means' }))
    const bubble = await screen.findByRole('dialog')
    expect(bubble).toHaveTextContent(/The performance of your holdings, \+102\.89\D?% since/)
    expect(bubble).not.toHaveTextContent(/IRR/)
  })

  it('keeps the plain IRR text where there is no TWR', async () => {
    server.use(totalsOf({ twr_index: null, ytd: { gain: 40.69, twr: null } }))
    const { user } = renderApp()
    await hero()

    await user.click(screen.getByRole('button', { name: 'Ce que veut dire TRI' }))
    const bubble = await screen.findByRole('dialog')
    expect(bubble).toHaveTextContent(/Ce que vos versements ont réellement rapporté/)
    expect(bubble).not.toHaveTextContent(/TWR/)
  })
})

describe('during the reconstruction', () => {
  it('keeps the head normal and degrades the year-to-date alone', async () => {
    server.use(totalsOf({ ytd: null }))
    renderApp()

    // Exact from the first cycle: the gain, the money-weighted return and the
    // four terms. Twenty-five minutes of "nothing works" is what this prevents.
    const head = await hero()
    expect(head).toHaveTextContent(/370,00/)
    expect(figure('TRI')).toHaveTextContent(/\+3,22/)
    expect(await screen.findByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /300,00/,
    )

    // Everything else is untouched — the degradation is the year-to-date and
    // nothing but it.
    expect(figure('Valeur du portefeuille')).toHaveTextContent(/2\D?800,00/)
  })

  it('degrades the euro half of the year-to-date with the sentence', async () => {
    // The percentage half lives in the IRR's bubble since #1112 and is simply
    // left out of it there; the euro half is on screen and owes its reason.
    server.use(
      totalsOf({ ytd: null }),
      http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))),
    )
    renderApp()

    const head = await hero()
    await waitFor(() =>
      expect(head).toHaveTextContent(
        /Depuis le 1ᵉʳ janvier : historique pas encore reconstruit jusque-là/,
      ),
    )

    expect(screen.getAllByText(/historique pas encore reconstruit/)).toHaveLength(1)
  })

  it('does not announce a rebuild to a portfolio younger than the year', async () => {
    // `ytd: null` has two causes and the head wrote one sentence for both: the
    // reconstruction has not reached January, **or** the first event is in
    // March and no day on or before 31 December exists to count from. The
    // second install is told to wait for something that will never happen, and
    // waiting is precisely what it must not do. The discriminant is already on
    // screen — `runtime.rebuilding`, which the TWR statistic reads for its base
    // date — so nothing is added to any payload.
    server.use(
      totalsOf({ ytd: null }),
      http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: false }))),
    )
    renderApp()

    const head = await hero()
    await waitFor(() =>
      expect(head).toHaveTextContent(
        /Depuis le 1ᵉʳ janvier : rien d’enregistré avant le 1ᵉʳ janvier/,
      ),
    )
    expect(screen.queryByText(/historique pas encore reconstruit/)).not.toBeInTheDocument()
  })

  it('does not announce a rebuild for a member that is merely not computable', async () => {
    // The ordinary v4 arrival: no `DEPOSIT` anywhere, so since #708 the
    // cash-derived four are `NULL` and `twr_index` with them. The euro figure
    // survives — it is the movement of `gain_absolu`, written always — while
    // the percentage genuinely is not computable. Read through `?.` alone, an
    // absent **member** was indistinguishable from an absent `ytd`, and the
    // head announced a rebuild that had already finished, permanently, to
    // exactly the population #708's per-field rule exists to serve. An absent
    // member takes the bare em dash: *there is nothing to compute*.
    server.use(
      totalsOf({ ytd: { gain: 40.69, twr: null } }),
      http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: false }))),
    )
    renderApp()

    await hero()
    await waitFor(() =>
      expect(screen.getByText('Depuis le 1ᵉʳ janvier').parentElement).toHaveTextContent(
        /\+40,69\D?€/,
      ),
    )
    // Neither sentence, on either figure — both would be false here.
    expect(screen.queryByText(/historique pas encore reconstruit/)).not.toBeInTheDocument()
    expect(screen.queryByText(/rien d’enregistré avant le 1ᵉʳ janvier/)).not.toBeInTheDocument()
  })

  it('says nothing about the ledger while the runtime has not answered', async () => {
    // The same rule the installation facts follow (#709): asserting *your ledger does
    // not go back that far* takes a **positive** observation of this process,
    // and a runtime that failed is not one. Absence therefore keeps the
    // rebuild's sentence — it names something the app is doing, and waiting
    // repairs it — rather than making a claim about the reader's own data on
    // the strength of a request that never landed.
    server.use(
      totalsOf({ ytd: null }),
      problemHandler(ROUTES.runtime, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp()

    const head = await hero()
    await waitFor(() =>
      expect(head).toHaveTextContent(
        /Depuis le 1ᵉʳ janvier : historique pas encore reconstruit jusque-là/,
      ),
    )
    expect(screen.queryByText(/rien d’enregistré avant le 1ᵉʳ janvier/)).not.toBeInTheDocument()
  })
})

describe('the hero while the history is rebuilding (#1260)', () => {
  // The newest row is a day of cash alone, the day before a line's acquisition.
  const CASH_ONLY = { day: '2026-03-01', total_value: 500, cash_balance: 500, xirr: 0 }
  const unpriced = aPosition({ symbol: 'ZZA', name: 'Zeta Alpha', price: null, terminal: false })
  const rebuilding = (reconstruction: { complete: number; total: number } | null) =>
    http.get(ROUTES.runtime, () =>
      HttpResponse.json(aRuntime({ rebuilding: true, reconstruction })),
    )

  function pastDayWhileRebuilding(reconstruction = { complete: 9, total: 19 }) {
    server.use(
      totalsOf(CASH_ONLY),
      http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload([unpriced]))),
      rebuilding(reconstruction),
    )
  }

  it('asserts no value, no cash line and no pill over a past-day row', async () => {
    pastDayWhileRebuilding()
    renderApp()

    const head = await hero()
    await screen.findByText(/Historique en reconstruction/)
    expect(head).not.toHaveTextContent(/\d,\d\d/)
    expect(screen.queryByText(/de liquidités/)).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'TRI' })).not.toBeInTheDocument()
    expect(screen.queryByText(/depuis le 1ᵉʳ janvier/)).not.toBeInTheDocument()
    expect(screen.queryByText(/aujourd’hui/)).not.toBeInTheDocument()
  })

  it('says how far the rebuild is with the bell’s own count', async () => {
    pastDayWhileRebuilding({ complete: 9, total: 19 })
    renderApp()

    expect(await screen.findByText(/9 séries remontent au premier achat, sur 19/)).toBeVisible()
  })

  it('names the lines that still have no price', async () => {
    pastDayWhileRebuilding()
    renderApp()

    expect(await screen.findByText('Toujours sans cours : Zeta Alpha.')).toBeVisible()
  })

  it('says the rebuild without numbers when the runtime carries no count', async () => {
    server.use(
      totalsOf(CASH_ONLY),
      http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload([unpriced]))),
      rebuilding(null),
    )
    renderApp()

    expect(await screen.findByText(/^Historique en reconstruction\. La valeur/)).toBeVisible()
  })

  it('draws nothing in the hero while the runtime has not answered over a past-day row', async () => {
    server.use(
      totalsOf(CASH_ONLY),
      problemHandler(ROUTES.runtime, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp()

    const head = await hero()
    expect(head).not.toHaveTextContent(/\d,\d\d/)
    expect(screen.queryByText(/Historique en reconstruction/)).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'TRI' })).not.toBeInTheDocument()
  })

  it('shows the value, at once, when the newest row becomes today’s', async () => {
    pastDayWhileRebuilding()
    const { queryClient } = renderApp({ fakeTimers: true })
    await screen.findByText(/Historique en reconstruction/)

    server.use(
      totalsOf({ day: '2026-03-02' }),
      http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload())),
    )
    await vi.advanceTimersByTimeAsync(60_000)
    await waitFor(() => expect(queryClient.getQueryState(['portfolio-totals'])).toBeDefined())

    await waitFor(() => expect(figure('Valeur du portefeuille')).toHaveTextContent(/2\D?800,00/))
    expect(screen.queryByText(/Historique en reconstruction/)).not.toBeInTheDocument()
  })

  it('keeps the value and its pills when the rebuild runs but the row is today’s', async () => {
    server.use(rebuilding({ complete: 9, total: 19 }))
    renderApp()

    const head = await hero()
    expect(head).toHaveTextContent(/2\D?800,00/)
    expect(figure('TRI')).toHaveTextContent(/\+3,22/)
    expect(screen.queryByText(/Historique en reconstruction/)).not.toBeInTheDocument()
  })
})

describe('a perf pass that raised', () => {
  it('says the figures are the previous pass’s, and leaves every one of them standing', async () => {
    // #994: `perf_job` records the verdict on every cycle and nothing in the
    // front read it, so a pass that raises leaves the previous
    // `account_metrics` and `portfolio_totals` rows on screen looking current.
    // Stale and right-looking is the class of wrong nobody reports.
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(aRuntime({ perf: { at: NOW, verdict: 'failed', error: 'boom' } })),
      ),
    )
    renderApp()

    expect(await screen.findByText(/Le dernier recalcul a échoué/)).toBeInTheDocument()
    // **And the figures stay.** The sentence qualifies them; it does not
    // replace them, which is the whole objection `absence.ts` raised against
    // letting an optional read decide what exists.
    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/370,00/)
  })

  it('says nothing when the runtime read itself refuses', async () => {
    // `/api/runtime` is an **optional** read: a diagnostic probe falling over
    // is not an observation about the reader's figures, so the silence is the
    // answer — and the page is untouched.
    server.use(
      problemHandler(ROUTES.runtime, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp()

    await screen.findByRole('group', { name: 'Gain total' })
    expect(screen.queryByText(/Le dernier recalcul a échoué/)).not.toBeInTheDocument()
    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/370,00/)
  })
})

describe('a refetch that fails keeps the figures (#1180)', () => {
  it('leaves the value on screen when the next poll gets a 503', async () => {
    // TanStack Query keeps `data` and sets `error` when a refetch fails. The
    // page used to read the error alone and swap the figures for an
    // `Unreadable` — on every outage the polling lives through.
    const { queryClient } = renderApp({ fakeTimers: true })
    expect(await hero()).toHaveTextContent(/2\D?800,00/)

    const unreadable = {
      status: 503,
      type: PROBLEM_TYPES.storageUnavailable,
      title: 'storage unavailable',
    }
    server.use(
      problemHandler(ROUTES.positions, unreadable),
      problemHandler(ROUTES.portfolioTotals, unreadable),
    )
    await vi.advanceTimersByTimeAsync(60_000)
    await waitFor(() => expect(queryClient.getQueryState(['positions'])?.error).toBeTruthy())

    expect(await hero()).toHaveTextContent(/2\D?800,00/)
    expect(screen.queryByText('Lecture impossible')).not.toBeInTheDocument()
  })
})

describe('a read that fails is named, where its content would have been', () => {
  it('says why the page is empty when the store will not answer', async () => {
    // The exact case, and the reason it had no announcer at all: the block
    // rendered `null`, and *"the store is unreadable"* and *"you own nothing
    // yet"* became one screen — a blank one. Since #829 there is no band left
    // to raise either: the two reads the page is *made of* are what
    // failed, so the page is empty and the page's own empty state says why.
    server.use(
      problemHandler(ROUTES.positions, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp()

    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.getByText(/son magasin ne répond pas/)).toBeInTheDocument()
    // An empty state, never a band: no live region is raised anywhere.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Gain total' })).not.toBeInTheDocument()
  })

  it('says it for the consolidated read too, rather than blaming an absent ledger', async () => {
    // `portfolio_totals` coming back `503` is not "you have no ledger", and the
    // sentence naming what a ledger would add would be a plain untruth here.
    server.use(
      problemHandler(ROUTES.portfolioTotals, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp()

    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.getByText(/son magasin ne répond pas/)).toBeInTheDocument()
    expect(screen.queryByText(/pour voir votre valeur totale/)).not.toBeInTheDocument()
  })

  it('says it once when the app answers nothing at all', async () => {
    // Every read of the page refuses together, which is what an app that is not
    // answering looks like. `oneFailure` keeps the first of the two the page is
    // made of, so the page is empty **once** and explained once — and the fact
    // about the *installation* is the bell's, three surfaces over.
    server.use(
      http.get(ROUTES.runtime, () => HttpResponse.error()),
      http.get(ROUTES.positions, () => HttpResponse.error()),
      http.get(ROUTES.portfolioTotals, () => HttpResponse.error()),
    )
    renderApp()

    await waitFor(() => expect(screen.getAllByText('Lecture impossible')).toHaveLength(1))
    expect(screen.getByText(/L’application ne répond pas/)).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

/**
 * **A secondary read that fails is named, and it costs no other block** (#799).
 *
 * The band used to be the head's and to render *instead* of it, so it could only
 * ever name the two reads the head is made of. The four others — the portfolio
 * series, the valuation series, the accounts and the N account series — entered
 * no condition at all: the block that consumed one rendered `null` and the graph,
 * or the comparison, left the dashboard **on every load, without a word**.
 *
 * #829 removed the band and kept the repair: each of those four is handed to the
 * block it belongs to, and the block says it **in the slot the content would have
 * filled**. The head keeps its figures either way, which is the half
 * the repair had to buy.
 *
 * The net in `readsInFlight.test.tsx` makes a read **hang**; it does not make one
 * **fail**, and a silent disappearance is what it *requires* during the flight. So
 * it cannot see this, it is not modified to, and the distinction between the two
 * states — which is the whole of the repair — is asserted here, on the rendering.
 */
describe('a secondary read that fails is named, and the head keeps its figures', () => {
  const STORAGE_DOWN = {
    status: 503,
    type: PROBLEM_TYPES.storageUnavailable,
    title: 'storage unavailable',
  }

  /** The one sentence a store that will not answer is entitled to. */
  const unreadable = (route: string) => problemHandler(route, STORAGE_DOWN)

  /**
   * What the head is worth on the fixture — the total and its four terms — and
   * it is worth it whatever else on the page failed to read. This is the half
   * the repair had to buy: pouring the four other reads into the two the page
   * is *made of* would have replaced every figure below with one sentence.
   */
  async function theHeadStandsWhole() {
    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/370,00/)
    expect(await screen.findByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /300,00/,
    )
    expect(figure('Plus-value réalisée')).toHaveTextContent(/50,00/)
    expect(figure('Dividendes reçus')).toHaveTextContent(/25,00/)
    expect(figure('Frais de virement')).toHaveTextContent(/5,00/)
  }

  it('names a failed portfolio series, and the chart alone goes', async () => {
    server.use(unreadable(ROUTES.portfolioTotalsHistory))
    renderApp()

    // In the chart's own slot, and as an empty state (#829).
    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.getByText(/son magasin ne répond pas/)).toBeInTheDocument()
    await theHeadStandsWhole()
    // The chart itself is gone rather than empty: its **reading** selector is
    // the surest proof, and the frame that would carry it is not drawn. The
    // range control sits on the same bar since #1150, so it is gone with it.
    expect(screen.queryByRole('group', { name: 'Lecture' })).not.toBeInTheDocument()
  })

  it('names a failed valuation series, which only an install with no cash ledger reads', async () => {
    // #708's per-field rule sends the chart to the second series, so this one
    // is armed under a condition false by default — and it disappeared exactly
    // as silently.
    server.use(
      totalsOf({
        total_value: null,
        cash_balance: null,
        net_contributed: null,
        twr_index: null,
        ytd: null,
      }),
      unreadable(ROUTES.positionsHistory),
    )
    renderApp()

    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.getByText(/son magasin ne répond pas/)).toBeInTheDocument()
    await theHeadStandsWhole()
    expect(screen.queryByRole('heading', { name: 'Montants' })).not.toBeInTheDocument()
  })

  it('says nothing at all while that same read is merely in flight', async () => {
    // **The repair distinguishes the failure from the flight, it does not
    // flatten them**. The sentence is composed out of an error and
    // never out of a silence, so a read that has not answered still takes its
    // block away without a word — title and empty state included.
    server.use(http.get(ROUTES.portfolioTotalsHistory, () => new Promise<never>(() => {})))
    renderApp()

    await theHeadStandsWhole()
    // The movers answer on a read of their own, so their list standing is the
    // proof the page has otherwise settled and the sentence is not late.
    await screen.findByRole('list', { name: 'Mouvements' })
    expect(screen.queryByText('Lecture impossible')).not.toBeInTheDocument()
    expect(document.querySelector('[data-empty]')).toBeNull()
    // The chart's frame is not drawn: its reading selector is what would carry
    // it, along with the range beside it (#1150).
    expect(screen.queryByRole('group', { name: 'Lecture' })).not.toBeInTheDocument()
  })

  it('gives each empty slot its own reason when two reads fail at once', async () => {
    // *One band on screen or none* was a rule about **announcers**, and there
    // is no announcer left: an empty state is not a live region, and two blocks
    // that are empty for the same cause are still two blocks the reader is
    // owed a reason for. What must never happen is a third sentence with no
    // slot under it — so the count is exactly the number of blocks that lost
    // their content.
    server.use(unreadable(ROUTES.portfolioTotalsHistory), unreadable(ROUTES.movers))
    renderApp()

    await waitFor(() => expect(screen.getAllByText('Lecture impossible')).toHaveLength(2))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await theHeadStandsWhole()
  })
})

describe('the statistics shrink instead of filling with dashes', () => {
  it('drops what does not exist for this installation, and names what a ledger would add', async () => {
    server.use(http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(null))))
    renderApp()

    // The three position terms keep their subject — they are read off the
    // positions, which are not under the constraint that empties
    // `portfolio_totals` — but **their sum is not the gain** (#775): with no
    // row at all there is nothing to bound the fourth term by, and a four-term
    // total rendered from three is not that total. It wears the em
    // dash, and the sentence at the foot of the block says why.
    const head = await hero()
    expect(head).toHaveTextContent('—')
    expect(head).not.toHaveTextContent(/375,00/)
    expect(await screen.findByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /300,00/,
    )

    for (const absent of ['Valeur totale', 'Versé net', 'TRI', 'TWR']) {
      expect(screen.queryByRole('group', { name: absent })).not.toBeInTheDocument()
    }
    expect(screen.getByText(/pour voir votre valeur totale/)).toBeInTheDocument()
  })

  it('says the currency is unanswered rather than denying the ledger', async () => {
    // `totals: null` has two causes (#745) and they were one sentence. The
    // second is the ordinary one: the perf job writes nothing at all until the
    // base currency is answered (#702), every figure it computes being money.
    // So the app told a reader holding a full portfolio that they had no ledger
    // — and said nothing about the one question they can answer.
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(aPositionsPayload(defaultPositions(), null)),
      ),
      http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(null, null))),
    )
    renderApp()

    await screen.findByRole('group', { name: 'Gain total' })
    expect(screen.getByText(/attendent une devise de base/)).toBeInTheDocument()
    expect(screen.queryByText(/pour voir votre valeur totale/)).not.toBeInTheDocument()
  })

  it('says nothing at all when there is no ledger and nothing held', async () => {
    server.use(
      http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload([], null))),
      http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(null, null))),
    )
    renderApp()

    expect(await screen.findByText('Aucun événement')).toBeInTheDocument()
    // One action (#1435): the ledger, and no second link beside it.
    expect(screen.getByRole('link', { name: 'Aller au grand livre' })).toHaveAttribute(
      'href',
      '/ledger',
    )
    expect(screen.queryByRole('link', { name: 'Revoir la mise en route' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Gain total' })).not.toBeInTheDocument()
  })
})

describe('the convention bubble', () => {
  it('opens on click and never on hover, and holds sense, rule and link', async () => {
    const { user } = renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    const trigger = screen.getByRole('button', { name: 'Ce que veut dire Gain total' })

    // Hover does not exist on touch, and a convention readable on half the
    // devices is a convention not stated.
    await user.hover(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(trigger)
    const bubble = await screen.findByRole('dialog')
    expect(bubble).toHaveTextContent(/Les quatre font ce total/)
    // One text, not two levels — and a link the reader can walk to, which is
    // the other half of why it opens on click.
    const link = within(bubble).getByRole('link', { name: 'Lire la règle complète' })
    expect(link).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#total-gain',
    )
  })

  it('closes on scroll, because it must not outlive its figure', async () => {
    const { user } = renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    await user.click(screen.getByRole('button', { name: 'Ce que veut dire TRI' }))
    await screen.findByRole('dialog')

    // Mounted `position: fixed`, the board's bubble stayed pinned above
    // unrelated content — worse than no bubble at all.
    fireEvent.scroll(document)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('carries the reader’s locale to the documentation', async () => {
    const { user } = renderApp({ browserLanguages: ['en-GB'] })
    await screen.findByRole('group', { name: 'Total P&L' })

    await user.click(screen.getByRole('button', { name: 'What Money-weighted return means' }))
    expect(within(await screen.findByRole('dialog')).getByRole('link')).toHaveAttribute(
      'href',
      'https://pbrissaud.github.io/suivi-bourse/docs/v5/read-your-figures#xirr',
    )
  })

  it('puts two icons on the head, not nine', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // A total and its subordinate terms are one figure, not five: the
    // `Gain total` bubble carries the identity **and** its four terms, and the
    // terms carry none of their own. It sits on the breakdown card since the
    // value took the hero, so it comes after the head's in reading order — the
    // IRR's first, on its pill beside the value (#1149).
    const bubbles = screen.getAllByRole('button', { name: /^Ce que veut dire/ })
    expect(bubbles.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Ce que veut dire TRI',
      'Ce que veut dire Gain total',
    ])
  })
})

describe('what is merely missing is named, never dashed', () => {
  it('says the rate is awaited, on the headline and on its term', async () => {
    // `lib/absence.ts` is the ticket's own primitive and it had **no consumer
    // in production at all** — its key `absence.awaitingRate` sat in both
    // catalogues, rendered nowhere. The head held `number | null`, so the case
    // died at the return and every site could write nothing but an em dash:
    // *there is nothing to compute* about a rate the app fetches by itself.
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload([aPosition({ price: 125, currency: 'USD', rate: null })]),
        ),
      ),
    )
    renderApp()

    const head = await hero()
    expect(head).toHaveTextContent(/en attente du taux/)
    expect(head).not.toHaveTextContent(/^Gain total\s*—/)
    expect(await screen.findByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /en attente du taux/,
    )
  })

  it('names the rebuild on a fresh install, and never the exchange rate', async () => {
    // The install of the first hour: no symbol is terminal, so no line has a
    // valuation and the total has no figure. The reason is the one the reader
    // can act on — here, none: the app is reading, and the rate has nothing to
    // do with it. Written in as `awaitingRate`, this headline sent every new
    // owner to a currency dial they had already answered (#845).
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload(
            defaultPositions().map((position) => ({
              ...position,
              terminal: false,
              price: null,
              converted: null,
            })),
          ),
        ),
      ),
    )
    renderApp()

    const head = await hero()
    expect(head).toHaveTextContent(/historique en cours de reconstitution/)
    expect(head).not.toHaveTextContent(/en attente du taux/)
    // Named and not dashed: the em dash says *there is nothing to compute*,
    //and a total refused in silence is a figure gone out with no
    // explanation under it.
    expect(head).not.toHaveTextContent(/^Gain total\s*—/)
    expect(await screen.findByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /historique en cours de reconstitution/,
    )
  })

  it('does not let a **sold** line with no rate blank the whole headline', async () => {
    // A position the owner closed years ago keeps a `symbol_quote` row, so it
    // still carries a last price; while the base currency is unanswered that
    // price has no rate. `absenceCase` tests `quantity === 0` first and
    // unconditionally for exactly this reason — and the head's own arithmetic
    // held a copy of the classification without that first test, so one closed
    // line turned the gain of the entire portfolio into an absence.
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload([
            ...defaultPositions(),
            aPosition({
              symbol: 'ZZD',
              quantity: 0,
              cost_basis: 0,
              realised: 120,
              price: 125,
              currency: 'USD',
              rate: null,
            }),
          ]),
        ),
      ),
    )
    renderApp()

    // +300,00 latent · 50,00 + 120,00 realised · 25,00 dividends − 5,00 = 490,00
    const head = await hero()
    expect(head).toHaveTextContent(/490,00/)
    expect(head).not.toHaveTextContent(/en attente du taux/)
    expect(await screen.findByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(
      /300,00/,
    )
  })
})

describe('a read that has not landed is not a fact', () => {
  it('waits for the totals rather than announcing there is no ledger', async () => {
    // The two reads the block *needs* land at their own pace, and the sentences
    // below are written about `portfolio_totals` as much as about the
    // positions. Taking `totals.data?.totals ?? null` put *« un grand livre
    // d’événements datés ajouterait… »* under a portfolio that has one, for as
    // long as the second request took — then swapped the headline for another
    // number under the reader's eyes.
    server.use(
      http.get(ROUTES.portfolioTotals, async () => {
        await delay(120)
        return HttpResponse.json(aTotalsPayload(aTotals()))
      }),
    )
    renderApp()

    // Nothing is claimed while it is in flight — not the three-term headline,
    // and above all not the sentence that denies the ledger.
    expect(screen.queryByText(/pour voir votre valeur totale/)).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Gain total' })).not.toBeInTheDocument()

    // And once it lands, the four-term figure, in one go.
    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/370,00/)
    expect(screen.queryByText(/pour voir votre valeur totale/)).not.toBeInTheDocument()
  })
})

describe('one chart slot, two readings', () => {
  it('offers a reading selector and one range control, and `3M` is dead', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // A **reading** selector, drawn as buttons since #831 — the maquette draws
    // it segmented exactly like the range beside it, and nothing here is a
    // place to go. Radios are still refused for the older reason: two sibling
    // radio groups read as two settings of the same thing, which is the
    // duplication this page has just closed.
    await chartCard()
    const readings = await screen.findByRole('group', { name: 'Lecture' })
    expect(
      within(readings)
        .getAllByRole('button')
        .map((one) => one.textContent),
    ).toEqual(['Montants', 'Performance'])
    expect(within(readings).getByRole('button', { name: 'Montants' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(readings).queryByRole('radio')).not.toBeInTheDocument()

    // **And there is not a tab left on the page** (#831). #830 emptied the
    // ledger and the settings of theirs and this card kept two, which is what
    // reopened this ticket.
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()

    const range = screen.getByRole('radiogroup', { name: 'Plage' })
    expect(
      within(range)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['1M', '1ᵉʳ janv.', '1A', 'MAX'])
    expect(screen.queryByRole('radio', { name: '3M' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '1ᵉʳ janv.' })).toBeInTheDocument()
  })

  it('sets the reading, the legend and the range on one bar above the plot (#1280)', async () => {
    const { user } = renderApp()
    const card = await chartCard()
    const range = within(card).getByRole('radiogroup', { name: 'Plage' })
    const bar = range.parentElement as HTMLElement
    const plot = card.querySelector('figure') as HTMLElement

    const legend = within(bar).getByText('Versé net')
    expect(within(bar).getByRole('group', { name: 'Lecture' })).toBeInTheDocument()
    expect(bar.compareDocumentPosition(plot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(legend.compareDocumentPosition(range) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(range).toHaveClass('ml-auto')

    // Under *Performance* the curves are not named, so the bar holds no legend.
    await user.click(within(bar).getByRole('button', { name: 'Performance' }))
    expect(within(bar).queryByText('Versé net')).not.toBeInTheDocument()
  })

  // One control bar (#1150): the reading on the left, the range on the right,
  // one track look — and the range wraps under the reading on a narrow screen.
  it('puts the reading and the range on one bar, reading first', async () => {
    renderApp()
    const readings = await screen.findByRole('group', { name: 'Lecture' })
    const range = screen.getByRole('radiogroup', { name: 'Plage' })

    expect(readings.parentElement).toBe(range.parentElement)
    expect(readings.parentElement?.closest('[data-hero-chart]')).not.toBeNull()
    expect(readings.compareDocumentPosition(range) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('puts the `Montants` heading and the range on one bar where there is no ledger', async () => {
    server.use(
      totalsOf({
        total_value: null,
        cash_balance: null,
        net_contributed: null,
        twr_index: null,
        ytd: null,
      }),
    )
    renderApp()
    const heading = await screen.findByRole('heading', { name: 'Montants' })
    const range = screen.getByRole('radiogroup', { name: 'Plage' })

    expect(heading.parentElement).toBe(range.parentElement)
    expect(heading.compareDocumentPosition(range) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the bar above an empty window, so the reader can widen the range', async () => {
    // A series that stops well before the last month: `1M` draws nothing.
    server.use(
      http.get(ROUTES.portfolioTotalsHistory, () =>
        HttpResponse.json(
          aPortfolioHistory([aPerfPoint('2020-01-01', 100), aPerfPoint('2020-01-02', 101)]),
        ),
      ),
    )
    const { user } = renderApp()
    await user.click(await screen.findByRole('radio', { name: '1M' }))

    expect(
      await screen.findByText('Rien à tracer sur cette plage pour l’instant.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Plage' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Lecture' })).toBeInTheDocument()
  })

  it('draws both controls bordered and compact', async () => {
    renderApp()
    const readings = await screen.findByRole('group', { name: 'Lecture' })
    const range = screen.getByRole('radiogroup', { name: 'Plage' })

    for (const control of [readings, range]) {
      expect(control).toHaveClass('border')
      for (const option of [
        ...within(control).queryAllByRole('button'),
        ...within(control).queryAllByRole('radio'),
      ]) {
        expect(option).toHaveClass('px-2.5', 'py-1', 'text-xs')
      }
    }
  })

  it('says the shape of the window to a reader who cannot see the plot', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })
    const chart = await chartCard()

    // **The plot is reachable, and the sentence sits beside it** (#1003).
    // Recharts makes the `<svg>` focusable and its arrows walk the series, so
    // hiding the drawing would leave a stop in the tab order that says nothing.
    // The `<svg>` itself does not render under jsdom — `chartReadingContract`
    // holds its name on the source — but the `<figure>` this component writes
    // does, and it must not be hidden.
    const figure = chart.querySelector('figure')
    expect(figure).not.toBeNull()
    expect(figure?.closest('[aria-hidden]')).toBeNull()

    // The four clauses, asserted by shape rather than by the fixture's figures:
    // the extent, the opening of each curve, the dated extremes of the first,
    // and which side of the other it stayed on.
    const said = () => (chart.querySelector('figcaption')?.textContent ?? '').replace(/[  ]/g, ' ')
    expect(said()).toMatch(/^Valeur totale et Versé net, du .+ au .+\./)
    expect(said()).toMatch(/Valeur totale part de .+, Versé net de .+\./)
    expect(said()).toMatch(/Valeur totale : plus haut .+ le .+, plus bas .+ le .+\./)
    expect(said()).toMatch(/Valeur totale (reste (au-dessus|en dessous) de Versé net|croise)/)

    // **The live region wraps the swap** (#1003), so a range press that empties
    // the window is announced by the empty state rather than by nothing.
    expect(chart.querySelector('[aria-live="polite"]')?.contains(figure!)).toBe(true)

    // Pressing the other reading re-reads the slot, and the sentence follows the
    // curve that is drawn: one curve, read against the zero line it draws.
    const readings = within(await screen.findByRole('group', { name: 'Lecture' }))
    fireEvent.click(readings.getByRole('button', { name: 'Performance' }))
    await waitFor(() => expect(said()).toMatch(/^Performance, du .+ au .+\./))
    expect(said()).toMatch(/Performance (reste (au-dessus|en dessous) de zéro|croise zéro)/)
  })

  it('names each curve and explains no rule under them', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // The legend names the two curves — that is what pairs a colour to a
    // figure — and it says nothing else. The sentence it used to close on,
    // *l'écart entre les deux courbes est votre gain total*, is a convention of
    // the product, and a convention lives on the bubble the head carries three
    // cards up, never in a paragraph on the page.
    //
    // Scoped to the chart's own card: `Valeur totale` is also one of the head's
    // statistics, and the two saying the same thing about one portfolio is the
    // point rather than a collision.
    const chart = within(await chartCard())
    expect(chart.getByText('Valeur totale')).toBeInTheDocument()
    expect(chart.getByText('Versé net')).toBeInTheDocument()
    expect(screen.queryByText(/L’écart entre les deux courbes/)).not.toBeInTheDocument()
  })

  it('falls back to valuation against cost, and it is then the only reading', async () => {
    // #708's per-field rule: with no cash event `total_value`,
    // `net_contributed` and `twr_index` are all `NULL`, so *value against net
    // contributed* is two empty curves. Which pair is drawn is said by the two
    // **names** in the legend — a valuation against a cost, not a value against
    // what was put in — and *Performance* is not offered rather than offered
    // empty.
    server.use(
      totalsOf({
        total_value: null,
        cash_balance: null,
        net_contributed: null,
        twr_index: null,
        ytd: null,
      }),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })
    await chartCard()

    expect(await screen.findByText('Valorisation')).toBeInTheDocument()
    expect(screen.getByText('Prix de revient')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Performance' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Lecture' })).not.toBeInTheDocument()
    // The range control survives the fallback: it sets the chart's window, not
    // a property of the series it happens to be drawing, and it sits beside
    // the `Montants` heading (#1150).
    expect(screen.getByRole('radiogroup', { name: 'Plage' })).toBeInTheDocument()
  })

  it('states neither a base date nor a base rule on the performance reading', async () => {
    // The date was already refused: the curve is rebased on the first day of
    // the visible window, so it does not move as the reconstruction reaches
    // further back — only the head's scalar does, and that one carries the date
    // while it is still moving. The **rule** goes with it (#831): *base 0 % au
    // premier jour de la plage affichée* is a convention written on the page,
    // and the two marks that say it without a sentence stay — the zero line the
    // curve crosses and the range control that names the window.
    const { user } = renderApp()
    await screen.findByRole('group', { name: 'Gain total' })
    await chartCard()

    await user.click(await screen.findByRole('button', { name: 'Performance' }))
    // The legend goes with the reading, which is how one knows the card has
    // actually swapped what it draws.
    await waitFor(async () =>
      expect(within(await chartCard()).queryByText('Valeur totale')).not.toBeInTheDocument(),
    )
    expect(screen.queryByText(/Base 0 %/)).not.toBeInTheDocument()
    expect(screen.queryByText(/premier jour de la plage/)).not.toBeInTheDocument()
    expect(screen.queryByText(/L’écart entre les deux courbes/)).not.toBeInTheDocument()
  })
})

describe('the page shows figures and never explains itself (#831)', () => {
  // The bubbles themselves are asserted above — four of them, on the head's
  // four figures. What is asserted here is the other half of the same decision:
  // the page states **no rule of the product** in prose. The three sentences
  // that did lived under the chart, one per reading, and a convention written
  // on the page is what the icon on the figure exists to replace.
  const RULES = [
    /L’écart entre les deux courbes/,
    /Base 0 %/,
    /l’application ne peut pas distinguer/,
  ]

  it('states no rule in prose, in either reading of the chart', async () => {
    const { user } = renderApp()
    await screen.findByRole('group', { name: 'Gain total' })
    await chartCard()

    for (const rule of RULES) expect(screen.queryByText(rule)).not.toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: 'Performance' }))
    await waitFor(async () =>
      expect(within(await chartCard()).queryByText('Valeur totale')).not.toBeInTheDocument(),
    )
    for (const rule of RULES) expect(screen.queryByText(rule)).not.toBeInTheDocument()
  })

  it('states none of them either where the reading falls back to cost', async () => {
    // The install with no cash ledger is where the last of the three lived, and
    // it was the one carrying a rule about what the app **cannot** tell from
    // what. Which pair of curves is drawn is said by their two **names**, and
    // that is a label rather than a rule.
    server.use(
      totalsOf({
        total_value: null,
        cash_balance: null,
        net_contributed: null,
        twr_index: null,
        ytd: null,
      }),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    const chart = within(await chartCard())
    expect(chart.getByText('Valorisation')).toBeInTheDocument()
    expect(chart.getByText('Prix de revient')).toBeInTheDocument()
    for (const rule of RULES) expect(screen.queryByText(rule)).not.toBeInTheDocument()
  })
})

describe('the allocation is not on this page', () => {
  it('draws no ring and no legend in the chart slot since #831', async () => {
    // It sat on the wide track from #727 to #830, and the maquette draws it in
    // the `Titres` branch and nowhere in this one. The figure moved rather than
    // being duplicated: `shares.test.tsx` is where its three cases are now, on
    // the page whose table it divides.
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // The card is on the grid (#1206), and the chart's slot holds none of it.
    const chart = await chartCard()
    expect(within(chart).queryByRole('list', { name: 'Répartition' })).not.toBeInTheDocument()
    expect(within(chart).queryByText('Répartition')).not.toBeInTheDocument()
  })
})

describe('the allocation card (#1206)', () => {
  function showAllocation(width: 'half' | 'full') {
    server.use(
      http.get(ROUTES.dashboardLayout, () =>
        HttpResponse.json({
          version: 1,
          blocks: [{ id: 'allocation', width, hidden: false }],
        }),
      ),
    )
  }

  it('is shown on a fresh install, with nothing « Nouveau »', async () => {
    renderApp()

    expect(await screen.findByRole('region', { name: 'Répartition' })).toBeInTheDocument()
    expect(screen.queryByText(/nouvelles? cartes?/)).not.toBeInTheDocument()
  })

  it('arrives under « Nouveau » on a saved layout without it, and draws nothing until it is shown', async () => {
    server.use(
      http.get(ROUTES.dashboardLayout, () =>
        HttpResponse.json({
          version: 1,
          blocks: [{ id: 'gain-breakdown', width: 'half', hidden: false }],
        }),
      ),
    )
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier le tableau de bord' }))

    const hidden = await screen.findByRole('region', { name: 'Cartes masquées' })
    expect(within(hidden).getByText('Répartition').closest('li')).toHaveTextContent('Nouveau')
    expect(screen.queryByRole('list', { name: 'Répartition' })).not.toBeInTheDocument()
  })

  it('links the account view to the accounts page, and the security view to nothing (#1280)', async () => {
    showAllocation('half')
    renderApp()
    const card = await screen.findByRole('region', { name: 'Répartition' })

    expect(within(card).queryByRole('link', { name: 'Voir les comptes →' })).not.toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Compte' }))
    expect(within(card).getByRole('link', { name: 'Voir les comptes →' })).toHaveAttribute(
      'href',
      '/accounts',
    )
  })

  it('at half width, sets the total on the title row and draws a legend with no ring', async () => {
    showAllocation('half')
    renderApp()
    const card = await screen.findByRole('region', { name: 'Répartition' })

    const titleRow = within(card).getByRole('heading', { name: 'Répartition' }).parentElement!
    expect(titleRow).toHaveTextContent(/2\D?300,00/)
    expect(within(card).queryByRole('group', { name: 'Titres' })).not.toBeInTheDocument()
    expect(within(card).getAllByRole('listitem')).toHaveLength(3)
    // Nothing folded: the list counts itself (#1412).
    expect(card).not.toHaveTextContent(/en portefeuille/)

    // The selector swaps the slot: pressed, not a radio, and the total holds.
    const bySecurity = within(card).getByRole('button', { name: 'Titre' })
    const byAccount = within(card).getByRole('button', { name: 'Compte' })
    expect(bySecurity).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(byAccount)
    expect(byAccount).toHaveAttribute('aria-pressed', 'true')
    const legend = within(card).getByRole('list', { name: 'Répartition' })
    expect(within(legend).getByText('alpha')).toBeInTheDocument()
    expect(card).not.toHaveTextContent(/en portefeuille/)
    expect(titleRow).toHaveTextContent(/2\D?300,00/)
  })

  it('switches the view from the keyboard', async () => {
    showAllocation('half')
    const { user } = renderApp()
    const card = await screen.findByRole('region', { name: 'Répartition' })

    const byAccount = within(card).getByRole('button', { name: 'Compte' })
    byAccount.focus()
    await user.keyboard('{Enter}')
    expect(byAccount).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard(' ')
    expect(byAccount).toHaveAttribute('aria-pressed', 'true')
    expect(within(card).getByRole('button', { name: 'Titre' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('folds past five lines into « Autres · N lignes » and says so', async () => {
    showAllocation('half')
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload(
            Array.from({ length: 9 }, (_, index) =>
              aPosition({ symbol: `Z${index}`, name: `Zeta ${index}`, price: 90 - index }),
            ),
          ),
        ),
      ),
    )
    renderApp()
    const card = await screen.findByRole('region', { name: 'Répartition' })

    const legend = within(card).getByRole('list', { name: 'Répartition' })
    expect(within(legend).getAllByRole('listitem')).toHaveLength(5)
    expect(within(legend).getByText('Autres · 5 lignes')).toBeInTheDocument()
    expect(card).toHaveTextContent('9 lignes · top 4 détaillé, 5 regroupées')
  })

  it('names the seeded account from the catalogue, not by its id', async () => {
    showAllocation('half')
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload([
            aPosition({ account: 'default', symbol: 'ZZA', name: 'Zeta Alpha' }),
            aPosition({ account: 'alpha', symbol: 'ZZB', name: 'Zeta Beta' }),
          ]),
        ),
      ),
    )
    const { user } = renderApp()
    const card = await screen.findByRole('region', { name: 'Répartition' })
    await user.click(within(card).getByRole('button', { name: 'Compte' }))

    const legend = within(card).getByRole('list', { name: 'Répartition' })
    expect(within(legend).getByText('Non affecté')).toBeInTheDocument()
    expect(within(legend).queryByText('default')).not.toBeInTheDocument()
  })

  it('at full width, draws the ring with the total in its hole and the amounts', async () => {
    showAllocation('full')
    renderApp()
    const card = await screen.findByRole('region', { name: 'Répartition' })

    expect(within(card).getByRole('group', { name: 'Titres' })).toHaveTextContent(/2\D?300,00/)
    const row = within(card).getByText('Zeta Alpha').closest('li')!
    expect(row).toHaveTextContent(/1\D?300,00/)
    expect(within(card).getByRole('group', { name: 'Répartir par' })).toBeInTheDocument()

    // By account: the same total in the hole, each account with its amount.
    fireEvent.click(within(card).getByRole('button', { name: 'Compte' }))
    expect(within(card).getByRole('group', { name: 'Titres' })).toHaveTextContent(/2\D?300,00/)
    expect(within(card).getByText('alpha').closest('li')).toHaveTextContent(/1\D?300,00/)
    expect(within(card).getByText('gamma').closest('li')).toHaveTextContent(/600,00/)
  })

  it('folds past five accounts into « Autres · N comptes » and counts accounts', async () => {
    showAllocation('half')
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload(
            Array.from({ length: 9 }, (_, index) =>
              aPosition({ account: `acct${index}`, symbol: `Z${index}`, price: 90 - index }),
            ),
          ),
        ),
      ),
    )
    const { user } = renderApp()
    const card = await screen.findByRole('region', { name: 'Répartition' })
    await user.click(within(card).getByRole('button', { name: 'Compte' }))

    const legend = within(card).getByRole('list', { name: 'Répartition' })
    expect(within(legend).getAllByRole('listitem')).toHaveLength(5)
    expect(within(legend).getByText('Autres · 5 comptes')).toBeInTheDocument()
    expect(card).toHaveTextContent('9 comptes · top 4 détaillé, 5 regroupés')
  })

  it('freezes the selector on the title row while the grid is arranged', async () => {
    showAllocation('full')
    renderApp()
    const card = await screen.findByRole('region', { name: 'Répartition' })
    expect(within(card).getByRole('group', { name: 'Répartir par' }).closest('[inert]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Modifier le tableau de bord' }))
    await waitFor(() =>
      expect(
        within(card).getByRole('group', { name: 'Répartir par' }).closest('[inert]'),
      ).not.toBeNull(),
    )
  })

  it('at 390 px, draws the half-width legend whatever the saved width', async () => {
    setViewportWidth(390)
    showAllocation('full')
    renderApp()
    const card = await screen.findByRole('region', { name: 'Répartition' })

    expect(within(card).queryByRole('group', { name: 'Titres' })).not.toBeInTheDocument()
    const titleRow = within(card).getByRole('heading', { name: 'Répartition' }).parentElement!
    expect(titleRow).toHaveTextContent(/2\D?300,00/)
  })

  it('names the lines it could not place, even when it could place none', async () => {
    showAllocation('half')
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload([
            aPosition({ symbol: 'ZZB', price: 125, currency: 'USD', rate: null }),
          ]),
        ),
      ),
    )
    renderApp()
    const card = await screen.findByRole('region', { name: 'Répartition' })

    expect(card).toHaveTextContent(/1 ligne n’est pas dans cette répartition.*ZZB/)
    // No total on the title row and the empty state's reason, with nothing placed.
    const titleRow = within(card).getByRole('heading', { name: 'Répartition' }).parentElement!
    expect(titleRow).not.toHaveTextContent(/€/)
    expect(card).toHaveTextContent('Aucune position détenue')
  })

  it('offers no selector while fewer than two accounts hold a placed line', async () => {
    showAllocation('half')
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload([
            aPosition({ account: 'alpha', symbol: 'ZZA', name: 'Zeta Alpha' }),
            aClosedPosition({ account: 'beta', symbol: 'ZZD', closed_at: '2025-11-04' }),
            // Held, but with nothing placed: gamma is no slice either.
            aPosition({
              account: 'gamma',
              symbol: 'ZZB',
              price: 125,
              currency: 'USD',
              rate: null,
            }),
          ]),
        ),
      ),
    )
    renderApp()
    const card = await screen.findByRole('region', { name: 'Répartition' })

    expect(within(card).queryByRole('group', { name: 'Répartir par' })).not.toBeInTheDocument()
  })
})

describe('the movers', () => {
  it('shows one list, biggest move first, and counts what it does not show', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // **One list and no headings** (#838): what moved most at the top, either
    // way, which is what a five-row list says without a column
    // called *Hausses* and a *Rien n'a baissé* under an empty one.
    const list = within(await screen.findByRole('list', { name: 'Mouvements' }))
    expect(screen.queryByText('Hausses')).not.toBeInTheDocument()
    expect(screen.queryByText('Baisses')).not.toBeInTheDocument()

    // The **ticker** on every line (#790, #838): it is the identity the rest of
    // the product addresses a security by, and a rail of names alone cannot be
    // matched to the allocation's legend or to a broker's own screen. It is a
    // badge and `aria-hidden`, so the symbol is said beside the name.
    expect(list.getByText('Zeta Alpha').closest('li')).toHaveTextContent('ZZA')

    // Three lines held, one of them shown: `ZZB` moved by exactly 0,00 % and is
    // in neither column, `ZZC` has never been quoted and has nothing to compare
    // a first day against. Silence about them reads as *nothing to say*.
    expect(
      screen.getByText(/2 autres lignes n’apparaissent pas ici, dont 1 n’a pas bougé/),
    ).toBeInTheDocument()
  })

  it('says nothing of a closed line the server serves at 0,00 %', async () => {
    // `/api/positions` carries a sold line on purpose and
    // `/api/portfolio/movers` compares its frozen quote against a baseline equal
    // to it, so the payload holds a `change_pct: 0` about a line nobody owns.
    // Counted, it inflated *dont N n’a pas bougé* — the qualifier of a set it is
    // not in — while the count of the lines *not shown* was taken over the held
    // ones alone.
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload([
            ...defaultPositions(),
            aClosedPosition({
              account: 'alpha',
              symbol: 'ZZD',
              name: 'Zeta Delta',
              closed_at: '2025-11-04',
            }),
          ]),
        ),
      ),
      http.get(ROUTES.movers, () =>
        HttpResponse.json(
          aMoversPayload([
            aMover(),
            aMover({ symbol: 'ZZB', name: 'Zeta Beta', change: 0, change_pct: 0, contribution: 0 }),
            aMover({
              symbol: 'ZZD',
              name: 'Zeta Delta',
              change: 0,
              change_pct: 0,
              market_value: 0,
              contribution: 0,
            }),
          ]),
        ),
      ),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // Unchanged still, and *one*: the three held lines, of which `ZZB` moved by
    // nothing and `ZZC` was never quoted. The closed one is in neither figure.
    expect(
      await screen.findByText(/2 autres lignes n’apparaissent pas ici, dont 1 n’a pas bougé/),
    ).toBeInTheDocument()
    expect(screen.queryByText('Zeta Delta')).not.toBeInTheDocument()
  })

  describe('says *dont 11* out of 11 once (#1146)', () => {
    // One line moved, `others` held lines behind it, `unchanged` of them at 0,00 %
    // and the rest never quoted.
    const hidden = (others: number, unchanged: number) => {
      const symbols = Array.from({ length: others }, (_, i) => `ZH${i}`)
      server.use(
        http.get(ROUTES.positions, () =>
          HttpResponse.json(
            aPositionsPayload([
              aPosition(),
              ...symbols.map((symbol) => aPosition({ symbol, name: `Hidden ${symbol}` })),
            ]),
          ),
        ),
        http.get(ROUTES.movers, () =>
          HttpResponse.json(
            aMoversPayload([
              aMover(),
              ...symbols.slice(0, unchanged).map((symbol) =>
                aMover({
                  symbol,
                  name: `Hidden ${symbol}`,
                  change: 0,
                  change_pct: 0,
                  contribution: 0,
                }),
              ),
            ]),
          ),
        ),
      )
      renderApp()
    }

    it.each([
      [11, 11, 'Les 11 autres lignes n’ont pas bougé.'],
      [11, 3, '11 autres lignes n’apparaissent pas ici, dont 3 n’ont pas bougé.'],
      [1, 1, 'L’autre ligne n’a pas bougé.'],
    ])('%i hidden, %i unchanged', async (others, unchanged, sentence) => {
      hidden(others, unchanged)
      expect(await screen.findByText(sentence)).toBeInTheDocument()
    })
  })

  it('draws a rank only when there is something to rank against (#1147)', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })
    // The default payload moves one line: a « 1 » beside it is noise.
    const one = within(await screen.findByRole('list', { name: 'Mouvements' }))
    expect(one.queryByText('1')).not.toBeInTheDocument()
  })

  it('ranks two lines « 1 » and « 2 »', async () => {
    server.use(
      http.get(ROUTES.movers, () =>
        HttpResponse.json(
          aMoversPayload([
            aMover(),
            aMover({ symbol: 'ZZB', name: 'Zeta Beta', change_pct: -0.01, contribution: -4 }),
          ]),
        ),
      ),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })
    const two = within(await screen.findByRole('list', { name: 'Mouvements' }))
    expect(two.getByText('1')).toBeInTheDocument()
    expect(two.getByText('2')).toBeInTheDocument()
  })

  it('says what it compares against, once, and dates nothing', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // Undated (#1142): each line has its own previous close, and on a weekend a
    // stock's and a 24/7 line's are not on the same day.
    expect(
      await within(await screen.findByRole('region', { name: 'Mouvements' })).findAllByText(
        'Aujourd’hui',
      ),
    ).toHaveLength(1)
  })
})

describe('the page is a grid of sections, never of cards (DESIGN.md)', () => {
  it('draws its four blocks as sections and no card at all', async () => {
    const { container } = renderApp()
    await screen.findByRole('list', { name: 'Mouvements' })
    await screen.findByRole('region', { name: 'Rythme d’investissement' })

    // A card is for something the user decides; nothing on this page is.
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(0)
    const sections = container.querySelectorAll('[data-slot="section"]')
    // The default layout of the dashboard grid (#1280): the allocation and the
    // gain, then the movers and the rhythm, two to a row.
    expect([...sections].map((one) => one.querySelector('h2')?.textContent)).toEqual([
      'Répartition',
      'D’où vient le gain',
      'Mouvements',
      'Rythme d’investissement',
    ])
    // And never one inside another.
    expect(container.querySelectorAll('[data-slot="section"] [data-slot="section"]')).toHaveLength(
      0,
    )
  })

  it('sets the close the movements compare against on the title’s row', async () => {
    renderApp()
    const movers = await screen.findByRole('region', { name: 'Mouvements' })
    const titleRow = within(movers).getByRole('heading', { name: 'Mouvements' }).parentElement!
    expect(titleRow).toHaveTextContent(/Aujourd’hui/)
  })
})

describe('the investment rhythm', () => {
  it('never says the amount without the coverage', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // **One group, two figures** (#751). The coverage is inside the
    // amount's own group rather than beside it, which is what makes *500 €*
    // impossible to read on its own — and *500 € a month* is what a reader
    // turns into *6 000 € a year* when half of that never went in.
    const amount = await screen.findByRole('group', { name: 'Acheté par mois (médiane)' })
    expect(amount).toHaveTextContent(/500,00/)
    expect(amount).toHaveTextContent('Sur 6 des 12 derniers mois')
  })

  it('lets its strip fill the height the row gives it, between 56 and 160 px (#1280)', async () => {
    renderApp()
    const strip = await screen.findByRole('list', { name: 'Acheté, mois par mois' })

    expect(strip.parentElement).toHaveClass('flex-1', 'min-h-14', 'max-h-40')
  })

  it('draws the months and judges none of them', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // The twelve observed months, oldest first, each naming what was bought in
    // it — and a month with no purchase said as such rather than left out,
    // because a gap is a fact about the rhythm. **No label anywhere**: not
    // *régulier*, not *mensuel* — the threshold that would produce one is a
    // setting nobody asked for, and the reading belongs to the
    // reader. The coefficient of variation stays in the payload and is quoted
    // nowhere: `18 %` of a month's own average is not a sentence.
    const strip = await screen.findByRole('list', { name: 'Acheté, mois par mois' })
    const months = within(strip).getAllByRole('listitem')
    expect(months).toHaveLength(12)
    expect(months[0]).toHaveTextContent(/mars 2025 : 400,00/)
    expect(months[1]).toHaveTextContent('avr. 2025 : aucun achat')
    expect(months[11]).toHaveTextContent('févr. 2026 : aucun achat')
    expect(screen.queryByText(/18,00/)).not.toBeInTheDocument()
    expect(screen.queryByText(/régulier/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/irrégulier/i)).not.toBeInTheDocument()
  })

  it('lets no month set the scale for the others when none is out of line', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // The default months peak at 620, under three times the median of 500:
    // the scale is the peak, as before #1152.
    const strip = await screen.findByRole('list', { name: 'Acheté, mois par mois' })
    expect(strip.querySelector('[data-capped]')).toBeNull()
    const bars = strip.querySelectorAll<HTMLElement>('[style*="height"]')
    expect(bars).toHaveLength(6)
    expect(bars[3].style.height).toBe('100%')
  })

  it('caps one large month at three times the median and notches it', async () => {
    // One large month used to press the other purchases onto the floor, where
    // they read as months with nothing bought (#1152).
    const months = aRhythm().months.map((one) =>
      one.month === '2025-09'
        ? { ...one, amount: 5000 }
        : one.month === '2025-03'
          ? { ...one, amount: 50 }
          : one,
    )
    server.use(http.get(ROUTES.investmentRhythm, () => HttpResponse.json(aRhythm({ months }))))
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    const strip = await screen.findByRole('list', { name: 'Acheté, mois par mois' })
    const items = within(strip).getAllByRole('listitem')
    const capped = items[6].querySelector<HTMLElement>('[data-capped]')
    expect(capped).not.toBeNull()
    expect(capped!.style.height).toBe('100%')
    expect(capped!.children).toHaveLength(1)
    expect(capped!.firstElementChild).toHaveClass('absolute', 'bg-muted')
    // The exact amount survives the cap, for a pointer and a screen reader.
    expect(items[6]).toHaveTextContent(/sept\. 2025 : 5\s000,00/)
    expect(items[6].getAttribute('title')).toMatch(/5\s000,00/)
    // The others are scaled to the cap (1 500), not to 5 000…
    const height = (item: HTMLElement) =>
      item.querySelector<HTMLElement>('[style*="height"]')!.style.height
    expect(parseFloat(height(items[2]))).toBeCloseTo((500 / 1500) * 100)
    // …and a small month stays well clear of the empty tick.
    expect(height(items[0])).toBe('15%')
    expect(items[1].querySelector('[style*="height"]')).toBeNull()
  })

  it('says no purchase rather than a rhythm of zero', async () => {
    // The absence the record names: a null amount with a coverage of zero is
    // *nobody bought anything*, and rendering it as `0,00 €` would state a
    // habit of buying nothing every month.
    server.use(
      http.get(ROUTES.investmentRhythm, () =>
        HttpResponse.json(
          aRhythm({ monthly_amount: null, months_covered: 0, dispersion: null, accounts: [] }),
        ),
      ),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    expect(await screen.findByText('Aucun achat sur les 12 derniers mois')).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Acheté par mois (médiane)' }),
    ).not.toBeInTheDocument()
  })

  it('draws one month when one month is all there is', async () => {
    // The population deviation of a single value is `0`, and the server
    // publishes it: over the one month lived, the amount did not vary. Drawn on
    // screen it reads *held perfectly steady* from one purchase — a claim about
    // a habit nobody has had time to have, on the first-run screen. The pair
    // above it survives, which is the figure that is actually true.
    server.use(
      http.get(ROUTES.investmentRhythm, () =>
        HttpResponse.json(
          aRhythm({
            months_covered: 1,
            months_observed: 1,
            dispersion: 0,
            months: [{ month: '2026-02', amount: 500 }],
          }),
        ),
      ),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    const amount = await screen.findByRole('group', { name: 'Acheté par mois (médiane)' })
    // And the coverage says *the one month observed* rather than counting one
    // out of one, which is a sentence with the same number twice in it.
    expect(amount).toHaveTextContent('Sur le seul mois observé')
    // The strip holds that one month and nothing invented around it.
    const strip = screen.getByRole('list', { name: 'Acheté, mois par mois' })
    expect(within(strip).getAllByRole('listitem')).toHaveLength(1)
  })

  it('renders nothing at all — title included — while the read is in flight', async () => {
    server.use(
      http.get(ROUTES.investmentRhythm, async () => {
        await delay('infinite')
        return HttpResponse.json(aRhythm())
      }),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })
    await screen.findByRole('list', { name: 'Mouvements' })

    expect(screen.queryByText('Rythme d’investissement')).not.toBeInTheDocument()
  })
})

describe('the time announcers', () => {
  it('keeps two permanent ones and no more', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // The page's own mention of when its prices were read, and the movers'
    // reference close — a *different* instant, and the subject of that block.
    expect(await screen.findByText(/Cours au 2 mars 2026/)).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Mouvements' })).getAllByText('Aujourd’hui'),
    ).toHaveLength(1)
    // The two transitory ones are absent here: the reconstruction is over, so
    // the base date is not news and the notifications panel raises no card for
    // it (#829).
    expect(screen.queryByText(/30 oct\. 2019/)).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('no installation fact lands here', () => {
  it('says nothing of a standing notice, which the installation tab counts', async () => {
    // A notice posted on the dashboard is invisible to whoever lands on another
    // page, and it would compete with the one global indicator — the bell since
    // #829, the banner before it. The badge on the data page is the
    // counterpart (#724).
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    expect(screen.queryByText(/Your amounts were read as EUR/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Acquitter/ })).not.toBeInTheDocument()
  })
})

describe('the four states of the page', () => {
  it('gives a portfolio with no events one sentence and a link, and nothing else', async () => {
    server.use(
      http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload([], null))),
      http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(null, null))),
    )
    renderApp()

    expect(await screen.findByText('Aucun événement')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Aller au grand livre' })).toBeInTheDocument()
    // Not a third copy of the pair of entries (#723's, which the first-run
    // modal is the second of): this page reads, it is not where one enters.
    expect(screen.queryByRole('radiogroup', { name: 'Plage' })).not.toBeInTheDocument()
    expect(screen.queryByText('Mouvements')).not.toBeInTheDocument()
    expect(screen.queryByText('Vos comptes, comparés')).not.toBeInTheDocument()
    // And the route is the dashboard unconditionally: a bookmark valid
    // yesterday is valid at zero events too.
    expect(screen.getByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument()
  })

  it('gives a portfolio that has sold everything an ordinary page', async () => {
    // The one place in the product where the em dash and the zero are read side
    // by side at the scale of the portfolio: `Plus-value latente —` because
    // nothing is held, the value read off the cash alone.
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload([
            aClosedPosition({
              symbol: 'ZZD',
              realised: 120,
              dividends: 10,
              closed_at: '2025-11-04',
            }),
            aClosedPosition({ symbol: 'ZZE', realised: -45, closed_at: '2026-01-15' }),
          ]),
        ),
      ),
      totalsOf({ holdings_value: 0 }),
      http.get(ROUTES.movers, () => HttpResponse.json(aMoversPayload([]))),
    )
    renderApp()

    //   realised +120,00 − 45,00 · dividends +10,00 · fees −5,00 = +80,00
    const head = await hero()
    expect(head).toHaveTextContent(/80,00/)
    expect(await screen.findByRole('group', { name: 'Plus-value latente' })).toHaveTextContent('—')
    expect(figure('Plus-value réalisée')).toHaveTextContent(/75,00/)
    expect(head).toHaveTextContent(/dont 500,00\D?€ de liquidités/)

    // And the block says **why** it is empty rather than being absent. There is
    // one of them here since #831: the allocation, which said the same thing
    // about the same portfolio, is on the shares page and says it there.
    expect(await screen.findByText('Rien à comparer')).toBeInTheDocument()
    // Nothing is compared, so the block names no close it compares against.
    expect(
      within(screen.getByRole('region', { name: 'Mouvements' })).queryByText('Aujourd’hui'),
    ).not.toBeInTheDocument()
  })
})

describe('the reconstruction, on the bell and in the block it leads to', () => {
  it('takes the green off the bell: the consolidated figures are behind', async () => {
    // **Green means the quotes are read *and* the performance is up to date**
    // (#787). It used to mean the scheduler was running, which is true during a
    // rebuild — so the indicator said the installation was fine while a red
    // band said the opposite at the top of the same page.
    server.use(
      http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))),
      // It reads `/health` since #819, where the same fact is the
      // backfill job's own verdict.
      http.get(ROUTES.health, () => HttpResponse.json(aRebuilding())),
    )
    renderApp()

    expect(
      await screen.findByRole('button', {
        name: /Votre historique est en cours de reconstruction/,
      }),
    ).toBeInTheDocument()
    // And the band is gone with it (#829): a condition that ends by
    // itself does not take the top of every page on every route, and there is
    // no band left anywhere to take it.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('carries a bar and names the account holding the global figures back', async () => {
    // The global series is written only where **every** account is,
    // so without the name *one slow account delays the whole home page* is a
    // rule nothing on screen states — and the owner reads the delay as a fault
    // of the portfolio as a whole. It is on the installation tab now, which is
    // where the dot leads.
    server.use(
      http.get(ROUTES.runtime, () =>
        HttpResponse.json(
          aRuntime({
            rebuilding: true,
            accounts: [
              { account: 'alpha', horizon: '2026-01-01' },
              { account: 'beta', horizon: '2025-06-01' },
              { account: 'gamma', horizon: '2024-01-01' },
            ],
          }),
        ),
      ),
    )
    renderApp({ url: '/system' })

    expect(await screen.findByText(/Compte le plus en retard : Alpha/)).toBeInTheDocument()
    // (2026-03-02 → 2026-01-01) over (2026-03-02 → 2025-12-24), the oldest day
    // the ledger names: 60 days of 68.
    expect(await screen.findByRole('progressbar')).toHaveAccessibleName(
      /88\D?% de la période couverte/,
    )
  })

  it('does not exist when nothing is being rebuilt', async () => {
    // A block with nothing in it does not exist. The workloads card names the
    // backfill whatever it is doing, which is why the absence is asked of *this*
    // card's own name rather than of the word `reconstruction` on the page.
    renderApp({ url: '/system' })
    await screen.findByRole('heading', { name: 'Tâches' })

    expect(screen.queryByText('Reconstruction en cours')).not.toBeInTheDocument()
  })
})

describe('the head in English', () => {
  it('renders whole, and says `Total P&L` rather than `Total gain`', async () => {
    renderApp({ browserLanguages: ['en-GB'] })

    // `Total gain` and `Total return` start with the same word and cohabit on
    // this very block.
    expect(await screen.findByRole('group', { name: 'Total P&L' })).toHaveTextContent(/370\.00/)
    expect(screen.queryByText('Total gain')).not.toBeInTheDocument()
    expect(figure('Unrealised P&L')).toHaveTextContent(/300\.00/)
    // Numbers follow the language, not the currency: the same euros, grouped
    // and pointed the English way.
    expect(figure('Portfolio value')).toHaveTextContent(/2,800\.00/)
    expect(figure('Portfolio value')).toHaveTextContent(/\+€370\.00\s*total P&L/)
    expect(screen.getByRole('heading', { name: 'Where the P&L comes from' })).toBeInTheDocument()
  })
})

describe('the comparison card (#1205)', () => {
  /** A saved layout with the card shown, at the width asked. */
  function shown(width: 'half' | 'full' = 'half') {
    return http.get(ROUTES.dashboardLayout, () =>
      HttpResponse.json({
        version: 1,
        blocks: [
          { id: 'gain-breakdown', width: 'half', hidden: false },
          { id: 'rhythm', width: 'half', hidden: false },
          { id: 'movers', width: 'full', hidden: false },
          { id: 'benchmark', width, hidden: false },
        ],
      }),
    )
  }

  function ready(overrides: Partial<BenchmarkResponse> = {}): Partial<BenchmarkResponse> {
    return {
      state: 'ready',
      reference: 'CW8.PA',
      index: 'MSCI World',
      consulted: ['CW8.PA'],
      covered_from: '2019-03-04',
      covered_to: '2026-09-17',
      ended: null,
      portfolio_value: 98_765.43,
      reference_value: 94_552.63,
      gap_gross: 4212.8,
      ...overrides,
    }
  }

  function renderCard(payload: Partial<BenchmarkResponse>, width: 'half' | 'full' = 'half') {
    server.use(
      shown(width),
      http.get(ROUTES.benchmark, () => HttpResponse.json(aBenchmark(payload))),
    )
    return renderApp()
  }

  const card = (name: string | RegExp = /^Face au/) => screen.findByRole('region', { name })

  it('states the gap, signed, with the period — and neither of the two values', async () => {
    renderCard(ready())
    const region = await card('Face au MSCI World')

    expect(within(region).getByText('+4 212,80 €')).toHaveClass('text-foreground', 'text-2xl')
    expect(region).toHaveTextContent(
      'd’avance, avec les mêmes versements · 4 mars 2019 → 17 sept. 2026',
    )
    expect(region).not.toHaveTextContent(/98\D?765/)
    expect(region).not.toHaveTextContent(/94\D?552/)
    expect(within(region).getByRole('link', { name: 'Voir la comparaison →' })).toHaveAttribute(
      'href',
      '/benchmark',
    )
  })

  it('the benchmark card writes its gap in the colour of text', async () => {
    renderCard(
      ready({
        gap_gross: -12.5,
        per_account: [
          aBenchmarkAccountRow({ account: 'PEA', gap_gross: 5000 }),
          aBenchmarkAccountRow({ account: 'CTO', gap_gross: -787.2 }),
        ],
      }),
    )
    const region = await card()

    for (const figure of [/^[-−]12,50 €$/, /^[-−]787,20 €$/, /^\+5\D?000,00 €$/]) {
      const node = within(region).getByText(figure)
      expect(node).toHaveClass('text-foreground')
      expect(node).not.toHaveClass('text-loss')
      expect(node).not.toHaveClass('text-gain')
    }
  })

  // To the cent: `−0,004 €` is a zero, not a loss printed as `−0,00 €`.
  it.each([
    [-12.5, /^[-−]12,50 €$/, 'de retard', 'text-foreground'],
    [0.004, /^0,00 €$/, 'à égalité', 'text-foreground'],
    [-0.004, /^0,00 €$/, 'à égalité', 'text-foreground'],
    // Half a cent is a cent on either side, as `Intl` would round it.
    [0.005, /^\+0,01 €$/, 'd’avance', 'text-foreground'],
    [-0.005, /^[-−]0,01 €$/, 'de retard', 'text-foreground'],
    // `1.005 * 100` is 100.4999… in binary: the cent is the decimal's.
    [1.005, /^\+1,01 €$/, 'd’avance', 'text-foreground'],
  ])('reads %s as %s, %s', async (gap, figure, verdict, tone) => {
    renderCard(ready({ gap_gross: gap }))
    const region = await card()

    expect(within(region).getByText(figure)).toHaveClass(tone)
    expect(region).toHaveTextContent(verdict)
  })

  it('says nothing of a gap it does not have, and keeps the em dash', async () => {
    renderCard(ready({ gap_gross: null }))
    const region = await card()

    expect(within(region).getByText('—')).toBeInTheDocument()
    expect(region).not.toHaveTextContent(/d’avance|de retard|à égalité/)
    // The period stays: the em dash is about the figure, not the window.
    expect(region).toHaveTextContent('4 mars 2019 → 17 sept. 2026')
  })

  it('breaks the gap down by account, only with two of them', async () => {
    const row = (account: string, gap_gross: number | null) =>
      aBenchmarkAccountRow({ account, gap_gross })
    renderCard(ready({ per_account: [row('PEA', 5000), row('CTO', -787.2), row('AV', null)] }))
    const list = within(await card()).getByRole('list', { name: 'Compte par compte' })

    const [pea, cto, av] = within(list).getAllByRole('listitem')
    expect(pea).toHaveTextContent(/^PEA\+5\D?000,00 €$/)
    expect(cto).toHaveTextContent(/^CTO[-−]787,20 €$/)
    // A null gap keeps its row, with the em dash.
    expect(av).toHaveTextContent(/^AV—$/)
  })

  it('draws no row for a single account', async () => {
    renderCard(
      ready({
        per_account: [aBenchmarkAccountRow({ gap_gross: 4212.8 })],
      }),
    )
    expect(within(await card()).queryByRole('list')).not.toBeInTheDocument()
  })

  it('invites to choose an index when none is', async () => {
    renderCard({ state: 'no_reference' })
    const region = await card('Face à l’indice')

    expect(within(region).getByText('Aucune référence choisie')).toBeInTheDocument()
    expect(within(region).getByRole('link', { name: 'Choisir un indice' })).toHaveAttribute(
      'href',
      '/benchmark',
    )
  })

  it.each(['rebuilding', 'splits_unknown'] as const)(
    'shows the rebuild and no figure while %s',
    async (state) => {
      renderCard(
        ready({
          state,
          rebuild: { symbol: 'CW8.PA', reached: '2015-01-02', target: '2009-06-16', ratio: 0.4 },
        } as Partial<BenchmarkResponse>),
      )
      const region = await card('Face au MSCI World')

      expect(region).toHaveTextContent('Reconstitution de l’historique')
      expect(region).not.toHaveTextContent(/4\D?212/)
    },
  )

  it('keeps its title and no figure while a rebuild has no progress to show yet', async () => {
    renderCard(ready({ state: 'splits_unknown' }))
    const region = await card('Face au MSCI World')

    expect(region).not.toHaveTextContent(/4\D?212/)
  })

  // The page's sentence for each `reason` (#1207), and the ledger only where
  // the cause lives there.
  it.each([
    ['no_events', /Enregistrez vos premiers événements/, true],
    [undefined, /Enregistrez vos premiers événements/, true],
    ['not_computed', /pas encore calculées/, false],
    ['nothing_held', /pas sur les liquidités/, true],
    ['no_rate_on_seed', /un taux de change manque/, false],
  ] as const)('says why there is nothing to compare: %s', async (reason, body, ledger) => {
    renderCard({ state: 'nothing_to_compare', reason, reference: 'CW8.PA', index: 'MSCI World' })
    const region = await card('Face au MSCI World')

    expect(region).toHaveTextContent(body)
    expect(Boolean(within(region).queryByRole('link', { name: 'Aller au grand livre' }))).toBe(
      ledger,
    )
  })

  it('says why the total is missing when the accounts have theirs', async () => {
    renderCard({
      state: 'nothing_to_compare',
      reason: 'no_rate_on_seed',
      reference: 'CW8.PA',
      per_account: [
        aBenchmarkAccountRow({ account: 'PEA', gap_gross: 100 }),
        aBenchmarkAccountRow({ account: 'CTO', gap_gross: -50 }),
      ],
    })
    const region = await card('Face au CW8.PA')

    expect(region).toHaveTextContent(
      'Le total ne peut pas être comparé : un taux de change manque au premier jour.',
    )
    expect(within(region).getAllByRole('listitem')).toHaveLength(2)
  })

  it('shows no amount without a base currency', async () => {
    renderCard(ready({ base_currency: null }))
    const region = await card('Face à l’indice')

    expect(region).not.toHaveTextContent('€')
  })

  it('names a failed read in its slot', async () => {
    server.use(
      shown(),
      problemHandler(ROUTES.benchmark, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp()

    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
  })

  it('asks again every minute while the reference is rebuilt, and stops once ready', async () => {
    let calls = 0
    let payload: Partial<BenchmarkResponse> = ready({ state: 'rebuilding' })
    server.use(
      shown(),
      http.get(ROUTES.benchmark, () => {
        calls += 1
        return HttpResponse.json(aBenchmark(payload))
      }),
    )
    renderApp({ fakeTimers: true })
    expect(await card('Face au MSCI World')).not.toHaveTextContent('d’avance')
    expect(calls).toBe(1)

    payload = ready()
    await vi.advanceTimersByTimeAsync(60_000)
    await screen.findByText(/d’avance/)
    expect(calls).toBe(2)

    await vi.advanceTimersByTimeAsync(180_000)
    expect(calls).toBe(2)
  })

  it('refreshes after an event write', async () => {
    let calls = 0
    server.use(
      shown(),
      http.get(ROUTES.benchmark, () => {
        calls += 1
        return HttpResponse.json(aBenchmark(ready()))
      }),
    )
    const { queryClient } = renderApp()
    await card()

    // What every event write does on success.
    await queryClient.invalidateQueries()
    await waitFor(() => expect(calls).toBe(2))
  })
})
