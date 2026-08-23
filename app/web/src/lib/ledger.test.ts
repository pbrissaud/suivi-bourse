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

import { aLongLedger, anEvent, aTypedEvent, ledgerEvents } from '@/test/factories'
import {
  accountOf,
  byDateDescending,
  exportHref,
  FIELDS,
  filterEvents,
  identityOf,
  isEditable,
  NO_FILTERS,
  PAGE,
  parseDay,
  parseDecimal,
  reveal,
  selectionParams,
  filtersFromSearch,
  ledgerSearchOf,
  validateLedgerSearch,
} from '@/lib/ledger'

describe('the fields of a type', () => {
  it('gives a transfer no security at all, and a grant an optional price', () => {
    // A `DEPOSIT` does not have a *missing* symbol: it raises no such question,
    // which is why the form drops the field rather than blanking it.
    expect(FIELDS.DEPOSIT.security).toBe(false)
    expect(FIELDS.BUY.security).toBe(true)
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

  it('reduces to a whole set of securities, cash movements excluded', () => {
    const events = ledgerEvents()

    // The set and not one of it: the notice that produces this reduction names
    // every security it concerns, and the search is single-term, which is why
    // this is a dimension of its own rather than a word in the query.
    expect(filterEvents(events, { ...NO_FILTERS, symbols: ['ZZA', 'ZZB', 'ZZC'] })).toHaveLength(3)
    expect(filterEvents(events, { ...NO_FILTERS, symbols: ['ZZC'] })).toHaveLength(1)
    // A transfer names no security at all — not a missing one, none — so a
    // reduction to securities drops it rather than keeping it as unclassified.
    expect(
      filterEvents(events, { ...NO_FILTERS, symbols: ['ZZA', 'ZZB', 'ZZC'] }).some(
        (event) => event.event_type === 'DEPOSIT',
      ),
    ).toBe(false)
    // `null` is *every security*, and it is not the same object as the empty
    // set: one reduces nothing, the other would empty the table.
    expect(filterEvents(events, { ...NO_FILTERS, symbols: null })).toHaveLength(events.length)
    expect(filterEvents(events, { ...NO_FILTERS, symbols: [] })).toHaveLength(0)
  })

  it('reduces to a period, and both bounds retain the day they name', () => {
    const events = ledgerEvents()

    // 2026-02-10, 2026-01-12, 2026-01-05 and 2025-12-24 — the interval below
    // names its two ends, and a half-open reading would drop one of them.
    expect(
      filterEvents(events, { ...NO_FILTERS, since: '2025-12-24', until: '2026-01-12' }).map(
        (event) => event.date,
      ),
    ).toEqual(['2026-01-12', '2026-01-05', '2025-12-24'])
    // One bound alone opens the interval on the other side — *everything since
    // January*, which is a legitimate reduction and not half of a pair.
    expect(filterEvents(events, { ...NO_FILTERS, since: '2026-01-06' })).toHaveLength(2)
    expect(filterEvents(events, { ...NO_FILTERS, until: '2025-12-31' })).toHaveLength(1)
    // Composed with the four others: one reduction, and it is an intersection.
    expect(
      filterEvents(events, { ...NO_FILTERS, type: 'DEPOSIT', since: '2026-01-01' }),
    ).toHaveLength(1)
    expect(
      filterEvents(events, { ...NO_FILTERS, type: 'DEPOSIT', since: '2026-01-06' }),
    ).toHaveLength(0)
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

describe('the reveal, which is a rendering budget and not a fetch', () => {
  it('draws forty of a longer reduction and says so, without claiming the end', () => {
    const long = aLongLedger(176)
    const first = reveal(long, PAGE)

    expect(PAGE).toBe(40)
    expect(first.rows).toHaveLength(40)
    // The two numbers the sentence under the table is made of, and they are
    // both about the reduction handed in — nothing here knows what the store
    // holds.
    expect(first.shown).toBe(40)
    expect(first.total).toBe(176)
    expect(first.atEnd).toBe(false)
  })

  it('says the end exactly when the last row of the reduction is drawn', () => {
    const long = aLongLedger(80)

    expect(reveal(long, 79).atEnd).toBe(false)
    expect(reveal(long, 80).atEnd).toBe(true)
    // A budget wider than the reduction is the whole of it, never a hole: the
    // reader who revealed 120 rows and then narrowed the chips is exactly this
    // call.
    const beyond = reveal(long, 120)
    expect(beyond.rows).toHaveLength(80)
    expect(beyond.shown).toBe(80)
    expect(beyond.atEnd).toBe(true)
  })

  it('draws nothing rather than slicing from the end on a budget below zero', () => {
    // `slice(0, -1)` drops the last row and returns the rest, which is the one
    // way this could fail silently: a reader would see a table one row short
    // and nothing would say why.
    expect(reveal(aLongLedger(5), -1).rows).toEqual([])
    expect(reveal(aLongLedger(5), -1).atEnd).toBe(false)
  })

  it('is the end of an empty reduction, which has no next row to promise', () => {
    // Nothing renders it — a reduction with no row is the *no match* state one
    // level up — but the predicate has to be true here, or a table showing
    // nothing would offer to show more of it.
    expect(reveal([], PAGE)).toEqual({ rows: [], shown: 0, total: 0, atEnd: true })
  })

  it('reveals the reduction, so the count follows the chips rather than the store', () => {
    const all = byDateDescending(ledgerEvents())
    const deposits = filterEvents(all, { ...NO_FILTERS, type: 'DEPOSIT' })

    expect(reveal(all, PAGE).total).toBe(4)
    expect(reveal(deposits, PAGE).total).toBe(1)
  })
})


describe('the reduction as the export takes it', () => {
  it('sends nothing at all when nothing is held back', () => {
    // Which is what tells the server it is serving a **backup** rather than a
    // selection, and therefore which of the two names the file takes.
    expect(selectionParams(NO_FILTERS).toString()).toBe('')
    expect(exportHref('/api/export/events.csv', NO_FILTERS)).toBe('/api/export/events.csv')
  })

  it('puts the period on the export’s own address, which is how a year leaves', () => {
    expect(
      exportHref('/api/export/events.csv', {
        ...NO_FILTERS,
        since: '2025-01-01',
        until: '2025-12-31',
      }),
    ).toBe('/api/export/events.csv?since=2025-01-01&until=2025-12-31')
  })

  it('carries the five names the chips hold, the securities one repeated', () => {
    const params = selectionParams({
      query: 'zza',
      type: 'BUY',
      account: 'beta',
      symbols: ['ZZA', 'ZZB'],
      since: '2025-01-01',
      until: '2025-12-31',
    })

    expect(params.get('q')).toBe('zza')
    expect(params.get('type')).toBe('BUY')
    expect(params.get('account')).toBe('beta')
    // Repeated and singular — the spelling `GET /api/events?symbol=` already
    // uses on this collection, and the one `events/export.py` reads.
    expect(params.getAll('symbol')).toEqual(['ZZA', 'ZZB'])
    // `since`/`until` and not `from`/`to`: the server's `Selection` is a
    // `NamedTuple` and `from` is a Python keyword, so one vocabulary means the
    // pair of names both sides can spell.
    expect(params.get('since')).toBe('2025-01-01')
    expect(params.get('until')).toBe('2025-12-31')
  })

  it('sends one bound alone, an interval open on the other side', () => {
    expect(selectionParams({ ...NO_FILTERS, since: '2026-01-01' }).toString()).toBe(
      'since=2026-01-01',
    )
    expect(selectionParams({ ...NO_FILTERS, until: '2026-01-01' }).toString()).toBe(
      'until=2026-01-01',
    )
  })

  it('leaves a query of spaces out, a reduction being what actually reduces', () => {
    // `filterEvents` trims before searching, so a field holding two spaces
    // retains every row. Sent, it would name the file a selection and give the
    // reader a partial-looking backup of the whole ledger.
    expect(selectionParams({ ...NO_FILTERS, query: '   ' }).toString()).toBe('')
  })
})

describe('the address of a reduced ledger', () => {
  it('is the export’s own three parameters, blank counting as unset', () => {
    expect(validateLedgerSearch({ q: 'ZZA', type: 'buy', account: 'alpha' })).toEqual({
      q: 'ZZA',
      type: 'BUY',
      account: 'alpha',
    })
    // Blank is unset, which is the server's own reading of `?type=&account=`.
    expect(validateLedgerSearch({ q: '  ', type: '', account: ' ' })).toEqual({})
    // A word that is not one of the six types reduces nothing rather than
    // reducing to nothing: the closed set is the only member that has one.
    expect(validateLedgerSearch({ type: 'CROISSANCE' })).toEqual({})
    expect(validateLedgerSearch({ q: 42, account: ['alpha'] })).toEqual({})
  })

  it('is `null` where nothing reduces, and a whole reduction where something does', () => {
    expect(filtersFromSearch({})).toBeNull()
    expect(filtersFromSearch({ q: 'ZZA', type: 'BUY', account: 'alpha' })).toEqual({
      query: 'ZZA',
      type: 'BUY',
      account: 'alpha',
      // The one dimension with no address: it arrives from a gesture made on
      // the page itself and has never needed one.
      symbols: null,
      // Named by no bound, so the address reduces on nothing here either.
      since: null,
      until: null,
    })
    expect(filtersFromSearch({ account: 'alpha' })).toEqual({ ...NO_FILTERS, account: 'alpha' })
  })

  it('round-trips the reduction it carries', () => {
    const filters: typeof NO_FILTERS = {
      query: 'Virement',
      type: 'DEPOSIT',
      account: 'default',
      symbols: null,
      since: '2025-12-01',
      until: '2026-01-31',
    }
    expect(filtersFromSearch(ledgerSearchOf(filters))).toEqual(filters)
    expect(ledgerSearchOf(NO_FILTERS)).toEqual({})
  })

  it('carries a period alone, and refuses a bound that is not a day', () => {
    // The period is a reduction of its own: an address holding nothing else
    // still describes a shorter ledger, so it has to answer as one.
    expect(validateLedgerSearch({ since: '2026-01-05', until: '2026-02-10' })).toEqual({
      since: '2026-01-05',
      until: '2026-02-10',
    })
    expect(filtersFromSearch({ since: '2026-01-05' })).toEqual({
      ...NO_FILTERS,
      since: '2026-01-05',
    })
    // Blank is unset, and a word or a day that does not exist reduces
    // **nothing** rather than reducing to nothing: the page still renders the
    // ledger the link was pointing at.
    expect(validateLedgerSearch({ since: '  ', until: 'hier' })).toEqual({})
    expect(validateLedgerSearch({ since: '2026-02-31' })).toEqual({})
    expect(validateLedgerSearch({ until: 20260210 })).toEqual({})
  })
})
