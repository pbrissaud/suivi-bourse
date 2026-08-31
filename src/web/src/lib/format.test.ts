/**
 * The eight `Intl` sites, under both languages.
 *
 * The claim under test is ADR-0024's, and it is worth stating as the negative:
 * **the format follows the language, not the currency**. The same amount, in the
 * *same* currency, is grouped and pointed one way for a French reader and the
 * other way for an English one — which is exactly what `const LOCALE = 'fr-FR'`
 * made impossible.
 *
 * Expected strings are written with their real code points: French groups with
 * a narrow no-break space (U+202F) and puts one before the symbol. A test that
 * typed an ordinary space would pass on a different ICU version than the one
 * that ships.
 */
import { describe, expect, it } from 'vitest'

import {
  ABSENT,
  formatBytes,
  formatCompact,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatPercentPoints,
  formatQuantity,
} from '@/lib/format'
import { LOCALES } from '@/lib/i18n'

const FR = LOCALES.fr
const EN = LOCALES.en

describe('the format follows the language, not the currency', () => {
  it('groups and points the same euro amount two ways', () => {
    expect(formatCurrency(FR, 1234.56, 'EUR')).toBe('1 234,56 €')
    // English keeps the euro and moves to its own separators. The symbol's
    // position is the locale's convention, not a decision of ours.
    expect(formatCurrency(EN, 1234.56, 'EUR')).toBe('€1,234.56')
  })

  it('renders a bare number when no currency is declared', () => {
    // Guessing EUR is exactly what the Grafana baseline did.
    expect(formatCurrency(FR, 1234.56, null)).toBe('1 234,56')
    expect(formatCurrency(EN, 1234.56, null)).toBe('1,234.56')
  })

  it('follows the language for plain numbers, quantities and percentages', () => {
    expect(formatNumber(FR, 1234.5)).toBe('1 234,50')
    expect(formatNumber(EN, 1234.5)).toBe('1,234.50')

    expect(formatQuantity(FR, 1234.5678)).toBe('1 234,5678')
    expect(formatQuantity(EN, 1234.5678)).toBe('1,234.5678')

    // Signed, because it is a change — and `+0` is not a sign.
    expect(formatPercent(FR, 0.1234)).toBe('+12,34 %')
    expect(formatPercent(EN, 0.1234)).toBe('+12.34%')
    expect(formatPercent(FR, 0)).toBe('0,00 %')

    // Percent *points*, which are not a ratio and must not be multiplied again
    // — and which wear the **same** percent sign as the ratio above, because
    // both come from `Intl`. This one used to close on a template literal's
    // `' %'`, so it applied the French typographic space to English too and the
    // dashboard showed `+12.34%` beside `12.34 %`. The separator is now the
    // locale's own: a no-break space in French, nothing at all in English.
    expect(formatPercentPoints(FR, 3.5)).toBe('3,50\u00a0%')
    expect(formatPercentPoints(EN, 3.5)).toBe('3.50%')

    expect(formatCompact(FR, 2_400_000_000, 'EUR')).toBe('2,4 Md €')
    // `bn` and not `B`: en-GB's own abbreviation, which is the point — the
    // locale is the language's, not a guess of ours.
    expect(formatCompact(EN, 2_400_000_000, 'EUR')).toBe('€2.4bn')
  })

  it('follows the language for the two date sites', () => {
    expect(formatDate(FR, '2026-03-02T12:00:00Z')).toBe('2 mars 2026')
    expect(formatDate(EN, '2026-03-02T12:00:00Z')).toBe('2 Mar 2026')

    expect(formatDateTime(FR, '2026-03-02T12:00:00Z')).toContain('2 mars 2026')
    expect(formatDateTime(EN, '2026-03-02T12:00:00Z')).toContain('2 Mar 2026')
  })

  it('reads a bare day as a calendar day and never as an instant', () => {
    // `new Date('2026-03-02')` is UTC midnight, so west of Greenwich the whole
    // product renders a day early: an event dated the 2nd shown as the 1st, and
    // a position closed the day before its sale. The store keeps its two kinds
    // of time apart; so does this.
    expect(formatDate(FR, '2026-03-02')).toBe('2 mars 2026')
    expect(formatDate(EN, '2026-03-02')).toBe('2 Mar 2026')
  })
})

describe('absence is not zero', () => {
  it('renders an em dash rather than a confident zero', () => {
    expect(formatCurrency(FR, null, 'EUR')).toBe(ABSENT)
    expect(formatNumber(FR, undefined)).toBe(ABSENT)
    expect(formatQuantity(FR, null)).toBe(ABSENT)
    expect(formatPercent(FR, null)).toBe(ABSENT)
    expect(formatPercentPoints(FR, null)).toBe(ABSENT)
    expect(formatCompact(FR, null, 'EUR')).toBe(ABSENT)
    expect(formatDate(FR, null)).toBe(ABSENT)
    expect(formatDateTime(FR, null)).toBe(ABSENT)
  })

  it('renders an em dash for a date it cannot read, never "Invalid Date"', () => {
    expect(formatDate(FR, 'not a date')).toBe(ABSENT)
    expect(formatDateTime(EN, 'not a date')).toBe(ABSENT)
  })
})

describe('a size on disk (#724)', () => {
  it('steps in binary and follows the language for the number', () => {
    // The **division** is ours, because file managers step in binary and name
    // in decimal; the **unit** is `Intl`'s, because it is a word the reader
    // reads. It used to be a hard-coded `['B', 'kB', 'MB', …]` inside a module
    // whose header promises the reader's language, so a French reader was shown
    // `26,0 MB` under a block whose own comment writes `126,0 Mo`. `Intl` knows
    // all five names — the claim that its list stopped at `gigabyte` was wrong.
    // The separator is the locale's: a narrow no-break space in French.
    expect(formatBytes(FR, 26 * 1024 * 1024)).toBe('26,0\u202fMo')
    expect(formatBytes(EN, 26 * 1024 * 1024)).toBe('26.0 MB')
    expect(formatBytes(FR, 512)).toBe('512\u202fo')
  })

  it('renders an em dash on a store that has never been written', () => {
    // A zero here would read as *the purge worked*, on the one figure of the
    // product that a purge does not move.
    expect(formatBytes(FR, null)).toBe(ABSENT)
  })
})
