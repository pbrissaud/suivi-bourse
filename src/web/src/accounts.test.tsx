/**
 * The accounts page (ADR-0028, ADR-0019, ADR-0016), at the one seam: the whole
 * app in jsdom, HTTP the only faked edge.
 *
 * What this file holds is the **master**: the rail, the weights it draws, and
 * the fact that which account is open is a URL. The detail's five blocks are
 * `accountDetail.test.tsx`'s.
 *
 * The fixture's three accounts are worth `1 800`, `900` and `600` — the third
 * having no cash ledger at all, so it states securities and nothing else — and
 * `3 300` is the whole. Those shares are the test: read as `total_value` alone
 * the third account would weigh zero, and the bar would still add up to a
 * hundred per cent.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import type { Account } from '@/lib/api'
import { ABSENT } from '@/lib/format'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  anAccount,
  anAccountsPayload,
  anAccountWithoutSeries,
  aLedgerPayload,
  aRuntime,
  defaultAccounts,
  theSeededAccount,
  unassignedLedger,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

function renderAccounts(accounts: Account[] = defaultAccounts(), url = '/accounts') {
  server.use(http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload(accounts))))
  return renderApp({ url })
}

function rail() {
  return screen.getByRole('list', { name: 'Vos comptes' })
}

/** The bar's own legend, one card up: it is where a share is written. */
function weightRows() {
  return within(screen.getByRole('list', { name: 'Poids de vos comptes' })).getAllByRole('listitem')
}

function weights() {
  return weightRows().map((row) => row.textContent ?? '')
}

/**
 * The share a weight row **draws**, in per cent — `null` where it draws none.
 *
 * The written half of a row is `weights()`, and the two are not the same
 * assertion (#800): a bar is `aria-hidden` and carries no word, so every
 * equality on `textContent` above holds identically whether the row draws the
 * right share, the wrong one or nothing at all.
 *
 * **The drawing is the stacked bar's segment** since #838: the block used to
 * put a bar of its own under every legend row, which drew each share twice on
 * one card — once as a slice of the whole and once against an empty track. The
 * segment is looked up by account rather than by position, an account with no
 * share drawing no segment at all.
 */
function drawnWeight(index: number): number | null {
  const account = weightRows()[index].getAttribute('data-account')
  const segment = document.querySelector(`[data-weights-bar] [data-account="${account}"]`)
  if (segment === null) return null
  return Number.parseFloat((segment as HTMLElement).style.width)
}

function entries() {
  return within(rail())
    .getAllByRole('link')
    .map((link) => link.textContent ?? '')
}

/** The detail — a landmark named by the account it is about. */
async function settled(name = 'Alpha') {
  return screen.findByRole('region', { name })
}

