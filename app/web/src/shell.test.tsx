/**
 * The shell, once the page's own head moved into it (#789).
 *
 * Four things are decided here and none of them is a look:
 *
 *  - **the page's title is the header's** — the `<h1>` each page used to draw
 *    for itself is one object of the shell now, so a reader reads the name of
 *    the page they are on without deducing it from the navigation, and a screen
 *    reader still finds a title on every route;
 *  - **the navigation opens to five, in three and two** (ADR-0038) — the
 *    portfolio at the top, what the owner acts on at the foot, and the fold
 *    survives a reload;
 *  - **the bell is the one global indicator** (#829, ADR-0037) — its icon
 *    carries the health colour, its badge the count, and it is in the content
 *    header because that is the one surface surviving all three sidebar states.
 *    The sidebar's status card is gone: it was a fourth rendering of one fact,
 *    and the one that vanished in the rail and in the drawer;
 *  - **the density is the reader's third preference** — same shape of key as
 *    the theme and the language, two states because a density has no `auto`,
 *    and nothing of it reaches the store (ADR-0024).
 */
import fs from 'node:fs'
import path from 'node:path'
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { DENSITY_STORAGE_KEY } from '@/lib/density'
import { LANGUAGE_STORAGE_KEY } from '@/lib/i18n'
import { PROBLEM_TYPES } from '@/lib/problem'
import { THEME_STORAGE_KEY } from '@/lib/theme'
import { aFrozenScrape } from '@/test/factories'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

function nav() {
  return screen.getByRole('navigation', { name: 'Sections' })
}

/** The navigation's own memory of its fold — the component's, read back. */
function sidebar() {
  return document.querySelector('[data-slot="sidebar"][data-state]') as HTMLElement
}

async function chooseInMenu(
  user: ReturnType<typeof renderApp>['user'],
  control: string,
  option: string,
) {
  await user.click(screen.getByRole('button', { name: control }))
  await user.click(await screen.findByRole('menuitemradio', { name: option }))
}

describe('the page title, now the header’s', () => {
  it('names every route, once, and follows the reader from one to the next', async () => {
    const { user } = renderApp()

    // One title and not two: the page's own `<h1>` migrated rather than being
    // duplicated, which is what `getByRole` in the singular asserts.
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)

    for (const entry of ['Titres', 'Comptes', 'Grand livre', 'Réglages']) {
      await user.click(within(nav()).getByRole('link', { name: entry }))
      expect(await screen.findByRole('heading', { level: 1, name: entry })).toBeInTheDocument()
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    }
  })

  it('carries the page’s own dated subtitle beside it', async () => {
    renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })

    // The date the figures are of is a property of the page, said in the one
    // place the page's name is said — and it is a *read* that says it, so it
    // arrives when the read does.
    const banner = screen.getByRole('heading', { level: 1, name: 'Tableau de bord' }).parentElement!
    await waitFor(() => expect(banner).toHaveTextContent(/Cours au/))
  })

  it('drops the previous page’s subtitle rather than letting the next one wear it', async () => {
    const { user } = renderApp()
    const banner = () =>
      screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement
    await waitFor(() => expect(banner()).toHaveTextContent(/Cours au/))

    // *Grand livre* dates nothing: it declares a name and no subtitle, and
    // what it does not say must not be read from what the dashboard said.
    await user.click(within(nav()).getByRole('link', { name: 'Grand livre' }))
    await screen.findByRole('heading', { level: 1, name: 'Grand livre' })
    expect(banner()).not.toHaveTextContent(/Cours au/)
  })

  it('titles the address that matches nothing too', async () => {
    renderApp({ url: '/nowhere' })
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Page introuvable' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })
})

