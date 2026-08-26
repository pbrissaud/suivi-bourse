/**
 * The head of the dashboard, and the three primitives it is the first surface
 * to need (#718, ADR-0016, ADR-0018).
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
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  anAccount,
  anAccountHistory,
  anAccountsPayload,
  aClosedPosition,
  aMover,
  aMoversPayload,
  aPosition,
  aPerfPoint,
  aPortfolioHistory,
  aPositionsPayload,
  aRebuilding,
  aRuntime,
  aTotals,
  aTotalsPayload,
  defaultAccounts,
  defaultPositions,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

/** One figure and everything subordinate to it, by the name it wears. */
function figure(name: string) {
  return screen.getByRole('group', { name })
}

function totalsOf(overrides: Parameters<typeof aTotals>[0]) {
  return http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(aTotals(overrides))))
}

describe('the gain is computed, never read', () => {
  it('adds its four terms up and ignores a divergent `gain_absolu`', async () => {
    // Two producers for one figure is what the shares page spent a session
    // dismantling. The payload is handed a total that is off by an order of
    // magnitude; the head does not blink.
    server.use(totalsOf({ gain_absolu: 99999 }))
    renderApp()

    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/370,00/)
    expect(head).not.toHaveTextContent(/99\D?999/)
    expect(screen.queryByText(/99\D?999/)).not.toBeInTheDocument()
  })

  it('shows the four terms on their own row, never on the head’s', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    expect(figure('Plus-value latente')).toHaveTextContent(/300,00/)
    expect(figure('Plus-value réalisée')).toHaveTextContent(/50,00/)
    expect(figure('Dividendes reçus')).toHaveTextContent(/25,00/)
    expect(figure('Frais de versement')).toHaveTextContent(/5,00/)

    // A total and its terms never share a line: the terms are not inside the
    // head's group, or the form would invite adding them to it.
    const head = figure('Gain total')
    expect(within(head).queryByRole('group')).not.toBeInTheDocument()
  })

  it('never mentions the fourth term to an install whose transfers are free', async () => {
    server.use(totalsOf({ transfer_fees: 0, gain_absolu: 375 }))
    renderApp()

    // Three terms, and the gain is their sum — not `370,00 − 0,00` written out.
    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/375,00/)
    expect(screen.queryByRole('group', { name: 'Frais de versement' })).not.toBeInTheDocument()
    expect(screen.queryByText('Frais de versement')).not.toBeInTheDocument()
  })
})

describe('the year-to-date is two figures that do not touch', () => {
  it('puts the euro under the head and the percentage inside the TWR statistic', async () => {
    renderApp()

    const head = await screen.findByRole('group', { name: 'Gain total' })
    const twr = figure('TWR')

    // `+40,69 €` and `−1,25 %` are of opposite signs over the same period and
    // both correct: the portfolio grew by deposits while its holdings lost.
    // Side by side they read as a contradiction.
    expect(head).toHaveTextContent(/40,69/)
    expect(twr).toHaveTextContent(/1,25\D?%/)
    expect(head).not.toHaveTextContent(/1,25/)
    expect(twr).not.toHaveTextContent(/40,69/)
  })

  it('leaves the head **no** range control, and gives each figure one', async () => {
    renderApp()
    const head = await screen.findByRole('group', { name: 'Gain total' })

    // The delta is fixed to year-to-date. The `1S / 1M / 1A / —` selector was a
    // *second* range control **on the head**, and two sibling controls read as
    // two settings of the same thing — so the head carries none (#718, #727).
    expect(within(head).queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(within(figure('TWR')).queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: '1S' })).not.toBeInTheDocument()

    // Two on the page, and they are two **figures**, not two settings of one:
    // the chart's drives the portfolio's own series, the accounts card's drives
    // the comparison ADR-0028 moved here — one range for every figure drawn on
    // that card, sparkline included (ADR-0019, carried over by ADR-0028).
    await waitFor(() =>
      expect(
        screen.getAllByRole('radiogroup').map((group) => group.getAttribute('aria-label')),
      ).toEqual(['Plage', 'Plage comparée']),
    )
  })

  it('never puts a delta on the money-weighted return, which is annualised', async () => {
    renderApp()
    const xirr = await screen.findByRole('group', { name: 'TRI' })
    expect(xirr).toHaveTextContent(/\+3,22\D?%/)
    expect(xirr).not.toHaveTextContent(/janvier/)
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
    const head = await screen.findByRole('group', { name: 'Gain total' })

    // A period is the same figure through another window; a term is a *part* of
    // it. Mounted among the four they read as two more things to add, which is
    // the addition ADR-0018's subordination exists to prevent.
    expect(head).toHaveTextContent(/aujourd’hui/)
    expect(head).toHaveTextContent(/depuis le 1ᵉʳ janvier/)
    for (const term of [
      'Plus-value latente',
      'Plus-value réalisée',
      'Dividendes reçus',
      'Frais de versement',
    ]) {
      expect(figure(term)).not.toHaveTextContent(/aujourd’hui|janvier/)
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

    const head = await screen.findByRole('group', { name: 'Gain total' })
    await waitFor(() => expect(head).toHaveTextContent(/\+30,00\D?€ aujourd’hui/))
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

    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/370,00/)
    await waitFor(() => expect(screen.queryByText(/aujourd’hui/)).not.toBeInTheDocument())
    expect(head).toHaveTextContent(/depuis le 1ᵉʳ janvier/)
  })
})

