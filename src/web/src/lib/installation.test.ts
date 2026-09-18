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

import type { RuntimeState, SettingDescription } from '@/lib/api'
import { cadenceReach, changedValues, draftFrom } from '@/lib/installation'
import { aRuntime, defaultSettings } from '@/test/factories'

function runtimeWith(symbols: RuntimeState['symbols']): RuntimeState {
  return aRuntime({ symbols })
}

function symbol(overrides: Partial<RuntimeState['symbols'][number]> = {}) {
  return { symbol: 'ZZA', next_run: null, failure_count: 0, closed: false, held: true, ...overrides }
}

describe('what a new cadence reaches', () => {
  it('splits on the last pass’s market state, and the two add up', () => {
    const reach = cadenceReach(
      runtimeWith([
        symbol({ symbol: 'ZZA', closed: false }),
        symbol({ symbol: 'ZZB', closed: false }),
        symbol({ symbol: 'ZZC', closed: true }),
      ]),
    )

    // The property that lets a reader tell *asleep* from *misconfigured*.
    expect(reach).toEqual({ now: 2, atMarketOpen: 1 })
    expect((reach?.now ?? 0) + (reach?.atMarketOpen ?? 0)).toBe(3)
  })

  it('counts a symbol that has never completed a pass as reached', () => {
    // It is armed to fire immediately, so it reads the new value on a pass that
    // has already begun. Re-arming it would push the bootstrap a whole cadence
    // into the future.
    expect(cadenceReach(runtimeWith([symbol({ closed: null })]))).toEqual({
      now: 1,
      atMarketOpen: 0,
    })
  })

  it('leaves a sold line out of both figures', () => {
    // The backfill's set is no longer the scrape's: a sold line is
    // reconstructed and not polled, so no cadence reaches it either way.
    expect(cadenceReach(runtimeWith([symbol({ held: false, closed: true })]))).toEqual({
      now: 0,
      atMarketOpen: 0,
    })
  })

  it('says nothing at all while the runtime read has not landed', () => {
    // A read that has not landed is not a fact — `0 titres` would be a claim.
    expect(cadenceReach(undefined)).toBeNull()
  })
})

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
    expect(changedValues(settings, { ...draftFrom(settings), regular_interval: ' 120 ' })).toEqual({})
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
