/**
 * What the palette offers, under the seam that is *no seam at all*: inputs,
 * outputs, nothing rendered (#712 Testing Decisions, #797).
 *
 * The three sections that read are built here rather than in the component for
 * the reason every other `lib/` module exists: a rule written in a render is a
 * rule re-decided per section.
 */
import { describe, expect, it } from 'vitest'

import { anEvent, aPosition, ledgerEvents } from '@/test/factories'
import { NO_FILTERS, selectionParams } from '@/lib/ledger'
import {
  accountsMatching,
  eventReduction,
  eventsMatching,
  EVENTS_SHOWN,
  heldTitles,
  matchesQuery,
  SHARES_SHOWN,
  titlesMatching,
} from '@/lib/palette'

describe('what the palette matches on', () => {
  it('folds the accents and the case, and an empty query matches everything', () => {
    expect(matchesQuery('societe', ['Société Générale'])).toBe(true)
    expect(matchesQuery('GÉNÉRALE', ['Société Générale'])).toBe(true)
    expect(matchesQuery('', ['Société Générale'])).toBe(true)
    expect(matchesQuery('zzz', ['Société Générale', null, undefined])).toBe(false)
  })
})

describe('the titles the palette offers', () => {
  it('is a symbol and not a line: two accounts holding it are one entry', () => {
    const titles = heldTitles([
      aPosition({ account: 'alpha', symbol: 'ZZA', name: 'Zeta Alpha' }),
      aPosition({ account: 'beta', symbol: 'ZZA', name: 'Zeta Alpha' }),
      aPosition({ account: 'beta', symbol: 'ZZB', name: 'Zeta Beta' }),
    ])
    expect(titles).toEqual([
      { symbol: 'ZZA', name: 'Zeta Alpha' },
      { symbol: 'ZZB', name: 'Zeta Beta' },
    ])
  })

  it('is **held**, so a position sold out of is not one of them', () => {
    // The palette reaches what the owner owns; a closed line is a row of the
    // shares page's folded section and nothing the reader is looking for here.
    const titles = heldTitles([
      aPosition({ account: 'alpha', symbol: 'ZZA' }),
      aPosition({ account: 'alpha', symbol: 'ZZD', quantity: 0, closed_at: '2025-04-01' }),
    ])
    expect(titles.map((title) => title.symbol)).toEqual(['ZZA'])
  })

  it('matches the ticker and the name alike, and never offers more than five', () => {
    const titles = heldTitles([
      aPosition({ symbol: 'ZZA', name: 'Zeta Alpha' }),
      aPosition({ symbol: 'ZZB', name: 'Zeta Beta' }),
    ])
    expect(titlesMatching(titles, 'zzb')).toEqual([{ symbol: 'ZZB', name: 'Zeta Beta' }])
    expect(titlesMatching(titles, 'alpha')).toEqual([{ symbol: 'ZZA', name: 'Zeta Alpha' }])

    const many = Array.from({ length: 12 }, (_, index) =>
      aPosition({ symbol: `Z${index}`, name: `Zeta ${index}` }),
    )
    expect(titlesMatching(heldTitles(many), '')).toHaveLength(SHARES_SHOWN)
  })
})

describe('the accounts the palette offers', () => {
  it('matches what the account is called and what it is addressed by', () => {
    const accounts = [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' },
    ]
    expect(accountsMatching(accounts, 'bet')).toEqual([{ id: 'beta', name: 'Beta' }])
    // The id is a name too: it is what the ledger's own column shows.
    expect(accountsMatching(accounts, 'alph')).toEqual([{ id: 'alpha', name: 'Alpha' }])
    expect(accountsMatching(accounts, '')).toHaveLength(2)
  })
})

describe('the events the palette offers', () => {
  it('says nothing at all until something is typed', () => {
    // Two hundred and eighty-five rows under a blank field is not a section,
    // and the ledger is one route away for whoever wants the whole of it.
    expect(eventsMatching(ledgerEvents(), '')).toEqual([])
    expect(eventsMatching(ledgerEvents(), '   ')).toEqual([])
  })

  it('reads what the ledger reads, newest first, capped', () => {
    const found = eventsMatching(ledgerEvents(), 'virement')
    expect(found).toHaveLength(1)
    expect(found[0].event_type).toBe('DEPOSIT')

    const many = Array.from({ length: 9 }, (_, index) =>
      anEvent({ date: `2026-01-0${index + 1}`, symbol: 'ZZA' }),
    )
    const capped = eventsMatching(many, 'zza')
    expect(capped).toHaveLength(EVENTS_SHOWN)
    // Date descending, the ledger's own and only ordering.
    expect(capped[0].date).toBe('2026-01-09')
  })
})

describe('the reduction an event leads to', () => {
  it('is the event’s three coordinates, and never a fourth', () => {
    expect(eventReduction(anEvent({ symbol: 'ZZA', event_type: 'BUY', account: 'alpha' }))).toEqual({
      ...NO_FILTERS,
      query: 'ZZA',
      type: 'BUY',
      account: 'alpha',
    })
  })

  it('takes the label where the event names no security', () => {
    const reduction = eventReduction(
      anEvent({ symbol: null, event_type: 'DEPOSIT', notes: 'Virement entrant', account: '' }),
    )
    expect(reduction.query).toBe('Virement entrant')
    expect(reduction.type).toBe('DEPOSIT')
    // A blank account is `default`, which is the aggregator's own rule.
    expect(reduction.account).toBe('default')
  })

  it('is expressible as the export resource’s own parameters', () => {
    // Which is the whole reason it is made of the ledger's four dimensions: the
    // address of a reduced ledger is the query string of its own export.
    const params = selectionParams(eventReduction(anEvent({ symbol: 'ZZA', account: 'alpha' })))
    expect(params.get('q')).toBe('ZZA')
    expect(params.get('type')).toBe('BUY')
    expect(params.get('account')).toBe('alpha')
    expect(params.getAll('symbol')).toEqual([])
  })
})
