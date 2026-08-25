/**
 * The reporting currency's **closed list**, and the suggestion a browser locale
 * is allowed to make (#726, ADR-0002, ADR-0021).
 *
 * `base_currency` has no default, so the field always opens on an unanswered
 * dial. Whether that absence is a question the app must ask is the registry's
 * to say and not this file's: the `required` mark carries it (ADR-0035), and
 * the front reads the mark rather than this key. What is decided here is the
 * field itself, and two decisions are encoded rather than described:
 *
 *  - **A closed list, bounded by what the rate source quotes.** A free-text
 *    field accepts `XYZ`, whose pair never resolves; the failure that follows is
 *    total (nothing is converted, so the perf job writes nothing at all) and,
 *    but for #704's `unconvertible` terminal, mute. The full ISO 4217 has the
 *    same defect one notch further out — `XPF`, `SLE`, `MRU` are codes a
 *    validator accepts and Yahoo does not quote. So the list is the venues the
 *    fetcher actually knows, and it is the *field* that is closed: the server
 *    stays the authority on the **shape** (`settings_registry.validate`), which
 *    is what keeps a headless `curl` answering the question at all — the one
 *    non-interactive path ADR-0015 leaves open — and this ticket adds **no API
 *    state**, so the list does not travel over HTTP either.
 *  - **A locale pre-fills a suggestion, never a default.** A suggestion poses
 *    nothing: the field is still unanswered, and what it buys is one click
 *    instead of a scroll through thirty codes. The reservation is written on the
 *    screen as well as here, because it is real and no heuristic removes it: a
 *    locale gives the currency of a **country**, not of a portfolio. Somebody
 *    reading in `fr-FR` may perfectly well report in `CHF`.
 */

/**
 * What the rate source quotes, in the order the field offers them: the
 * reporting currencies of the venues this app scrapes first, then the rest
 * alphabetically. Every code here is one half of a `XXXYYY=X` pair Yahoo serves.
 */
export const CURRENCIES = [
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'JPY',
  'CAD',
  'AUD',
  'BRL',
  'CNY',
  'CZK',
  'DKK',
  'HKD',
  'HUF',
  'ILS',
  'INR',
  'KRW',
  'MXN',
  'NOK',
  'NZD',
  'PLN',
  'RON',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'TWD',
  'ZAR',
] as const

export type Currency = (typeof CURRENCIES)[number]

const KNOWN = new Set<string>(CURRENCIES)

/** Whether a code is one the field offers. Case-sensitive: codes are upper. */
export function isSupported(code: string | null | undefined): code is Currency {
  return typeof code === 'string' && KNOWN.has(code)
}

/**
 * The country a locale names, mapped to the currency that country reports in.
 *
 * Only regions whose currency is in the closed list are here: a locale naming a
 * currency the rate source does not quote has to suggest **nothing**, or the
 * field would open pre-filled with a value it cannot accept.
 */
const BY_REGION: Record<string, Currency> = {
  AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR', ES: 'EUR', FI: 'EUR',
  FR: 'EUR', GR: 'EUR', HR: 'EUR', IE: 'EUR', IT: 'EUR', LT: 'EUR', LU: 'EUR',
  LV: 'EUR', MT: 'EUR', NL: 'EUR', PT: 'EUR', SI: 'EUR', SK: 'EUR',
  US: 'USD', GB: 'GBP', CH: 'CHF', JP: 'JPY', CA: 'CAD', AU: 'AUD',
  BR: 'BRL', CN: 'CNY', CZ: 'CZK', DK: 'DKK', HK: 'HKD', HU: 'HUF',
  IL: 'ILS', IN: 'INR', KR: 'KRW', MX: 'MXN', NO: 'NOK', NZ: 'NZD',
  PL: 'PLN', RO: 'RON', SE: 'SEK', SG: 'SGD', TH: 'THB', TR: 'TRY',
  TW: 'TWD', ZA: 'ZAR',
}

/**
 * What the reader's browser suggests, or `null` — **never a fallback**.
 *
 * `null` where the locale carries no region (`fr` alone), where the region is
 * one whose currency the rate source does not quote, and where the browser
 * answers nothing at all. The field then opens empty, which is the honest state:
 * the question is unanswered and the app is not going to pretend otherwise.
 */
export function suggestedCurrency(locales: readonly string[] | undefined): Currency | null {
  for (const locale of locales ?? []) {
    // `fr-FR`, `en-US`, `zh-Hans-CN` — the region is the 2-letter subtag, and
    // `Intl.Locale` is what reads it rather than a split on `-`, which takes
    // `Hans` for a region on the third of those.
    let region: string | undefined
    try {
      region = new Intl.Locale(locale).region ?? undefined
    } catch {
      region = undefined
    }
    const currency = region ? BY_REGION[region.toUpperCase()] : undefined
    if (currency) return currency
  }
  return null
}
