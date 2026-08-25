/**
 * The four questions the *Notices* block answers, asked once (#724, #768,
 * ADR-0021, ADR-0024).
 *
 * Under the page seam, and it is not a second seam: entries in, verdicts out.
 * What is pinned here is the exclusion list, because each of its three members
 * looks countable and is not — and, since #768, **the sentence itself**, on all
 * three keys and in both languages: the notice of a French reader was entirely
 * English, and only one of the three is easy to provoke.
 */
import { describe, expect, it } from 'vitest'

import type { InstallationFact } from '@/lib/api'
import { formatList } from '@/lib/format'
import { LOCALES, formatMessage } from '@/lib/i18n'
import type { Language } from '@/lib/i18n'
import {
  BANNER_FACT,
  FACT_KEYS,
  factGesture,
  factText,
  shownFacts,
  unacknowledgedCount,
} from '@/lib/installationFacts'

function fact(overrides: Partial<InstallationFact> = {}): InstallationFact {
  return {
    key: 'unread_environment',
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
    const shown = shownFacts([
      fact(),
      fact({ key: 'assumed_base_currency', acknowledged: true }),
    ])

    // Greyed out, the notice of somebody who decided to live with what it names
    // for ever would be a permanent fixture of their screen.
    expect(shown.map((entry) => entry.key)).toEqual(['unread_environment'])
  })

  it('leaves the reconstruction to the banner, its one announcer', () => {
    const shown = shownFacts([fact(), fact({ key: 'reconstruction_running' })])

    expect(shown.map((entry) => entry.key)).toEqual(['unread_environment'])
  })

  it('keeps the server’s declared order rather than sorting by date', () => {
    const shown = shownFacts([
      fact({ key: 'assumed_base_currency', first_seen_at: '2026-03-02T00:00:00.000Z' }),
      fact({ key: 'unread_environment', first_seen_at: '2026-01-01T00:00:00.000Z' }),
    ])

    // A badge whose contents reshuffle between two reads is a badge nobody
    // trusts: the list comes out in the order the server declared it, and the
    // older of the two does **not** climb to the front.
    expect(shown.map((entry) => entry.key)).toEqual([
      'assumed_base_currency',
      'unread_environment',
    ])
  })
})

describe('what the badge counts', () => {
  it('counts exactly what the block shows', () => {
    const entries = [
      fact(),
      fact({ key: 'assumed_base_currency' }),
      fact({ key: 'assumed_base_currency', acknowledged: true }),
      fact({ key: 'reconstruction_running' }),
    ]

    expect(unacknowledgedCount(entries)).toBe(shownFacts(entries).length)
    expect(unacknowledgedCount(entries)).toBe(2)
  })

  it('is zero when everything standing has been acknowledged', () => {
    expect(unacknowledgedCount([fact({ acknowledged: true })])).toBe(0)
  })
})

/**
 * **The banner shows conditions the owner can end; the badge counts facts they
 * can only acknowledge** (ADR-0021, carried into ADR-0036).
 *
 * That one sentence is what separates the three notions the word *advisory* used
 * to carry, so #820 renamed everything around it and left it standing. It is
 * asserted here rather than left to the prose: the rename touched every name the
 * rule is written in, and a rule that survives only in a comment is a rule the
 * next refactor drops.
 */
describe('the rule that separates health, installation facts and advisories', () => {
  it('keeps the one condition the owner can end out of the block and the badge', () => {
    // `reconstruction_running` ends by itself when the reconstruction finishes —
    // there is nothing to acknowledge — so the banner announces it and neither
    // the block nor the badge says a word about it.
    const entries = [fact({ key: BANNER_FACT }), fact()]

    expect(shownFacts(entries).map((entry) => entry.key)).toEqual(['unread_environment'])
    expect(unacknowledgedCount(entries)).toBe(1)
  })

  it('counts every other key, each being a fact one can only acknowledge', () => {
    // The two that are left name something the app cannot undo for the owner —
    // a variable set in the container, an assertion made once about imported
    // amounts — so the only gesture is the acknowledgement, and the badge is
    // what counts them.
    const acknowledgeable = FACT_KEYS.filter((key) => key !== BANNER_FACT)

    expect(acknowledgeable).toEqual(['unread_environment', 'assumed_base_currency'])
    expect(unacknowledgedCount(acknowledgeable.map((key) => fact({ key })))).toBe(
      acknowledgeable.length,
    )
  })

  it('takes an acknowledged fact out of the block and the badge together', () => {
    // A badge is a promise that something is there to read: the two read one
    // list, so acknowledging cannot empty the block and leave the count on.
    const entries = [fact({ key: 'assumed_base_currency', acknowledged: true })]

    expect(shownFacts(entries)).toEqual([])
    expect(unacknowledgedCount(entries)).toBe(0)
  })
})

