/**
 * The dashboard's grid and its edit mode (design doc of 11/10/2026, its eng
 * and design reviews, and Paul's notes on the interactive mock-up).
 *
 * Driven through the real app with the one faked edge, HTTP: the layout the
 * server answers, and the writes it receives, are what each case states.
 */
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DashboardLayout } from '@/features/dashboard/lib/api'
import { ROUTES } from '@/lib/api'
import { aBenchmark, aMover, aMoversPayload, aPosition, aPositionsPayload } from '@/test/factories'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

/** What the old default, saved, draws: the arrangement the edit cases move cards through. */
const SEEN_TITLES = ['D’où vient le gain', 'Rythme d’investissement', 'Mouvements']
const TITLES = ['Répartition', 'D’où vient le gain', 'Rythme d’investissement', 'Mouvements']

/** The cards' titles, in the order the grid draws them. */
function order(container: HTMLElement) {
  return [...container.querySelectorAll('[data-slot="section"] h2')].map((one) => one.textContent)
}

function layoutOf(blocks: DashboardLayout['blocks']) {
  return http.get(ROUTES.dashboardLayout, () => HttpResponse.json({ version: 1, blocks }))
}

/** Every write the grid sends to the layout route, in order. */
function recordWrites() {
  const writes: { method: string; body: unknown }[] = []
  server.events.on('request:start', async ({ request }) => {
    const url = new URL(request.url)
    if (url.pathname !== ROUTES.dashboardLayout || request.method === 'GET') return
    const body = request.method === 'PUT' ? await request.clone().json() : null
    writes.push({ method: request.method, body })
  })
  return writes
}

