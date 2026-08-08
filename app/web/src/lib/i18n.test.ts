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