describe('the navigation, five entries in three and two (ADR-0038)', () => {
  /** The nav's links, in the order a reader — and a screen reader — meets them. */
  const entries = () => within(nav()).getAllByRole('link').map((link) => link.textContent)

  it('says Grand livre and Réglages, and puts both at the foot of the list', async () => {
    renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })

    // *Grand livre* and never *Registre*: the concept has a word, and a label
    // inventing a second one puts two names on one thing. The order is the
    // decision — the three the owner **looks at**, then the two they **act
    // on** — so it is asserted as an order and not as a set.
    expect(entries()).toEqual([
      'Tableau de bord',
      'Titres',
      'Comptes',
      'Grand livre',
      'Réglages',
    ])
  })

  it('leads to a settings page that is a page, with a title of its own', async () => {
    const { user } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })

    await user.click(within(nav()).getByRole('link', { name: 'Réglages' }))

    // A route that renders a stub is a promise; this one renders the surface —
    // the dials, and the store the reader came to read.
    expect(await screen.findByRole('heading', { level: 1, name: 'Réglages' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Le magasin' })).toBeInTheDocument()
  })

  it('answers on its own address, so a bookmark on the settings survives', async () => {
    renderApp({ url: '/reglages' })

    // It is not `/donnees#installation` under a shorter name: a hash names a
    // tab, and ADR-0038 took the tab bar away.
    expect(await screen.findByRole('heading', { level: 1, name: 'Réglages' })).toBeInTheDocument()
  })

  it('folds on ⌘B, and is still folded on the next load', async () => {
    // The fold is the component's — the rail, the shortcut, the cookie — but
    // the **read back** is the product's: upstream reads that cookie on a
    // server this app does not have, so without it the write landed and
    // nothing ever looked at it.
    //
    // The marker used to be the status card, which the rail could not hold and
    // which #829 removed; what is left is the component's own state, read the
    // way the density is read off a table.
    const { user, unmount } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })
    expect(sidebar()).toHaveAttribute('data-state', 'expanded')

    await user.keyboard('{Meta>}b{/Meta}')
    await waitFor(() => expect(sidebar()).toHaveAttribute('data-state', 'collapsed'))

    unmount()
    renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })
    expect(sidebar()).toHaveAttribute('data-state', 'collapsed')
  })

  it('is a drawer at 390 px, behind a gesture, with the five entries in it', async () => {
    setViewportWidth(390)
    const { user } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })

    // Nothing of the navigation is on screen until it is asked for: the drawer
    // is what let the sidebar win over the top bar, which lost a route here.
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Afficher ou masquer la navigation' }))
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' })
    expect(within(drawer).getAllByRole('link')).toHaveLength(5)
  })
})

