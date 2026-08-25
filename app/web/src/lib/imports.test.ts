/**
 * What there is to hand back out (#728, #796, ADR-0032).
 *
 * **The rest of this file left with the sources** (#816). It held the order of
 * the imported-files list, what a revocation would take with it counted before
 * it was made, the refusal the server would answer, and which accounts the
 * gesture freed — every one of them a statement about a *source*, and there is
 * no source any more: a file is handed over once, parsed, and never seen again.
 * The gesture that replaced the revocation is the deletion on the ledger's own
 * reduction, and it is tested where it lives (`data.test.tsx`).
 *
 * They disappear without replacement, which #803 says of them by name: their
 * subject no longer exists.
 */
import { describe, expect, it } from 'vitest'

import { exportable } from '@/lib/imports'
import { anAccount, anAccountsPayload, anEvent, theSeededAccount } from '@/test/factories'

describe('what there is to export', () => {
  it('offers the events as soon as one is recorded, whatever it came from', () => {
    expect(exportable([anEvent()], anAccountsPayload([anAccount({ id: 'alpha' })]))).toEqual({
      events: true,
      accounts: true,
    })
  })

  it('does not offer the accounts file on an install that has declared nothing', () => {
    // The seeded row is not a declaration (ADR-0013), so the file would be a
    // header row with no rows under it.
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

  it('withholds the accounts file while the declaration has not landed', () => {
    // ADR-0026, one notch down: `null` is *the read is in flight*, and a band
    // that offered the file then would state something about the reader's own
    // data on a silence.
    expect(exportable([anEvent()], null)).toEqual({ events: true, accounts: false })
  })
})
