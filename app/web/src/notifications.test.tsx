/**
 * The notifications panel (#829, ADR-0036, ADR-0037), at the one seam: the
 * whole app in jsdom, HTTP the only faked edge.
 *
 * It replaces `notices.test.tsx` rather than extending it, because the surface
 * it covered no longer exists: the notices tab is gone, the banner is gone, the
 * status dot is gone, and what carries all three is one control in the content
 * header. What is **kept** from that file is the rule the tab was the last
 * exception to — *a block with nothing in it does not exist* — and ADR-0026's
 * clause beside it: nothing is claimed while a read is in flight, which is what
 * makes *Rien à signaler* a statement about the panel rather than about a
 * silence.
 *
 * The three registers are exercised together on purpose. They are one panel,
 * their difference is what each card **offers**, and the register itself is
 * never a word on screen — so the only way to assert it is on the gestures.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import { ROUTES, type Advisory, type InstallationFact } from '@/lib/api'
import { FIRST_RUN_STORAGE_KEY } from '@/lib/firstRun'
import { PROBLEM_TYPES } from '@/lib/problem'
import {
  aConfig,
  aFrozenScrape,
  anAdvisory,
  anEnvironmentFact,
  anInstallationFact,
} from '@/test/factories'
import { renderApp } from '@/test/render'
import { problemHandler, server } from '@/test/server'

/** The one predicate of the first run: the reporting currency unanswered. */
function noCurrency() {
  const config = aConfig()
  return {
    ...config,
    settings: config.settings.map((setting) =>
      setting.key === 'base_currency' ? { ...setting, value: null, stored: false } : setting,
    ),
  }
}

interface Given {
  facts?: InstallationFact[]
  advisories?: Advisory[]
  url?: string
}

/** Open the panel on a stated installation. */
async function openPanel({ facts, advisories, url = '/' }: Given = {}) {
  if (facts) server.use(http.get(ROUTES.installationFacts, () => HttpResponse.json(facts)))
  if (advisories) server.use(http.get(ROUTES.advisories, () => HttpResponse.json(advisories)))
  const rendered = renderApp({ url })
  await rendered.user.click(await screen.findByRole('button', { name: /^Notifications/ }))
  await screen.findByRole('dialog', { name: 'Notifications' })
  return rendered
}

function panel() {
  return screen.getByRole('dialog', { name: 'Notifications' })
}

/** The card a title sits on, which is the unit a gesture belongs to. */
function card(title: string | RegExp) {
  return within(panel()).getByText(title).parentElement as HTMLElement
}

describe('the panel holds three registers under four subjects', () => {
  it('marks each card with its subject, and names no register anywhere', async () => {
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    await openPanel({ facts: [anEnvironmentFact()], advisories: [anAdvisory()] })

    // The reader sees **subjects** and infers the rest from what each card lets
    // them do (ADR-0037). Since #838 the subject is a mark *on the card* rather
    // than a heading over a group of one: the drawer is one list, and three
    // headings of one line each are a table of contents for three lines. The
    // order the subjects come in is unchanged — it is `lib/notifications.ts`'s.
    const subjects = within(panel())
      .getAllByRole('listitem')
      .map((entry) => entry.firstElementChild?.firstElementChild?.textContent)
    expect(subjects).toEqual(['Santé', 'Installation', 'Comptes'])
    expect(panel().textContent).not.toMatch(/avis|registre|installation fact/i)
  })

  it('offers a link and no acknowledgement on health, which is repaired', async () => {
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    await openPanel({ facts: [] })

    const health = card('Quelque chose s’est arrêté')
    expect(within(health).getByRole('link', { name: 'Voir dans Réglages' })).toBeInTheDocument()
    expect(within(health).queryByRole('button', { name: /Acquitter/ })).not.toBeInTheDocument()
  })

  it('says on the card that an advisory is put to sleep, never ended', async () => {
    await openPanel({ facts: [], advisories: [anAdvisory()] })

    const advisory = card(/de liquidités non investies/)
    // *Acknowledge 30 days*, and the card says why it is not *acknowledge*: the
    // window is what answers ADR-0036's objection, and a reader who is not told
    // about it has been sold a permanent silence.
    expect(
      within(advisory).getByRole('button', { name: 'Acquitter 30 jours' }),
    ).toBeInTheDocument()
    expect(panel().textContent).toContain('Réapparaîtra si la situation dure.')
  })

  it('acknowledges an installation fact for good, on its own resource', async () => {
    const asked: string[] = []
    server.use(
      http.post(ROUTES.installationFactAcknowledgement, ({ params }) => {
        asked.push(`fact:${params.key}`)
        return HttpResponse.json(anInstallationFact({ acknowledged: true }))
      }),
    )
    const { user } = await openPanel({ facts: [anEnvironmentFact()] })

    await user.click(within(panel()).getByRole('button', { name: 'Acquitter' }))

    await waitFor(() => expect(asked).toEqual(['fact:unread_environment']))
  })

  it('acknowledges an advisory on the other one, which is the whole difference', async () => {
    const asked: string[] = []
    server.use(
      http.post(ROUTES.advisoryAcknowledgement, ({ params }) => {
        asked.push(`advisory:${params.key}`)
        return HttpResponse.json({
          ...anAdvisory(),
          acknowledged_until: '2026-04-01T12:00:00.000Z',
        })
      }),
    )
    const { user } = await openPanel({ facts: [], advisories: [anAdvisory()] })

    await user.click(within(panel()).getByRole('button', { name: 'Acquitter 30 jours' }))

    await waitFor(() => expect(asked).toEqual(['advisory:cash_share:alpha']))
  })
})

