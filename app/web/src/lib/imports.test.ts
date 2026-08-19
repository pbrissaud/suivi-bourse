import { describe, expect, it } from 'vitest'

import type { Account, LedgerEvent } from '@/lib/api'
import { exportable, importRows, orderedImports, revocationOf } from '@/lib/imports'
import {
  anAccount,
  anAccountsPayload,
  anEvent,
  aFileAccount,
  anImport,
  aTypedEvent,
  theSeededAccount,
} from '@/test/factories'

const EVENTS_SOURCE = anImport({ id: 1, filename: 'zeta-events_2.csv', kind: 'events', events: 3 })
const ACCOUNTS_SOURCE = anImport({ id: 2, filename: 'zeta-accounts.csv', kind: 'accounts', events: 0 })

function ledger(): LedgerEvent[] {
  return [
    anEvent({ source_id: 1, account: 'alpha', symbol: 'ZZA' }),
    anEvent({ source_id: 1, account: 'alpha', symbol: 'ZZB' }),
    anEvent({ source_id: 1, account: 'beta', symbol: 'ZZA' }),
    aTypedEvent({ account: 'alpha', symbol: 'ZZA' }),
  ]
}

function accounts(rows: Account[] = [anAccount({ id: 'alpha' }), aFileAccount({ id: 'beta', source_id: 2 })]) {
  return anAccountsPayload(rows)
}

describe('the order of the list', () => {
  it('puts the accounts sources first, then sorts on the name', () => {
    // Not a rendering choice: `event.account` references `account(id)`, so the
    // accounts sources are what an import has to read first — the order the
    // foreign key imposes, shown as it is.
    const rows = orderedImports([
      anImport({ id: 3, filename: 'b.csv', kind: 'events' }),
      anImport({ id: 4, filename: 'a.csv', kind: 'events' }),
      anImport({ id: 5, filename: 'z-accounts.csv', kind: 'accounts' }),
      anImport({ id: 6, filename: 'a-accounts.csv', kind: 'accounts' }),
    ])

    expect(rows.map((record) => record.filename)).toEqual([
      'a-accounts.csv',
      'z-accounts.csv',
      'a.csv',
      'b.csv',
    ])
  })
})

describe('what a revocation takes with it, counted before it is made', () => {
  it('counts the events, the securities and the accounts that leave the allocation', () => {
    const revocation = revocationOf(EVENTS_SOURCE, ledger(), accounts())

    expect(revocation).toEqual({
      kind: 'offered',
      effect: {
        events: 3,
        // `ZZA` survives on the typed row; `ZZB` is named by nothing else.
        symbols: 1,
        // `alpha` survives on the typed row; `beta` is named by nothing else.
        accounts: 1,
        frees: ['beta'],
      },
    })
  })

  it('counts the accounts an accounts source declared, which carries no event', () => {
    // An accounts source lays down no event at all, so counting its effect off
    // the ledger alone would answer *nothing happens* about a gesture that
    // removes a declared row.
    const revocation = revocationOf(ACCOUNTS_SOURCE, [], accounts())

    expect(revocation).toEqual({
      kind: 'offered',
      effect: { events: 0, symbols: 0, accounts: 1, frees: [] },
    })
  })

  it('names the account an event holds, rather than offering a gesture the server refuses', () => {
    // `accounts.delete_account` refuses to retire an account an event names, and
    // the cascade is refused with it: forgetting the accounts file is a `409`
    // while an event names `beta`. A control the app knows will be refused
    // teaches nothing by being there; the count is what the owner has to act on.
    expect(revocationOf(ACCOUNTS_SOURCE, ledger(), accounts())).toEqual({
      kind: 'namedByEvents',
      count: 1,
    })
  })

  it('frees an account no event will name any more, and nothing else', () => {
    // The ticket's own example: an account **another file** declares, whose
    // events come from this one. It is undeletable *while an event names it* —
    // so forgetting these events changes the deletability of a row the gesture
    // never touches, which is the one consequence a reader cannot foresee.
    // `alpha` survives on the typed row and is therefore not one of them.
    const revocation = revocationOf(EVENTS_SOURCE, ledger(), accounts())

    expect(revocation.kind === 'offered' && revocation.effect.frees).toEqual(['beta'])
  })

  it('never frees the seeded account, which is not removable at all', () => {
    const rows = accounts([theSeededAccount(), anAccount({ id: 'alpha' })])
    const events = [anEvent({ source_id: 1, account: 'default', symbol: 'ZZA' })]

    const revocation = revocationOf(EVENTS_SOURCE, events, rows)
    expect(revocation.kind === 'offered' && revocation.effect.frees).toEqual([])
  })
})