/** The store refusing, as `problem+json` with a 503. */
function unavailable(method: 'get' | 'put' | 'delete') {
  return http[method](ROUTES.dashboardLayout, () =>
    HttpResponse.json(
      { status: 503, title: 'Storage unavailable' },
      { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
    ),
  )
}

async function landed() {
  return screen.findByRole('button', { name: 'Modifier le tableau de bord' })
}

async function openMenu(user: ReturnType<typeof renderApp>['user'], card: string) {
  await user.click(screen.getByRole('button', { name: `Options : ${card}` }))
}

afterEach(() => setViewportWidth(1024))

/**
 * The default layout once saved: the allocation (#1206) and the comparison
 * (#1205) arrived hidden and a save wrote them in, so nothing is *Nouveau* and
 * a « Terminé » with no change has nothing to write.
 */
const SEEN = [
  { id: 'gain-breakdown', width: 'half', hidden: false },
  { id: 'rhythm', width: 'half', hidden: false },
  { id: 'movers', width: 'full', hidden: false },
  { id: 'allocation', width: 'half', hidden: true },
  { id: 'benchmark', width: 'half', hidden: true },
] as const satisfies DashboardLayout['blocks']

describe('reading mode', () => {
  it('gives the edit entry and the ⓘ a 24 px hit area, 44 px on touch', async () => {
    renderApp()
    const targets = [
      await landed(),
      await screen.findByRole('button', { name: 'Ce que veut dire TRI' }),
    ]

    for (const target of targets) {
      expect(target).toHaveClass(
        'min-h-6',
        'min-w-6',
        'pointer-coarse:min-h-11',
        'pointer-coarse:min-w-11',
      )
    }
  })

  it('draws the default layout: the allocation and the gain, then the movers and the rhythm', async () => {
    const { container } = renderApp()
    await landed()
    await screen.findByRole('region', { name: 'Mouvements' })

    expect(order(container)).toEqual(TITLES)
  })

  it('says nothing is new on a fresh install, and keeps the comparison out of the grid (#1280)', async () => {
    renderApp()
    await landed()

    expect(await screen.findByRole('region', { name: 'Répartition' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Face à l’indice' })).not.toBeInTheDocument()
    expect(screen.queryByText(/nouvelles? cartes?/)).not.toBeInTheDocument()
  })

  it('closes the grid with the edit entry, and not above it (#1280)', async () => {
    const { container } = renderApp()
    const entry = await landed()
    const grid = container.querySelector('[data-dashboard-grid]') as HTMLElement

    expect(grid.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('draws the saved order, and leaves a hidden card out', async () => {
    server.use(
      layoutOf([
        { id: 'movers', width: 'full', hidden: false },
        { id: 'gain-breakdown', width: 'half', hidden: false },
        { id: 'rhythm', width: 'half', hidden: true },
      ]),
    )
    const { container } = renderApp()
    await landed()
    await screen.findByRole('region', { name: 'Mouvements' })

    expect(order(container)).toEqual(['Mouvements', 'D’où vient le gain'])
  })

  it('draws the default layout when the saved one cannot be read, and will not edit over it', async () => {
    server.use(unavailable('get'))
    const { container } = renderApp()

    const entry = await landed()
    expect(entry).toBeDisabled()
    expect(entry).toHaveAccessibleDescription('La disposition enregistrée n’a pas pu être lue.')
    await screen.findByRole('region', { name: 'Mouvements' })
    expect(order(container)).toEqual(TITLES)
  })

  it('offers no card menu outside edit mode', async () => {
    renderApp()
    await landed()
    await screen.findByRole('region', { name: 'Mouvements' })

    expect(screen.queryByRole('button', { name: /^Options :/ })).not.toBeInTheDocument()
  })
})

describe('the movers by width', () => {
  // The old default, saved: the movers at the full width, which a fresh install no longer has.
  beforeEach(() => {
    server.use(layoutOf([...SEEN]))
  })

  const ten = Array.from({ length: 12 }, (_, index) =>
    aMover({
      symbol: index === 0 ? 'MC.PA' : index === 1 ? 'BTC-EUR' : `Z${index}`,
      name: `Ligne ${index}`,
      change_pct: (index + 1) / 100,
    }),
  )

  it('starts at the full width, and says so when it goes to half of it', async () => {
    server.use(http.get(ROUTES.movers, () => HttpResponse.json(aMoversPayload(ten))))
    const { user } = renderApp()
    await landed()
    await screen.findByRole('region', { name: 'Mouvements' })

    await user.click(await landed())
    await openMenu(user, 'Mouvements')
    expect(screen.getByRole('menuitemradio', { name: 'Pleine largeur' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.click(screen.getByRole('menuitemradio', { name: 'Demi-largeur' }))
    expect(await screen.findByText('Mouvements en demi-largeur')).toBeInTheDocument()
  })

  // Two columns only when one column at half the width would not hold the list
  // (#1145): a short list split in two left its figures half-way across.
  it.each([
    [1, false],
    [5, false],
    [6, true],
    [7, true],
  ])('at the full width, flows %i lines into two columns: %s', async (count, split) => {
    const movers = ten.slice(0, count)
    server.use(
      http.get(ROUTES.movers, () => HttpResponse.json(aMoversPayload(movers))),
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload(movers.map(({ symbol, name }) => aPosition({ symbol, name }))),
        ),
      ),
    )
    renderApp()
    const list = await screen.findByRole('list', { name: 'Mouvements' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(count)
    expect(list.classList.contains('columns-2')).toBe(split)
    // The first line of each column carries no rule above it, and only those.
    const unruled = items.flatMap((item, index) =>
      item.classList.contains('border-t-0') ? [index] : [],
    )
    expect(unruled).toEqual(split ? [0, Math.ceil(count / 2)] : [0])
  })
})

describe('the movers across three tracks (#1325)', () => {
  const lines = Array.from({ length: 20 }, (_, index) =>
    aMover({ symbol: `Z${index}`, name: `Ligne ${index}`, change_pct: (index + 1) / 100 }),
  )

  // Columns of five: as many as it takes, three at most, and the first line of each unruled.
  it.each([
    [5, 1, [0]],
    [6, 2, [0, 3]],
    [11, 3, [0, 4, 8]],
    [15, 3, [0, 5, 10]],
    [20, 3, [0, 5, 10]],
  ])('flows %i lines into %i column(s)', async (count, columns, unruled) => {
    setViewportWidth(1920)
    const movers = lines.slice(0, count)
    server.use(
      http.get(ROUTES.movers, () => HttpResponse.json(aMoversPayload(movers))),
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload(movers.map(({ symbol, name }) => aPosition({ symbol, name }))),
        ),
      ),
    )
    renderApp()
    const list = await screen.findByRole('list', { name: 'Mouvements' })
    const items = within(list).getAllByRole('listitem')

    expect(items).toHaveLength(Math.min(count, 15))
    expect(list.classList.contains(`columns-${columns}`)).toBe(columns > 1)
    expect(
      items.flatMap((item, index) => (item.classList.contains('border-t-0') ? [index] : [])),
    ).toEqual(unruled)
  })
})

describe('the movers just under three tracks, and at half width (#1325)', () => {
  const lines = Array.from({ length: 20 }, (_, index) =>
    aMover({ symbol: `Z${index}`, name: `Ligne ${index}`, change_pct: (index + 1) / 100 }),
  )

  it.each([
    ['full', 1599, 10, 'columns-2'],
    ['half', 1920, 5, null],
  ] as const)('keeps a %s card at %i px to %i lines', async (width, viewport, count, columns) => {
    setViewportWidth(viewport)
    server.use(
      layoutOf([{ id: 'movers', width, hidden: false }]),
      http.get(ROUTES.movers, () => HttpResponse.json(aMoversPayload(lines))),
      http.get(ROUTES.positions, () =>
        HttpResponse.json(
          aPositionsPayload(lines.map(({ symbol, name }) => aPosition({ symbol, name }))),
        ),
      ),
    )
    renderApp()
    const list = await screen.findByRole('list', { name: 'Mouvements' })

    expect(within(list).getAllByRole('listitem')).toHaveLength(count)
    if (columns !== null) expect(list).toHaveClass(columns)
    else expect(list).not.toHaveClass('columns-2', 'columns-3')
  })
})

describe('edit mode', () => {
  // The arrangement these cases move cards through: the old default, saved.
  beforeEach(() => {
    server.use(layoutOf([...SEEN]))
  })

  it('opens on its title, puts a menu in each card’s title row, and freezes the content', async () => {
    const { user } = renderApp()
    await user.click(await landed())

    const title = await screen.findByRole('heading', { name: 'Modifier le tableau de bord' })
    await waitFor(() => expect(title).toHaveFocus())
    const movers = screen.getByRole('region', { name: 'Mouvements' })
    expect(within(movers).getByRole('button', { name: 'Options : Mouvements' })).toBeInTheDocument()
    expect(movers.querySelector('[inert]')).not.toBeNull()
  })

  it('offers no width to a card that has only one', async () => {
    const { user } = renderApp()
    await user.click(await landed())
    await openMenu(user, 'D’où vient le gain')

    expect(screen.getByRole('menuitem', { name: 'Monter' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
  })

  it('jumps a full card over a whole pair, keeps the focus on it, and says where it went', async () => {
    const { user, container } = renderApp()
    await user.click(await landed())
    await openMenu(user, 'Mouvements')
    await user.click(screen.getByRole('menuitem', { name: 'Monter' }))

    expect(order(container)).toEqual([
      'Mouvements',
      'D’où vient le gain',
      'Rythme d’investissement',
    ])
    expect(await screen.findByText('Mouvements déplacée, position 1 sur 3')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Options : Mouvements' })).toHaveFocus(),
    )
  })

  it('disables a move with nowhere to go', async () => {
    const { user } = renderApp()
    await user.click(await landed())
    await openMenu(user, 'D’où vient le gain')

    expect(screen.getByRole('menuitem', { name: 'Monter' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('hides a card into the hidden list, and shows it again where it was', async () => {
    const { user, container } = renderApp()
    await user.click(await landed())
    await openMenu(user, 'Rythme d’investissement')
    await user.click(screen.getByRole('menuitem', { name: 'Masquer' }))

    const hidden = screen.getByRole('region', { name: 'Cartes masquées' })
    const row = () => within(hidden).queryByText('Rythme d’investissement')?.closest('li')
    expect(row()).toBeInTheDocument()
    expect(await screen.findByText('Rythme d’investissement masquée')).toBeInTheDocument()
    // The gain is alone on its row now and half-only: the other half is free.
    expect(screen.getByText('Place libre')).toBeInTheDocument()

    const rhythm = within(hidden).getByText('Rythme d’investissement').closest('li')!
    await user.click(within(rhythm).getByRole('button', { name: 'Afficher' }))
    expect(order(container)).toEqual(SEEN_TITLES)
    expect(within(hidden).queryByText('Rythme d’investissement')).not.toBeInTheDocument()
  })

  it('writes the layout once, on « Terminé », and goes back to the entry', async () => {
    const writes = recordWrites()
    const { user } = renderApp()
    await user.click(await landed())
    await openMenu(user, 'Mouvements')
    await user.click(screen.getByRole('menuitem', { name: 'Monter' }))
    await user.click(screen.getByRole('button', { name: 'Terminé' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({
      method: 'PUT',
      body: {
        version: 1,
        blocks: [
          { id: 'movers', width: 'full', hidden: false },
          { id: 'gain-breakdown', width: 'half', hidden: false },
          { id: 'rhythm', width: 'half', hidden: false },
          // Written in hidden: saving is what ends their *Nouveau* (18A).
          { id: 'allocation', width: 'half', hidden: true },
          { id: 'benchmark', width: 'half', hidden: true },
        ],
      },
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Modifier le tableau de bord' })).toHaveFocus(),
    )
  })

  it('writes nothing when nothing changed', async () => {
    server.use(layoutOf([...SEEN]))
    const writes = recordWrites()
    const { user } = renderApp()
    await user.click(await landed())
    await user.click(screen.getByRole('button', { name: 'Terminé' }))

    await landed()
    expect(writes).toEqual([])
  })

  it('throws the draft away on « Annuler »', async () => {
    const writes = recordWrites()
    const { user, container } = renderApp()
    await user.click(await landed())
    await openMenu(user, 'Mouvements')
    await user.click(screen.getByRole('menuitem', { name: 'Monter' }))
    await user.click(screen.getByRole('button', { name: 'Annuler' }))

    await landed()
    expect(order(container)).toEqual(SEEN_TITLES)
    expect(writes).toEqual([])
  })

  it('confirms a reset in a card, and deletes the saved layout on « Terminé »', async () => {
    server.use(
      layoutOf([
        { id: 'movers', width: 'full', hidden: false },
        { id: 'gain-breakdown', width: 'half', hidden: false },
        { id: 'rhythm', width: 'half', hidden: false },
      ]),
    )
    const writes = recordWrites()
    const { user, container } = renderApp()
    await user.click(await landed())
    await user.click(screen.getByRole('button', { name: 'Réinitialiser' }))
    await user.click(await screen.findByRole('button', { name: 'Revenir au défaut' }))

    expect(order(container)).toEqual(TITLES)
    expect(screen.getByRole('button', { name: 'Réinitialiser' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Terminé' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'DELETE', body: null }]))
  })

  it('writes a layout after a reset that was followed by an edit', async () => {
    server.use(
      layoutOf([
        { id: 'movers', width: 'full', hidden: false },
        { id: 'gain-breakdown', width: 'half', hidden: false },
        { id: 'rhythm', width: 'half', hidden: false },
      ]),
    )
    const writes = recordWrites()
    const { user } = renderApp()
    await user.click(await landed())
    await user.click(screen.getByRole('button', { name: 'Réinitialiser' }))
    await user.click(await screen.findByRole('button', { name: 'Revenir au défaut' }))
    await openMenu(user, 'Rythme d’investissement')
    await user.click(screen.getByRole('menuitem', { name: 'Masquer' }))
    await user.click(screen.getByRole('button', { name: 'Terminé' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].method).toBe('PUT')
  })

  it('keeps the draft and offers to retry when the save fails', async () => {
    server.use(unavailable('put'))
    const { user, container } = renderApp()
    await user.click(await landed())
    await openMenu(user, 'Mouvements')
    await user.click(screen.getByRole('menuitem', { name: 'Monter' }))
    await user.click(screen.getByRole('button', { name: 'Terminé' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le tableau de bord n’a pas pu être enregistré.',
    )
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
    expect(order(container)[0]).toBe('Mouvements')
  })

  it('offers no width on a phone', async () => {
    setViewportWidth(390)
    const { user } = renderApp()
    await user.click(await landed())
    await openMenu(user, 'Mouvements')

    expect(screen.getByRole('menuitem', { name: 'Monter' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
  })

  it('keeps a failed card arrangeable, with its name on a reduced row', async () => {
    server.use(
      http.get(ROUTES.movers, () =>
        HttpResponse.json(
          { status: 503, title: 'Storage unavailable' },
          { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user, container } = renderApp()
    await user.click(await landed())
    await openMenu(user, 'Mouvements')
    await user.click(screen.getByRole('menuitem', { name: 'Monter' }))

    expect(await screen.findByText('Mouvements déplacée, position 1 sur 3')).toBeInTheDocument()
    expect(order(container)).toEqual(['D’où vient le gain', 'Rythme d’investissement'])
  })

  it('offers to retry a reset whose delete failed, and leaves once it goes through', async () => {
    server.use(
      layoutOf([
        { id: 'movers', width: 'full', hidden: false },
        { id: 'gain-breakdown', width: 'half', hidden: false },
        { id: 'rhythm', width: 'half', hidden: false },
      ]),
      unavailable('delete'),
    )
    const { user } = renderApp()
    await user.click(await landed())
    await user.click(screen.getByRole('button', { name: 'Réinitialiser' }))
    await user.click(await screen.findByRole('button', { name: 'Revenir au défaut' }))
    await user.click(screen.getByRole('button', { name: 'Terminé' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    server.use(http.delete(ROUTES.dashboardLayout, () => new HttpResponse(null, { status: 204 })))
    await user.click(screen.getByRole('button', { name: 'Réessayer' }))
    await landed()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('leaves no save alert behind after « Annuler »', async () => {
    server.use(unavailable('put'))
    const { user } = renderApp()
    await user.click(await landed())
    await openMenu(user, 'Mouvements')
    await user.click(screen.getByRole('menuitem', { name: 'Monter' }))
    await user.click(screen.getByRole('button', { name: 'Terminé' }))
    await screen.findByRole('alert')

    await user.click(screen.getByRole('button', { name: 'Annuler' }))
    await landed()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('freezes the hero while the grid is arranged', async () => {
    const { user } = renderApp()
    const entry = await landed()
    const hero = screen.getByRole('group', { name: 'Valeur du portefeuille' })
    expect(hero.closest('[inert]')).toBeNull()

    await user.click(entry)
    await waitFor(() => expect(hero.closest('[inert]')).not.toBeNull())
  })
})

describe('dragging a card', () => {
  // jsdom lays nothing out, and dnd-kit's arrows go from card to card by
  // their boxes, clipped by their ancestors': the grid's cells are stacked
  // here, one 280 px row each, inside a page large enough to hold them.
  beforeEach(() => {
    server.use(layoutOf([...SEEN]))
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const grid = this.parentElement
      if (grid?.hasAttribute('data-dashboard-grid') !== true) return new DOMRect(0, 0, 1024, 4000)
      return new DOMRect(0, [...grid.children].indexOf(this) * 300, 1000, 280)
    })
  })
  afterEach(() => vi.restoreAllMocks())

  async function dragWithKeys(
    user: ReturnType<typeof renderApp>['user'],
    card: string,
    keys: string,
  ) {
    const handle = await screen.findByRole('button', { name: `Déplacer : ${card}` })
    handle.focus()
    await user.keyboard(keys)
    return handle
  }

  it('moves a card with the keyboard as « Monter » does, and says where it landed', async () => {
    const { user, container } = renderApp()
    await user.click(await landed())
    await dragWithKeys(user, 'Mouvements', ' {ArrowUp} ')

    await waitFor(() =>
      expect(order(container)).toEqual([
        'Mouvements',
        'D’où vient le gain',
        'Rythme d’investissement',
      ]),
    )
    expect(await screen.findByText('Mouvements déposée, position 1 sur 3')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Déplacer : Mouvements' })).toHaveFocus(),
    )
  })

  it('lets a half swap with another, and come back home in the same drag', async () => {
    const { user, container } = renderApp()
    await user.click(await landed())
    await dragWithKeys(user, 'Rythme d’investissement', ' {ArrowUp}')
    expect(await screen.findByText('Rythme d’investissement, position 1 sur 3')).toBeInTheDocument()

    await user.keyboard('{ArrowDown} ')
    expect(
      await screen.findByText('Rythme d’investissement déposée, position 2 sur 3'),
    ).toBeInTheDocument()
    expect(order(container)).toEqual(SEEN_TITLES)
  })

  it('says a drop in place, and leaves nothing to write', async () => {
    server.use(layoutOf([...SEEN]))
    const writes = recordWrites()
    const { user, container } = renderApp()
    await user.click(await landed())
    await dragWithKeys(user, 'Mouvements', '  ')

    expect(await screen.findByText('Mouvements déposée, position 3 sur 3')).toBeInTheDocument()
    expect(order(container)).toEqual(SEEN_TITLES)
    await user.click(screen.getByRole('button', { name: 'Terminé' }))
    await landed()
    expect(writes).toEqual([])
  })

  it('puts everything back on Escape', async () => {
    const { user, container } = renderApp()
    await user.click(await landed())
    await dragWithKeys(user, 'Mouvements', ' {ArrowUp}{Escape}')

    expect(await screen.findByText('Déplacement annulé')).toBeInTheDocument()
    expect(order(container)).toEqual(SEEN_TITLES)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Déplacer : Mouvements' })).toHaveFocus(),
    )
  })

  it('writes the drop on « Terminé », and not before', async () => {
    const writes = recordWrites()
    const { user } = renderApp()
    await user.click(await landed())
    await dragWithKeys(user, 'Mouvements', ' {ArrowUp} ')
    await screen.findByText('Mouvements déposée, position 1 sur 3')
    expect(writes).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Terminé' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body).toEqual({
      version: 1,
      blocks: [
        { id: 'movers', width: 'full', hidden: false },
        { id: 'gain-breakdown', width: 'half', hidden: false },
        { id: 'rhythm', width: 'half', hidden: false },
        { id: 'allocation', width: 'half', hidden: true },
        { id: 'benchmark', width: 'half', hidden: true },
      ],
    })
  })

  it('puts a handle on a failed card’s reduced row too', async () => {
    server.use(
      http.get(ROUTES.movers, () =>
        HttpResponse.json(
          { status: 503, title: 'Storage unavailable' },
          { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = renderApp()
    await user.click(await landed())

    expect(await screen.findByRole('button', { name: 'Déplacer : Mouvements' })).toBeInTheDocument()
  })

  it('offers no handle outside edit mode, nor on a phone', async () => {
    renderApp()
    await landed()
    expect(screen.queryByRole('button', { name: /^Déplacer :/ })).not.toBeInTheDocument()
    cleanup()

    setViewportWidth(390)
    const { user } = renderApp()
    await user.click(await landed())
    expect(screen.getByRole('button', { name: 'Options : Mouvements' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Déplacer :/ })).not.toBeInTheDocument()
  })
})

describe('the comparison card (#1205)', () => {
  /** Every `/api/benchmark` request, counted. */
  function countBenchmarkReads() {
    const reads = { count: 0 }
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname === ROUTES.benchmark) reads.count += 1
    })
    return reads
  }

  it('lands under « Nouveau », and is not read until it is shown in the draft', async () => {
    server.use(layoutOf(SEEN.slice(0, 4)))
    const reads = countBenchmarkReads()
    const { user } = renderApp()
    await screen.findByRole('region', { name: 'Mouvements' })
    expect(screen.getByText('1 nouvelle carte disponible')).toBeInTheDocument()

    await user.click(await landed())
    const hidden = screen.getByRole('region', { name: 'Cartes masquées' })
    const row = within(hidden).getByText('Face à l’indice').closest('li') as HTMLElement
    expect(within(row).getByText('Nouveau')).toBeInTheDocument()
    expect(reads.count).toBe(0)

    // Shown in the draft, before « Terminé »: it fills at once.
    await user.click(within(row).getByRole('button', { name: 'Afficher' }))
    await waitFor(() => expect(reads.count).toBe(1))
    expect(await screen.findByRole('region', { name: 'Face à l’indice' })).toBeInTheDocument()
  })

  it.each([
    ['saved hidden', layoutOf([...SEEN])],
    ['never saved', http.get(ROUTES.dashboardLayout, () => HttpResponse.json(null))],
  ])('is not read while hidden, layout %s', async (_, layout) => {
    server.use(layout)
    const reads = countBenchmarkReads()
    renderApp()
    await screen.findByRole('region', { name: 'Mouvements' })

    expect(screen.queryByRole('region', { name: /^Face/ })).not.toBeInTheDocument()
    expect(reads.count).toBe(0)
  })

  it.each([
    ['full', 1024, true],
    ['full', 390, true],
    ['half', 1024, false],
    ['half', 390, false],
  ] as const)('set %s, at %i px, draws the curves: %s', async (width, viewport, curves) => {
    setViewportWidth(viewport)
    server.use(
      layoutOf([...SEEN.slice(0, 4), { id: 'benchmark', width, hidden: false }]),
      http.get(ROUTES.benchmark, () =>
        HttpResponse.json(
          aBenchmark({
            state: 'ready',
            reference: 'CW8.PA',
            index: 'MSCI World',
            covered_from: '2019-03-04',
            covered_to: '2026-09-17',
            gap_gross: 10,
            series: [
              { t: '2019-03-04', portfolio: 100, reference: 100 },
              { t: '2026-09-17', portfolio: 110, reference: 100 },
            ],
          }),
        ),
      ),
    )
    renderApp()
    const region = await screen.findByRole('region', { name: 'Face au MSCI World' })

    expect(Boolean(within(region).queryByText('Même argent investi, jour après jour'))).toBe(curves)
  })
})

describe('at three tracks (#1325)', () => {
  const HALVES = [
    { id: 'gain-breakdown', width: 'half', hidden: false },
    { id: 'rhythm', width: 'half', hidden: false },
    { id: 'allocation', width: 'half', hidden: true },
    { id: 'movers', width: 'half', hidden: true },
    { id: 'benchmark', width: 'half', hidden: true },
  ] as const satisfies DashboardLayout['blocks']

  const cellOf = (title: string) =>
    screen.getByRole('region', { name: title }).closest('[data-dashboard-grid] > *')

  it('draws three tracks from 1 600 px, the movers across the row, in the default order', async () => {
    setViewportWidth(1920)
    const { container } = renderApp()
    await landed()
    await screen.findByRole('region', { name: 'Mouvements' })

    expect(container.querySelector('[data-dashboard-grid]')).toHaveClass('3xl:grid-cols-3')
    expect(order(container)).toEqual(TITLES)
    expect(cellOf('Mouvements')).toHaveClass('md:col-span-full')
    expect(cellOf('Rythme d’investissement')).not.toHaveClass('md:col-span-full')
    expect(screen.queryByText('Place libre')).not.toBeInTheDocument()
  })

  it.each([
    [HALVES, 1],
    [[HALVES[0], { ...HALVES[1], hidden: true }, ...HALVES.slice(2)], 2],
  ])('shows « Place libre » once per free track in edit mode', async (blocks, tracks) => {
    setViewportWidth(1920)
    server.use(layoutOf(blocks as DashboardLayout['blocks']))
    const { user } = renderApp()
    await user.click(await landed())

    expect(screen.getAllByText('Place libre')).toHaveLength(tracks)
  })

  it('leaves free tracks blank in reading mode', async () => {
    setViewportWidth(1920)
    server.use(layoutOf(HALVES))
    const { container } = renderApp()
    await landed()
    await screen.findByRole('region', { name: 'Rythme d’investissement' })

    expect(screen.queryByText('Place libre')).not.toBeInTheDocument()
    expect(container.querySelectorAll('[data-dashboard-grid] > [aria-hidden]')).toHaveLength(1)
  })

  it('offers the drag handles and the width choice', async () => {
    setViewportWidth(1920)
    const { user } = renderApp()
    await user.click(await landed())

    expect(document.querySelectorAll('[data-card-handle]')).toHaveLength(4)
    await openMenu(user, 'Mouvements')
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
  })

  it('moves a card by the rows of three, and a width never follows the viewport', async () => {
    setViewportWidth(1920)
    server.use(
      layoutOf([
        { id: 'movers', width: 'full', hidden: false },
        { id: 'gain-breakdown', width: 'half', hidden: false },
        { id: 'rhythm', width: 'half', hidden: false },
        { id: 'allocation', width: 'half', hidden: false },
        { id: 'benchmark', width: 'half', hidden: true },
      ]),
    )
    const { user, container } = renderApp()
    await user.click(await landed())
    await openMenu(user, 'Mouvements')
    await user.click(screen.getByRole('menuitem', { name: 'Descendre' }))

    // The row of three halves moves up as one, the full card below it.
    expect(order(container)).toEqual([
      'D’où vient le gain',
      'Rythme d’investissement',
      'Répartition',
      'Mouvements',
    ])
  })

  it('writes nothing when the viewport crosses 1 600 px', async () => {
    setViewportWidth(1920)
    const writes = recordWrites()
    renderApp()
    await landed()
    await screen.findByRole('region', { name: 'Mouvements' })

    act(() => setViewportWidth(1200))
    act(() => setViewportWidth(1920))

    expect(writes).toEqual([])
  })
})
