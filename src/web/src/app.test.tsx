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
 * legibility of the eight allocation stops stay acceptance criteria checked by eye.
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
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

/** The navigation, by its accessible name — the reader's own handle on it. */
function nav() {
  return screen.getByRole('navigation', { name: 'Sections' })
}

/** One option of a preference on the settings page: a select for the language, a segmented control otherwise. */
async function chooseInSettings(
  user: ReturnType<typeof renderApp>['user'],
  control: string,
  option: string,
) {
  if (control === 'Langue' || control === 'Language') {
    await user.click(await screen.findByRole('combobox', { name: control }))
    await user.click(screen.getByRole('option', { name: option }))
    return
  }
  const group = await screen.findByRole('radiogroup', { name: control })
  await user.click(within(group).getByRole('radio', { name: option }))
}

describe('the walking skeleton', () => {
  it('starts, dresses, speaks two languages and walks its seven routes', async () => {
    // The whole ticket in one pass, because the value of a tracer bullet is
    // that it can be *shown*: the app comes up, the sidebar is there, the
    // ground turns, the language turns, and the seven routes answer under both.
    const { user } = renderApp()

    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument()
    expect(within(nav()).getAllByRole('link')).toHaveLength(8)

    // The preferences are set on the settings page, and nowhere else.
    await user.click(within(nav()).getByRole('link', { name: 'Réglages' }))
    await chooseInSettings(user, 'Apparence', 'Sombre')
    expect(document.documentElement).toHaveClass('dark')

    await chooseInSettings(user, 'Langue', 'English')
    await user.click(within(nav()).getByRole('link', { name: 'Dashboard' }))
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()

    // **The six routes now answer with six pages.** `PendingPage` and its one
    // sentence left with #721, the last placeholder: a page that says it is not
    // built yet has no subject once every one of them is, and a route arriving
    // later — #760's comparison is the sixth — arrives with its page rather
    // than with a promise of one, and so does #1196's agent, the seventh.
    for (const entry of [
      'Shares',
      'Accounts',
      'Reference',
      'Agent',
      'Ledger',
      'System',
      'Settings',
    ]) {
      await user.click(within(nav()).getByRole('link', { name: entry }))
      // `level: 1` is the page's own name, which the header draws (#789). The
      // settings page needs it said: the block it renders is *called* the
      // settings too, one level down, and that block is #830's to reshape.
      expect(await screen.findByRole('heading', { level: 1, name: entry })).toBeInTheDocument()
    }

    // Back to French, on the page we happen to be standing on.
    await chooseInSettings(user, 'Language', 'Français')
    expect(await screen.findByRole('heading', { level: 1, name: 'Réglages' })).toBeInTheDocument()
    // The ground did not move when the language did.
    expect(document.documentElement).toHaveClass('dark')
    // Two seconds and a half in a quiet run, and the default five is not a
    // margin under a loaded worker.
  }, 20_000)
})

describe('the five routes', () => {
  it('answer, and the reader walks to each of them', async () => {
    const { user } = renderApp()

    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument()

    for (const entry of ['Titres', 'Comptes', 'Grand livre', 'Réglages']) {
      await user.click(within(nav()).getByRole('link', { name: entry }))
      expect(await screen.findByRole('heading', { level: 1, name: entry })).toBeInTheDocument()
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
    // page's own: comparing one term is not comparing.
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
    const { user } = renderApp({ url: '/settings' })
    expect(await screen.findByRole('heading', { level: 1, name: 'Réglages' })).toBeInTheDocument()

    await chooseInSettings(user, 'Langue', 'English')

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(within(nav()).getByRole('link', { name: 'Shares' })).toBeInTheDocument()
    // The chrome follows too: the control that was `Langue` a moment ago is now
    // `Language`, so nothing is left in the other language on screen.
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeInTheDocument()
    expect(document.documentElement).toHaveAttribute('lang', 'en')
  })

  it('put the ground on the document, and keep it across a remount', async () => {
    const { user, unmount } = renderApp({ url: '/settings' })
    await screen.findByRole('heading', { level: 1, name: 'Réglages' })
    expect(document.documentElement).not.toHaveClass('dark')

    await chooseInSettings(user, 'Apparence', 'Sombre')
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

  it('stay reachable when every settings read fails', async () => {
    // The block reads the browser and nothing else: the page it sits on may
    // find every one of its own reads refused and still lets the reader
    // change the language, the ground and the density.
    server.use(
      ...[ROUTES.config, ROUTES.agentConfig, ROUTES.theme].map((route) =>
        problemHandler(route, {
          status: 503,
          type: PROBLEM_TYPES.storageUnavailable,
          title: 'Storage unavailable',
        }),
      ),
    )
    const { user } = renderApp({ url: '/settings' })
    await screen.findByRole('heading', { level: 1, name: 'Réglages' })

    await chooseInSettings(user, 'Apparence', 'Sombre')
    expect(document.documentElement).toHaveClass('dark')
    await chooseInSettings(user, 'Langue', 'English')
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
  })
})

describe('when the app is not answering', () => {
  /**
   * Every route the shell and the page read, refusing together — which is what
   * an app that is not answering looks like from a browser. There is no band
   * left to raise since #829: the bell is red, its panel says so in
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
    expect(within(panel).getByRole('link', { name: 'Voir dans Système' })).toHaveAttribute(
      'href',
      expect.stringContaining('/system'),
    )
  })
})

describe('the content header', () => {
  it('carries the fold, the title, the search and the bell, and nothing else', async () => {
    const { user } = renderApp()
    await screen.findByRole('heading', { name: 'Tableau de bord' })

    const header = () => screen.getByRole('banner')
    const objects = () => [
      ...within(header()).getAllByRole('button'),
      ...within(header()).getAllByRole('heading'),
    ]
    const names = () =>
      objects().map((object) => object.getAttribute('aria-label') ?? object.textContent)

    // Three controls and a title: the three preferences are Settings'.
    expect(within(header()).getAllByRole('button')).toHaveLength(3)
    expect(within(header()).getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(names()).toEqual(
      expect.arrayContaining(['Afficher ou masquer la navigation', 'Tableau de bord']),
    )
    expect(within(header()).getByRole('button', { name: /^Notifications/ })).toBeInTheDocument()
    for (const preference of ['Densité des tableaux', 'Langue', 'Apparence']) {
      expect(within(header()).queryByRole('button', { name: preference })).not.toBeInTheDocument()
    }

    await user.click(within(nav()).getByRole('link', { name: 'Grand livre' }))
    await screen.findByRole('heading', { name: 'Grand livre' })
    // It is the one surface that survives the three sidebar states, so it is
    // the one that has to be on all five pages.
    expect(within(header()).getAllByRole('button')).toHaveLength(3)
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
    const { user } = renderApp({ url: '/settings' })
    await screen.findByRole('heading', { level: 1, name: 'Réglages' })

    const rail = screen.getByRole('button', { name: 'Replier ou déplier la navigation' })
    // `title` is the one string here a sighted reader actually sees.
    expect(rail).toHaveAttribute('title', 'Replier ou déplier la navigation')

    await chooseInSettings(user, 'Langue', 'English')
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