describe('the accounts card, where the comparison moved (ADR-0028)', () => {
  /** The card's own rows, by the name its list wears. */
  function comparison() {
    return within(screen.getByRole('list', { name: 'Vos comptes, comparés' }))
  }

  it('offers the four presets and never `MAX`', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    const range = await screen.findByRole('radiogroup', { name: 'Plage comparée' })
    expect(within(range).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      '1M',
      'Depuis le 1ᵉʳ janvier',
      '1A',
      'Depuis l’ouverture',
    ])
    // A time-weighted index has no bounded amplitude, so one account's ancient
    // volatility would set the scale for every other (ADR-0019, ADR-0028).
    expect(within(range).queryByRole('radio', { name: 'MAX' })).not.toBeInTheDocument()
  })

  it('draws every figure on the card over the one range the reader chose', async () => {
    const { user } = renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // A year: `alpha` rebases on 150 and ends on 171,5, `beta` on its own
    // opening at 100 and ends on 115. `gamma` has no index at all (#708), so
    // there is nothing to compute and the em dash says exactly that.
    await waitFor(() =>
      expect(comparison().getByText('Alpha').closest('li')).toHaveTextContent(/\+14,33/),
    )
    expect(comparison().getByText('Beta').closest('li')).toHaveTextContent(/\+15,00/)
    expect(comparison().getByText('Gamma').closest('li')).toHaveTextContent('—')

    // One month, and **both** figures follow: the curve and the percentage are
    // read off one rebasing, so a thirty-day sparkline can never sit beside a
    // one-year percentage.
    const range = within(screen.getByRole('radiogroup', { name: 'Plage comparée' }))
    await user.click(range.getByRole('radio', { name: '1M' }))
    await waitFor(() => expect(comparison().getByText('Alpha').closest('li')).toHaveTextContent(/\+3,94/))
    expect(comparison().getByText('Beta').closest('li')).toHaveTextContent(/\+2,68/)
  })

  it('is absent where there is one account, and reads no series for it', async () => {
    // ADR-0013 seeds a `default` row that is never removed, so the
    // single-account install is the ordinary one: gated on the rendering alone,
    // every load fetched that account's whole daily series to throw it away.
    let asked = 0
    server.use(
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload([anAccount()]))),
      http.get(ROUTES.accountHistory, ({ params }) => {
        asked += 1
        return HttpResponse.json(anAccountHistory(String(params.account)))
      }),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // The head's own figures already are that account's, with a border round
    // them — *a block with nothing in it does not exist*.
    await waitFor(() => expect(screen.getByText('1 compte')).toBeInTheDocument())
    expect(screen.queryByText('Vos comptes, comparés')).not.toBeInTheDocument()
    expect(asked).toBe(0)
  })

  it('says there is nothing to compare rather than dashing every account', async () => {
    // `windowStart` answers `null` on *since the opening* alone, so an empty
    // perf cache — a fresh install whose backfill has not run — left the
    // default one-year preset rendering an em dash per account: *there is
    // nothing to compute* said about a history merely not rebuilt yet.
    server.use(
      http.get(ROUTES.accountHistory, ({ params }) =>
        HttpResponse.json({ ...anAccountHistory(String(params.account)), points: [] }),
      ),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    expect(
      await screen.findByText('Rien à comparer sur cette plage pour l’instant.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Vos comptes, comparés' })).not.toBeInTheDocument()
  })
})

