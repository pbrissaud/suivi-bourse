/**
 * What the notifications panel holds, and in what order (#829, ADR-0037).
 *
 * Under the page seam, and it is not a second seam: payloads in, entries out.
 * What is pinned here is the arrangement — the **two axes**, the ordering, and
 * the three counts the panel's own controls are made of — because all of those
 * are one question asked in several places, and a component answering it per
 * render is how a badge and the list under it end up disagreeing.
 */
import { describe, expect, it } from 'vitest'

import type { Advisory, InstallationFact } from '@/lib/api'
import {
  SUBJECTS,
  acknowledgeable,
  grouped,
  notifications,
  openCount,
  selfEnding,
} from '@/lib/notifications'

const list = (items: readonly string[]) => items.join(', ')

function fact(overrides: Partial<InstallationFact> = {}): InstallationFact {
  return {
    key: 'unread_environment',
    first_seen_at: '2026-03-01T09:00:00.000Z',
    acknowledged: false,
    acknowledged_at: null,
    message: 'Environment variables are set and read by nothing.',
    detail: { variables: ['SB_EXECUTOR_POOL'] },
    ...overrides,
  }
}

function advisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    key: 'cash_share:alpha',
    kind: 'cash_share',
    subject: 'accounts',
    message: 'Alpha holds 24.8% of its value in uninvested cash.',
    detail: { account: 'alpha', label: 'Alpha', share: 0.248 },
    observed_at: '2026-03-02T11:00:00.000Z',
    ...overrides,
  }
}

/** A settled installation with nothing to say, which is the ordinary case. */
const QUIET = {
  health: 'ok' as const,
  facts: [] as InstallationFact[],
  advisories: [] as Advisory[],
  currencyUnanswered: false,
  list,
}

describe('the two axes, and only one of them is a word on screen', () => {
  it('gives every entry a register and a subject', () => {
    const entries = notifications({
      ...QUIET,
      health: 'attention',
      facts: [fact()],
      advisories: [advisory()],
      currencyUnanswered: true,
    })

    // The **register** decides what a card offers and is never named to the
    // reader; the **subject** is the group heading and the destination.
    expect(entries.map((entry) => [entry.register, entry.subject])).toEqual([
      ['health', 'health'],
      ['fact', 'installation'],
      ['fact', 'installation'],
      ['advisory', 'accounts'],
    ])
  })

  it('offers a link and no acknowledgement on health, which is repaired', () => {
    const [entry] = notifications({ ...QUIET, health: 'unreachable' })

    expect(entry.acknowledge).toBeNull()
    expect(entry.link?.to).toEqual({ to: '/settings' })
  })

  it('acknowledges an installation fact for good and an advisory for a window', () => {
    const entries = notifications({ ...QUIET, facts: [fact()], advisories: [advisory()] })

    expect(entries.map((entry) => entry.acknowledge)).toEqual([
      { register: 'fact', key: 'unread_environment' },
      { register: 'advisory', key: 'cash_share:alpha' },
    ])
  })

  it('never offers one on the currency, because *seen* is not an answer to it', () => {
    // Acknowledging *I have no currency* means nothing, which is why this was
    // never one of the acknowledgement table's keys (ADR-0021).
    const [entry] = notifications({ ...QUIET, currencyUnanswered: true })

    expect(entry.acknowledge).toBeNull()
    expect(entry.link?.to).toEqual({ to: '/settings' })
  })
})

describe('one fact has one announcer', () => {
  it('leaves the reconstruction to its installation fact, not to the colour', () => {
    // `rebuilding` is a state of the bell's icon **and** the subject of the
    // `reconstruction_running` fact. Raising a health card for it too would put
    // two cards on one reconstruction — the defect the banner-and-badge rule
    // existed against.
    const entries = notifications({
      ...QUIET,
      health: 'rebuilding',
      facts: [fact({ key: 'reconstruction_running' })],
    })

    expect(entries.map((entry) => entry.register)).toEqual(['fact'])
  })

  it('says nothing at all about an installation that is fine, or unread', () => {
    expect(notifications(QUIET)).toEqual([])
    expect(notifications({ ...QUIET, health: null })).toEqual([])
    // A read in flight is not an absence: `undefined` is *nothing has been
    // observed about the currency*, and it raises no card.
    expect(notifications({ ...QUIET, currencyUnanswered: undefined })).toEqual([])
  })

  it('drops an acknowledged fact rather than greying it out', () => {
    expect(notifications({ ...QUIET, facts: [fact({ acknowledged: true })] })).toEqual([])
  })
})