describe('the control that clears says what it clears', () => {
  it('names its scope rather than promising a clean slate', async () => {
    // The badge cannot reach zero — three of the four sources never decrement
    // on their own — so *Acknowledge all* would be a promise the panel cannot
    // keep. This is the exchange ADR-0037 accepts the stuck counter for.
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    await openPanel({
      facts: [anEnvironmentFact(), anInstallationFact()],
      advisories: [anAdvisory()],
    })

    expect(
      within(panel()).getByRole('button', { name: 'Tout acquitter (3)' }),
    ).toBeEnabled()
  })

  it('is disabled **with its reason in prose** when there is nothing in it', async () => {
    // Two entries that end by themselves and nothing else: a stopped job, and
    // a question nobody has answered. The walk has been through in this
    // browser, or its modal would sit over the control being asked about.
    window.localStorage.setItem(FIRST_RUN_STORAGE_KEY, 'dismissed')
    server.use(
      http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())),
      http.get(ROUTES.config, () => HttpResponse.json(noCurrency())),
    )
    await openPanel({ facts: [], advisories: [] })

    expect(within(panel()).getByRole('button', { name: /acquitter/i })).toBeDisabled()
    // Greyed out with nothing to explain itself is the form the account
    // refusals already refuse: the reason is said, in words.
    expect(panel().textContent).toContain(
      'Rien à acquitter : ces 2 constats se terminent d’eux-mêmes.',
    )
  })

  it('clears every acknowledgeable one in a single gesture', async () => {
    const asked: string[] = []
    server.use(
      http.post(ROUTES.installationFactAcknowledgement, ({ params }) => {
        asked.push(String(params.key))
        return HttpResponse.json(anInstallationFact({ acknowledged: true }))
      }),
      http.post(ROUTES.advisoryAcknowledgement, ({ params }) => {
        asked.push(String(params.key))
        return HttpResponse.json({
          ...anAdvisory(),
          acknowledged_until: '2026-04-01T12:00:00.000Z',
        })
      }),
    )
    const { user } = await openPanel({
      facts: [anEnvironmentFact()],
      advisories: [anAdvisory()],
    })

    await user.click(within(panel()).getByRole('button', { name: /Tout acquitter \(2\)/ }))

    await waitFor(() => expect(asked).toEqual(['unread_environment', 'cash_share:alpha']))
  })
})

