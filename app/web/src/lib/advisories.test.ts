/**
 * The three questions the *Notices* block answers, asked once (#724, ADR-0021).
 *
 * Under the page seam, and it is not a second seam: entries in, verdicts out.
 * What is pinned here is the exclusion list, because each of its three members
 * looks countable and is not.
 */
import { describe, expect, it } from 'vitest'

import { advisoryGesture, shownAdvisories, unacknowledgedCount } from '@/lib/advisories'
import type { Advisory } from '@/lib/api'

function advisory(overrides: Partial<Advisory> = {}): Advisory {
  return {
    key: 'legacy_config_file',
    first_seen_at: '2026-03-01T09:00:00.000Z',
    acknowledged: false,
    acknowledged_at: null,
    message: 'A file the app names and does not read.',
    detail: null,
    ...overrides,
  }
}

describe('what the block shows', () => {
  it('drops an acknowledged notice rather than greying it out', () => {
    const shown = shownAdvisories([
      advisory(),
      advisory({ key: 'legacy_settings_file', acknowledged: true }),
    ])

    // Greyed out, the notice of somebody who decided to keep their v4 file for
    // ever would be a permanent fixture of their screen.
    expect(shown.map((entry) => entry.key)).toEqual(['legacy_config_file'])
  })

  it('leaves the reconstruction to the banner, its one announcer', () => {
    const shown = shownAdvisories([advisory(), advisory({ key: 'reconstruction_running' })])

    expect(shown.map((entry) => entry.key)).toEqual(['legacy_config_file'])
  })

  it('keeps the server’s declared order rather than sorting by date', () => {
    const shown = shownAdvisories([
      advisory({ key: 'unread_environment', first_seen_at: '2026-03-02T00:00:00.000Z' }),
      advisory({ key: 'legacy_config_file', first_seen_at: '2026-01-01T00:00:00.000Z' }),
    ])

    // A badge whose contents reshuffle between two reads is a badge nobody
    // trusts, and the order is the one `advisories.SPECS` declares.
    expect(shown.map((entry) => entry.key)).toEqual(['unread_environment', 'legacy_config_file'])
  })
})

describe('what the badge counts', () => {
  it('counts exactly what the block shows', () => {
    const entries = [
      advisory(),
      advisory({ key: 'unread_environment' }),
      advisory({ key: 'legacy_settings_file', acknowledged: true }),
      advisory({ key: 'reconstruction_running' }),
    ]

    expect(unacknowledgedCount(entries)).toBe(shownAdvisories(entries).length)
    expect(unacknowledgedCount(entries)).toBe(2)
  })

  it('is zero when everything standing has been acknowledged', () => {
    expect(unacknowledgedCount([advisory({ acknowledged: true })])).toBe(0)
  })
})

describe('the gesture a notice carries', () => {
  it('leads to every security the currency assertion names', () => {
    // The multi-symbol case is the ordinary one — a portfolio reporting in EUR
    // and holding two foreign currencies produces it — and the gesture carries
    // the whole set. Keeping the first would state a repair perimeter smaller
    // than the sentence rendered above the button, on the one notice the app
    // cannot recompute.
    const gesture = advisoryGesture(
      advisory({
        key: 'assumed_base_currency',
        detail: { symbols: ['ZZA', 'ZZB', 'ZZC'], events: [1, 2, 3, 4] },
      }),
    )

    expect(gesture).toEqual({ kind: 'ledger', symbols: ['ZZA', 'ZZB', 'ZZC'] })
  })

  it('is nothing for a notice about a file the app cannot touch', () => {
    // Its own sentence — the server's, because it names this installation's
    // path — already says what to do out there. A button would be a power the
    // app does not have.
    expect(advisoryGesture(advisory({ key: 'legacy_config_file' }))).toBeNull()
    expect(advisoryGesture(advisory({ key: 'unread_environment' }))).toBeNull()
  })

  it('is nothing when this process could not observe what it names', () => {
    // `detail: null` is the honest answer of a runtime that cannot see the
    // source — never an error, and never a gesture pointing at nothing.
    expect(advisoryGesture(advisory({ key: 'assumed_base_currency', detail: null }))).toBeNull()
    expect(
      advisoryGesture(advisory({ key: 'assumed_base_currency', detail: { symbols: [] } })),
    ).toBeNull()
  })
})