describe('the panel groups by subject, and pins inside a group', () => {
  it('reads the four headings down in one declared order, empty ones dropped', () => {
    expect(SUBJECTS).toEqual(['health', 'installation', 'portfolio', 'accounts'])

    const groups = grouped(
      notifications({
        ...QUIET,
        health: 'attention',
        facts: [fact()],
        advisories: [advisory()],
      }),
    )

    expect(groups.map((group) => group.subject)).toEqual(['health', 'installation', 'accounts'])
  })

  it('heads a group with what says the figures are still moving', () => {
    // The band's three conditions are entries now, and they are pinned for the
    // reason they were a band: they say what is on screen is not what it will
    // be. Pinned **inside** the group, never at the top of the panel — a pinned
    // card in the Accounts group would be a fourth ordering nobody predicts.
    const [installation] = grouped(
      notifications({
        ...QUIET,
        facts: [fact(), fact({ key: 'reconstruction_running' })],
      }),
    )

    expect(installation.entries.map((entry) => entry.id)).toEqual([
      'reconstruction_running',
      'unread_environment',
    ])
  })

  it('keeps the server’s declared order among entries of one rank', () => {
    // A panel whose contents reshuffle between two reads is a panel nobody
    // trusts, so nothing is sorted by date.
    const [installation] = grouped(
      notifications({
        ...QUIET,
        facts: [
          fact({ key: 'assumed_base_currency', first_seen_at: '2026-03-02T00:00:00.000Z' }),
          fact({ key: 'unread_environment', first_seen_at: '2026-01-01T00:00:00.000Z' }),
        ],
      }),
    )

    expect(installation.entries.map((entry) => entry.id)).toEqual([
      'assumed_base_currency',
      'unread_environment',
    ])
  })

  it('groups a family it does not know under the portfolio rather than dropping it', () => {
    // The subject is the **server's** answer, and an entry counted by the badge
    // that renders nowhere is the one outcome a panel cannot afford.
    const [entry] = notifications({
      ...QUIET,
      advisories: [advisory({ kind: 'from_the_future', subject: 'martian' })],
    })

    expect(entry.subject).toBe('portfolio')
    expect(entry.acknowledge).not.toBeNull()
  })
})

describe('the badge counts every open entry, and the control says what it clears', () => {
  it('counts the ones that never decrement too, with the objection in view', () => {
    // ADR-0037 accepts it rather than going round it: a badge that counted
    // *some* of what the panel holds would lie to a reader who opens it
    // expecting three things and finds five.
    const entries = notifications({
      ...QUIET,
      health: 'attention',
      facts: [fact()],
      currencyUnanswered: true,
      advisories: [advisory()],
    })

    expect(openCount(entries)).toBe(4)
    // Two of the four end by themselves: health is repaired, and the currency
    // is answered.
    expect(acknowledgeable(entries).map((entry) => entry.id)).toEqual([
      'unread_environment',
      'cash_share:alpha',
    ])
    expect(selfEnding(entries)).toBe(2)
  })

  it('has nothing to clear on a panel of conditions alone', () => {
    const entries = notifications({ ...QUIET, health: 'attention', currencyUnanswered: true })

    expect(acknowledgeable(entries)).toEqual([])
    // The count the disabled control states its reason with.
    expect(selfEnding(entries)).toBe(2)
  })
})

describe('a card’s link lands on the figure, never on the page', () => {
  it('opens the account selected', () => {
    const [entry] = notifications({ ...QUIET, advisories: [advisory()] })

    expect(entry.link?.to).toEqual({ to: '/accounts', search: { account: 'alpha' } })
  })

  it('opens the ledger reduced to every security the fact names', () => {
    // **The whole set, never the first of it**: the sentence above the button
    // enumerates all of them, so a reduction naming one would state a repair
    // perimeter smaller than the card just announced.
    const [entry] = notifications({
      ...QUIET,
      facts: [
        fact({
          key: 'assumed_base_currency',
          detail: { symbols: ['ZZA', 'ZZB', 'ZZC'], events: [1, 2] },
        }),
      ],
    })

    expect(entry.link?.to).toEqual({
      to: '/ledger',
      search: { symbol: ['ZZA', 'ZZB', 'ZZC'] },
    })
  })

  it('offers none where the app has no power to offer', () => {
    // A variable set in the container is outside the app's reach, and its own
    // sentence already says what to do out there.
    const [entry] = notifications({ ...QUIET, facts: [fact({ key: 'unread_environment' })] })

    expect(entry.link).toBeNull()
  })
})