describe('the two time-weighted scalars', () => {
  it('carries the base date while the rebuild is still moving it', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    renderApp()

    await waitFor(() => expect(figure('TWR')).toHaveTextContent(/30 oct\. 2019/))
    expect(figure('TWR')).toHaveTextContent(/\+102,89/)
  })

  it('drops it once the reconstruction is over', async () => {
    // A base date that never changes again is not news, and the origin scalar
    // is the one that has to keep saying it *is* moving while it does.
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    expect(figure('TWR')).not.toHaveTextContent(/2019/)
    // Both scalars are there all the same — origin and year-to-date.
    expect(figure('TWR')).toHaveTextContent(/\+102,89/)
    expect(figure('TWR')).toHaveTextContent(/1,25/)
  })
})

describe('during the reconstruction', () => {
  it('keeps the head normal and degrades the year-to-date alone', async () => {
    server.use(totalsOf({ ytd: null }))
    renderApp()

    // Exact from the first cycle: the gain, the money-weighted return and the
    // four terms. Twenty-five minutes of "nothing works" is what this prevents.
    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/370,00/)
    expect(figure('TRI')).toHaveTextContent(/\+3,22/)
    expect(figure('Plus-value latente')).toHaveTextContent(/300,00/)

    // Everything else is untouched — the degradation is the year-to-date and
    // nothing but it.
    expect(figure('Valeur totale')).toHaveTextContent(/2\D?800,00/)
    expect(figure('TWR')).toHaveTextContent(/\+102,89/)
  })

  it('degrades **both** halves of the year-to-date, each with the sentence', async () => {
    // The year-to-date is two figures, and the two are deliberately kept apart
    // — the euro under the head, the percentage inside the TWR statistic —
    // because side by side they read as a contradiction. A reader looking at
    // one therefore never sees the other's caption, so a sentence written once
    // covers one figure and leaves the other wearing a bare `—`. And by the
    // rule this ticket installs (`lib/absence.ts`, ADR-0016) a bare dash means
    // *there is nothing to compute*, which is the opposite of the truth here:
    // the history simply is not rebuilt that far back yet, and it will be.
    server.use(
      totalsOf({ ytd: null }),
      http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))),
    )
    renderApp()

    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/—/)
    expect(head).toHaveTextContent(/historique pas encore reconstruit jusque-là/)

    const twr = figure('TWR')
    expect(twr).toHaveTextContent(/—/)
    expect(twr).toHaveTextContent(/historique pas encore reconstruit jusque-là/)

    // Twice, once per figure — never a third time somewhere neither of them is.
    expect(screen.getAllByText(/historique pas encore reconstruit/)).toHaveLength(2)
  })

  it('does not announce a rebuild to a portfolio younger than the year', async () => {
    // `ytd: null` has two causes and the head wrote one sentence for both: the
    // reconstruction has not reached January, **or** the first event is in
    // March and no day on or before 31 December exists to count from. The
    // second install is told to wait for something that will never happen, and
    // waiting is precisely what it must not do. The discriminant is already on
    // screen — `runtime.rebuilding`, which the TWR statistic reads for its base
    // date — so nothing is added to any payload (ADR-0021).
    server.use(
      totalsOf({ ytd: null }),
      http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: false }))),
    )
    renderApp()

    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/rien d’enregistré avant le 1ᵉʳ janvier/)
    expect(figure('TWR')).toHaveTextContent(/rien d’enregistré avant le 1ᵉʳ janvier/)
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
    // member takes the bare em dash: *there is nothing to compute* (ADR-0016).
    server.use(
      totalsOf({ ytd: { gain: 40.69, twr: null } }),
      http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: false }))),
    )
    renderApp()

    const head = await screen.findByRole('group', { name: 'Gain total' })
    await waitFor(() => expect(head).toHaveTextContent(/40,69/))
    expect(figure('TWR')).toHaveTextContent('—')
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

    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/historique pas encore reconstruit jusque-là/)
    expect(screen.queryByText(/rien d’enregistré avant le 1ᵉʳ janvier/)).not.toBeInTheDocument()
  })
})

