/**
 * The shell, once the page's own head moved into it (#789).
 *
 * Three things are decided here and none of them is a look:
 *
 *  - **the page's title is the header's** — the `<h1>` each page used to draw
 *    for itself is one object of the shell now, so a reader reads the name of
 *    the page they are on without deducing it from the navigation, and a screen
 *    reader still finds a title on every route;
 *  - **the status card is the dot's development, never its home** — it says in
 *    words what the dot says in a colour, and it is *absent* in the two sidebar
 *    states that cannot hold it, the dot staying put in all three (ADR-0022);
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

    for (const entry of ['Titres', 'Comptes', 'Données']) {
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

    // *Données* dates nothing: it declares a name and no subtitle, and what it
    // does not say must not be read from what the dashboard said.
    await user.click(within(nav()).getByRole('link', { name: 'Données' }))
    await screen.findByRole('heading', { level: 1, name: 'Données' })
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

describe('the status dot reads /health (#819, ADR-0036)', () => {
  const dot = () => screen.getByRole('link', { name: /état de l’installation/i })

  /** The tone a state is worn in, read off the one span that carries it. */
  const toneOf = (node: HTMLElement) =>
    Array.from(node.querySelectorAll('span[aria-hidden]'))
      .flatMap((span) => Array.from(span.classList))
      .find((name) => name.startsWith('bg-'))

  it('is amber on a writer frozen since Tuesday, which is a 200', async () => {
    // The behaviour this ticket adds. Reading `/api/runtime` the dot had one
    // detectable problem in it — the scheduler — so this install, whose
    // scheduler is running and whose scrape has written nothing for days, was
    // **green**. The route answers `200` and the body carries the fault, which
    // is exactly the register split ADR-0036 draws: restarting the container
    // repairs nothing that yfinance or the market broke.
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    renderApp()

    await waitFor(() => expect(dot()).toHaveAccessibleName(/demande un regard/))
  })

  it('stays green while everything is running', async () => {
    renderApp()
    await waitFor(() => expect(dot()).toHaveAccessibleName(/va bien/))
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

    await waitFor(() => expect(dot()).toHaveAccessibleName(/ne répond pas/))
  })

  it('is red when the route answers with a body it cannot read', async () => {
    // A proxy in front of the app, an image whose body has moved on. The read
    // succeeded and there is nothing in it: the colour has to stay true when
    // the detail disappears, and grey would claim nobody had looked.
    server.use(http.get(ROUTES.health, () => HttpResponse.json({ alive: true })))
    renderApp()

    await waitFor(() => expect(dot()).toHaveAccessibleName(/ne répond pas/))
  })

  it('leads to the installation tab, where the jobs and the store are', async () => {
    const { user } = renderApp()
    await waitFor(() => expect(dot()).toHaveAccessibleName(/va bien/))
    expect(dot()).toHaveAttribute('href', expect.stringContaining('/donnees'))

    await user.click(dot())
    // Where one repairs — which is what ADR-0022 asked of the dot when it made
    // it *lead* somewhere rather than indicate without pointing.
    expect(await screen.findByRole('heading', { name: 'Le magasin' })).toBeInTheDocument()
  })

  it('and the card beside it says the same thing, in the same tone', async () => {
    // The card is the **development** of the dot and never a second opinion on
    // what *attention* covers: one read, one derivation, one table of tones.
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    renderApp()

    const title = await screen.findByText('Quelque chose s’est arrêté')
    expect(dot()).toHaveAccessibleName(/demande un regard/)
    const card = title.closest('div')!.parentElement as HTMLElement
    expect(toneOf(card)).toBe('bg-attention')
    expect(toneOf(dot())).toBe('bg-attention')
  })

  it('holds the table of tones in one module, and one only', () => {
    // Held on the source, because no rendering can see it: a second copy of the
    // mapping renders identically on the day it is written and drifts on the
    // next state added.
    const declaring = ['components/StatusDot.tsx', 'components/AppSidebar.tsx', 'lib/status.ts']
      .filter((file) =>
        /STATE_TONE(\s*:\s*Record|\s*=)/.test(
          fs.readFileSync(path.join(import.meta.dirname, file), 'utf8'),
        ),
      )
    expect(declaring).toEqual(['components/StatusDot.tsx'])
  })
})

describe('the status card of the sidebar', () => {
  /**
   * `hidden` is not a loophole: a modal dialog hides the rest of the document
   * from the accessibility tree, so the drawer's own pass asks for the dot the
   * way a screen reader would find it once the drawer is shut.
   */
  const dot = (hidden = false) =>
    screen.getByRole('link', { name: /état de l’installation/i, hidden })

  it('develops the dot in words while the navigation is unfolded', async () => {
    renderApp()
    expect(await screen.findByText('Système opérationnel')).toBeInTheDocument()
    expect(dot()).toBeInTheDocument()
  })

  it('says which fact the dot is showing, and not merely that there is one', async () => {
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    renderApp()
    expect(await screen.findByText('Quelque chose s’est arrêté')).toBeInTheDocument()
  })

  it('claims nothing at all while the read that would fill it is in flight', async () => {
    server.use(http.get(ROUTES.health, () => new Promise<never>(() => {})))
    renderApp()

    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })
    expect(screen.queryByText('Système opérationnel')).not.toBeInTheDocument()
    // The dot is still there — it is a colour, and *unknown* is one of its five.
    expect(dot()).toBeInTheDocument()
  })

  it('leaves with the navigation when it folds to icons, and the dot stays', async () => {
    const { user } = renderApp()
    await screen.findByText('Système opérationnel')

    await user.click(screen.getByRole('button', { name: 'Afficher ou masquer la navigation' }))

    await waitFor(() => expect(screen.queryByText('Système opérationnel')).not.toBeInTheDocument())
    expect(dot()).toBeInTheDocument()
  })

  it('is not in the drawer either, where the whole navigation is behind a gesture', async () => {
    setViewportWidth(390)
    const { user } = renderApp()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })

    expect(screen.queryByText('Système opérationnel')).not.toBeInTheDocument()
    expect(dot()).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Afficher ou masquer la navigation' }))
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' })
    expect(within(drawer).queryByText('Système opérationnel')).not.toBeInTheDocument()
    expect(dot(true)).toBeInTheDocument()
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
