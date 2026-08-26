/**
 * The two catalogues and the machinery that reads them (ADR-0024).
 */
import { IntlMessageFormat } from 'intl-messageformat'
import { describe, expect, it } from 'vitest'

import en from '@/i18n/en.json'
import fr from '@/i18n/fr.json'
import {
  LANGUAGE_STORAGE_KEY,
  LOCALES,
  formatMessage,
  readLanguageChoice,
  resolveLanguage,
} from '@/lib/i18n'

describe('the catalogues', () => {
  it('are addressed by the same semantic keys, neither being a translation', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort())
  })

  it('say the same thing in two languages', () => {
    expect(formatMessage('fr', 'nav.dashboard')).toBe('Tableau de bord')
    expect(formatMessage('en', 'nav.dashboard')).toBe('Dashboard')
  })

  it('carry no key rendered as itself', () => {
    for (const [key, message] of Object.entries(fr)) {
      expect(message, `fr:${key}`).not.toBe(key)
    }
  })
})

describe('ICU is the format, and it is needed', () => {
  it('selects a branch, which is how a state and a gender agreement are written', () => {
    // The status dot is the first real `select` in the product: three states,
    // one key, and a fourth branch so an unknown state is a sentence rather
    // than a crash.
    expect(formatMessage('fr', 'status.dot', { state: 'ok' })).toBe('L’installation va bien')
    expect(formatMessage('en', 'status.dot', { state: 'unreachable' })).toBe(
      'The app is not answering',
    )
    expect(formatMessage('fr', 'status.dot', { state: 'martian' })).toContain('inconnu')
  })

  it('pluralises **from the catalogue**, on the values that turn the form', () => {
    // #713 shipped the mechanism and no coverage: neither catalogue held a
    // single `plural`, and the only one exercised was a literal written inside
    // this file. That was unavoidable there — the four pages were placeholders,
    // so nothing on screen counted anything and a key with no consumer is dead
    // weight. This ticket is the first to put two counted nouns on a screen.
    //
    // Zero is the value that separates the two languages: French counts it as
    // `one`, English does not.
    expect(formatMessage('fr', 'dashboard.scope', { count: 0 })).toBe('0 compte')
    expect(formatMessage('en', 'dashboard.scope', { count: 0 })).toBe('0 accounts')
    expect(formatMessage('fr', 'dashboard.scope', { count: 1 })).toBe('1 compte')
    expect(formatMessage('en', 'dashboard.scope', { count: 1 })).toBe('1 account')
    expect(formatMessage('fr', 'dashboard.scope', { count: 2 })).toBe('2 comptes')
    expect(formatMessage('en', 'dashboard.scope', { count: 2 })).toBe('2 accounts')

    // The second counted noun: the absence rendering that reports its count
    // rather than a verdict.
    expect(formatMessage('fr', 'absence.noQuote', { count: 1 })).toBe(
      '1 relevé consécutif, aucun cours',
    )
    expect(formatMessage('fr', 'absence.noQuote', { count: 3 })).toBe(
      '3 relevés consécutifs, aucun cours',
    )
    expect(formatMessage('en', 'absence.noQuote', { count: 1 })).toBe(
      '1 consecutive reading, no price',
    )
    expect(formatMessage('en', 'absence.noQuote', { count: 3 })).toBe(
      '3 consecutive readings, no price',
    )
  })

  it('carries French gender agreement, which forbids one shared string', () => {
    // `plus-value` is feminine, so the adjective agrees — `latente`,
    // `réalisée` — and it would be `latent` / `réalisé` beside a masculine
    // subject such as `gain`. English needs no agreement and could have shared
    // one adjective between the two contexts; French cannot, which is why the
    // key is **semantic** and never the rendered word.
    expect(formatMessage('fr', 'gain.term.unrealised')).toBe('Plus-value latente')
    expect(formatMessage('fr', 'gain.term.realised')).toBe('Plus-value réalisée')
    expect(formatMessage('en', 'gain.term.unrealised')).toBe('Unrealised P&L')
    expect(formatMessage('en', 'gain.term.realised')).toBe('Realised P&L')

    // And no key serves both: a string shared between two genders is exactly
    // what is *not available* here.
    for (const language of ['fr', 'en'] as const) {
      expect(formatMessage(language, 'gain.term.unrealised')).not.toBe(
        formatMessage(language, 'gain.term.realised'),
      )
    }
  })

  it('says `Total P&L` in English, never `Total gain`', () => {
    // `Total gain` and `Total return` start with the same word and cohabit on
    // the dashboard head; the French pair has no such collision (ADR-0024).
    expect(formatMessage('en', 'dashboard.gainTotal')).toBe('Total P&L')
    expect(formatMessage('fr', 'dashboard.gainTotal')).toBe('Gain total')
  })

  it('writes the bell’s five states in both catalogues, as two sources', () => {
    // The vocabulary the bell is said in (#819, #829, ADR-0036, ADR-0037).
    // Both catalogues carry all five branches, and neither is a rendering of
    // the other: the word `attention` used to say *scheduler stopped* in both,
    // which stopped being true the day it started reading `/health` — one
    // stuck scrape, one wedged backfill and one failing perf pass all land on
    // it now.
    for (const state of ['ok', 'attention', 'rebuilding', 'unreachable'] as const) {
      for (const language of ['fr', 'en'] as const) {
        expect(formatMessage(language, 'status.dot', { state }), `${language}:${state}`).not.toBe('')
      }
    }

    // The panel's health **card** says the state in prose, and it says it on
    // the two states that are a card: health is repaired rather than
    // dismissed, `ok` is not an entry at all, and a rebuild is carried by the
    // installation fact whose subject it is — one fact, one announcer.
    for (const state of ['attention', 'unreachable'] as const) {
      for (const key of ['notification.health.title', 'notification.health.body'] as const) {
        for (const language of ['fr', 'en'] as const) {
          expect(formatMessage(language, key, { state }), `${language}:${key}:${state}`).not.toBe('')
        }
      }
    }

    // And the two part company where a literal rendering would degrade one of
    // them: English has **job** for the three of them, and French has no crisp
    // equivalent — so the French sentence names them, which is a decision and
    // not a longer translation.
    expect(formatMessage('en', 'notification.health.title', { state: 'attention' })).toBe(
      'A job needs a look',
    )
    expect(formatMessage('fr', 'notification.health.title', { state: 'attention' })).toBe(
      'Quelque chose s’est arrêté',
    )
    expect(formatMessage('fr', 'notification.health.body', { state: 'attention' })).toContain(
      'Un relevé, une reconstruction ou un calcul de performance',
    )
  })

  it('pluralises per language rather than per string', () => {
    // French puts 0 in `one` and English does not — which is why a shared
    // string between two contexts is not available, and why the catalogue
    // format has to be ICU rather than interpolation.
    const message = {
      fr: '{count, plural, one {# relevé infructueux} other {# relevés infructueux}}',
      en: '{count, plural, one {# fruitless reading} other {# fruitless readings}}',
    }
    const render = (language: 'fr' | 'en', count: number) =>
      String(new IntlMessageFormat(message[language], LOCALES[language]).format({ count }))

    expect(render('fr', 0)).toBe('0 relevé infructueux')
    expect(render('en', 0)).toBe('0 fruitless readings')
    expect(render('fr', 1)).toBe('1 relevé infructueux')
    expect(render('fr', 3)).toBe('3 relevés infructueux')
    expect(render('en', 3)).toBe('3 fruitless readings')
  })
})

describe('the language is the reader’s, and lives in the browser', () => {
  it('reads absence, and anything unrecognised, as auto', () => {
    const storage = new Map<string, string>()
    const view = { getItem: (key: string) => storage.get(key) ?? null }

    expect(readLanguageChoice(view)).toBe('auto')
    storage.set(LANGUAGE_STORAGE_KEY, 'kl')
    expect(readLanguageChoice(view)).toBe('auto')
    storage.set(LANGUAGE_STORAGE_KEY, 'fr')
    expect(readLanguageChoice(view)).toBe('fr')
  })

  it('resolves auto against the browser, and falls back to the source language', () => {
    expect(resolveLanguage('auto', ['fr-FR', 'en-GB'])).toBe('fr')
    expect(resolveLanguage('auto', ['en-US'])).toBe('en')
    // A browser asking for German gets English — the source — rather than a
    // half-translated screen.
    expect(resolveLanguage('auto', ['de-DE'])).toBe('en')
    expect(resolveLanguage('auto', [])).toBe('en')
    // A choice is a choice: it does not consult the browser at all.
    expect(resolveLanguage('fr', ['en-GB'])).toBe('fr')
  })
})