describe('nothing to report is said of the panel, or it is not said', () => {
  it('says it when the panel is truly empty', async () => {
    await openPanel({ facts: [], advisories: [] })

    expect(await within(panel()).findByText('Rien à signaler')).toBeInTheDocument()
    // And the badge is not drawn at all: a badge at zero is an ornament that
    // promises something to find.
    expect(screen.getByRole('button', { name: /^Notifications/ })).toHaveAccessibleName(
      /0 entrée ouverte/,
    )
  })

  it('never says it under a pinned card', async () => {
    // A pinned red health card and this sentence cannot be on screen together
    // (ADR-0037): the sentence is true of the panel or it is not said.
    server.use(http.get(ROUTES.health, () => HttpResponse.json(aFrozenScrape())))
    await openPanel({ facts: [], advisories: [] })

    await within(panel()).findByText('Quelque chose s’est arrêté')
    expect(within(panel()).queryByText('Rien à signaler')).not.toBeInTheDocument()
  })

  it('never says it while a read is in flight', async () => {
    // ADR-0026, and the member the net cannot see: *Rien à signaler* is a claim
    // about the reader's installation, and one read hanging is not an answer.
    server.use(http.get(ROUTES.advisories, () => new Promise<never>(() => {})))
    await openPanel({ facts: [] })

    await waitFor(() => expect(panel()).toBeInTheDocument())
    expect(within(panel()).queryByText('Rien à signaler')).not.toBeInTheDocument()
    expect(within(panel()).queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
  })

  it('names a read that failed instead of reporting nothing', async () => {
    server.use(
      problemHandler(ROUTES.advisories, {
        status: 503,
        type: PROBLEM_TYPES.storageUnavailable,
        title: 'Storage unavailable',
      }),
    )
    await openPanel({ facts: [] })

    expect(
      await within(panel()).findByText(/Vos données sont illisibles pour l’instant/),
    ).toBeInTheDocument()
    expect(within(panel()).queryByText('Rien à signaler')).not.toBeInTheDocument()
  })
})

describe('a card’s link lands on the figure, not on the page', () => {
  it('opens the accounts page with that account selected', async () => {
    const view = await openPanel({ facts: [], advisories: [anAdvisory()] })
    const { user } = view

    await user.click(within(panel()).getByRole('link', { name: 'Voir le compte' }))

    // Not merely `/accounts`: the account the card names, **selected** — which
    // the rail says with `aria-current` and the address says with `?account=`.
    await screen.findByRole('heading', { level: 1, name: 'Comptes' })
    await waitFor(() => expect(view.router.state.location.search).toEqual({ account: 'alpha' }))
    const rail = await screen.findByRole('list', { name: 'Vos comptes' })
    // `aria-current` is what says *this one is open* to a screen reader, and
    // the router writes `page` on the entry whose address is the one in force.
    await waitFor(() =>
      expect(within(rail).getByRole('link', { name: /Alpha/ })).toHaveAttribute('aria-current'),
    )
    expect(within(rail).getByRole('link', { name: /Beta/ })).not.toHaveAttribute('aria-current')
  })
})

describe('the advisory is read twice, and acknowledged in one place', () => {
  it('draws a chip beside the account and offers no gesture on it', async () => {
    // The chip is the **reading**, the panel is the **inventory** (ADR-0037):
    // one fact cannot propose two different gestures depending on where it is
    // met, so the acknowledgement belongs to the panel and to the panel alone.
    server.use(http.get(ROUTES.advisories, () => HttpResponse.json([anAdvisory()])))
    renderApp({ url: '/accounts' })

    const chip = await screen.findByText('25 % de cash')
    const railEntry = chip.closest('a') as HTMLElement
    expect(railEntry).toHaveTextContent('Alpha')
    expect(within(railEntry).queryByRole('button', { name: /Acquitter/ })).not.toBeInTheDocument()
  })

  it('draws none while the read has not landed', async () => {
    server.use(http.get(ROUTES.advisories, () => new Promise<never>(() => {})))
    renderApp({ url: '/accounts' })

    await screen.findByRole('heading', { level: 1, name: 'Comptes' })
    expect(screen.queryByText(/% de cash/)).not.toBeInTheDocument()
  })

  it('keeps the chip when the panel’s card is acknowledged, the condition standing', async () => {
    // **The two surfaces ask two questions of the same instant.** *Acknowledge
    // for thirty days* is *not now*, said to the inventory; the cash is still
    // sitting in that account while the card sleeps, so the reading beside the
    // figure goes on saying so. Read through the inventory the chip left with
    // the card, and ADR-0037's *the chip is the reading, the panel is the
    // inventory* had no effect anybody could observe.
    //
    // The server tells the two apart with `?asleep=include`, so the net does
    // too: `listing` on the panel's read, `standing` on the rail's.
    let asleep = false
    server.use(
      http.get(ROUTES.advisories, ({ request }) => {
        const standing = new URL(request.url).searchParams.get('asleep') === 'include'
        return HttpResponse.json(standing || !asleep ? [anAdvisory()] : [])
      }),
      http.post(ROUTES.advisoryAcknowledgement, ({ params }) => {
        asleep = true
        return HttpResponse.json({
          ...anAdvisory({ key: String(params.key) }),
          acknowledged_until: '2026-04-01T12:00:00.000Z',
        })
      }),
    )
    const { user } = renderApp({ url: '/accounts' })

    expect(await screen.findByText('25 % de cash')).toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: /^Notifications/ }))
    const panel = await screen.findByRole('dialog', { name: 'Notifications' })
    await user.click(within(panel).getByRole('button', { name: 'Acquitter 30 jours' }))

    // The card goes — that is the whole of what the gesture was for…
    await waitFor(() =>
      expect(within(panel).queryByText(/de liquidités non investies/)).not.toBeInTheDocument(),
    )
    // …and the reading stays, because the condition does.
    expect(screen.getByText('25 % de cash')).toBeInTheDocument()
  })
})
