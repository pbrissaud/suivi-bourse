/**
 * The dashboard (« Relevé »): the hero and its period, the chart, then the
 * investment rhythm and the securities' value, each with its states.
 *
 * The gain total, the cash, the variation and the net if sold are the server's
 * (`GET /api/portfolio-totals`): the page states them and sums nothing.
 *
 * Assertions are on the accessible rendering: a role, a name, a text. Amounts
 * are matched with regular expressions rather than literals because `fr-FR`
 * groups with a narrow no-break space, and a test that hard-coded a plain one
 * would be asserting the wrong thing about the right number.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, delay, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aClosedPosition,
  aPosition,
  aPositionsPayload,
  aRebuilding,
  aRhythm,
  aRuntime,
  aTotals,
  aTotalsPayload,
  NOW,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

/** One figure and everything subordinate to it, by the name it wears. */
function figure(name: string) {
  return screen.getByRole('group', { name })
}

/** The hero: the portfolio's value and its variation over the period. */
function hero() {
  return screen.findByRole('group', { name: 'Valeur du portefeuille' })
}

function totalsOf(overrides: Parameters<typeof aTotals>[0]) {
  return http.get(ROUTES.portfolioTotals, () =>
    HttpResponse.json(aTotalsPayload(aTotals(overrides))),
  )
}

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

  it('keeps the value and its figures when the rebuild runs but the row is today’s', async () => {
    server.use(rebuilding({ complete: 9, total: 19 }))
    renderApp()

    const head = await hero()
    expect(head).toHaveTextContent(/2\D?800,00/)
    expect(screen.getByText(/TRI/)).toHaveTextContent(/3,22/)
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
    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/370,00/)
    expect(
      await screen.findByRole('group', { name: /Valeur du portefeuille|Titres/ }),
    ).toHaveTextContent(/\d,\d\d/)
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
    await screen.findByRole('group', { name: 'Gain total' })
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
    server.use(unreadable(ROUTES.portfolioTotalsHistory), unreadable(ROUTES.investmentRhythm))
    renderApp()

    await waitFor(() => expect(screen.getAllByText('Lecture impossible')).toHaveLength(2))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await theHeadStandsWhole()
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

describe('the investment rhythm', () => {
  it('never says the amount without the coverage', async () => {
    renderApp()

    // The amount is read with its coverage in the same plane: *500 € a month*
    // is what a reader turns into *6 000 € a year* when half of that never went
    // in, so the sentence under the months says what really did.
    const rhythm = await screen.findByRole('region', { name: 'Rythme d’investissement' })
    expect(rhythm).toHaveTextContent(/500,00\D?€\s*achetés par mois/)
    expect(rhythm).toHaveTextContent(/versés sur 12 mois/)
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

    const rhythm = await screen.findByRole('region', { name: 'Rythme d’investissement' })
    // The window says *the last month* rather than counting one out of one.
    expect(rhythm).toHaveTextContent('Dernier mois')
    expect(rhythm).toHaveTextContent(/500,00\D?€ versés sur 1 mois\./)
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
    await screen.findByRole('group', { name: 'Gain total' })

    expect(screen.queryByText('Rythme d’investissement')).not.toBeInTheDocument()
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
    )
    renderApp()

    // The gain total is the server's: the page states it as it comes.
    expect(await hero()).toHaveTextContent(/2\D?800,00/)
    expect(await screen.findByLabelText('Trajectoire')).toHaveTextContent(/500,00/)
    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/370,00/)
    expect(screen.getByText('Valeur des titres')).toBeInTheDocument()
    expect(screen.getByText('Aucune ligne détenue')).toBeInTheDocument()
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

describe('the hero (« Relevé »)', () => {
  it('states the value, then its variation over the period, in words', async () => {
    renderApp()

    const head = await hero()
    expect(head).toHaveTextContent(/2\D?800,00/)
    // The default period is a year: `variation['1Y']` of the payload.
    expect(head).toHaveTextContent(/\+310,00\D?€/)
    expect(head).toHaveTextContent(/\+14,0\D?%/)
    expect(head).toHaveTextContent('depuis un an')
  })

  it('moves the variation line and the chart together with the period', async () => {
    const { user } = renderApp()
    await hero()

    await user.click(await screen.findByRole('radio', { name: '1 mois' }))

    const head = await hero()
    expect(head).toHaveTextContent(/\+120,00\D?€/)
    expect(head).toHaveTextContent(/\+4,5\D?%/)
    expect(head).toHaveTextContent(/depuis le 2 févr\. 2026/)
    expect(screen.getByRole('radio', { name: '1 mois' })).toBeChecked()

    await user.click(screen.getByRole('radio', { name: 'Tout' }))
    expect(await hero()).toHaveTextContent('depuis le premier versement')
    await user.click(screen.getByRole('radio', { name: 'Cette année' }))
    expect(await hero()).toHaveTextContent(/depuis le 1ᵉʳ janvier/)
  })

  it('draws no variation where the series does not reach back that far', async () => {
    server.use(
      totalsOf({
        variation: {
          '1M': null,
          YTD: null,
          '1Y': null,
          MAX: { amount: 370, pct: 0.152, start_date: '2019-10-30' },
        },
      }),
    )
    renderApp()

    const head = await hero()
    expect(head).toHaveTextContent(/2\D?800,00/)
    expect(head).not.toHaveTextContent('depuis un an')
  })

  it('states the first deposit, the cash and the net if all sold on the right', async () => {
    renderApp()
    await hero()

    const trajectory = await screen.findByLabelText('Trajectoire')
    expect(trajectory).toHaveTextContent('Premier versement')
    expect(trajectory).toHaveTextContent(/30 oct\. 2019/)
    expect(trajectory).toHaveTextContent('Liquidités')
    expect(trajectory).toHaveTextContent(/500,00/)
    expect(trajectory).toHaveTextContent('Net si tout vendu')
    expect(trajectory).toHaveTextContent(/2\D?800,00/)
  })

  it('names the accounts whose tax was estimated in the net’s tooltip', async () => {
    server.use(totalsOf({ net_if_sold_today: 2650, estimated_accounts: ['pea'] }))
    const { user } = renderApp()

    const trajectory = await screen.findByLabelText('Trajectoire')
    expect(trajectory).toHaveTextContent(/2\D?650,00/)
    await user.hover(within(trajectory).getByText(/2\D?650,00/))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Impôt estimé sur le compte pea seul',
    )
  })

  it('says the net is gross where no account carries a tax model', async () => {
    const { user } = renderApp()

    const trajectory = await screen.findByLabelText('Trajectoire')
    await user.hover(within(trajectory).getAllByText(/2\D?800,00/)[0])

    expect(await screen.findByRole('tooltip')).toHaveTextContent(/Montant brut/)
  })

  it('draws the net contribution and the gain as one bar, then the line under it', async () => {
    renderApp()
    await hero()

    // 370 / 2 800 = 13,2 % of the value is gain.
    expect(await screen.findByRole('img', { name: /Versé net .*86,8.*gain .*13,2/ })).toBeVisible()
    const gain = screen.getByRole('group', { name: 'Gain total' })
    expect(gain).toHaveTextContent(/\+370,00\D?€/)
    expect(gain).toHaveTextContent(/\+15,2\D?%/)
    // The IRR stands alone on the right, with its unit, and carries no sign.
    expect(screen.getByText(/^TRI /)).toHaveTextContent(/TRI 3,22\D?% par an/)
  })

  it('draws no arrow, no pill and no help bubble', async () => {
    renderApp()
    const head = await hero()

    expect(head.querySelector('svg')).toBeNull()
    expect(screen.queryByRole('button', { name: /Ce que veut dire/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Depuis le 1ᵉʳ janvier/)).not.toBeInTheDocument()
  })

  it('names the securities as the hero, and leaves the cash out, where there is no cash ledger', async () => {
    server.use(
      totalsOf({
        total_value: null,
        cash_balance: null,
        net_contributed: null,
        twr_index: null,
        xirr: null,
        cash: null,
        net_if_sold_today: null,
        ytd: null,
      }),
    )
    renderApp()

    const head = await screen.findByRole('group', { name: 'Titres' })
    expect(head).toHaveTextContent(/2\D?300,00/)
    expect(screen.queryByText('Liquidités')).not.toBeInTheDocument()
    expect(screen.queryByText('Net si tout vendu')).not.toBeInTheDocument()
    expect(screen.queryByText(/^TRI /)).not.toBeInTheDocument()
    // The only reading of the chart is the valuation: one heading, no tabs.
    expect(await screen.findByRole('heading', { name: 'Montants' })).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('says a zero cash balance, which is a figure and not an absence', async () => {
    server.use(totalsOf({ cash: 0 }))
    renderApp()

    expect(await screen.findByLabelText('Trajectoire')).toHaveTextContent(/Liquidités\s*0,00/)
  })

  it('writes an unknown gain as a dash', async () => {
    server.use(totalsOf({ gain_total: { amount: null, pct: null } }))
    renderApp()

    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent('—')
  })

  it('renders whole in English', async () => {
    renderApp({ browserLanguages: ['en-GB'] })

    const head = await screen.findByRole('group', { name: 'Portfolio value' })
    expect(head).toHaveTextContent(/2,800\.00/)
    expect(head).toHaveTextContent('over the past year')
    expect(await screen.findByRole('group', { name: 'Total P&L' })).toHaveTextContent(/370\.00/)
    expect(await screen.findByText('Securities value')).toBeInTheDocument()
  })
})

describe('the chart', () => {
  it('chooses its reading with text tabs and its period with a segmented control', async () => {
    const { user } = renderApp()

    const tabs = await screen.findByRole('tablist', { name: 'Lecture' })
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Montants', 'Performance'])
    expect(within(tabs).getByRole('tab', { name: 'Montants' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    const range = screen.getByRole('radiogroup', { name: 'Plage' })
    expect(
      within(range)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['1 mois', 'Cette année', '1 an', 'Tout'])
    // One bar: the tabs and the period share a parent line.
    expect(tabs.parentElement?.contains(range)).toBe(true)

    await user.click(within(tabs).getByRole('tab', { name: 'Performance' }))
    expect(within(tabs).getByRole('tab', { name: 'Performance' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(await screen.findByText('Performance des titres')).toBeInTheDocument()
  })

  it('names its curves with the figures the drawing ends on', async () => {
    renderApp()

    await screen.findByRole('tablist', { name: 'Lecture' })
    const legend = (await screen.findAllByText('Valeur totale'))[0].parentElement
    expect(legend).toHaveTextContent(/1\D?800,00/)
  })

  it('holds its place as an empty plane while the series is in flight', async () => {
    server.use(http.get(ROUTES.portfolioTotalsHistory, () => new Promise<never>(() => {})))
    renderApp()

    await hero()
    expect(screen.queryByRole('tablist', { name: 'Lecture' })).not.toBeInTheDocument()
    expect(screen.queryByText('Lecture impossible')).not.toBeInTheDocument()
    expect(document.querySelector('[data-empty]')).toBeNull()
  })
})

describe('the two sections under the chart', () => {
  it('sets the rhythm and the securities’ value side by side', async () => {
    renderApp()

    const rhythm = await screen.findByRole('region', { name: 'Rythme d’investissement' })
    const securities = await screen.findByRole('region', { name: 'Valeur des titres' })
    expect(rhythm.parentElement).toBe(securities.parentElement)
    expect(rhythm.parentElement).toHaveClass('md:grid-cols-2')
  })

  it('says how much went in over the months, and which months nothing did', async () => {
    renderApp()

    const rhythm = await screen.findByRole('region', { name: 'Rythme d’investissement' })
    expect(rhythm).toHaveTextContent('12 derniers mois')
    expect(rhythm).toHaveTextContent(/500,00\D?€\s*achetés par mois \(médiane\)/)
    // 400 + 500 + 500 + 620 + 500 + 480
    expect(rhythm).toHaveTextContent(/3\D?000,00\D?€ versés sur 12 mois, aucun achat en avr\./)
  })

  it('divides the securities by line, the top four and the rest, without the cash', async () => {
    renderApp()

    const securities = await screen.findByRole('region', { name: 'Valeur des titres' })
    // Three held lines: 1 300 + 400 + 600.
    expect(securities).toHaveTextContent(/2\D?300,00\D?€\s*sur 3 lignes, hors liquidités/)
    const rows = within(within(securities).getByRole('list')).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Zeta Alpha')
    expect(rows[0]).toHaveTextContent(/56,5\D?%/)
    expect(securities).not.toHaveTextContent('Répartition')
    expect(within(securities).queryByRole('button')).not.toBeInTheDocument()
  })

  it('folds the lines past the fourth into one row', async () => {
    const lines = ['ZZA', 'ZZB', 'ZZC', 'ZZD', 'ZZE', 'ZZF'].map((symbol, index) =>
      aPosition({ symbol, name: `Line ${symbol}`, price: 100 - index * 10 }),
    )
    server.use(http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload(lines))))
    renderApp()

    const securities = await screen.findByRole('region', { name: 'Valeur des titres' })
    expect(securities).toHaveTextContent('2 autres lignes')
    expect(within(within(securities).getByRole('list')).getAllByRole('listitem')).toHaveLength(5)
  })

  it('holds the place of each while its read is in flight, and says nothing', async () => {
    server.use(http.get(ROUTES.investmentRhythm, () => new Promise<never>(() => {})))
    renderApp()

    await screen.findByRole('region', { name: 'Valeur des titres' })
    expect(
      screen.queryByRole('region', { name: 'Rythme d’investissement' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Lecture impossible')).not.toBeInTheDocument()
    expect(document.querySelector('[data-empty]')).toBeNull()
  })

  it('says why the rhythm is empty, in its own plane', async () => {
    server.use(
      http.get(ROUTES.investmentRhythm, () =>
        HttpResponse.json(aRhythm({ monthly_amount: null, months_covered: 0 })),
      ),
    )
    renderApp()

    const rhythm = await screen.findByRole('region', { name: 'Rythme d’investissement' })
    expect(rhythm).toHaveTextContent(/Aucun achat sur les 12 derniers mois/)
  })
})

describe('no customisation is left', () => {
  it('offers no edit mode, no hidden card, no movers and no layout request', async () => {
    const requested: string[] = []
    server.events.on('request:start', ({ request }) =>
      requested.push(new URL(request.url).pathname),
    )
    renderApp()
    await hero()

    expect(
      screen.queryByRole('button', { name: /Modifier le tableau de bord/ }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Mouvements')).not.toBeInTheDocument()
    expect(requested.filter((path) => /layout/.test(path))).toEqual([])
    expect(requested.filter((path) => path.startsWith('/api/accounts'))).toEqual([])
  })
})
