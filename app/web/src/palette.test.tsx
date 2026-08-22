/**
 * The ⌘K palette (#797, ADR-0026), at the one seam: the whole app in jsdom,
 * HTTP the only faked edge.
 *
 * Four of the six cases below are the ticket's own criteria and they are not
 * assertions about a component: *the two ways in are one surface*, *the palette
 * opens while its three reads hang*, *no page mounts a read for it*, and *an
 * event result lands on a ledger that says what it retains*. The last of those
 * is the one that could not be attested anywhere else — the reduction crosses a
 * route, so it is a property of the address and not of a prop.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { beforeAll, describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { aLedgerPayload, anAdvisory, ledgerEvents } from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

/** What has crossed the wire since the last reset — the reads, by pathname. */
const asked: string[] = []

beforeAll(() => {
  server.events.on('request:start', ({ request }) => {
    asked.push(new URL(request.url).pathname)
  })
})

function render(url = '/') {
  asked.length = 0
  return renderApp({ url })
}

/** The field is the palette: it is what both ways in have to produce. */
function field() {
  return screen.getByRole('searchbox', { name: 'Rechercher dans votre portefeuille' })
}

async function open(user: ReturnType<typeof renderApp>['user']) {
  // The router resolves its first match asynchronously, so the bar the button
  // lives in is one tick away from the mount.
  await user.click(await screen.findByRole('button', { name: /^Rechercher/ }))
  return field()
}

function section(name: string) {
  return screen.queryByRole('list', { name })
}

describe('the two ways into the palette', () => {
  it('is one surface, opened by ⌘K and by the button alike', async () => {
    const { user } = render()

    // The visible half, which is the whole reason the button exists: a shortcut
    // is not an interface on a phone.
    await open(user)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await user.keyboard('{Meta>}k{/Meta}')
    expect(field()).toBeInTheDocument()
    // And `Ctrl` answers too, one desktop over.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.keyboard('{Control>}k{/Control}')
    expect(field()).toBeInTheDocument()
  })
})

describe('what the palette costs a page that never opens it', () => {
  it('reads nothing at all on the mount, and its three resources on the opening', async () => {
    const { user } = render()
    await screen.findByRole('heading', { level: 1, name: 'Tableau de bord' })
    await waitFor(() => expect(asked).toContain(ROUTES.portfolioTotals))

    // The dashboard has never had a reason to read the ledger, and the palette
    // does not give it one: `enabled` is what makes this true, and it is the
    // difference between a surface most sessions never open costing nothing and
    // costing one read per page.
    expect(asked).not.toContain(ROUTES.events)

    await open(user)
    await waitFor(() => expect(asked).toContain(ROUTES.events))
    expect(asked).toContain(ROUTES.accounts)
  })
})

describe('the three sections that read', () => {
  it('opens without them, and each one absent removes a section', async () => {
    // All three left hanging: the palette is whole without any of them.
    server.use(
      http.get(ROUTES.positions, () => new Promise<never>(() => {})),
      http.get(ROUTES.accounts, () => new Promise<never>(() => {})),
      http.get(ROUTES.events, () => new Promise<never>(() => {})),
    )
    const { user } = render()
    await open(user)

    // The pages and the actions are there at once — they read nothing.
    expect(within(section('Pages') as HTMLElement).getAllByRole('listitem')).toHaveLength(4)
    expect(section('Actions')).not.toBeNull()
    // And the three that read are **gone**, not empty, and not holding the rest.
    expect(section('Titres détenus')).toBeNull()
    expect(section('Comptes')).toBeNull()
    expect(section('Événements')).toBeNull()

    // Nor is anything claimed about a portfolio nobody has read: the sentence
    // about nothing matching is a claim, so it waits like any other.
    await user.type(field(), 'zeta')
    expect(screen.queryByText(/Aucun résultat/)).toBeNull()
  })

  it('draws each section as its own read lands', async () => {
    const { user } = render()
    await open(user)

    await waitFor(() => expect(section('Titres détenus')).not.toBeNull())
    expect(section('Comptes')).not.toBeNull()
    // The events say nothing at all until something is typed: a section of the
    // five newest rows of a ledger nobody asked about is a table in a palette.
    expect(section('Événements')).toBeNull()

    await user.type(field(), 'virement')
    await waitFor(() => expect(section('Événements')).not.toBeNull())
  })
})

describe('where an entry leads', () => {
  it('reaches a held title on its own sheet', async () => {
    const { user } = render()
    await open(user)
    await user.type(field(), 'zeta alpha')
    await user.click(await screen.findByRole('button', { name: /Zeta Alpha/ }))

    // The sheet is a URL since this ticket, which is what lets anything outside
    // the shares page lead to it.
    expect(await screen.findByRole('dialog', { name: /Zeta Alpha/ })).toBeInTheDocument()
  })

  it('reaches an account on its own detail', async () => {
    const { user } = render()
    await open(user)
    await user.type(field(), 'beta')
    await user.click(await screen.findByRole('button', { name: /^Beta/ }))

    await screen.findByRole('heading', { level: 1, name: 'Comptes' })
    await waitFor(() => expect(screen.getAllByText('Beta').length).toBeGreaterThan(0))
  })

  it('makes the gesture its action is named after', async () => {
    const { user } = render()
    await open(user)
    await user.type(field(), 'saisir')
    await user.click(await screen.findByRole('button', { name: 'Saisir un événement' }))

    // Not the data page with the form shut, which would be a page entry wearing
    // an action's name.
    expect(await screen.findByRole('radiogroup', { name: 'Ce qui s’est passé' })).toBeInTheDocument()
  })
})

