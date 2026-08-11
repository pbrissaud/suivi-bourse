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
  it('starts, dresses, speaks two languages and walks its four routes', async () => {
    // The whole ticket in one pass, because the value of a tracer bullet is
    // that it can be *shown*: the app comes up, the sidebar is there, the
    // ground turns, the language turns, and the four routes answer under both.
    const { user } = renderApp()

    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument()
    expect(within(nav()).getAllByRole('link')).toHaveLength(4)

    await chooseInMenu(user, 'Thème', 'Sombre')
    expect(document.documentElement).toHaveClass('dark')

    await chooseInMenu(user, 'Langue', 'English')
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()

    for (const entry of ['Shares', 'Accounts', 'Data']) {
      await user.click(within(nav()).getByRole('link', { name: entry }))
      expect(await screen.findByRole('heading', { name: entry })).toBeInTheDocument()
      // The pages that are not built yet say so — in the reader's language.
      // `Shares` landed with #719 and has left that set.
      if (entry !== 'Shares') {
        expect(screen.getByText('This page is not built yet.')).toBeInTheDocument()
      }
    }

    // Back to French, on the page we happen to be standing on.
    await chooseInMenu(user, 'Language', 'Français')
    expect(await screen.findByRole('heading', { name: 'Données' })).toBeInTheDocument()
    expect(screen.getByText('Cette page n’est pas encore construite.')).toBeInTheDocument()
    // The ground did not move when the language did.
    expect(document.documentElement).toHaveClass('dark')
  })
})

describe('the four routes', () => {
  it('answer, and the reader walks to each of them', async () => {
    const { user } = renderApp()

    expect(await screen.findByRole('heading', { name: 'Tableau de bord' })).toBeInTheDocument()

    for (const entry of ['Titres', 'Comptes', 'Données']) {
      await user.click(within(nav()).getByRole('link', { name: entry }))
      expect(await screen.findByRole('heading', { name: entry })).toBeInTheDocument()
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
  it('drops the entry from the navigation and keeps the route answering', async () => {
    server.use(
      http.get(ROUTES.accounts, () => HttpResponse.json(anAccountsPayload([defaultAccounts()[0]]))),
    )

    const { unmount } = renderApp()
    await waitFor(() =>
      expect(within(nav()).queryByRole('link', { name: 'Comptes' })).not.toBeInTheDocument(),
    )
    // The other three are still there — the entry left, the navigation did not.
    expect(within(nav()).getByRole('link', { name: 'Titres' })).toBeInTheDocument()
    unmount()

    renderApp({ url: '/comptes' })
    expect(await screen.findByRole('heading', { name: 'Comptes' })).toBeInTheDocument()
  })
})

describe('the two reader preferences', () => {
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

  it('write the twelve allocation stops for the ground in force', async () => {
    const { user } = renderApp()
    await screen.findByRole('heading', { name: 'Tableau de bord' })

    const stopsOf = () =>
      Array.from({ length: 12 }, (_, index) =>
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
  const unavailable = () =>
    problemHandler(ROUTES.runtime, {
      status: 503,
      type: PROBLEM_TYPES.storageUnavailable,
      title: 'Storage unavailable',
      detail: 'Catalog Error: Table with name position does not exist!',
    })

  it('shows one band and never the server’s own sentence', async () => {
    server.use(unavailable())
    renderApp()

    const band = await screen.findByRole('status')
    expect(band).toHaveTextContent(/Les données ne sont pas lisibles pour l’instant/)
    // One band, never two.
    expect(screen.getAllByRole('status')).toHaveLength(1)
    // `detail` and `title` are English diagnostics. They are carried, and
    // rendered nowhere — which is what put a French title over an English
    // sentence in the prototype's most consequential alert.
    expect(screen.queryByText(/Catalog Error/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Storage unavailable/)).not.toBeInTheDocument()
  })

  it('keeps the status dot, which is what explains the empty page', async () => {
    server.use(unavailable())
    renderApp()

    const dot = await screen.findByRole('link', { name: /installation/i })
    await waitFor(() => expect(dot).toHaveAccessibleName(/ne répond pas/))
    expect(dot).toHaveAttribute('href', expect.stringContaining('/donnees'))
  })
})

describe('the content header', () => {
  it('carries its four objects, on every page', async () => {
    const { user } = renderApp()
    await screen.findByRole('heading', { name: 'Tableau de bord' })

    const objects = () => [
      screen.queryByRole('button', { name: 'Afficher ou masquer la navigation' }),
      screen.queryByRole('link', { name: /installation/i }),
      screen.queryByRole('button', { name: 'Langue' }),
      screen.queryByRole('button', { name: 'Thème' }),
    ]

    expect(objects().every(Boolean)).toBe(true)

    await user.click(within(nav()).getByRole('link', { name: 'Données' }))
    await screen.findByRole('heading', { name: 'Données' })
    // It is the one surface that survives the three sidebar states, so it is
    // the one that has to be on all four pages.
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