describe('a read that fails is named, and named once', () => {
  it('says why the block is empty when the store will not answer', async () => {
    // The exact case, and the reason it had no announcer at all: `/api/runtime`
    // answers from the scheduler's process memory and never opens the store
    // (#668), so the shell's band is perfectly quiet while the figures are
    // unreadable. The block rendered `null`, and *"the store is unreadable"*
    // and *"you own nothing yet"* became one screen — a blank one.
    server.use(
      problemHandler(ROUTES.positions, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp()

    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
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

    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    expect(screen.queryByText(/Un grand livre d’événements datés ajouterait/)).not.toBeInTheDocument()
  })

  it('stays silent while the shell already says the app is not answering', async () => {
    // One band on screen or none. While the app answers nothing, it is the
    // cause of every failed read below it, and the band at the top of the
    // column has already said so — two announcers for one fact is the defect
    // the head's own comment was written against.
    server.use(
      http.get(ROUTES.runtime, () => HttpResponse.error()),
      http.get(ROUTES.positions, () => HttpResponse.error()),
      http.get(ROUTES.portfolioTotals, () => HttpResponse.error()),
    )
    renderApp()

    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(1))
    expect(screen.getByRole('status')).toHaveTextContent(/L’application ne répond pas/)
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
   * the repair had to buy: pouring the four other reads into the head's own
   * band would have replaced every figure below with one sentence.
   */
  async function theHeadStandsWhole() {
    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/370,00/)
    expect(figure('Plus-value latente')).toHaveTextContent(/300,00/)
    expect(figure('Plus-value réalisée')).toHaveTextContent(/50,00/)
    expect(figure('Dividendes reçus')).toHaveTextContent(/25,00/)
    expect(figure('Frais de versement')).toHaveTextContent(/5,00/)
  }

  it('names a failed portfolio series, and the chart alone goes', async () => {
    server.use(unreadable(ROUTES.portfolioTotalsHistory))
    renderApp()

    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    await theHeadStandsWhole()
    // The block the read belongs to renders nothing at all, title included:
    // its range control is the surest proof the card is gone rather than empty.
    expect(screen.queryByRole('radiogroup', { name: 'Plage' })).not.toBeInTheDocument()
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

    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    await theHeadStandsWhole()
    expect(screen.queryByRole('radiogroup', { name: 'Plage' })).not.toBeInTheDocument()
  })

  it('names a failed accounts read, and keeps the figures whose perimeter it states', async () => {
    server.use(unreadable(ROUTES.accounts))
    renderApp()

    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    await theHeadStandsWhole()
    // The perimeter is *unknown*, which is not written down (ADR-0026) — and
    // the comparison has no list of accounts to be a comparison of.
    expect(screen.queryByText(/compte/)).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Vos comptes, comparés' })).not.toBeInTheDocument()
  })

  it('names one account’s failed series, the comparison being all of them at once', async () => {
    // The N series are waited for together because the comparison *is* the
    // object (ADR-0028), so one `503` out of three removes the card — which is
    // right, and used to be the whole of what happened.
    server.use(
      http.get(ROUTES.accountHistory, ({ params }) =>
        String(params.account) === 'beta'
          ? HttpResponse.json(STORAGE_DOWN, {
              status: 503,
              headers: { 'Content-Type': 'application/problem+json' },
            })
          : HttpResponse.json(anAccountHistory(String(params.account))),
      ),
    )
    renderApp()

    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    await theHeadStandsWhole()
    expect(screen.queryByRole('list', { name: 'Vos comptes, comparés' })).not.toBeInTheDocument()
  })

  it('says nothing at all while that same read is merely in flight', async () => {
    // **The repair distinguishes the failure from the flight, it does not
    // flatten them** (ADR-0026). The band is composed out of an error and never
    // out of a silence, so a read that has not answered still takes its block
    // away without a word — title, sentence and band included.
    server.use(http.get(ROUTES.portfolioTotalsHistory, () => new Promise<never>(() => {})))
    renderApp()

    await theHeadStandsWhole()
    // The comparison waits on three reads of its own, so its list standing is
    // the proof the page has otherwise settled and the band is not merely late.
    await screen.findByRole('list', { name: 'Vos comptes, comparés' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Plage' })).not.toBeInTheDocument()
  })

  it('keeps one band on screen when several of its reads fail at once', async () => {
    // *One band on screen or none* is unchanged, and it is a rule about
    // announcers: the four reads are one more list handed to `readConditions`,
    // whose causal order — and `oneBand` after it — does the rest.
    server.use(unreadable(ROUTES.portfolioTotalsHistory), unreadable(ROUTES.accounts))
    renderApp()

    expect(await screen.findByRole('status')).toHaveTextContent(/son magasin ne répond pas/)
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(1))
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
    // total rendered from three is not that total (ADR-0018). It wears the em
    // dash, and the sentence at the foot of the block says why.
    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent('—')
    expect(head).not.toHaveTextContent(/375,00/)
    expect(screen.getByRole('group', { name: 'Plus-value latente' })).toHaveTextContent(/300,00/)

    for (const absent of ['Valeur totale', 'Versé net', 'TRI', 'TWR']) {
      expect(screen.queryByRole('group', { name: absent })).not.toBeInTheDocument()
    }
    expect(
      screen.getByText(/Un grand livre d’événements datés ajouterait/),
    ).toBeInTheDocument()
  })

  it('says the currency is unanswered rather than denying the ledger', async () => {
    // `totals: null` has two causes (#745) and they were one sentence. The
    // second is the ordinary one: the perf job writes nothing at all until the
    // base currency is answered (#702), every figure it computes being money.
    // So the app told a reader holding a full portfolio that they had no
    // ledger — and said nothing about the one question they can answer.
    // The condition is *the install has no answered currency*, so both payloads
    // carry it: ADR-0021 adds no route and no field for the state, it is read
    // off `base_currency` being null wherever it already travels.
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(aPositionsPayload(defaultPositions(), null)),
      ),
      http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(null, null))),
    )
    renderApp()

    await screen.findByRole('group', { name: 'Gain total' })
    expect(screen.getByText(/attendent une devise de base/)).toBeInTheDocument()
    expect(
      screen.queryByText(/Un grand livre d’événements datés ajouterait/),
    ).not.toBeInTheDocument()
  })

  it('says nothing at all when there is no ledger and nothing held', async () => {
    server.use(
      http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload([], null))),
      http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(null, null))),
    )
    renderApp()

    expect(await screen.findByText('Aucun événement')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Aller au grand livre' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Gain total' })).not.toBeInTheDocument()
  })
})

