/**
 * The demonstration: the whole app in jsdom, HTTP the only faked edge.
 *
 * Every assertion below is about **what the reader sees** — a role, a name, a
 * text. Never a class, never a component name, and never a DOM snapshot: a
 * snapshot fails when a `div` is renamed and passes when `Gain total` becomes
 * false, which is the exact inverse of what is wanted.
 *
 * What this seam cannot see is written down rather than pretended away: jsdom
 * has no layout, so the drawer under 768 px, the lost route at 390 px and the
 * legibility of the twelve stops stay acceptance criteria checked by eye.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aPositionsPayload,
  aTotalsPayload,
  anAccountsPayload,
  defaultAccounts,
} from '@/test/factories'
import { setPrefersDark, setViewportWidth } from '@/test/media'
import { ALLOCATION_SLICES } from '@/lib/alloc'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

/** The navigation, by its accessible name — the reader's own handle on it. */
function nav() {
  return screen.getByRole('navigation', { name: 'Sections' })
}

async function chooseInMenu(
  user: ReturnType<typeof renderApp>['user'],
  control: string,
  option: string,
) {
  await user.click(screen.getByRole('button', { name: control }))
  await user.click(await screen.findByRole('menuitemradio', { name: option }))
}

describe('the walking skeleton', () => {
  it('starts, dresses, speaks two languages and walks its five routes', async () => {
    // The whole ticket in one pass, because the value of a tracer bullet is
    // that it can be *shown*: the app comes up, the sidebar is there, the
    // ground turns, the language turns, and the five routes answer under both.
    const { user } = renderApp()

    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument()
    // Five since ADR-0038, in three and two — the portfolio, then what the
    // owner acts on.
    expect(within(nav()).getAllByRole('link')).toHaveLength(5)

    await chooseInMenu(user, 'Thème', 'Sombre')
    expect(document.documentElement).toHaveClass('dark')

    await chooseInMenu(user, 'Langue', 'English')
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()

    // **The five routes now answer with five pages.** `PendingPage` and its one
    // sentence left with #721, the last placeholder: a page that says it is not
    // built yet has no subject once every one of them is, and keeping the
    // component around for a sixth route nobody plans is how dead code is kept
    // warm.
    for (const entry of ['Shares', 'Accounts', 'Ledger', 'Settings']) {
      await user.click(within(nav()).getByRole('link', { name: entry }))
      // `level: 1` is the page's own name, which the header draws (#789). The
      // settings page needs it said: the block it renders is *called* the
      // settings too, one level down, and that block is #830's to reshape.
      expect(
        await screen.findByRole('heading', { level: 1, name: entry }),
      ).toBeInTheDocument()
    }

    // Back to French, on the page we happen to be standing on.
    await chooseInMenu(user, 'Language', 'Français')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Réglages' }),
    ).toBeInTheDocument()
    // The ground did not move when the language did.
    expect(document.documentElement).toHaveClass('dark')
    // Headroom, and it is measured rather than defensive: this one walks the
    // five routes **twice**, and since ADR-0028 the accounts route mounts a
    // detail reading the positions, the ledger and a perf series on top of the
    // declaration. Two seconds and a half in a quiet run, and the default five
    // is not a margin under a loaded worker.
  }, 20_000)
})

