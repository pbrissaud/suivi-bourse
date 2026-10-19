/**
 * **One component draws a share** (#800), held on the source because nothing
 * makes it true by construction and no rendering test can see it.
 *
 * The rule is the ticket's central criterion and its reason is the product's
 * own history: `Stat`, `EmptyState`, `Refusal` and `EntryPair` all exist because
 * the prototype held four copies of one thing, and a share bar written three
 * times diverges three times. It had already started — the allocation's legend
 * wrote none, the rail wrote one, and the account's composition wrote a second
 * with its own height, its own clamp and its own answer to a missing whole.
 *
 * A rendering test cannot hold it. A bar is `aria-hidden` and carries no word,
 * so `readsInFlight.test.tsx`, which reads every rendered phrase, walks past it
 * exactly as it walks past a spinner — which is the gap `lint/no-wait-dressing.grit` was
 * written for, one file over. What is left to assert is the shape of the
 * *source*: a percentage width, computed and written into a `style`, is what a
 * hand-written share bar is made of, and there is one place it belongs.
 *
 * **There is no hand-written bar left.** The accounts rail drew its accounts
 * as adjacent segments closing a whole, and was the one exemption of
 * `lint/share-width.grit`; it went with the rail (#1277), the chips of the
 * accounts bar carrying their share as a figure. The gain's breakdown drew a
 * cascade here once (#1143) and is a statement with no drawing since #1175.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * The surfaces that draw a share, spelled out — the other half of the rule.
 *
 * Refusing hand-written bars everywhere says nothing about there being a bar at
 * all: delete `<ShareBar />` from the allocation's legend and every other test
 * still passes, the drawing carrying no word for a rendering test to miss. The
 * shares table's `Poids` column joined the list at #791,
 * left when the column did, came back with it at #832 and has left with it again
 * (#831, the maquette read rendered): the weight of a line is drawn on that page
 * by the allocation's legend above the table now, and `AccountDetail` is where a
 * per-line share is still a cell: the weight of each of its lines, and the
 * dividend payers' (the account's composition split went at #1277).
 */
const MOUNTS = [
  'src/features/shares/components/Allocation.tsx',
  'src/features/accounts/components/AccountDetail.tsx',
]

describe('one component draws a share', () => {
  // `leaves every share bar to the primitive` is a Biome rule now: lint/share-width.grit

  it.each(MOUNTS)('is mounted by %s, which draws a share', (file) => {
    expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).toContain('<ShareBar')
  })
})