describe('the consolidated figures name their perimeter', () => {
  it('counts the accounts and leads to the page where the gap is legible', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    const scope = await screen.findByRole('link', { name: '3 comptes' })
    expect(scope).toHaveAttribute('href', '/comptes')
  })

  it('drops the link of itself at one account', async () => {
    server.use(
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload([defaultAccounts()[0]]))),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    await waitFor(() => expect(screen.getByText('1 compte')).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: /compte/ })).not.toBeInTheDocument()
  })

  it('never claims a perimeter of zero accounts, which cannot exist', async () => {
    // ADR-0013 seeds a `default` row that is never removed, so `0 compte` is a
    // state the product declares impossible — and it was printed, under the
    // consolidated figures, as the statement of their perimeter, whenever the
    // accounts read failed or had simply not landed yet. An unknown perimeter
    // is not written down; the figures above it are exact either way.
    server.use(
      problemHandler(ROUTES.accounts, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp()

    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/370,00/)
    await waitFor(() => expect(screen.queryByText(/0 compte/)).not.toBeInTheDocument())
    expect(screen.queryByRole('link', { name: /compte/ })).not.toBeInTheDocument()
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
    expect(bubble).toHaveTextContent(/somme de quatre termes/)
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

    await user.click(screen.getByRole('button', { name: 'Ce que veut dire TWR' }))
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

  it('puts four icons on the head, not nine', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // A total and its subordinate terms are one figure, not five: the
    // `Gain total` bubble carries the identity **and** its four terms, and the
    // terms carry none of their own.
    const bubbles = screen.getAllByRole('button', { name: /^Ce que veut dire/ })
    expect(bubbles.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Ce que veut dire Gain total',
      'Ce que veut dire Versé net',
      'Ce que veut dire TRI',
      'Ce que veut dire TWR',
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

    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/en attente du taux/)
    expect(head).not.toHaveTextContent(/^Gain total\s*—/)
    expect(figure('Plus-value latente')).toHaveTextContent(/en attente du taux/)
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
    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/490,00/)
    expect(head).not.toHaveTextContent(/en attente du taux/)
    expect(figure('Plus-value latente')).toHaveTextContent(/300,00/)
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
    expect(screen.queryByText(/Un grand livre d’événements datés ajouterait/)).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Gain total' })).not.toBeInTheDocument()

    // And once it lands, the four-term figure, in one go.
    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/370,00/)
    expect(screen.queryByText(/Un grand livre d’événements datés ajouterait/)).not.toBeInTheDocument()
  })
})

