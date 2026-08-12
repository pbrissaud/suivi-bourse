/**
 * Rendering, and the two rules that run through all of it.
 *
 * **Absence is not zero.** Every formatter below returns an em dash for `null`
 * — the last possible moment where a `?? 0` would otherwise sneak in and put a
 * confident `0,00 €` where the honest answer is "we have never observed this".
 *
 * **The format follows the language, not the currency** (ADR-0024). `const
 * LOCALE = 'fr-FR'` is gone: every `Intl` site below takes the locale as its
 * first argument, and the eight of them — six numbers, two dates — read the
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
 * A yield already expressed in percent points (the writer multiplies by 100),
 * so it is *not* a ratio and must not go through `formatPercent`.
 */
export function formatPercentPoints(locale: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return ABSENT
  return `${formatNumber(locale, value, 2)} %`
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
 * The eight sites, bound to the reader's language. A component calls
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
      dateTime: (value: string | null | undefined) => formatDateTime(locale, value),
      date: (value: string | number | Date | null | undefined) => formatDate(locale, value),
    }),
    [locale],
  )
}
