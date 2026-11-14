/**
 * The settings surface's two decisions, pinned under the page (#724, #701).
 *
 * Both prevent a save that looks like nothing from outside: the reach, because
 * a portfolio-wide dial that touches part of the portfolio has to say so; and
 * *only what moved*, because `reschedule_job` recomputes the next run from
 * **now** — a form that posted every field would reset every timer on every
 * click, invisibly.
 */
import { describe, expect, it } from 'vitest'

import type { SettingDescription } from '@/features/settings/lib/api'
import { changedValues, draftFrom } from '@/features/settings/lib/installation'
import { defaultSettings } from '@/test/factories'

describe('what the form sends', () => {
  const settings: SettingDescription[] = defaultSettings()

  it('is only what moved', () => {
    const draft = { ...draftFrom(settings), regular_interval: '300' }

    expect(changedValues(settings, draft)).toEqual({ regular_interval: '300' })
  })

  it('is empty when nothing was typed', () => {
    expect(changedValues(settings, draftFrom(settings))).toEqual({})
  })

  it('reads a re-typed identical value as no change at all', () => {
    // The comparison is against the store's **effective** value, so re-posting
    // `120` on a dial that already reads `120` reports no change — and re-arms
    // nothing.
    expect(changedValues(settings, { ...draftFrom(settings), regular_interval: ' 120 ' })).toEqual(
      {},
    )
  })

  it('never reads an emptied field as a request for the default', () => {
    // The write path refuses a blank, and reading one as *give me the default*
    // would make an accidental clear and a deliberate reset the same gesture.
    expect(changedValues(settings, { ...draftFrom(settings), base_currency: '' })).toEqual({})
  })

  it('sends the blank that unsets a dial with no default and no obligation', () => {
    // The other direction of the same rule (#982). `benchmark_symbol` has
    // nothing to fall back to, so emptying its field is the *only* way to say
    // "no reference" — and if the form drops it here, the gesture the help text
    // promises never leaves the browser.
    const answered = settings.map((setting) =>
      setting.key === 'benchmark_symbol' ? { ...setting, value: 'CW8.PA', stored: true } : setting,
    )

    expect(changedValues(answered, { ...draftFrom(answered), benchmark_symbol: '' })).toEqual({
      benchmark_symbol: '',
    })
  })

  it('reads emptying an already empty dial as no change', () => {
    // Unset and unset is not a move: posting it would re-arm the cycle for
    // nothing.
    expect(changedValues(settings, { ...draftFrom(settings), benchmark_symbol: '' })).toEqual({})
  })

  it('starts a dial with no stored answer from an empty field', () => {
    const unanswered = settings.map((setting) =>
      setting.key === 'base_currency' ? { ...setting, value: null, stored: false } : setting,
    )

    // *Not answered yet* and *answered* have to stay two states.
    expect(draftFrom(unanswered).base_currency).toBe('')
    expect(changedValues(unanswered, { ...draftFrom(unanswered), base_currency: 'usd' })).toEqual({
      base_currency: 'usd',
    })
  })
})
