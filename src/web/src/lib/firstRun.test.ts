import { describe, expect, it } from 'vitest'

import {
  PASSAGES,
  currencyFixed,
  currencyUnanswered,
  firstRunStands,
  nextPassage,
  passageNumber,
  previousPassage,
  reopenedPassage,
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
    // a decision reopened. The currency is answered here and the
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
    expect(firstRunStands(withASecondRequiredDial)).toBe(true)
  })

  it('says nothing at all while the read has not landed', () => {
    expect(requiredUnanswered(undefined)).toBeUndefined()
    // A payload carrying no mark at all is a server this front has not
    // understood, not an install that has answered everything.
    expect(requiredUnanswered([aSetting()])).toBeUndefined()
  })

  it('stands on a missing answer, and on nothing else', () => {
    expect(firstRunStands(unanswered())).toBe(true)
    expect(firstRunStands(defaultSettings())).toBe(false)
    // Never on a silence: one that appears and disappears when the read lands
    // is worse than one that arrives late.
    expect(firstRunStands(undefined)).toBe(false)
  })
})

describe('the four steps', () => {
  it('are walked in the order the record names', () => {
    // The currency first — the app cannot convert or compute without it — then
    // the tax models, so the first account can carry one, then the account,
    // then where the first events come from.
    expect(PASSAGES).toEqual(['currency', 'models', 'account', 'events'])
    expect(nextPassage('currency')).toBe('models')
    expect(nextPassage('models')).toBe('account')
    expect(nextPassage('account')).toBe('events')
    expect(previousPassage('events')).toBe('account')
    expect(previousPassage('models')).toBe('currency')
  })

  it('end, rather than looping: the last passage has nothing after it', () => {
    // What that `null` is read as, one file over, is *leave*.
    expect(nextPassage('events')).toBeNull()
    // And the first has no way back, which is what makes the walk a sequence
    // rather than three tabs.
    expect(previousPassage('currency')).toBeNull()
  })

  it('are counted from one, because that is what a reader is told', () => {
    expect(PASSAGES.map(passageNumber)).toEqual([1, 2, 3, 4])
  })
})

describe('the currency keeps a reading of its own', () => {
  it('is what the pinned card and the immutability sentence are about', () => {
    // Not the predicate: the card says *answer the currency*, so it is about
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

describe('the gesture that reopens the walk', () => {
  it('reopens on the tax models once every required dial is answered, and on the question otherwise', () => {
    expect(reopenedPassage(defaultSettings())).toBe('models')
    expect(reopenedPassage(unanswered())).toBe('currency')
  })
})
