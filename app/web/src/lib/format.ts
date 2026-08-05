/**
 * Rendering, and the one rule that runs through all of it: **absence is not
 * zero**.
 *
 * Every formatter below returns an em dash for `null`. That is trap 3 and #652
 * déc. 6 ("empty states that mean something") enforced at the last possible
 * moment — the place where a `?? 0` would otherwise sneak in and put a
 * confident `0,00 €` where the honest answer is "we have never observed this".
 *
 * Amounts arrive as raw numbers plus a `currency` read from the account
 * declaration (#655's minor conventions; trap 14 — the baseline hardcodes
 * `currencyEUR`), so the locale formatting is the front's job and happens here.
 */

/** What absence looks like. One glyph, one place to change it. */
export const ABSENT = '—'

const LOCALE = 'fr-FR'

export function formatCurrency(
  value: number | null | undefined,
  currency: string | null | undefined,
  fractionDigits = 2,
): string {
  if (value === null || value === undefined) return ABSENT
  // Without a declared currency, render a bare number rather than guessing
  // EUR — guessing is exactly what the Grafana baseline does.
  if (!currency) return formatNumber(value, fractionDigits)
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

export function formatNumber(
  value: number | null | undefined,
  fractionDigits = 2,
): string {
  if (value === null || value === undefined) return ABSENT
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/** Quantities can be fractional (fractional shares) but are usually whole. */
export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined) return ABSENT
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 4 }).format(value)
}

/** A ratio (0.1234) rendered as a percentage. Signed, because it is a change. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return ABSENT
  return new Intl.NumberFormat(LOCALE, {
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
export function formatPercentPoints(value: number | null | undefined): string {
  if (value === null || value === undefined) return ABSENT
  return `${formatNumber(value, 2)} %`
}

/** Market cap: billions, not fifteen digits. */
export function formatCompact(
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (value === null || value === undefined) return ABSENT
  return new Intl.NumberFormat(LOCALE, {
    notation: 'compact',
    maximumFractionDigits: 2,
    ...(currency ? { style: 'currency' as const, currency } : {}),
  }).format(value)
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return ABSENT
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ABSENT
  return new Intl.DateTimeFormat(LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function formatDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ABSENT
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ABSENT
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' }).format(date)
}

/**
 * The colour of a signed figure — and `null` is deliberately *neutral*, not
 * green. A position with no cost price has no gain to be happy about.
 */
export function signClass(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return 'text-muted-foreground'
  // `text-[var(--gain)]`, not `text-[--gain]`: the bare-variable shorthand is
  // not a colour utility Tailwind v4 resolves, and it fails *silently* — the
  // class is emitted, nothing is coloured, and a screen of black numbers looks
  // like a design choice rather than a bug. Caught by looking at the page.
  return value > 0 ? 'text-[var(--gain)]' : 'text-[var(--loss)]'
}