describe('the five routes', () => {
  it('answer, and the reader walks to each of them', async () => {
    const { user } = renderApp()

    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument()

    for (const entry of ['Titres', 'Comptes', 'Grand livre', 'Réglages']) {
      await user.click(within(nav()).getByRole('link', { name: entry }))
      expect(
        await screen.findByRole('heading', { level: 1, name: entry }),
      ).toBeInTheDocument()
    }
  })

  it('serve `/` as the dashboard unconditionally', async () => {
    // No redirect on an empty ledger: it would make `/` the one route whose
    // behaviour depends on the data, and a bookmark valid yesterday lie today.
    server.use(
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload([], false))),
      http.get(ROUTES.positions, () => HttpResponse.json(aPositionsPayload([], null))),
      http.get(ROUTES.portfolioTotals, () => HttpResponse.json(aTotalsPayload(null, null))),
    )
    renderApp({ url: '/' })
    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument()
  })

  it('answer on an address that matches nothing, with a way back', async () => {
    renderApp({ url: '/nowhere' })
    expect(await screen.findByRole('heading', { name: 'Page introuvable' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Revenir au tableau de bord' })).toBeInTheDocument()
  })
})

describe('a single account', () => {
  it('keeps the entry, the page being a reading of one account and not a comparison', async () => {
    // The entry used to disappear here, and the argument was the accounts
    // page's own: comparing one term is not comparing. ADR-0028 replaced that
    // page with a master-detail whose four blocks exist nowhere else, so at one
    // account it is the **ordinary** reading — and hiding it would put the
    // composition, the annualised rate, the dividends and the last events out
    // of reach of most installs.
    server.use(
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload([defaultAccounts()[0]]))),
    )

    const { unmount } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })
    await waitFor(() =>
      expect(within(nav()).getByRole('link', { name: 'Comptes' })).toBeInTheDocument(),
    )
    unmount()

    renderApp({ url: '/accounts' })
    expect(await screen.findByRole('heading', { name: 'Comptes' })).toBeInTheDocument()
  })
})

describe('the reader preferences', () => {
  it('render the whole app in either language', async () => {
    const { user } = renderApp()
    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument()

    await chooseInMenu(user, 'Langue', 'English')

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(within(nav()).getByRole('link', { name: 'Shares' })).toBeInTheDocument()
    // The chrome follows too: the control that was `Langue` a moment ago is now
    // `Language`, so nothing is left in the other language on screen.
    expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument()
    expect(document.documentElement).toHaveAttribute('lang', 'en')
  })

  it('put the ground on the document, and keep it across a remount', async () => {
    const { user, unmount } = renderApp()
    await screen.findByRole('heading', { name: 'Tableau de bord' })
    expect(document.documentElement).not.toHaveClass('dark')

    await chooseInMenu(user, 'Thème', 'Sombre')
    expect(document.documentElement).toHaveClass('dark')

    unmount()
    document.documentElement.className = ''
    renderApp()
    // Read back from the browser, where the preference lives — never from the
    // store, which has no dial for it.
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'))
  })

  it('follow the system while the choice is auto', async () => {
    renderApp()
    await screen.findByRole('heading', { name: 'Tableau de bord' })
    expect(document.documentElement).not.toHaveClass('dark')

    setPrefersDark(true)
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'))
  })

  it('write the eight allocation stops for the ground in force', async () => {
    const { user } = renderApp()
    await screen.findByRole('heading', { name: 'Tableau de bord' })

    const stopsOf = () =>
      Array.from({ length: ALLOCATION_SLICES }, (_, index) =>
        document.documentElement.style.getPropertyValue(`--alloc-${index + 1}`),
      )

    const light = stopsOf()
    expect(light.every(Boolean)).toBe(true)

    await chooseInMenu(user, 'Thème', 'Sombre')
    const dark = stopsOf()
    expect(dark.every(Boolean)).toBe(true)
    // The ramp is not merely re-tinted between grounds: it is reversed, because
    // rank 1 has to be the most contrasted on both.
    expect(dark[0]).not.toBe(light[0])
  })
})