describe('the gesture a notice carries', () => {
  it('leads to every security the currency assertion names', () => {
    // The multi-symbol case is the ordinary one — a portfolio reporting in EUR
    // and holding two foreign currencies produces it — and the gesture carries
    // the whole set. Keeping the first would state a repair perimeter smaller
    // than the sentence rendered above the button, on the one notice the app
    // cannot recompute.
    const gesture = factGesture(
      fact({
        key: 'assumed_base_currency',
        detail: { symbols: ['ZZA', 'ZZB', 'ZZC'], events: [1, 2, 3, 4] },
      }),
    )

    expect(gesture).toEqual({ kind: 'ledger', symbols: ['ZZA', 'ZZB', 'ZZC'] })
  })

  it('is nothing for a notice about what lies outside the app', () => {
    // Its own sentence — which names this installation's variables — already
    // says what to do out there. A button would be a power the app does not
    // have: unsetting a variable is a `docker run` away from here.
    expect(factGesture(fact({ key: 'unread_environment' }))).toBeNull()
    expect(factGesture(fact({ key: 'reconstruction_running' }))).toBeNull()
  })

  it('is nothing when this process could not observe what it names', () => {
    // `detail: null` is the honest answer of a runtime that cannot see the
    // source — never an error, and never a gesture pointing at nothing.
    expect(factGesture(fact({ key: 'assumed_base_currency', detail: null }))).toBeNull()
    expect(
      factGesture(fact({ key: 'assumed_base_currency', detail: { symbols: [] } })),
    ).toBeNull()
  })
})

/**
 * The sentence, on the three keys and in the two languages (#768).
 *
 * The composer and the catalogue are exercised together, deliberately: a key
 * that composes fine against a message that does not exist is exactly the defect
 * the pair is here to prevent, and `formatMessage` is what turns one into the
 * other.
 */
function say(language: Language, entry: InstallationFact): string {
  const said = factText(entry, (list) => formatList(LOCALES[language], list))
  if (!said) throw new Error(`no catalogue sentence for ${entry.key}`)
  return formatMessage(language, said.key, said.values)
}

const DETAILS: Record<string, Record<string, unknown>> = {
  unread_environment: { variables: ['SB_PERF_INTERVAL', 'INFLUXDB_TOKEN'] },
  reconstruction_running: { complete: 7, total: 19, remaining: 12 },
  assumed_base_currency: {
    base_currency: 'EUR',
    events: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    symbols: ['ZZA', 'ZZB', 'ZZC'],
    currencies: ['GBP', 'USD'],
  },
}