describe('the rail', () => {
  it('lists every declared account and carries its weight', async () => {
    renderAccounts()
    await settled()

    // **Two objects**: the weights are a card of their own, and each account is
    // its own card carrying what it is worth.
    expect(entries()).toHaveLength(3)
    expect(entries()[0]).toContain('Alpha')
    expect(entries()[0]).toMatch(/1\D?800,00/)
    // And what it has done with it (#833): `322,00 / 1 478,00`, the maquette's
    // own `Performance totale` — a cumulative ratio, so ADR-0028's clause is
    // satisfied rather than waived, a rail with no range control having no
    // period it could state. The name is announced, the card carrying a value
    // and a type already.
    expect(entries()[0]).toMatch(/\+21,79\s?%/)
    expect(entries()[0]).toContain('Performance totale')

    expect(weights()[0]).toContain('Alpha')
    // A share of a whole, never a change: `+54,55 %` would put the sign of a
    // gain on a weight.
    expect(weights()[0]).toMatch(/54,55\s%/)
    expect(weights()[0]).not.toContain('+54,55')
    // **The name and the share, and nothing a second time** (#800). The bar
    // drawn under this row is `aria-hidden`, and an equality is how that stays
    // true: were it ever announced, the row would read its own weight twice.
    expect(weights()[0].replace(/\s/g, '')).toBe('Alpha54,55%')
    // And the row **draws** that share as well as writing it, which is the
    // ticket itself: `1 800 / 3 300`, the same figure the line reads out.
    expect(drawnWeight(0)).toBeCloseTo(54.55, 1)
  })

  it('weighs an account on its securities where no cash ledger was ever kept', async () => {
    renderAccounts()
    await settled()

    // `gamma` has `total_value` at `null` (#708) and 600,00 € of shares all the
    // same. Weighed on the total alone it would read `0,00 %` — silently, the
    // bar still summing to a hundred.
    expect(entries()[2]).toContain('Gamma')
    expect(entries()[2]).toMatch(/600,00/)
    expect(weights()[2]).toMatch(/18,18\s%/)
    // Its ratio is the em dash and never a zero: with nothing ever paid in
    // there is no contribution to divide by, which is *nothing to compute*.
    expect(entries()[2]).not.toMatch(/%/)
    expect(entries()[2]).toContain(ABSENT)
  })

  it('states no share at all where there is none, and never a zero', async () => {
    renderAccounts([...defaultAccounts(), anAccountWithoutSeries({ id: 'delta', label: 'Delta' })])
    await settled()

    // The em dash and nothing else (ADR-0021): an account nothing has been
    // written about has no share of the whole to state, and `0,00 %` would be a
    // *figure* — the fifth rendering of absence the product refuses. The bar
    // #800 put under each of these rows answers the same way and for the same
    // reason: a drawing at zero makes that claim silently, so an absent share
    // draws nothing at all.
    expect(weights()[3].replace(/\s/g, '')).toBe(`Delta${ABSENT}`)
    expect(weights()[3]).not.toMatch(/0,00\s%/)
    // Not an empty track either, and only the DOM can say so: the equality
    // above passes on a row that draws a bar at zero, that bar having no word.
    expect(drawnWeight(3)).toBeNull()
    // The rows that *have* a share keep theirs, so this is the absent share
    // drawing nothing and not the bars having gone.
    expect(drawnWeight(0)).toBeCloseTo(54.55, 1)
  })

  it('names the reason an account has no figures, and never a progress', async () => {
    renderAccounts([...defaultAccounts(), anAccountWithoutSeries({ id: 'delta', label: 'Delta' })])
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ rebuilding: true }))))
    await settled()

    // *Without a cash ledger* and *being rebuilt* are the same absent figures
    // and two different sentences.
    expect(
      await screen.findByText('aucun mouvement d’espèces enregistré sur ce compte'),
    ).toBeInTheDocument()
    expect(screen.getByText('historique encore en reconstruction')).toBeInTheDocument()
    // A progression with a date belongs to the reconstruction's own card in the
    // notifications panel (#829, ADR-0037), which is the one place that can
    // carry it without repeating it per account.
    expect(within(rail()).queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('distinguishes the unassigned line and gives it the way back', async () => {
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(unassignedLedger()))))
    renderAccounts([...defaultAccounts(), theSeededAccount()])
    await settled()

    // While it still wears the name the schema seeded, that name comes from the
    // catalogue rather than from the payload (#745).
    expect(within(rail()).getByRole('link', { name: /Non affecté/ })).toBeInTheDocument()
    expect(screen.queryByText('Default account')).not.toBeInTheDocument()
    // **The gesture, not the page** (#725): the link leads to the seeded
    // account's own detail, where the offer stands — one click away on this very
    // page since ADR-0028, rather than on another one.
    expect(
      await screen.findByRole('link', { name: 'Affecter ces événements à un compte' }),
    ).toHaveAttribute('href', '/accounts?account=default')
  })

  it('offers the reassignment for events, never for a row named `default`', async () => {
    // The seeded row can *become* a declaration — renamed, retyped, or taken
    // over by a file (#698, #729) — and its events then name the account their
    // owner named. Offered on the id alone, the rail proposed moving events off
    // the one line the reader had themselves put a name on.
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(unassignedLedger()))))
    renderAccounts([...defaultAccounts(), theSeededAccount({ label: 'Mon PEA' })])
    await settled()

    expect(within(rail()).getByRole('link', { name: /Mon PEA/ })).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.queryByRole('link', { name: 'Affecter ces événements à un compte' }),
      ).not.toBeInTheDocument(),
    )
  })

  it('reads the unassigned line’s name in the reader’s language', async () => {
    server.use(
      http.get(ROUTES.accounts, () =>
        HttpResponse.json(anAccountsPayload([...defaultAccounts(), theSeededAccount()])),
      ),
    )
    renderApp({ url: '/accounts', browserLanguages: ['en-GB'] })

    // Both renderings of the choice carry it — the column of cards and the
    // sticky row of chips the stacked width draws instead (#838) — so the
    // assertion is scoped to one of them rather than counting on there being
    // exactly one link with that name on screen.
    expect(
      within(await screen.findByRole('list', { name: 'Your accounts' })).getByRole('link', {
        name: /Unassigned/,
      }),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('list', { name: 'Your accounts' })).getByRole('link', {
        name: /Alpha/,
      }),
    ).toBeInTheDocument()
  })
})

describe('which account is open', () => {
  it('is a URL, so it survives a reload and can be handed on', async () => {
    const { user, router } = renderAccounts()
    await settled()

    await user.click(within(rail()).getByRole('link', { name: /Beta/ }))
    await settled('Beta')
    expect(router.state.location.href).toBe('/accounts?account=beta')
  })

  it('is read off the URL on arrival', async () => {
    renderAccounts(defaultAccounts(), '/accounts?account=gamma')
    await settled('Gamma')
  })

  it('falls back to the first declared account rather than to an empty page', async () => {
    // An id naming nothing is what a bookmark becomes when an account is
    // renamed away or an import revoked.
    renderAccounts(defaultAccounts(), '/accounts?account=gone')
    await settled('Alpha')
  })

  it('says which one is open, and not with a colour alone', async () => {
    const { user } = renderAccounts()
    await settled()

    expect(within(rail()).getByRole('link', { name: /Alpha/ })).toHaveAttribute(
      'aria-current',
      'true',
    )
    await user.click(within(rail()).getByRole('link', { name: /Beta/ }))
    await settled('Beta')
    expect(within(rail()).getByRole('link', { name: /Alpha/ })).not.toHaveAttribute('aria-current')
  })
})