describe('one chart slot, two readings', () => {
  it('offers a reading selector and one range control, and `3M` is dead', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // A **reading** selector, drawn as tabs: two sibling radio groups would
    // read as two settings of the same thing, which is the duplication this
    // page has just closed.
    const readings = await screen.findByRole('tablist')
    expect(within(readings).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Montants',
      'Performance',
    ])

    const range = screen.getByRole('radiogroup', { name: 'Plage' })
    expect(within(range).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      '1M',
      'Depuis le 1ᵉʳ janvier',
      '1A',
      'MAX',
    ])
    expect(screen.queryByRole('radio', { name: '3M' })).not.toBeInTheDocument()
  })

  it('names the area with its subject — and it is the gain', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // The area between value and net contributed *is* the gain, which is the
    // clearest answer to *did I gain because it went up or because I put more
    // in*. Naming it is what makes the surface readable at all.
    expect(
      await screen.findByText(/L’écart entre les deux courbes est votre gain total/),
    ).toBeInTheDocument()
  })

  it('falls back to valuation against cost, and it is then the only reading', async () => {
    // #708's per-field rule: with no cash event `total_value`,
    // `net_contributed` and `twr_index` are all `NULL`, so *value against net
    // contributed* is two empty curves. The area is then the **latent** gain —
    // a different figure, therefore a different sentence — and *Performance* is
    // not offered rather than offered empty.
    server.use(
      totalsOf({ total_value: null, cash_balance: null, net_contributed: null, twr_index: null, ytd: null }),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    expect(
      await screen.findByText(/L’écart entre les deux courbes est votre plus-value latente/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Performance' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    // The range control survives the fallback: it is the page's, not a
    // property of the series it happens to be drawing.
    expect(screen.getByRole('radiogroup', { name: 'Plage' })).toBeInTheDocument()
  })

  it('states no base date on the performance reading', async () => {
    // The curve is rebased on the first day of the visible window, so it does
    // not move as the reconstruction reaches further back — only the head's
    // scalar does, and that one carries the date while it is still moving.
    const { user } = renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    await user.click(await screen.findByRole('tab', { name: 'Performance' }))
    expect(await screen.findByText(/Base 0 % au premier jour de la plage affichée/)).toBeInTheDocument()
    expect(screen.queryByText(/L’écart entre les deux courbes/)).not.toBeInTheDocument()
  })
})

describe('the allocation', () => {
  it('names every line in the slices’ own order, with its share', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // 1 300 / 600 / 400 out of 2 300 — and the legend is in the slices' own
    // descending order, which is what pairs a legend row to its slice and what
    // licenses the rank ramp of ADR-0023.
    const list = await screen.findByRole('list', { name: 'Répartition' })
    const legend = within(list)
    const rows = legend.getAllByRole('listitem').map((row) => row.textContent ?? '')
    expect(rows.map((row) => row.replace(/\s/g, ''))).toEqual([
      'ZetaAlpha56,52%',
      'ZetaGamma26,09%',
      'ZetaBeta17,39%',
    ])
    // The total, in the ring's own hole — **one named group and two lines**,
    // not a sentence: `2 300,00 € de titres` measured wider than the hole and
    // was drawn over the slices it divides. The pair stays whole where it has
    // to, which is the accessible tree.
    //
    // Scoped to the card, because the head one track over names the same figure
    // the same way: the ring's centre is the total *this figure* is the division
    // of, and the two agree because they read one number.
    const card = list.closest('[data-slot="card"]') as HTMLElement
    expect(within(card).getByRole('group', { name: 'Titres' })).toHaveTextContent(/2\D?300,00/)
  })

  it('names what it could not place instead of dropping it in silence', async () => {
    // Summing a position whose rate has not resolved makes every *other*
    // percentage silently wrong — the exclusion was already right, and its own
    // comment said why without ever saying it on screen.
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload([
            aPosition({ symbol: 'ZZA', quantity: 10, cost_basis: 1000, price: 130 }),
            aPosition({ symbol: 'ZZB', quantity: 4, cost_basis: 400, price: 125, currency: 'USD', rate: null }),
          ]),
        ),
      ),
    )
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    expect(await screen.findByText(/ZZB/)).toBeInTheDocument()
    expect(screen.getByText(/n’est pas dans cette répartition/)).toBeInTheDocument()
    // And the line it kept is the whole of what it counted.
    const legend = within(screen.getByRole('list', { name: 'Répartition' }))
    expect(legend.getAllByRole('listitem')).toHaveLength(1)
    expect(legend.getByRole('listitem')).toHaveTextContent(/100,00\D?%/)
  })

  it('adds no second selector beside the chart’s', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // No breakdown by account and none by type: a second control **on this
    // block** is the duplication this page keeps closing. The two radio groups
    // on the page belong to the chart and to the accounts card, and the
    // allocation has neither.
    const allocation = screen.getByRole('list', { name: 'Répartition' }).closest('[data-slot="card"]')!
    expect(within(allocation as HTMLElement).queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})

