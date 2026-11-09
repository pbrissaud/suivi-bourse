/**
 * A tax model as the Settings list and the registry sheet say it: its rates in
 * one line, and the region the reader's browser speaks for.
 */
import type { MessageKey, MessageValues } from '@/lib/i18n'

type Translate = (key: MessageKey, values?: MessageValues) => string

interface Rated {
  kind: string
  parameters: Record<string, unknown>
}

/**
 * « 12,8 % puis 0 % après 5 ans · 18,6 % de prélèvements sociaux »: the rates of
 * `model`, the social levy last. The messages keep the kind in their key, so a
 * kind the app does not know yet falls back to its own name.
 */
export function modelRule(t: Translate, model: Rated): string {
  const values: MessageValues = {}
  for (const [name, value] of Object.entries(model.parameters)) {
    if (typeof value === 'number' || typeof value === 'string') values[name] = value
    else if (Array.isArray(value)) values.count = value.length
  }
  const main = t(`settings.taxation.summary.${model.kind}` as MessageKey, values)
  return typeof values.social_rate === 'number'
    ? `${main} · ${t('settings.taxation.summary.social', values)}`
    : main
}

/** The region of the browser's language (`fr-FR` is `FR`), or `null`. */
export function ownCountry(): string | null {
  try {
    return new Intl.Locale(navigator.language).region ?? null
  } catch {
    return null
  }
}

/** A region code as a country's name in `language`; the code itself when it is not one. */
export function countryName(language: string, code: string): string {
  try {
    return new Intl.DisplayNames([language], { type: 'region' }).of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}
