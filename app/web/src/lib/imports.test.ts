/**
 * What there is to hand back out (#728, #796, ADR-0032, ADR-0034).
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
 *
 * **And the accounts file left too** (ADR-0034, #817). It was the second half of
 * a round trip, and nothing reads one back in since the upload started refusing
 * a declaration by name — so what remains is one question about one file.
 */
import { describe, expect, it } from 'vitest'

import { exportable } from '@/lib/imports'
import { anEvent } from '@/test/factories'

describe('what there is to export', () => {
  it('offers the events as soon as one is recorded, whatever it came from', () => {
    expect(exportable([anEvent()])).toEqual({ events: true })
  })

  it('offers nothing at all on an empty ledger', () => {
    expect(exportable([])).toEqual({ events: false })
  })
})
