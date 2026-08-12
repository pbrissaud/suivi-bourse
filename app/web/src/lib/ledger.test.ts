/**
 * The ledger's rules, under the seam that is *no seam at all*: inputs, outputs,
 * nothing rendered (#712 Testing Decisions).
 *
 * Two of them cannot be observed from the page at all, and that is why they are
 * here: jsdom's date input sanitises `31/02/2026` to an empty string before any
 * code sees it, so *the shape is not enough* and *a day that does not exist is
 * not a day* are only assertable on the function.
 */
import { describe, expect, it } from 'vitest'

import { anEvent, aTypedEvent, ledgerEvents } from '@/test/factories'
import {
  accountOf,
  byDateDescending,
  FIELDS,
  filterEvents,
  identityOf,
  isCashEvent,
  isEditable,
  NO_FILTERS,
  parseDay,
  parseDecimal,
} from '@/lib/ledger'

describe('the fields of a type', () => {
  it('gives a transfer no security at all, and a grant an optional price', () => {
    // A `DEPOSIT` does not have a *missing* symbol: it raises no such question,
    // which is why the form drops the field rather than blanking it.
    expect(isCashEvent('DEPOSIT')).toBe(true)
    expect(isCashEvent('BUY')).toBe(false)
    expect(FIELDS.DEPOSIT).toEqual({
      security: false,
      quantity: false,
      unitPrice: 'none',
      fee: true,
      amount: true,
    })

    // The one field in the product whose **emptiness is a statement**.
    expect(FIELDS.GRANT.unitPrice).toBe('optional')
    expect(FIELDS.BUY.unitPrice).toBe('required')
    expect(FIELDS.GRANT.fee).toBe(false)
    expect(FIELDS.DIVIDEND).toMatchObject({ quantity: false, amount: true })
  })
})

describe('the identity of a row', () => {
  it('is the ticker and the label, or the label alone', () => {
    expect(identityOf(anEvent({ symbol: 'ZZA', notes: 'Ordre au marché' }))).toEqual({
      ticker: 'ZZA',
      label: 'Ordre au marché',
    })
    // No symbol at all on a transfer: the label is the whole identity.
    expect(identityOf(anEvent({ symbol: null, notes: 'Virement entrant' }))).toEqual({
      ticker: null,
      label: 'Virement entrant',
    })
    // An empty label is not a label — 7 rows of 285 carry none.
    expect(identityOf(anEvent({ notes: '  ' })).label).toBeNull()
  })

  it('says which rows the app may edit, and it is provenance that decides', () => {
    expect(isEditable(anEvent())).toBe(false)
    expect(isEditable(aTypedEvent())).toBe(true)
    // A row with no source and no key is not editable either: an install whose
    // store has no write path yet offers nothing to press.
    expect(isEditable(aTypedEvent({ id: null }))).toBe(false)
  })

  it('reads a blank account as `default`, which is the aggregator’s own rule', () => {
    expect(accountOf(anEvent({ account: '' }))).toBe('default')
    expect(accountOf(anEvent({ account: 'pea' }))).toBe('pea')
  })
})

describe('the reduction', () => {
  it('reads the label, folds accents, and drops nothing on an empty query', () => {
    const events = ledgerEvents()
    expect(filterEvents(events, NO_FILTERS)).toHaveLength(events.length)

    // Two purchases of the same security on the same account: the label is the
    // only discriminant the rows own.
    expect(filterEvents(events, { ...NO_FILTERS, query: 'programmé' })).toHaveLength(1)
    expect(filterEvents(events, { ...NO_FILTERS, query: 'EXECUTION' })).toHaveLength(1)
    expect(filterEvents(events, { ...NO_FILTERS, type: 'DEPOSIT' })).toHaveLength(1)
    expect(filterEvents(events, { ...NO_FILTERS, account: 'alpha' })).toHaveLength(events.length)
  })

  it('sorts by date descending, and keeps the store’s order inside a day', () => {
    const sorted = byDateDescending([
      anEvent({ notes: 'b', date: '2025-01-01' }),
      anEvent({ notes: 'a', date: '2026-01-01' }),
      anEvent({ notes: 'c', date: '2025-01-01' }),
    ])
    // Two events of one day keep the order the aggregator sorted them in —
    // re-deciding it here would make the ledger disagree with the replay.
    expect(sorted.map((event) => event.notes)).toEqual(['a', 'b', 'c'])
  })
})

describe('the two parses', () => {
  it('refuses a day that is not one, whatever its shape', () => {
    expect(parseDay('2026-02-20')).toBe('2026-02-20')
    // February has no 31st, and the shape alone would have let it through.
    expect(parseDay('2026-02-31')).toBeNull()
    expect(parseDay('20/02/2026')).toBeNull()
    expect(parseDay('')).toBeNull()
    expect(parseDay('0000-00-00')).toBeNull()
  })

  it('takes the comma a French reader types, and refuses what is not a number', () => {
    expect(parseDecimal('250,50')).toBe(250.5)
    expect(parseDecimal('1 250.5')).toBe(1250.5)
    expect(parseDecimal('-3')).toBe(-3)
    expect(parseDecimal('')).toBeNull()
    expect(parseDecimal('deux cents')).toBeNull()
    expect(parseDecimal('12,5,5')).toBeNull()
  })
})