describe('the bell is the one global indicator (#829, ADR-0036, ADR-0037)', () => {
  const bell = (hidden = false) =>
    screen.getByRole('button', { name: /^Notifications/, hidden })

  /** The tone the icon is worn in, read off the one node that carries it. */
  const toneOf = (node: HTMLElement) =>
    Array.from(node.querySelectorAll('[aria-hidden]'))
      .flatMap((child) => Array.from(child.classList))
      .find((name) => name.startsWith('text-'))

  it('is amber on a writer frozen since Tuesday, which is a 200', async () => {
    // The behaviour #819 added and this ticket inherits. Reading `/api/runtime`
    // the indicator had one detectable problem in it — the scheduler — so this
    // install, whose scheduler is running and whose scrape has written nothing
    // for days, was **green**. The route answers `200` and the body carries the
    // fault, which is exactly the register split ADR-0036 draws.
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    renderApp()

    await waitFor(() => expect(bell()).toHaveAccessibleName(/demande un regard/))
  })

  it('stays green while everything is running', async () => {
    renderApp()
    await waitFor(() => expect(bell()).toHaveAccessibleName(/va bien/))
  })

  it('is red when the app is not answering at all', async () => {
    // The store went, so the body went with it — the trade ADR-0036 states in
    // as many words. What survives is the colour that needs no body to be true.
    server.use(
      problemHandler(ROUTES.health, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'Storage unavailable',
      }),
    )
    renderApp()

    await waitFor(() => expect(bell()).toHaveAccessibleName(/ne répond pas/))
  })

  it('is red when the route answers with a body it cannot read', async () => {
    // A proxy in front of the app, an image whose body has moved on. The read
    // succeeded and there is nothing in it: the colour has to stay true when
    // the detail disappears, and grey would claim nobody had looked.
    server.use(http.get(ROUTES.health, () => HttpResponse.json({ alive: true })))
    renderApp()

    await waitFor(() => expect(bell()).toHaveAccessibleName(/ne répond pas/))
  })

  it('carries the health colour on the icon and the count on the badge', async () => {
    // **Two channels, one control** (ADR-0037). The badge is deliberately
    // neutral in colour so the two do not compete for the same signal, and the
    // count is in the accessible name because the badge itself is `aria-hidden`.
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    renderApp()

    await waitFor(() => expect(toneOf(bell())).toBe('text-attention'))
    // One health card, one installation fact: the fixture's own two.
    await waitFor(() => expect(bell()).toHaveAccessibleName(/2 entrées ouvertes/))
  })

  it('opens onto a panel that says the state in prose, and leads to the settings', async () => {
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    const { user } = renderApp()
    await waitFor(() => expect(bell()).toHaveAccessibleName(/demande un regard/))

    await user.click(bell())
    const panel = await screen.findByRole('dialog', { name: 'Notifications' })

    // The card the sidebar's own used to be: the same sentence, in the one
    // place that survives the three sidebar states.
    expect(within(panel).getByText('Quelque chose s’est arrêté')).toBeInTheDocument()
    // Health is **repaired, never dismissed**: a link, and no acknowledgement.
    expect(within(panel).getByRole('link', { name: 'Voir dans Réglages' })).toBeInTheDocument()
  })

  it('has no sidebar card left to disagree with it', async () => {
    // ADR-0037 removes the fourth rendering of one fact — and it was the one
    // that vanished in the rail and in the drawer, which is to say on the
    // widths where a reader has least to look at.
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    renderApp()

    await waitFor(() => expect(bell()).toHaveAccessibleName(/demande un regard/))
    expect(screen.queryByText('Système opérationnel')).not.toBeInTheDocument()
  })

  it('stays put when the navigation folds, and in the drawer', async () => {
    setViewportWidth(390)
    const { user } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })

    expect(bell()).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Afficher ou masquer la navigation' }))
    await screen.findByRole('dialog', { name: 'Navigation' })
    // `hidden` is not a loophole: a modal dialog hides the rest of the document
    // from the accessibility tree, so this asks for the control the way a
    // screen reader would find it once the drawer is shut.
    expect(bell(true)).toBeInTheDocument()
  })

  it('holds the table of tones in one module, and one only', () => {
    // Held on the source, because no rendering can see it: a second copy of the
    // mapping renders identically on the day it is written and drifts on the
    // next state added. It used to be the dot's and to be read a second time by
    // the sidebar card; there is one consumer now.
    const declaring = ['components/Notifications.tsx', 'components/AppSidebar.tsx', 'lib/status.ts']
      .filter((file) =>
        /STATE_TONE(\s*:\s*Record|\s*=)/.test(
          fs.readFileSync(path.join(import.meta.dirname, file), 'utf8'),
        ),
      )
    expect(declaring).toEqual(['components/Notifications.tsx'])
  })

  it('leaves no band anywhere, and no component named for one', () => {
    // `Banner.tsx`, `Band.tsx` and `StatusDot.tsx` are gone (#829, ADR-0037):
    // the banner is retired without replacement, its conditions are cards in
    // the panel, and its sentence descends into each page's empty state.
    for (const gone of ['components/Banner.tsx', 'components/Band.tsx', 'components/StatusDot.tsx']) {
      expect(fs.existsSync(path.join(import.meta.dirname, gone)), gone).toBe(false)
    }
  })
})

describe('the density, the reader’s third preference', () => {
  it('offers two states and no third, because a density has no automatic', async () => {
    const { user } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })

    await user.click(screen.getByRole('button', { name: 'Densité des tableaux' }))
    const options = await screen.findAllByRole('menuitemradio')
    expect(options.map((option) => option.textContent)).toEqual(['Confortable', 'Compact'])
  })

  it('reaches the tables, and survives a remount without touching the store', async () => {
    let written = 0
    server.use(
      http.put(ROUTES.settings, () => {
        written += 1
        return HttpResponse.json({ settings: [], changed: [], effect: {} })
      }),
    )

    const { user, unmount } = renderApp({ url: '/titres' })
    const table = await screen.findByRole('table')
    expect(table).toHaveAttribute('data-density', 'comfortable')

    await chooseInMenu(user, 'Densité des tableaux', 'Compact')
    await waitFor(() => expect(screen.getByRole('table')).toHaveAttribute('data-density', 'compact'))

    unmount()
    renderApp({ url: '/titres' })
    // Read back from the browser, where the three preferences live — the store
    // has no dial for any of them.
    await waitFor(() => expect(screen.getByRole('table')).toHaveAttribute('data-density', 'compact'))
    expect(written).toBe(0)
  })

  it('keeps its key in the shape the other two wear', () => {
    expect([THEME_STORAGE_KEY, LANGUAGE_STORAGE_KEY, DENSITY_STORAGE_KEY]).toEqual([
      'sb.theme',
      'sb.lang',
      'sb.density',
    ])
  })
})
