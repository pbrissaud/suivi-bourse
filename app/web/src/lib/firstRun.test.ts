import { describe, expect, it } from 'vitest'

import { currencyMutable, currencyUnanswered, firstRunStands } from '@/lib/firstRun'
import { aSetting, anEvent, defaultSettings } from '@/test/factories'

const unanswered = () =>
  defaultSettings().map((setting) =>
    setting.key === 'base_currency' ? { ...setting, value: null, stored: false } : setting,
  )

describe('the one predicate', () => {
  it('is the reporting currency being unanswered, and nothing else', () => {
    expect(currencyUnanswered(unanswered())).toBe(true)
    expect(currencyUnanswered(defaultSettings())).toBe(false)
  })

  it('says nothing at all while the read has not landed', () => {
    expect(currencyUnanswered(undefined)).toBeUndefined()
    // A registry that does not carry the dial is not an install that answered.
    expect(currencyUnanswered([aSetting()])).toBeUndefined()
  })

  it('never opens the modal on a silence, nor once it has been waved away', () => {
    expect(firstRunStands({ settings: unanswered(), dismissed: false })).toBe(true)
    expect(firstRunStands({ settings: unanswered(), dismissed: true })).toBe(false)
    expect(firstRunStands({ settings: undefined, dismissed: false })).toBe(false)
    expect(firstRunStands({ settings: defaultSettings(), dismissed: false })).toBe(false)
  })
})

describe('the currency stops being mutable at the first event', () => {
  it('is free on an empty ledger and fixed afterwards, once it has been answered', () => {
    expect(currencyMutable({ events: [], answered: true })).toBe(true)
    expect(currencyMutable({ events: [anEvent()], answered: true })).toBe(false)
  })

  it('stays free on a dial nobody has ever answered, whatever the ledger holds', () => {
    // The server's own first clause, one line before it counts the events: a
    // dial never answered has interpreted nothing, so nothing can be
    // re-interpreted. Without it the modal — whose whole population is that
    // dial — told a v4 arrival with 285 events it was already too late, over a
    // form whose save then worked.
    expect(currencyMutable({ events: [anEvent()], answered: false })).toBe(true)
    expect(currencyMutable({ events: undefined, answered: false })).toBe(true)
  })

  it('claims neither while either read is still out', () => {
    expect(currencyMutable({ events: undefined, answered: true })).toBeUndefined()
    expect(currencyMutable({ events: null, answered: true })).toBeUndefined()
    expect(currencyMutable({ events: [], answered: undefined })).toBeUndefined()
  })
})