describe('when the app is not answering', () => {
  /**
   * Every route the shell and the page read, refusing together — which is what
   * an app that is not answering looks like from a browser. There is no band
   * left to raise since #829 (ADR-0037): the bell is red, its panel says so in
   * prose, and the page names its own failed reads.
   */
  const unavailable = () =>
    [ROUTES.runtime, ROUTES.health, ROUTES.positions, ROUTES.portfolioTotals].map((route) =>
      problemHandler(route, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'Storage unavailable',
        detail: 'Catalog Error: Table with name position does not exist!',
      }),
    )

  it('names the failure once, where the page is empty, and never with the server’s own sentence', async () => {
    server.use(...unavailable())
    renderApp()

    // The page's own empty state, in the space the figures would have filled —
    // and **no strip anywhere**: not one live region is raised on the whole
    // screen, which is the criterion *there is no band anywhere* read off the
    // rendering rather than off a file name.
    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
    expect(screen.getByText(/Vos données sont illisibles pour l’instant/)).toBeInTheDocument()
    expect(screen.getAllByText('Lecture impossible')).toHaveLength(1)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    // `detail` and `title` are English diagnostics. They are carried, and
    // rendered nowhere — which is what put a French title over an English
    // sentence in the prototype's most consequential alert.
    expect(screen.queryByText(/Catalog Error/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Storage unavailable/)).not.toBeInTheDocument()
  })

  it('keeps the bell, which is what explains the empty page', async () => {
    server.use(...unavailable())
    const { user } = renderApp()

    const bell = await screen.findByRole('button', { name: /^Notifications/ })
    await waitFor(() => expect(bell).toHaveAccessibleName(/ne répond pas/))

    // And it *leads* somewhere rather than indicating without pointing: the
    // panel's health card offers a link to where one repairs.
    await user.click(bell)
    const panel = await screen.findByRole('dialog', { name: 'Notifications' })
    expect(within(panel).getByRole('link', { name: 'Voir dans Réglages' })).toHaveAttribute(
      'href',
      expect.stringContaining('/settings'),
    )
  })
})

describe('the content header', () => {
  it('carries its six objects, on every page', async () => {
    const { user } = renderApp()
    await screen.findByRole('heading', { name: 'Tableau de bord' })

    const objects = () => [
      screen.queryByRole('button', { name: 'Afficher ou masquer la navigation' }),
      screen.queryByRole('heading', { level: 1 }),
      screen.queryByRole('button', { name: /^Notifications/ }),
      screen.queryByRole('button', { name: 'Densité des tableaux' }),
      screen.queryByRole('button', { name: 'Langue' }),
      screen.queryByRole('button', { name: 'Thème' }),
    ]

    expect(objects().every(Boolean)).toBe(true)

    await user.click(within(nav()).getByRole('link', { name: 'Grand livre' }))
    await screen.findByRole('heading', { name: 'Grand livre' })
    // It is the one surface that survives the three sidebar states, so it is
    // the one that has to be on all five pages.
    expect(objects().every(Boolean)).toBe(true)
  })
})

describe('the chrome the component library ships', () => {
  // The criterion is "no hard string in a component", and the components most
  // likely to break it are the ones nobody wrote: the vendored `Sidebar` shipped
  // four English strings, one of them a **visible** native tooltip on the rail.
  // Covering them at the call site was not enough — these three surfaces have no
  // call site — so the strings were moved into the catalogues, and this is what
  // holds them there.
  it('names the rail in the reader’s language, tooltip included', async () => {
    const { user } = renderApp()
    await screen.findByRole('heading', { name: 'Tableau de bord' })

    const rail = screen.getByRole('button', { name: 'Replier ou déplier la navigation' })
    // `title` is the one string here a sighted reader actually sees.
    expect(rail).toHaveAttribute('title', 'Replier ou déplier la navigation')

    await chooseInMenu(user, 'Langue', 'English')
    expect(
      await screen.findByRole('button', { name: 'Collapse or expand the navigation' }),
    ).toHaveAttribute('title', 'Collapse or expand the navigation')
  })

  it('opens the drawer under 768 px, and it speaks French too', async () => {
    // jsdom has no layout, so this decides *which shell mounts*, not how it
    // looks — the look stays an acceptance criterion checked by eye.
    setViewportWidth(390)
    const { user } = renderApp()
    await screen.findByRole('heading', { name: 'Tableau de bord' })

    await user.click(screen.getByRole('button', { name: 'Afficher ou masquer la navigation' }))

    const drawer = await screen.findByRole('dialog', { name: 'Navigation' })
    expect(drawer).toHaveAccessibleDescription('Les sections de l’application, dans un tiroir.')
    expect(within(drawer).getByRole('navigation', { name: 'Sections' })).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Fermer' })).toBeInTheDocument()
  })
})
