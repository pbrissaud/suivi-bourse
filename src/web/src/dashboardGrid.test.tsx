/**
 * The dashboard's grid and its edit mode (design doc of 11/10/2026, its eng
 * and design reviews, and Paul's notes on the interactive mock-up).
 *
 * Driven through the real app with the one faked edge, HTTP: the layout the
 * server answers, and the writes it receives, are what each case states.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ROUTES, type DashboardLayout } from '@/lib/api'
import { aMover, aMoversPayload } from '@/test/factories'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const TITLES = ['D’où vient le gain', 'Rythme d’investissement', 'Mouvements']

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

describe('reading mode', () => {
  it('draws the default layout: the gain and the rhythm, then the movers', async () => {
    const { container } = renderApp()
    await landed()
    await screen.findByRole('region', { name: 'Mouvements' })

    expect(order(container)).toEqual(TITLES)
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
})

describe('edit mode', () => {
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
    expect(within(hidden).getByText('Rythme d’investissement')).toBeInTheDocument()
    expect(await screen.findByText('Rythme d’investissement masquée')).toBeInTheDocument()
    // The gain is alone on its row now and half-only: the other half is free.
    expect(screen.getByText('Place libre')).toBeInTheDocument()

    await user.click(within(hidden).getByRole('button', { name: 'Afficher' }))
    expect(order(container)).toEqual(TITLES)
    expect(within(hidden).getByText('Aucune carte masquée.')).toBeInTheDocument()
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
        ],
      },
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Modifier le tableau de bord' })).toHaveFocus(),
    )
  })

  it('writes nothing when nothing changed', async () => {
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
    expect(order(container)).toEqual(TITLES)
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
    expect(order(container)).toEqual(TITLES)
  })

  it('says a drop in place, and leaves nothing to write', async () => {
    const writes = recordWrites()
    const { user, container } = renderApp()
    await user.click(await landed())
    await dragWithKeys(user, 'Mouvements', '  ')

    expect(await screen.findByText('Mouvements déposée, position 3 sur 3')).toBeInTheDocument()
    expect(order(container)).toEqual(TITLES)
    await user.click(screen.getByRole('button', { name: 'Terminé' }))
    await landed()
    expect(writes).toEqual([])
  })

  it('puts everything back on Escape', async () => {
    const { user, container } = renderApp()
    await user.click(await landed())
    await dragWithKeys(user, 'Mouvements', ' {ArrowUp}{Escape}')

    expect(await screen.findByText('Déplacement annulé')).toBeInTheDocument()
    expect(order(container)).toEqual(TITLES)
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
