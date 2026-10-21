/**
 * What there is to hand back out (#728, #796).
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
 * **And the accounts file left too** (#817). It was the second half of
 * a round trip, and nothing reads one back in since the upload started refusing
 * a declaration by name — so what remains is one question about one file.
 */
import { describe, expect, it } from 'vitest'

import {
  accountLines,
  acrossFiles,
  correspondenceOf,
  exportable,
  keptAsOne,
  repeatGroups,
  unanswered,
} from '@/features/data/lib/imports'
import { aDuplicateRow, anEvent } from '@/test/factories'

describe('what there is to export', () => {
  it('offers the events as soon as one is recorded, whatever it came from', () => {
    expect(exportable([anEvent()])).toEqual({ events: true })
  })

  it('offers nothing at all on an empty ledger', () => {
    expect(exportable([])).toEqual({ events: false })
  })
})

/**
 * **The correspondence, as arithmetic** (#835).
 *
 * What blocks the button is a property of this list and not of a rendered
 * control, so it is asserted here — where the two states that look alike on
 * screen, *nothing chosen* and *the account whose id is empty*, are told apart
 * by the type itself.
 */
describe('where each account of the file goes', () => {
  const declared = new Set(['default', 'pea'])

  it('leaves a declared account where its own rows would land', () => {
    const [line] = accountLines([{ name: 'pea', rows: 12 }], declared, true)

    expect(line.settled).toBe(true)
    expect(line.target).toEqual({ kind: 'account', id: 'pea' })
    expect(unanswered([line])).toEqual([])
  })

  it('asks about an account nobody has declared', () => {
    const [line] = accountLines([{ name: 'TR', rows: 47 }], declared, true)

    expect(line.settled).toBe(false)
    expect(line.target).toEqual({ kind: 'unanswered' })
    // And the volume travels with the question, because it is what makes it
    // answerable: *where do these 47 events go* rather than *where does TR go*.
    expect(line.rows).toBe(47)
  })

  it('reads the blank column against the declaration and never on its own', () => {
    // #698's rule, and it is the reason the blank is a line rather than a case
    // swallowed early: the **same file** is settled on a fresh install and a
    // question on the one that has since declared an account.
    const [fresh] = accountLines([{ name: '', rows: 3 }], new Set(['default']), false)
    const [asked] = accountLines([{ name: '', rows: 3 }], declared, true)

    expect(fresh.target).toEqual({ kind: 'account', id: 'default' })
    expect(asked.target).toEqual({ kind: 'unanswered' })
  })

  it('carries every answered line, and the ones that were never a question', () => {
    // A request that says where each of the file's accounts goes is one the
    // server judges whole; stating only the changes would make *left as it was*
    // and *sent back to itself* two spellings of one thing.
    const lines = accountLines(
      [
        { name: '', rows: 3 },
        { name: 'TR', rows: 47 },
        { name: 'pea', rows: 12 },
      ],
      declared,
      true,
      { '': { kind: 'account', id: 'pea' }, TR: { kind: 'declare' } },
    )

    expect(correspondenceOf(lines)).toEqual({
      mapping: { '': 'pea', pea: 'pea' },
      declaring: ['TR'],
    })
    expect(unanswered(lines)).toEqual([])
  })

  it('keeps a line unanswered until the reader answers it', () => {
    const lines = accountLines(
      [
        { name: 'TR', rows: 47 },
        { name: 'CTO', rows: 8 },
      ],
      declared,
      true,
      { TR: { kind: 'account', id: 'pea' } },
    )

    expect(unanswered(lines).map((line) => line.name)).toEqual(['CTO'])
    expect(correspondenceOf(lines)).toEqual({ mapping: { TR: 'pea' }, declaring: [] })
  })
})

describe('the groups a batch repeats (#1266)', () => {
  const copy = (repeat_of: number, file: number, repeat_of_file: number) =>
    aDuplicateRow({ duplicate_of: null, repeat_of, file, repeat_of_file })

  it('names every file a group touches, the first copy’s included, in order', () => {
    // Three copies over three files: the first copy is in file 2 and is not a row.
    const rows = [copy(4, 0, 2), copy(4, 1, 2)]

    expect(repeatGroups(rows)).toMatchObject([{ first: 4, copies: 3, files: [0, 1, 2] }])
  })

  it('keeps one copy of the groups spanning files, until the reader says otherwise', () => {
    const rows = [copy(0, 1, 0), copy(2, 1, 1), copy(5, 0, 0)]

    expect([...acrossFiles(rows)]).toEqual([0])
    expect([...keptAsOne(undefined, rows)]).toEqual([0])
    expect([...keptAsOne(new Set(), rows)]).toEqual([])
  })

  it('reads a row with no repeat_of_file as inside its file', () => {
    expect(acrossFiles([aDuplicateRow({ duplicate_of: null, repeat_of: 0, file: 1 })]).size).toBe(0)
  })
})
