import { describe, expect, it } from 'vitest'

import { currencyFixed, currencyUnanswered, firstRunStands } from '@/lib/firstRun'
import { aSetting, defaultSettings } from '@/test/factories'

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

describe('the currency is fixed the moment it is answered', () => {
  it('reads the dial and not the ledger', () => {
    // `CONTEXT.md`: *immutable once set — the answer can be given late, it just
    // cannot be taken back*. The server is looser, and what its looseness buys
    // is a window in which a reader adopts a second unit and discovers on their
    // first import that the first one was never converted.
    expect(currencyFixed(defaultSettings())).toBe(true)
    expect(currencyFixed(unanswered())).toBe(false)
  })

  it('claims neither half while the settings read is still out', () => {
    expect(currencyFixed(undefined)).toBeUndefined()
    // A registry that does not carry the dial is not an install that answered.
    expect(currencyFixed([aSetting()])).toBeUndefined()
  })
})
