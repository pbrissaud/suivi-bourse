/**
 * Rendering, and the two rules that run through all of it.
 *
 * **Absence is not zero.** Every formatter below returns an em dash for `null`
 * — the last possible moment where a `?? 0` would otherwise sneak in and put a
 * confident `0,00 €` where the honest answer is "we have never observed this".
 *
 * **The format follows the language, not the currency** (ADR-0024). `const
 * LOCALE = 'fr-FR'` is gone: every `Intl` site below takes the locale as its
 * first argument, and the ten of them — six numbers, three dates and one list
 * (#768, #834) — read the
 * reader's current language through `useFormatters()`. ADR-0002's *a currency is
 * a unit, not a locale* is what licenses this rather than what contradicts it:
 * precisely because a currency is a unit, it cannot dictate a decimal
 * separator. The same amount in the same currency is `1 234,56 €` for a French
 * reader and `€1,234.56` for an English one — the separators are the language's,
 * the symbol's position is the locale's own convention and not ours to place.
 */
import { useMemo } from 'react'

import { useI18n } from '@/lib/i18n'

/** What absence looks like. One glyph, one place to change it. */
export const ABSENT = '—'

export function formatCurrency(
  locale: string,
  value: number | null | undefined,
  currency: string | null | undefined,
  fractionDigits = 2,
): string {
  if (value === null || value === undefined) return ABSENT
  // Without a declared currency, render a bare number rather than guessing EUR
  // — guessing is exactly what the Grafana baseline did.
  if (!currency) return formatNumber(locale, value, fractionDigits)
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/**
 * A **delta** is signed, and a plain amount is not: `+40,69 €` says the gain
 * moved up, where `40,69 €` says only what it is worth.
 *
 * This is not a ninth `Intl` site — it composes the currency one. A second
 * `NumberFormat` differing from the first by `signDisplay` alone would be two
 * places to keep a currency's decimals in step, on a page that puts the two
 * renderings one line apart.
 */
export function formatSignedCurrency(
  locale: string,
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  const rendered = formatCurrency(locale, value, currency)
  return value !== null && value !== undefined && value > 0 ? `+${rendered}` : rendered
}

export function formatNumber(
  locale: string,
  value: number | null | undefined,
  fractionDigits = 2,
): string {
  if (value === null || value === undefined) return ABSENT
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/** Quantities can be fractional (fractional shares) but are usually whole. */
export function formatQuantity(locale: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return ABSENT
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value)
}

/** A ratio (0.1234) rendered as a percentage. Signed, because it is a change. */
export function formatPercent(locale: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return ABSENT
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'exceptZero',
  }).format(value)
}

/**
 * A figure already expressed in percent points — a dividend yield as yfinance
 * hands it over (5.32 for 5,32 %), an allocation share the caller has scaled.
 * It is *not* a ratio, which is why it does not go through `formatPercent`;
 * that one is a **change** and carries a sign, and a share of a pie never does.
 *
 * The suffix comes from `Intl` like every other one in this module. It used to
 * be a template literal closing on `' %'`, which is the French typographic
 * space applied to English as well: the dashboard showed `+12.34%` from
 * `formatPercent` next to `12.34 %` from this one, two spellings of a
 * percentage on one screen.
 */
export function formatPercentPoints(locale: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return ABSENT
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100)
}

/** Market cap: billions, not fifteen digits. */
export function formatCompact(
  locale: string,
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (value === null || value === undefined) return ABSENT
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 2,
    ...(currency ? { style: 'currency' as const, currency } : {}),
  }).format(value)
}

//: The decimal names of the binary steps, as `Intl` spells them. Binary steps
//: and decimal names is what every file manager the reader has ever opened
//: shows, so the **division** is ours; the **name** is not, and it used to be:
//: the array read `['B', 'kB', 'MB', …]` inside a module whose header promises
//: the reader's language, so a French reader was shown `126,0 MB` where the
//: block above it writes `126,0 Mo`. `Intl` knows all five — the claim that its
//: unit list stopped at `gigabyte` was simply wrong.
const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

/**
 * A size on disk, in the reader's language (#724).
 *
 * `null` is a store that has never been written, and it renders as the em dash
 * every other absence does rather than as `0 o` — a zero here would read as *the
 * purge worked*, on the one figure of the product that a purge does not move.
 */
export function formatBytes(locale: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return ABSENT
  let size = value
  let unit = 0
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024
    unit += 1
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: BYTE_UNITS[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 ? 0 : 1,
    minimumFractionDigits: unit === 0 ? 0 : 1,
  }).format(size)
}