describe('the sentence a notice is read in', () => {
  it('says all three in the reader’s language, and none of them in the other’s', () => {
    // Three keys, not the one that is easy to provoke: the whole block was
    // English on a French installation, and most of these sentences had no
    // rendering surface at all before #724 gave them one. It was five until
    // ADR-0032 took the two that were a `stat` on a folder nothing reads.
    expect(FACT_KEYS).toEqual([
      'unread_environment',
      'reconstruction_running',
      'assumed_base_currency',
    ])

    for (const key of FACT_KEYS) {
      const entry = fact({ key, detail: DETAILS[key] })
      const fr = say('fr', entry)
      const en = say('en', entry)

      expect(fr, `fr:${key}`).not.toBe(en)
      // A catalogue miss renders the key as itself, and an unfilled placeholder
      // renders as a brace: both are silent on screen and neither is a sentence.
      for (const [language, sentence] of [['fr', fr], ['en', en]] as const) {
        expect(sentence, `${language}:${key}`).not.toContain('{')
        expect(sentence, `${language}:${key}`).not.toContain('undefined')
        expect(sentence.length, `${language}:${key}`).toBeGreaterThan(40)
      }
    }
  })

  it('interpolates what this installation names, so the notice stays actionable', () => {
    const named = fact({
      key: 'unread_environment',
      detail: DETAILS.unread_environment,
    })
    expect(say('fr', named)).toContain('INFLUXDB_TOKEN')
    expect(say('en', named)).toContain('INFLUXDB_TOKEN')

    const assumed = fact({
      key: 'assumed_base_currency',
      detail: DETAILS.assumed_base_currency,
    })
    expect(say('fr', assumed)).toContain('EUR')
    expect(say('en', assumed)).toContain('EUR')
  })

  it('pluralises through ICU rather than through a « (s) »', () => {
    // `f"{len(variables)} environment variable(s) are set"` is the approximate
    // pluralisation ICU exists to replace, and the verb was wrong at one
    // whichever branch the server picked.
    const one = fact({ key: 'unread_environment', detail: { variables: ['SB_PERF_INTERVAL'] } })
    const three = fact({
      key: 'unread_environment',
      detail: { variables: ['SB_PERF_INTERVAL', 'SB_EXECUTOR_POOL', 'INFLUXDB_TOKEN'] },
    })

    expect(say('fr', one)).toContain('1 variable d’environnement est définie')
    expect(say('fr', three)).toContain('3 variables d’environnement sont définies')
    expect(say('en', one)).toContain('1 environment variable is set')
    expect(say('en', three)).toContain('3 environment variables are set')

    // And the two counted nouns of the currency notice turn independently: four
    // events on three lines is the ordinary shape, one on one is not the same
    // sentence twice.
    const alone = fact({
      key: 'assumed_base_currency',
      detail: {
        base_currency: 'EUR',
        events: [{ id: 1 }],
        symbols: ['ZZA'],
        currencies: ['USD'],
      },
    })
    expect(say('fr', alone)).toContain('1 événement sur 1 ligne cotée')
    expect(say('en', alone)).toContain('1 event on 1 line')
    expect(say('fr', fact({ key: 'assumed_base_currency', detail: DETAILS.assumed_base_currency })))
      .toContain('4 événements sur 3 lignes cotées')

    // The reconstruction counts its own noun, and French agrees the verb where
    // English does not.
    expect(say('fr', fact({ key: 'reconstruction_running', detail: { complete: 1, total: 19 } })))
      .toContain('1 série a atteint sa première acquisition')
    expect(
      say('fr', fact({ key: 'reconstruction_running', detail: DETAILS.reconstruction_running })),
    ).toContain('7 séries ont atteint leur première acquisition')
  })

  it('enumerates the way the language does, never with a « , » that crosses the wire', () => {
    // `', '.join(...)` is a machine's list wearing a sentence's clothes. English
    // closes on *and*, French on *et*, and `Intl.ListFormat` is the only thing
    // that knows which — so the payload carries the array and the front carries
    // the language.
    const assumed = fact({
      key: 'assumed_base_currency',
      detail: DETAILS.assumed_base_currency,
    })
    expect(say('fr', assumed)).toContain('ZZA, ZZB et ZZC')
    expect(say('en', assumed)).toContain('ZZA, ZZB and ZZC')
    expect(say('fr', assumed)).toContain('GBP et USD')
    expect(say('en', assumed)).toContain('GBP and USD')

    const variables = fact({
      key: 'unread_environment',
      detail: { variables: ['SB_PERF_INTERVAL', 'SB_EXECUTOR_POOL'] },
    })
    expect(say('fr', variables)).toContain('SB_PERF_INTERVAL et SB_EXECUTOR_POOL')
    expect(say('en', variables)).toContain('SB_PERF_INTERVAL and SB_EXECUTOR_POOL')
  })

  it('falls back to what the notice *is* when this process observed nothing', () => {
    // `detail: null` is #709's third answer, and the server does the same thing
    // one level up: its `message` becomes `FactSpec.doc`. A paragraph with
    // `undefined` where a path should be would be the alternative.
    const unobserved = fact({ key: 'unread_environment', detail: null })
    expect(say('fr', unobserved)).toBe(
      'Des variables d’environnement sont définies et cette version n’en lit aucune.',
    )
    expect(say('en', unobserved)).toBe(
      'Environment variables are set that this version reads for nothing.',
    )

    // Same answer for a detail that is there and does not carry what the
    // sentence interpolates: half a sentence is not a degradation, it is a bug
    // rendered.
    const partial = fact({ key: 'assumed_base_currency', detail: { base_currency: 'EUR' } })
    expect(say('fr', partial)).not.toContain('undefined')
    expect(say('en', partial)).toBe(
      'Amounts imported from files were taken to be in the base currency.',
    )
  })

  it('leaves a key it has never heard of to the server’s own sentence', () => {
    // The list is closed (ADR-0021), so this cannot happen against a server of
    // the same generation — and against one of another, an English sentence is
    // better than an empty notice in a block that exists to be read.
    expect(factText(fact({ key: 'a_sixth_notice' }), (list) => list.join(', '))).toBeNull()
  })
})
