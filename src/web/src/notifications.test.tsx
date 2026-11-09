/**
 * The bell and its popover (#829, « Relevé »), at the one seam: the whole app in
 * jsdom, HTTP the only faked edge.
 *
 * The bell holds the `user` register of the advisories and nothing else: the
 * sentences are the server's, the technical state of the app is Système's. The
 * outage toast, which echoes the bell's colour, is covered at the end.
 */
import { screen, waitFor, within } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import type { UserNotification } from '@/components/Notifications'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import { aFrozenScrape, NOW } from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

/** A late price, unread, observed just now: the notification the mockup opens on. */
function aNotification(overrides: Partial<UserNotification> = {}): UserNotification {
  return {
    key: 'late_price:AMUNDI',
    kind: 'late_price',
    subject: 'AMUNDI',
    register: 'user',
    message: 'The price of Amundi PEA Nasdaq-100 has not moved since 16:25',
    texts: {
      fr: {
        title: 'Le cours d’Amundi PEA Nasdaq-100 n’a pas bougé depuis 16:25',
        sub: 'La valeur affichée peut être légèrement en retard',
      },
      en: {
        title: 'The price of Amundi PEA Nasdaq-100 has not moved since 16:25',
        sub: 'The value shown may be slightly behind',
      },
    },
    detail: {},
    observed_at: NOW,
    acknowledged_until: null,
    ...overrides,
  }
}

/** Noon the day before the app's clock: a day the panel says « hier » whatever the zone. */
function yesterday() {
  const now = new Date(NOW)
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).toISOString()
}

const IMPORT = {
  key: 'import_finished:1',
  kind: 'import_finished',
  subject: '1',
  message: 'Import finished',
  texts: {
    fr: { title: 'Import terminé', sub: '41 événements ajoutés au PEA' },
    en: { title: 'Import finished', sub: '41 events added to the PEA' },
  },
  acknowledged_until: '2026-12-01T12:00:00.000Z',
} satisfies Partial<UserNotification>

/** Which `register` each read of the advisories asked for. */
const asked: URL[] = []

function given(notifications: UserNotification[]) {
  asked.length = 0
  server.use(
    http.get(ROUTES.advisories, ({ request }) => {
      asked.push(new URL(request.url))
      return HttpResponse.json(notifications)
    }),
  )
}

async function openPanel(url = '/') {
  const rendered = renderApp({ url })
  await rendered.user.click(await screen.findByRole('button', { name: /^Notifications/ }))
  await screen.findByRole('dialog', { name: 'Notifications' })
  return rendered
}

function panel() {
  return screen.getByRole('dialog', { name: 'Notifications' })
}