export function formatDateTime(locale: string, value: string | null | undefined): string {
  if (!value) return ABSENT
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ABSENT
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

/**
 * A day, and **a bare `YYYY-MM-DD` is a calendar day rather than an instant**
 * (#723). The store's own rule is that the two kinds of time never mix, and
 * `new Date('2026-02-10')` breaks it: the string is read as UTC midnight, so
 * every date in the product renders one day early for a reader west of
 * Greenwich — a ledger dated the 9th for an event recorded the 10th, and a
 * position closed the day before the sale. Parsed by its parts, the day is the
 * day.
 */
export function formatDate(
  locale: string,
  value: string | number | Date | null | undefined,
): string {
  if (value === null || value === undefined) return ABSENT
  const day = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
  const date = day
    ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    : new Date(value)
  if (Number.isNaN(date.getTime())) return ABSENT
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
}

/**
 * **The extent a range covers, said once** (#838).
 *
 * The drawing puts the period the page is reading beside the control that sets
 * it — `1ᵉʳ janv. → 20 août 2026` — and it is one figure, not two dates: the
 * year is written where it is needed and dropped where the other end already
 * says it. That is the whole reason this is a formatter and not two calls to
 * `formatDate` with an arrow between them; written at a call site, the year
 * would either be repeated or dropped on both ends.
 */
export function formatDaySpan(
  locale: string,
  from: string | number | Date | null | undefined,
  to: string | number | Date | null | undefined,
): string {
  if (from === null || from === undefined || to === null || to === undefined) return ABSENT
  const parse = (value: string | number | Date) => {
    const day = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
    return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value)
  }
  const start = parse(from)
  const end = parse(to)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return ABSENT
  const sameYear = start.getFullYear() === end.getFullYear()
  const left = new Intl.DateTimeFormat(
    locale,
    sameYear ? { day: 'numeric', month: 'short' } : { dateStyle: 'medium' },
  ).format(start)
  const right = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(end)
  return `${left} → ${right}`
}

/**
 * A month, named short — `janv.`, `Jan` (#834).
 *
 * The tenth `Intl` site, and the first that names a *part* of a date rather
 * than a date: the ledger's facet panel lays the twelve out in a grid three
 * cells wide, where `1 janv. 2026` would not fit and would repeat the year
 * twelve times besides. A hand-written table of twelve French names would be
 * the bug this module exists to prevent — the reader chooses their language,
 * and the months would stay French in English.
 */
export function formatMonth(locale: string, year: string, month: number): string {
  const date = new Date(Date.UTC(Number(year), month - 1, 1))
  if (Number.isNaN(date.getTime())) return ABSENT
  return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(date)
}

/**
 * An enumeration, in the reader's language (#768).
 *
 * The ninth `Intl` site, and the first that is not a number or a date. It exists
 * because a language does not enumerate with a separator: English closes on
 * *and*, French on *et*, and `', '.join(...)` is neither — it is the separator
 * of a machine-readable list wearing a sentence's clothes. The notices are what
 * put three securities and two currencies inside one sentence, and the server's
 * own `', '.join(...)` stays where it belongs, in the log line and in the
 * headless payload, English being the language of both (ADR-0024).
 *
 * An empty list renders as the em dash the rest of this module uses for absence
 * — never as an empty gap inside a sentence — though no caller can reach it: an
 * installation fact that names nothing does not stand.
 */
export function formatList(locale: string, items: readonly string[]): string {
  if (items.length === 0) return ABSENT
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items)
}

/**
 * The ten sites, bound to the reader's language. A component calls
 * `formatCurrency(value, currency)` and never learns which locale it got, which
 * is what keeps the language out of every call site.
 */
export function useFormatters() {
  const { locale } = useI18n()
  return useMemo(
    () => ({
      locale,
      currency: (value: number | null | undefined, currency: string | null | undefined, digits?: number) =>
        formatCurrency(locale, value, currency, digits),
      signedCurrency: (value: number | null | undefined, currency: string | null | undefined) =>
        formatSignedCurrency(locale, value, currency),
      number: (value: number | null | undefined, digits?: number) =>
        formatNumber(locale, value, digits),
      quantity: (value: number | null | undefined) => formatQuantity(locale, value),
      percent: (value: number | null | undefined) => formatPercent(locale, value),
      percentPoints: (value: number | null | undefined) => formatPercentPoints(locale, value),
      compact: (value: number | null | undefined, currency: string | null | undefined) =>
        formatCompact(locale, value, currency),
      bytes: (value: number | null | undefined) => formatBytes(locale, value),
      dateTime: (value: string | null | undefined) => formatDateTime(locale, value),
      date: (value: string | number | Date | null | undefined) => formatDate(locale, value),
      daySpan: (
        from: string | number | Date | null | undefined,
        to: string | number | Date | null | undefined,
      ) => formatDaySpan(locale, from, to),
      month: (year: string, month: number) => formatMonth(locale, year, month),
      list: (items: readonly string[]) => formatList(locale, items),
    }),
    [locale],
  )
}