describe('the movers', () => {
  it('shows two columns and counts what it does not show', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    expect(await screen.findByText('Hausses')).toBeInTheDocument()
    expect(screen.getByText('Baisses')).toBeInTheDocument()
    expect(screen.getByText(/Rien n’a baissé/)).toBeInTheDocument()

    // The **ticker** beside the name (#790): it is the identity the rest of the
    // product addresses a security by, and a rail of names alone cannot be
    // matched to the allocation's legend or to a broker's own screen.
    expect(screen.getByText('ZZA').closest('li')).toHaveTextContent('Zeta Alpha')

    // Three lines held, one of them shown: `ZZB` moved by exactly 0,00 % and is
    // in neither column, `ZZC` has never been quoted and has nothing to compare
    // a first day against. Silence about them reads as *nothing to say*.
    expect(
      screen.getByText(/2 autres lignes n’apparaissent pas ici, dont 1 n’a pas bougé/),
    ).toBeInTheDocument()
  })

  it('says nothing of a closed line the server serves at 0,00 %', async () => {
    // `/api/positions` carries a sold line on purpose (ADR-0017) and
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
            aClosedPosition({ account: 'alpha', symbol: 'ZZD', name: 'Zeta Delta', closed_at: '2025-11-04' }),
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

  it('names the close it compares against, and names it once', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // The **reference**, never the cut: naming the cut announced a session that
    // had not happened yet.
    expect(await screen.findAllByText(/Depuis la clôture du 1 mars 2026/)).toHaveLength(1)
  })
})

