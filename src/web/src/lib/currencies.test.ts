import { describe, expect, it } from 'vitest'

import { CURRENCIES, isSupported, suggestedCurrency } from '@/lib/currencies'

describe('the closed list', () => {
  it('holds no duplicate and only upper-case three-letter codes', () => {
    expect(new Set(CURRENCIES).size).toBe(CURRENCIES.length)
    for (const code of CURRENCIES) expect(code).toMatch(/^[A-Z]{3}$/)
  })

  it('refuses a code the rate source does not quote', () => {
    // The criterion's own example: shape-valid, and its pair never resolves.
    expect(isSupported('XYZ')).toBe(false)
    // ISO 4217 accepts it; the list is narrower than ISO on purpose.
    expect(isSupported('XPF')).toBe(false)
    expect(isSupported('eur')).toBe(false)
    expect(isSupported(null)).toBe(false)
    expect(isSupported('EUR')).toBe(true)
  })
})

describe('the suggestion a locale makes', () => {
  it('reads the region and not the language', () => {
    expect(suggestedCurrency(['fr-FR'])).toBe('EUR')
    expect(suggestedCurrency(['fr-CH'])).toBe('CHF')
    expect(suggestedCurrency(['en-US'])).toBe('USD')
    // A script subtag is not a region.
    expect(suggestedCurrency(['zh-Hans-CN'])).toBe('CNY')
  })

  it('suggests nothing rather than falling back', () => {
    expect(suggestedCurrency(['fr'])).toBeNull()
    expect(suggestedCurrency([])).toBeNull()
    expect(suggestedCurrency(undefined)).toBeNull()
    // A region whose currency the list does not carry suggests nothing at all,
    // rather than opening the field on a value it would refuse.
    expect(suggestedCurrency(['fr-PF'])).toBeNull()
    expect(suggestedCurrency(['not a locale'])).toBeNull()
  })

  it('takes the first locale that names a currency it can offer', () => {
    expect(suggestedCurrency(['fr', 'fr-PF', 'de-DE'])).toBe('EUR')
  })
})
