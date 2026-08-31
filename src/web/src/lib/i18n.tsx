/**
 * The two catalogues, and the reader's other preference (ADR-0024).
 *
 * Three decisions are encoded here rather than described:
 *
 *  - **Semantic keys, English as the source.** `nav.shares`, not `Titres` and
 *    not `Shares`: neither catalogue is the original and neither is the other's
 *    translation. Where a literal rendering would lose a decision — `Total P&L`
 *    over `Total gain`, the six event types named by effect — the English
 *    catalogue is free to say something else, because a key is not a string.
 *  - **ICU, one JSON per language.** Plurals are real in this product (a header
 *    counter, `Forget this import (214)`, `N consecutive readings`) and French
 *    carries gendered agreement (`latente`, `réalisée`, `soldée`) that English
 *    does not — so a string shared between two contexts is *not available*, and
 *    the message format has to do selects and plurals rather than `%s`.
 *  - **The language lives in the browser, never in the store.** It is a property
 *    of the *reader*: the product has no authentication, so a dial in the store
 *    would impose one language on two people reading the same portfolio. It also
 *    keeps ADR-0021's *one question at first run* at exactly one, and the
 *    settings registry purely about the engine (ADR-0014).
 *
 * The library is a choice ADR-0024 left open (`react-i18next`, `Lingui`,
 * `Paraglide` — all three emit JSON). What is here is `intl-messageformat`, the
 * ICU runtime the three of them wrap, plus the sixty lines below. It buys one
 * thing the wrappers do not: `MessageKey` is `keyof typeof en`, so a key that
 * does not exist, or a French catalogue that drifts from the English one, is a
 * **compile error** rather than a string that renders as itself.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { IntlMessageFormat } from 'intl-messageformat'

import en from '@/i18n/en.json'
import fr from '@/i18n/fr.json'
import { browserStorage, rememberPreference } from '@/lib/storage'

export type Language = 'fr' | 'en'
export type LanguageChoice = Language | 'auto'

/** Same shape as the theme key, deliberately (ADR-0024: one mechanism). */
export const LANGUAGE_STORAGE_KEY = 'sb.lang'

const CHOICES: LanguageChoice[] = ['fr', 'en', 'auto']

/**
 * The catalogues. English types the pair: `fr` is declared as
 * `Record<MessageKey, string>`, so a key added to one and forgotten in the other
 * does not compile.
 */
export type MessageKey = keyof typeof en
export type Catalogue = Record<MessageKey, string>

const CATALOGUES: Record<Language, Catalogue> = { en, fr }

/**
 * The BCP 47 tag each language formats with — numbers and dates follow the
 * **language**, never the currency (ADR-0002 is what licenses this: precisely
 * because a currency is a unit, it cannot dictate a decimal separator).
 */
export const LOCALES: Record<Language, string> = { fr: 'fr-FR', en: 'en-GB' }

/** Absence — and anything unrecognised — means `auto`. */
export function readLanguageChoice(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): LanguageChoice {
  const stored = storage?.getItem(LANGUAGE_STORAGE_KEY)
  return CHOICES.find((choice) => choice === stored) ?? 'auto'
}

/**
 * Pure: the reader's choice plus the browser's preference list gives the
 * language. `auto` takes the first *supported* preference — a browser asking for
 * `de` gets English, the source, rather than a half-translated screen.
 */
export function resolveLanguage(
  choice: LanguageChoice,
  preferences: readonly string[],
): Language {
  if (choice !== 'auto') return choice
  for (const preference of preferences) {
    const base = preference.toLowerCase().split('-')[0]
    if (base === 'fr' || base === 'en') return base
  }
  return 'en'
}

export type MessageValues = Record<string, string | number | Date>

/**
 * Format one message. Exported unbound so a pure test — and a module with no
 * React around it — can format without mounting anything.
 */
export function formatMessage(
  language: Language,
  key: MessageKey,
  values?: MessageValues,
): string {
  const message = CATALOGUES[language][key]
  // Most messages are literal, and running the ICU parser over them would cost
  // a parse per render for nothing. Keyed on the *message* rather than on the
  // absence of arguments: a `select` called without values must not fall
  // through and render its own source.
  if (!message.includes('{')) return message
  return String(new IntlMessageFormat(message, LOCALES[language]).format(values))
}

export interface I18nContextValue {
  choice: LanguageChoice
  language: Language
  locale: string
  setChoice: (choice: LanguageChoice) => void
  t: (key: MessageKey, values?: MessageValues) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<LanguageChoice>(() =>
    readLanguageChoice(browserStorage()),
  )

  const language = resolveLanguage(choice, navigator.languages ?? [navigator.language])

  const setChoice = useCallback((next: LanguageChoice) => {
    setChoiceState(next)
    rememberPreference(LANGUAGE_STORAGE_KEY, next)
  }, [])

  const value = useMemo<I18nContextValue>(
    () => ({
      choice,
      language,
      locale: LOCALES[language],
      setChoice,
      t: (key, values) => formatMessage(language, key, values),
    }),
    [choice, language, setChoice],
  )

  // `lang` on the document is not decoration: it is what a screen reader picks
  // its voice from, and what `:lang()` and hyphenation key on.
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n outside I18nProvider')
  return value
}

/** The everyday half of {@link useI18n}. */
export function useT(): I18nContextValue['t'] {
  return useI18n().t
}
