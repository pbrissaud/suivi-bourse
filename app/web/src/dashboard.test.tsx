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
  anAccountsPayload,
  aPosition,
  aPositionsPayload,
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

  it('offers no range control at all', async () => {
    renderApp()
    await screen.findByRole('group', { name: 'Gain total' })

    // The delta is fixed to year-to-date. The `1S / 1M / 1A / —` selector was
    // the second range control on this page, and two sibling controls read as
    // two settings of the same thing.
    for (const preset of ['1S', '1M', '1A', 'YTD', 'MAX']) {
      expect(screen.queryByRole('button', { name: preset })).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('never puts a delta on the money-weighted return, which is annualised', async () => {
    renderApp()
    const xirr = await screen.findByRole('group', { name: 'TRI' })
    expect(xirr).toHaveTextContent(/\+3,22\D?%/)
    expect(xirr).not.toHaveTextContent(/janvier/)
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

  it('says nothing about the ledger while the runtime has not answered', async () => {
    // The same rule the advisories follow (#709): asserting *your ledger does
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

describe('the statistics shrink instead of filling with dashes', () => {
  it('drops what does not exist for this installation, and names what a ledger would add', async () => {
    server.use(http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(null))))
    renderApp()

    // The head keeps its subject: three terms are read off the positions, which
    // are not under the constraint that empties `portfolio_totals`.
    expect(await screen.findByRole('group', { name: 'Gain total' })).toHaveTextContent(/375,00/)

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
    expect(screen.getByText(/attendent une devise de report/)).toBeInTheDocument()
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
    expect(screen.getByRole('link', { name: 'Aller à Données' })).toBeInTheDocument()
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