describe('what the page stopped doing', () => {
  it('compares no account with any other', async () => {
    renderAccounts()
    await settled()

    // The eight columns and the plot of N curves are the dashboard's accounts
    // card now, with ADR-0019's rule travelling with them.
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText('Portefeuille')).not.toBeInTheDocument()
  })

  it('explains its figures on the figures and never in prose', async () => {
    renderAccounts()
    await settled()

    // The subtitle telling the two rates apart was prose about the product's
    // own rules, which is what the bubbles are for (ADR-0016).
    expect(screen.queryByText(/annualisé depuis l’origine/)).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: /^Ce que veut dire/ }).map((button) =>
          button.getAttribute('aria-label'),
        ),
      ).toEqual([
        'Ce que veut dire Gain',
        'Ce que veut dire Performance totale',
        'Ce que veut dire TRI',
        'Ce que veut dire Encaissés',
      ]),
    )
  })

  it('carries no range control at all, on either track', async () => {
    renderAccounts()
    await settled()

    // ADR-0028 corrected (#833): the control is the dashboard accounts card's,
    // where several spans are read side by side and one account's ancient
    // volatility can set the scale for every other. Here the detail draws one
    // series on one axis and the rail draws none, so the defect the control
    // guards against has no subject — and the maquette this page takes its form
    // from defines its presets and renders them nowhere.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })
})

describe('the page’s own reads', () => {
  it('does not date its money figures: the bell already answers that question', async () => {
    // The mention was #721's — *these figures are a day, and a page of money
    // with no date reads as now*. The risk is real and the answer was the wrong
    // surface: the perf cycle writes today's row every two minutes while the
    // scheduler runs, weekends included, so with the indicator green the day
    // **is** today on every install, always. A constant mention is not a
    // safeguard, and on a phone it took the page's own name down with it.
    renderAccounts()
    await settled()

    expect(screen.queryByText(/Chiffres arrêtés/)).not.toBeInTheDocument()
    // What answers it instead, and it opens onto the detail the sentence never
    // had room for (#829, ADR-0037).
    expect(screen.getByRole('button', { name: /^Notifications/ })).toBeInTheDocument()
    // No interval is named on this page in any register since #833: there is no
    // control asking for one, and what is drawn is the account's whole history,
    // which its legend states as an extent rather than as a window.
    expect(screen.queryByText(/sur (un an|les douze derniers mois)/i)).not.toBeInTheDocument()
  })

  it('names an unreadable store instead of showing an empty page', async () => {
    server.use(
      problemHandler(ROUTES.accounts, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp({ url: '/accounts' })

    // The declaration is what the page is made of, so the page is empty — and
    // it says why, in an empty state and never in a band (#829, ADR-0037).
    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.getByText(/son magasin ne répond pas/)).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Vos comptes' })).not.toBeInTheDocument()
  })

  it('keeps the page when a read one of its blocks needs is the one that failed', async () => {
    // Only the declaration failing empties the page. The four other reads each
    // go to the block they compose, so a ledger that would not answer costs the
    // reader the *last events* block and nothing else — and that block says why
    // it is not there, in its own place (#829, ADR-0037).
    server.use(
      problemHandler(ROUTES.events, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp({ url: '/accounts' })

    const detail = await settled()
    expect(rail()).toBeInTheDocument()
    // The block that read it is never composed out of nothing — and where it
    // would have been, the reason.
    expect(
      within(detail).queryByRole('list', { name: 'Derniers événements' }),
    ).not.toBeInTheDocument()
    expect(within(detail).getByText('Lecture impossible')).toBeInTheDocument()
    expect(within(detail).getByText(/son magasin ne répond pas/)).toBeInTheDocument()
    // One block, one sentence — and no band anywhere on the page.
    expect(screen.getAllByText('Lecture impossible')).toHaveLength(1)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says nothing has been declared, and offers the declaration itself', async () => {
    // A state the resource does not produce — ADR-0013 gives every install one
    // account — so the way out is the form on this very page, not a trip to the
    // data page, which is where it was until #793.
    const { user } = renderAccounts([])
    expect(await screen.findByText('Aucun compte déclaré')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Déclarer un compte' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('answers at N = 1, on a page that is no longer a comparison', async () => {
    renderAccounts([anAccount()])
    await settled()

    // One entry in the rail, and a detail beside it that is the ordinary
    // reading rather than a degenerate comparison — which is why the navigation
    // keeps its entry here (`AppSidebar`).
    expect(entries()).toHaveLength(1)
    expect(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', {
        name: 'Comptes',
      }),
    ).toBeInTheDocument()
  })
})