describe('the time announcers', () => {
  it('keeps two permanent ones and no more', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // The page's own mention of when its prices were read, and the movers'
    // reference close — a *different* instant, and the subject of that block.
    expect(await screen.findByText(/Cours au 2 mars 2026/)).toBeInTheDocument()
    expect(screen.getAllByText(/Depuis la clôture/)).toHaveLength(1)
    // The two transitory ones are absent here: the reconstruction is over, so
    // the base date is not news and the banner says nothing.
    expect(screen.queryByText(/30 oct\. 2019/)).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('no installation fact lands here', () => {
  it('says nothing of a standing notice, which the installation tab counts', async () => {
    // A notice posted on the dashboard is invisible to whoever lands on another
    // page, and it would compete with the banner — which was validated in
    // production. The badge on the data page is the counterpart (#724).
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
    expect(screen.queryByText('Répartition')).not.toBeInTheDocument()
    expect(screen.queryByText('Mouvements')).not.toBeInTheDocument()
    expect(screen.queryByText('Vos comptes, comparés')).not.toBeInTheDocument()
    // And the route is the dashboard unconditionally: a bookmark valid
    // yesterday is valid at zero events too.
    expect(screen.getByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument()
  })

  it('gives a portfolio that has sold everything an ordinary page', async () => {
    // The one place in the product where the em dash and the zero are read side
    // by side at the scale of the portfolio: `Plus-value latente —` because
    // nothing is held, `Titres 0,00 €` because that is a figure.
    server.use(
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload([
            aClosedPosition({ symbol: 'ZZD', realised: 120, dividends: 10, closed_at: '2025-11-04' }),
            aClosedPosition({ symbol: 'ZZE', realised: -45, closed_at: '2026-01-15' }),
          ]),
        ),
      ),
      totalsOf({ holdings_value: 0 }),
      http.get(ROUTES.movers, () => HttpResponse.json(aMoversPayload([]))),
    )
    renderApp()

    //   realised +120,00 − 45,00 · dividends +10,00 · fees −5,00 = +80,00
    const head = await screen.findByRole('group', { name: 'Gain total' })
    expect(head).toHaveTextContent(/80,00/)
    expect(figure('Plus-value latente')).toHaveTextContent('—')
    expect(figure('Plus-value réalisée')).toHaveTextContent(/75,00/)
    expect(figure('Titres')).toHaveTextContent(/0,00/)

    // And both blocks say **why** they are empty rather than being absent.
    expect(await screen.findByText('Aucune position détenue')).toBeInTheDocument()
    expect(screen.getByText('Rien à comparer')).toBeInTheDocument()
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
      // It reads `/health` since #819 (ADR-0036), where the same fact is the
      // backfill job's own verdict.
      http.get(ROUTES.health, () => HttpResponse.json(aRebuilding())),
    )
    renderApp()

    expect(
      await screen.findByRole('button', {
        name: /L’historique est en cours de reconstruction/,
      }),
    ).toBeInTheDocument()
    // And the band is gone with it (#829, ADR-0037): a condition that ends by
    // itself does not take the top of every page on every route, and there is
    // no band left anywhere to take it.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('carries a bar and names the account holding the global figures back', async () => {
    // The global series is written only where **every** account is (ADR-0018),
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
    const { user } = renderApp({ url: '/donnees' })
    await user.click(await screen.findByRole('tab', { name: /L’installation/ }))

    expect(
      await screen.findByText(/Alpha est le compte le plus en retard/),
    ).toBeInTheDocument()
    // (2026-03-02 → 2026-01-01) over (2026-03-02 → 2025-12-24), the oldest day
    // the ledger names: 60 days of 68.
    expect(await screen.findByRole('progressbar')).toHaveAccessibleName(
      /88\D?% de la période couverte/,
    )
  })

  it('does not exist when nothing is being rebuilt', async () => {
    // A block with nothing in it does not exist.
    const { user } = renderApp({ url: '/donnees' })
    await user.click(await screen.findByRole('tab', { name: /L’installation/ }))
    await screen.findByRole('heading', { name: 'Le magasin' })

    expect(screen.queryByText(/Reconstruction de l’historique/)).not.toBeInTheDocument()
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
    expect(figure('Total value')).toHaveTextContent(/2,800\.00/)
    expect(await screen.findByRole('link', { name: '3 accounts' })).toBeInTheDocument()
  })
})