describe('the rows the block renders', () => {
  it('carries each record with its own revocation, in the order the list shows', () => {
    const rows = importRows([EVENTS_SOURCE, ACCOUNTS_SOURCE], ledger(), accounts())

    expect(rows.map((row) => row.record.id)).toEqual([2, 1])
    expect(rows.map((row) => row.revocation.kind)).toEqual(['namedByEvents', 'offered'])
  })

  it('is empty while the reads have not landed, and says so by being empty', () => {
    expect(importRows(null, ledger(), accounts())).toEqual([])
    // **The declaration is one of those reads**, and it is the one the verdict
    // rests on: read as *nothing is declared*, a source whose accounts an event
    // holds renders the gesture the server answers a `409` to, and its box states
    // *« Retire 0 compte déclaré »* — a claim about the reader's data made on a
    // silence. The net cannot see it: the same words exist once it has landed.
    expect(importRows([EVENTS_SOURCE], ledger(), null)).toEqual([])
  })
})

describe('the seeded account is not a subject of any of this', () => {
  it('forgets a file that took `default` over, however many events name it', () => {
    // `accounts._retire` excludes `default` **by name**: the row every install
    // has is never removed and never refused, and a file that declared it hands
    // it back to the seed instead. Refusing here would make that file
    // permanently unforgettable — and on an install that declares nothing every
    // event names `default`, a blank account resolving to it.
    const takenOver = anAccountsPayload([theSeededAccount({ source_id: 2, editable: false })])
    const events = [anEvent({ source_id: 1, account: '' }), anEvent({ source_id: 1, account: 'default' })]

    expect(revocationOf(ACCOUNTS_SOURCE, events, takenOver)).toEqual({
      kind: 'offered',
      effect: { events: 0, symbols: 0, accounts: 0, frees: [] },
    })
  })

  it('never counts it among the accounts a revocation removes from the allocation', () => {
    // ADR-0013 seeds it and never removes it, so announcing it as leaving is a
    // statement about a row that stays.
    const only = anAccountsPayload([theSeededAccount()])
    const events = [anEvent({ source_id: 1, account: 'default', symbol: 'ZZA' })]

    expect(revocationOf(EVENTS_SOURCE, events, only)).toEqual({
      kind: 'offered',
      effect: { events: 1, symbols: 1, accounts: 0, frees: [] },
    })
  })
})

describe('what there is to export', () => {
  it('offers the events as soon as one is recorded, whatever it came from', () => {
    expect(exportable([anEvent()], accounts())).toEqual({ events: true, accounts: true })
  })

  it('does not offer the accounts file on an install that has declared nothing', () => {
    // The seeded row is not a declaration (ADR-0013), so the file would be a
    // header row with no rows under it — and v4's loader refuses the whole
    // directory over it, which is the round trip this export exists for.
    expect(exportable([anEvent()], anAccountsPayload([theSeededAccount()], false))).toEqual({
      events: true,
      accounts: false,
    })
  })

  it('offers nothing at all on an empty ledger', () => {
    expect(exportable([], anAccountsPayload([theSeededAccount()], false))).toEqual({
      events: false,
      accounts: false,
    })
  })
})