describe('the ledger an event result lands on', () => {
  it('is reduced, says what it retains, and offers the way out', async () => {
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))))
    const { user } = render()
    await open(user)
    await user.type(field(), 'virement')
    await user.click(await screen.findByRole('button', { name: /Virement entrant/ }))

    await screen.findByRole('heading', { level: 1, name: 'Données' })
    const table = await screen.findByRole('table', { name: 'Vos événements' })
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2))

    // **It names itself**, in the terms of what it retains — a type, a word and
    // an account — and never in terms of the one row it was asked about: a
    // ledger row has no address (ADR-0020).
    expect(
      screen.getByText(
        /Réduit aux événements de type Versement portant « Virement entrant depuis le compte courant », sur le compte alpha\./,
      ),
    ).toBeInTheDocument()

    // And it offers the way out, which restores the ledger entire.
    await user.click(screen.getByRole('button', { name: 'Afficher tout le grand livre' }))
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(5))
    expect(screen.queryByText(/Réduit aux événements/)).toBeNull()
  })

  it('says nothing matched only once every read has landed', async () => {
    const { user } = render()
    await open(user)
    await user.type(field(), 'introuvable')

    expect(await screen.findByText(/Aucun résultat pour « introuvable »/)).toBeInTheDocument()
  })
})

describe('a gesture the palette armed is spent once', () => {
  it('does not reopen the form on the way back from another tab', async () => {
    // Radix unmounts the inactive tab, so an arming still held in a prop is an
    // arming made again on every remount — a form the reader closed, open again
    // for having read the notices.
    const { user } = render()
    await open(user)
    await user.type(field(), 'saisir')
    await user.click(await screen.findByRole('button', { name: 'Saisir un événement' }))
    await screen.findByRole('radiogroup', { name: 'Ce qui s’est passé' })

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('radiogroup', { name: 'Ce qui s’est passé' })).toBeNull(),
    )

    await user.click(await screen.findByRole('tab', { name: /L’installation/ }))
    await user.click(await screen.findByRole('tab', { name: /Le grand livre/ }))
    await screen.findByRole('table', { name: 'Vos événements' })
    expect(screen.queryByRole('radiogroup', { name: 'Ce qui s’est passé' })).toBeNull()
  })

  it('does not bring back a reduction the reader has lifted', async () => {
    server.use(http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))))
    const { user } = render()
    await open(user)
    await user.type(field(), 'virement')
    await user.click(await screen.findByRole('button', { name: /Virement entrant/ }))

    const table = await screen.findByRole('table', { name: 'Vos événements' })
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: 'Afficher tout le grand livre' }))
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(5))

    // The address went with it, so the tab it is not on cannot restore it: a
    // sentence naming a reduction over a table nobody reduced is two truths.
    await user.click(await screen.findByRole('tab', { name: /L’installation/ }))
    await user.click(await screen.findByRole('tab', { name: /Le grand livre/ }))
    const back = await screen.findByRole('table', { name: 'Vos événements' })
    await waitFor(() => expect(within(back).getAllByRole('row')).toHaveLength(5))
    expect(screen.queryByText(/Réduit aux événements/)).toBeNull()
  })

  it('leaves no address behind when a notice reduces the ledger its own way', async () => {
    server.use(
      http.get(ROUTES.events, () => HttpResponse.json(aLedgerPayload(ledgerEvents()))),
      http.get(ROUTES.advisories, () => HttpResponse.json([anAdvisory()])),
    )
    const view = render()
    const { user } = view
    await open(user)
    await user.type(field(), 'virement')
    await user.click(await screen.findByRole('button', { name: /Virement entrant/ }))
    await screen.findByRole('table', { name: 'Vos événements' })

    await user.click(await screen.findByRole('tab', { name: /Les avis/ }))
    await user.click(await screen.findByRole('button', { name: 'Voir les événements concernés' }))
    await screen.findByText(/Réduit à 3 titres/)

    // Two reductions cannot both be the table's: the one that arrived by the
    // address left with it, or the link handed to somebody else opens a ledger
    // reduced another way than the one on screen.
    expect(view.router.state.location.search).toEqual({})
    expect(screen.queryByText(/Réduit aux événements de type/)).toBeNull()
  })
})

describe('what the palette does with a keystroke and with a failure', () => {
  it('does nothing on Enter over an untouched field', async () => {
    const view = render()
    await open(view.user)
    await waitFor(() => expect(section('Titres détenus')).not.toBeNull())

    // An empty query matches everything, so the first title the owner holds is
    // one reflex away from being navigated to. The palette stays where it is,
    // and so does the reader — asserted on the address, the dialog having taken
    // the page under it out of the accessibility tree.
    await view.user.keyboard('{Enter}')
    expect(field()).toBeInTheDocument()
    expect(view.router.state.location.pathname).toBe('/')
  })

  it('says why a section is missing when its read came back an error', async () => {
    server.use(
      problemHandler(ROUTES.events, {
        status: 500,
        type: PROBLEM_TYPES.internal,
        title: 'Internal error',
      }),
    )
    const { user } = render()
    await open(user)
    await user.type(field(), 'introuvable')

    // Neither in flight nor empty: without this the reader gets a field over a
    // blank body, which reads as a broken palette rather than a failed read.
    expect(await screen.findByText(/erreur qu’elle n’attendait pas/)).toBeInTheDocument()
    // And nothing is claimed about a portfolio one read of which never landed.
    expect(screen.queryByText(/Aucun résultat/)).toBeNull()
  })
})
