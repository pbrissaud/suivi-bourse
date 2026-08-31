import { describe, expect, it } from 'vitest'

import {
  PASSAGES,
  currencyFixed,
  currencyUnanswered,
  firstRunStands,
  nextPassage,
  passageNumber,
  previousPassage,
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
    expect(firstRunStands({ settings: withASecondRequiredDial, mark: null })).toBe(true)
  })

  it('says nothing at all while the read has not landed', () => {
    expect(requiredUnanswered(undefined)).toBeUndefined()
    // A payload carrying no mark at all is a server this front has not
    // understood, not an install that has answered everything.
    expect(requiredUnanswered([aSetting()])).toBeUndefined()
  })

  it('never opens the modal on a silence, nor once the reader has been through', () => {
    expect(firstRunStands({ settings: unanswered(), mark: null })).toBe(true)
    expect(firstRunStands({ settings: unanswered(), mark: 'unanswered' })).toBe(false)
    expect(firstRunStands({ settings: undefined, mark: null })).toBe(false)
    expect(firstRunStands({ settings: defaultSettings(), mark: null })).toBe(false)
  })

  it('walks again the reader who left having answered, their store being gone', () => {
    // The half of the browser's memory that is not *been through* (ADR-0035):
    // a mark saying only that would suppress the question for ever in the very
    // browser that answered it, so the reader who loses their volume — the
    // trial install ADR-0015 designs for — would meet an app with no currency
    // and nothing asking for one. A required dial unanswered under an
    // *answered* mark can only be a store that no longer holds the answer.
    expect(firstRunStands({ settings: unanswered(), mark: 'answered' })).toBe(true)
    // And nothing changes for the reader who walked away from an open question:
    // an emptied ledger, a reload, a second container — the mark still fits
    // what the server says, and they are left alone.
    expect(firstRunStands({ settings: unanswered(), mark: 'unanswered' })).toBe(false)
    // Answered and answered: no walk either way.
    expect(firstRunStands({ settings: defaultSettings(), mark: 'answered' })).toBe(false)
  })
})

describe('the three passages', () => {
  it('are walked in the order the record names', () => {
    // The required settings first — the app cannot convert or compute without
    // the answer — then the accounts, so the notion exists before a file that
    // names them is handed over, then the events themselves (ADR-0035).
    expect(PASSAGES).toEqual(['settings', 'accounts', 'events'])
    expect(nextPassage('settings')).toBe('accounts')
    expect(nextPassage('accounts')).toBe('events')
    expect(previousPassage('events')).toBe('accounts')
    expect(previousPassage('accounts')).toBe('settings')
  })

  it('end, rather than looping: the last passage has nothing after it', () => {
    // What that `null` is read as, one file over, is *leave* — and leaving is
    // what writes the browser's mark. A fourth passage would be a line here.
    expect(nextPassage('events')).toBeNull()
    // And the first has no way back, which is what makes the walk a sequence
    // rather than three tabs.
    expect(previousPassage('settings')).toBeNull()
  })

  it('are counted from one, because that is what a reader is told', () => {
    expect(PASSAGES.map(passageNumber)).toEqual([1, 2, 3])
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
