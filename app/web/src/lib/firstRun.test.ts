import { describe, expect, it } from 'vitest'

import {
  currencyFixed,
  currencyUnanswered,
  firstRunStands,
  requiredUnanswered,
} from '@/lib/firstRun'
import { aSetting, defaultSettings } from '@/test/factories'

const unanswered = () =>
  defaultSettings().map((setting) =>
    setting.key === 'base_currency' ? { ...setting, value: null, stored: false } : setting,
  )

describe('the one predicate', () => {
  it('is a required dial being unanswered, read off the mark', () => {
    expect(requiredUnanswered(unanswered())).toBe(true)
    expect(requiredUnanswered(defaultSettings())).toBe(false)
  })

  it('is driven by the mark and not by the key that wears it today', () => {
    // The whole of this ticket: a second required dial is a registry line, not
    // a decision reopened (ADR-0035). The currency is answered here and the
    // predicate still stands, which no reading of `base_currency` produces.
    const withASecondRequiredDial = [
      ...defaultSettings(),
      aSetting({
        key: 'a_second_required_dial',
        value: null,
        default: null,
        required: true,
        stored: false,
      }),
    ]

    expect(requiredUnanswered(withASecondRequiredDial)).toBe(true)
    expect(currencyUnanswered(withASecondRequiredDial)).toBe(false)
    expect(firstRunStands({ settings: withASecondRequiredDial, dismissed: false })).toBe(true)
  })

  it('says nothing at all while the read has not landed', () => {
    expect(requiredUnanswered(undefined)).toBeUndefined()
    // A payload carrying no mark at all is a server this front has not
    // understood, not an install that has answered everything.
    expect(requiredUnanswered([aSetting()])).toBeUndefined()
  })

  it('never opens the modal on a silence, nor once it has been waved away', () => {
    expect(firstRunStands({ settings: unanswered(), dismissed: false })).toBe(true)
    expect(firstRunStands({ settings: unanswered(), dismissed: true })).toBe(false)
    expect(firstRunStands({ settings: undefined, dismissed: false })).toBe(false)
    expect(firstRunStands({ settings: defaultSettings(), dismissed: false })).toBe(false)
  })
})

describe('the currency keeps a reading of its own', () => {
  it('is what the band and the immutability sentence are about', () => {
    // Not the predicate: the band says *answer the currency*, so it is about
    // that dial and would be a lie over a second required one.
    expect(currencyUnanswered(unanswered())).toBe(true)
    expect(currencyUnanswered(defaultSettings())).toBe(false)
  })

  it('says nothing at all while the read has not landed', () => {
    expect(currencyUnanswered(undefined)).toBeUndefined()
    // A registry that does not carry the dial is not an install that answered.
    expect(currencyUnanswered([aSetting()])).toBeUndefined()
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