describe('the panel holds what concerns the figures, in the server’s words', () => {
  it('asks for the user register and draws each notification as a row', async () => {
    given([aNotification(), aNotification({ ...IMPORT, observed_at: yesterday() })])
    await openPanel()

    expect(asked.at(-1)?.searchParams.get('register')).toBe('user')
    const rows = within(panel()).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText(/n’a pas bougé depuis 16:25/)).toBeInTheDocument()
    expect(
      within(rows[0]).getByText('La valeur affichée peut être légèrement en retard'),
    ).toBeInTheDocument()
    // Today is a time, yesterday a word.
    expect(within(rows[0]).getByText(/^\d{2}:\d{2}$/)).toBeInTheDocument()
    expect(within(rows[1]).getByText('hier')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Import terminé')).toBeInTheDocument()
  })

  it('marks the one to look at, and sets a read one in muted-foreground', async () => {
    given([aNotification(), aNotification({ ...IMPORT })])
    await openPanel()

    const [late, imported] = within(panel()).getAllByRole('listitem')
    expect(late.querySelector('svg')).not.toBeNull()
    expect(imported.querySelector('svg')).toBeNull()
    expect(within(imported).getByText('Import terminé')).toHaveClass('text-muted-foreground')
    expect(within(late).getByText(/n’a pas bougé/)).not.toHaveClass('text-muted-foreground')
  })

  it('counts only the unread ones in the bell’s name', async () => {
    given([aNotification(), aNotification({ ...IMPORT })])
    renderApp()

    expect(
      await screen.findByRole('button', { name: /^Notifications.*1 notification non lue/ }),
    ).toBeInTheDocument()
  })

  it('holds no card for the technical state of the app', async () => {
    // A frozen scrape turns the bell's colour, which is its one channel; the
    // sentence about it is Système's, and the panel stays empty.
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    given([])
    await openPanel()

    expect(within(panel()).getByText('Rien à signaler')).toBeInTheDocument()
    expect(within(panel()).queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByRole('button', { name: /^Notifications/ })).toHaveAccessibleName(
      /demande votre attention/,
    )
  })

  it('points to Système and Réglages in its footer', async () => {
    given([])
    const { user } = await openPanel()

    expect(panel()).toHaveTextContent('L’état des tâches est dans Système')
    await user.click(within(panel()).getByRole('link', { name: 'Système' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Système' })).toBeVisible()
  })
})

describe('Tout marquer lu', () => {
  it('acknowledges every unread one, on the advisories’ own resource, and re-reads', async () => {
    const done: string[] = []
    given([aNotification(), aNotification({ key: 'update:5.3.0', kind: 'update_installed' })])
    server.use(
      http.post(ROUTES.advisoryAcknowledgement, ({ params }) => {
        done.push(String(params.key))
        return HttpResponse.json({
          ...aNotification({ key: String(params.key) }),
          acknowledged_until: '2026-12-01T12:00:00.000Z',
        })
      }),
    )
    const { user } = await openPanel()
    const reads = asked.length

    await user.click(within(panel()).getByRole('button', { name: 'Tout marquer lu' }))

    await waitFor(() => expect(done).toEqual(['late_price:AMUNDI', 'update:5.3.0']))
    await waitFor(() => expect(asked.length).toBeGreaterThan(reads))
  })

  it('is not offered when everything is read', async () => {
    given([aNotification({ ...IMPORT })])
    await openPanel()

    expect(within(panel()).getByText('Import terminé')).toBeInTheDocument()
    expect(within(panel()).queryByRole('button', { name: 'Tout marquer lu' })).toBeNull()
  })
})

describe('nothing to report is said of the panel, or it is not said', () => {
  it('says it when the panel is truly empty', async () => {
    given([])
    await openPanel()

    expect(within(panel()).getByText('Rien à signaler')).toBeInTheDocument()
  })

  it('never says it while a read is in flight', async () => {
    server.use(http.get(ROUTES.advisories, () => new Promise<never>(() => {})))
    await openPanel()

    expect(within(panel()).queryByText('Rien à signaler')).not.toBeInTheDocument()
    expect(within(panel()).queryByRole('button', { name: 'Tout marquer lu' })).toBeNull()
  })

  it('names a read that failed instead of reporting nothing', async () => {
    server.use(
      problemHandler(ROUTES.advisories, {
        status: 500,
        type: PROBLEM_TYPES.internal,
        title: 'Internal error',
      }),
    )
    await openPanel()

    expect(await within(panel()).findByText('Lecture impossible')).toBeInTheDocument()
    expect(within(panel()).queryByText('Rien à signaler')).not.toBeInTheDocument()
  })
})

describe('a row leads to where its figure is read', () => {
  it('takes an import to the ledger', async () => {
    given([aNotification({ ...IMPORT, acknowledged_until: null })])
    const { user } = await openPanel()

    await user.click(within(panel()).getByRole('link', { name: /Import terminé/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Grand livre' })).toBeVisible()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull())
  })
})

describe('the outage toast echoes the bell (#1180)', () => {
  const TITLE = 'Le serveur ne répond plus'

  function bell() {
    return screen.getByRole('button', { name: /^Notifications/ })
  }

  /** The app with a healthy bell, the timers faked so the next poll can come. */
  async function healthy() {
    const rendered = renderApp({ fakeTimers: true })
    await waitFor(() => expect(bell()).toHaveAccessibleName(/Tout fonctionne/))
    return rendered
  }

  /**
   * The next poll, **landed**: the failure counted and the observers told.
   * Advancing the clock alone returns before msw has answered, which would let
   * an assertion about the toast pass before the poll it is about.
   */
  async function nextPoll(queryClient: QueryClient) {
    const before = queryClient.getQueryState(['health'])?.dataUpdateCount ?? 0
    const failures = queryClient.getQueryState(['health'])?.errorUpdateCount ?? 0
    await vi.advanceTimersByTimeAsync(60_000)
    await waitFor(() => {
      const state = queryClient.getQueryState(['health'])
      expect((state?.dataUpdateCount ?? 0) + (state?.errorUpdateCount ?? 0)).toBeGreaterThan(
        before + failures,
      )
    })
    await vi.advanceTimersByTimeAsync(0)
  }

  const down = () => server.use(http.get(ROUTES.health, () => HttpResponse.error()))

  it('opens once on the outage, however many polls fail', async () => {
    const { queryClient } = await healthy()
    down()
    await nextPoll(queryClient)

    expect(await screen.findByText(TITLE)).toBeInTheDocument()
    expect(
      screen.getByText(/^Chiffres de \d{1,2}:\d{2}, nouvel essai chaque minute$/),
    ).toBeInTheDocument()
    expect(bell()).toHaveAccessibleName(/ne répond pas/)

    await nextPoll(queryClient)
    await nextPoll(queryClient)
    expect(screen.getAllByText(TITLE)).toHaveLength(1)
  })

  it('stays dismissed until the next outage', async () => {
    const { user, queryClient } = await healthy()
    down()
    await nextPoll(queryClient)
    await screen.findByText(TITLE)

    await user.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())
    await nextPoll(queryClient)
    await nextPoll(queryClient)
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
    // The bell has not forgotten.
    expect(bell()).toHaveAccessibleName(/ne répond pas/)
  })

  it('stays dismissed when the API was down from the first visit', async () => {
    // A read that never answered goes back to `pending` on every poll, which
    // clears its error — and used to reopen the toast once a minute. The poll
    // is held open until the bell has shown that `pending`, as a network would.
    let release: (() => void) | null = null
    server.use(
      http.get(ROUTES.health, async () => {
        if (release !== null) await new Promise<void>((resolve) => (release = resolve))
        return HttpResponse.error()
      }),
    )
    const { user, queryClient } = renderApp({ fakeTimers: true })
    await screen.findByText(TITLE)
    await user.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())

    const failures = queryClient.getQueryState(['health'])?.errorUpdateCount ?? 0
    release = () => {}
    await vi.advanceTimersByTimeAsync(60_000)
    await waitFor(() => expect(bell()).toHaveAccessibleName(/inconnu/))
    ;(release as () => void)()
    await waitFor(() =>
      expect(queryClient.getQueryState(['health'])?.errorUpdateCount).toBeGreaterThan(failures),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('closes silently on recovery', async () => {
    const { queryClient } = await healthy()
    down()
    await nextPoll(queryClient)
    await screen.findByText(TITLE)

    server.resetHandlers()
    await nextPoll(queryClient)
    await waitFor(() => expect(screen.queryByText(TITLE)).not.toBeInTheDocument())
    expect(bell()).toHaveAccessibleName(/Tout fonctionne/)
    // No *reconnected* receipt.
    expect(document.querySelector('[data-sonner-toast]')).toBeNull()
  })

  it('says nothing for attention', async () => {
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    renderApp()
    await waitFor(() => expect(bell()).toHaveAccessibleName(/demande votre attention/))
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('opens on a first visit with the API already down, beside the page’s own sentence', async () => {
    server.use(
      http.get(ROUTES.health, () => HttpResponse.error()),
      problemHandler(ROUTES.positions, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'storage unavailable',
      }),
    )
    renderApp()

    expect(await screen.findByText(TITLE)).toBeInTheDocument()
    // No figures were ever read, so there is no instant to name.
    expect(screen.getByText('Nouvel essai chaque minute')).toBeInTheDocument()
    expect(await screen.findByText('Lecture impossible')).toBeInTheDocument()
  })
})
