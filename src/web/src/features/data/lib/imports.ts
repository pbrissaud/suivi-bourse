/**
 * What there is to hand back out (#728, #796).
 *
 * **The rest of this module left with the sources** (#816). It held the order
 * imported files were listed in, what a revocation would take with it counted
 * before it was made, the refusal the server would answer, and which accounts
 * the gesture freed — an apparatus whose whole subject was *the source*, and
 * there is no source any more: a file is handed over once, parsed, and never
 * seen again, so nothing persists that could be listed or revoked. Undoing an
 * import is a deletion over the ledger's own reduction (`BulkDelete`), which
 * reaches the twelve rows somebody mistyped as well.
 *
 * What is left is the one question that was never about a source: **is there
 * anything to export**.
 */
import { DEFAULT_ACCOUNT_ID } from '@/features/accounts/lib/accounts'
import type { DuplicateRow, FileAccount, LedgerEvent } from '@/features/data/lib/api'

/**
 * **Where one account of the file is to go** (#835).
 *
 * Three values and not two: *nothing chosen yet* is a state of its own, and it
 * is the one that blocks the button. Collapsing it into an empty id would make
 * *no answer* and *the account whose id is the empty string* the same thing, on
 * the one line — the blank column — where that distinction is the whole
 * question.
 */
export type AccountTarget =
  | { kind: 'unanswered' }
  | { kind: 'account'; id: string }
  | { kind: 'declare' }

/** One line of the correspondence: what the file names, and what becomes of it. */
export interface AccountLine {
  /** The label as the file writes it — `''` for the blank column. */
  name: string
  /** How many of the file's rows carry it. */
  rows: number
  /**
   * Whether those rows land somewhere **as they stand**, with no answer needed.
   *
   * It is the front's reading of the rule the server holds (#698): a declared id
   * lands, and a blank cell lands on the seeded account *only while nothing is
   * declared* — so the very same file is settled on a fresh install and a
   * question on the one that has since declared `pea`.
   */
  settled: boolean
  target: AccountTarget
}

/** The answer, in the shape the gesture carries it (`ImportOptions`). */
export interface Correspondence {
  mapping: Record<string, string>
  declaring: string[]
}

/** Nothing answered yet — the first preview's correspondence, and a reset. */
export const NO_CORRESPONDENCE: Correspondence = { mapping: {}, declaring: [] }

/**
 * The census read against the declaration: **one line per account the file
 * names**, each with its volume and its target (#835).
 *
 * `chosen` is what the reader has said so far, by label. A line they have not
 * touched falls back to where its rows would land on their own — which is the
 * account of the same id, or the seeded one for the blank column — and to
 * *unanswered* where they would land nowhere, which is the line the modal exists
 * to put a question about.
 *
 * Pure, and deliberately: what blocks the button is arithmetic over this list,
 * and it is asserted on the list rather than through a rendered control.
 */
export function accountLines(
  census: readonly FileAccount[],
  declared: ReadonlySet<string>,
  anyDeclared: boolean,
  chosen: Readonly<Record<string, AccountTarget>> = {},
): AccountLine[] {
  return census.map((account) => {
    const settled = account.name === '' ? !anyDeclared : declared.has(account.name)
    const own: AccountTarget = settled
      ? { kind: 'account', id: account.name === '' ? DEFAULT_ACCOUNT_ID : account.name }
      : { kind: 'unanswered' }
    return {
      name: account.name,
      rows: account.rows,
      settled,
      target: chosen[account.name] ?? own,
    }
  })
}

/** The lines still waiting for an answer — what the refusal in prose names. */
export function unanswered(lines: readonly AccountLine[]): AccountLine[] {
  return lines.filter((line) => line.target.kind === 'unanswered')
}

/**
 * The lines as the gesture carries them: the two parameters, and never a third.
 *
 * Every answered line is stated, the ones that were never a question included:
 * a request that says where each of the file's accounts goes is a request the
 * server judges whole, and one that states only the changes would make *left as
 * it was* and *sent back to itself* two spellings of one thing.
 */
export function correspondenceOf(lines: readonly AccountLine[]): Correspondence {
  const mapping: Record<string, string> = {}
  const declaring: string[] = []
  for (const line of lines) {
    if (line.target.kind === 'account') mapping[line.name] = line.target.id
    if (line.target.kind === 'declare') declaring.push(line.name)
  }
  return { mapping, declaring }
}

/**
 * What there is to hand back. **Total or nothing** as to the ledger: the
 * export's whole justification is the round trip (*« puis-je revenir en
 * arrière ? »*), and a partial file is not one while looking exactly like one —
 * which is why a reduction leaves under a name of its own.
 */
export function exportable(events: readonly LedgerEvent[]): { events: boolean } {
  return { events: events.length > 0 }
}

/**
 * **The ten columns a file is read by**, in the export's order without
 * `base_currency` (#1266). The empty ledger renders this list and the template
 * is built from it, so the two cannot disagree; the docs page's example and the
 * loader are pinned to it by tests.
 */
export const EVENT_FILE_COLUMNS = [
  'date',
  'event_type',
  'account',
  'symbol',
  'name',
  'quantity',
  'unit_price',
  'fee',
  'amount',
  'notes',
] as const

/**
 * The template as a `data:` URI: the header and nothing else. An example row the
 * reader forgets to delete would be imported.
 */
export function templateHref(): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(`${EVENT_FILE_COLUMNS.join(',')}\n`)}`
}

/**
 * **The groups of identical lines the file repeats** (#1267): the index of each
 * group's first copy, in the order the file has them, with how many lines the
 * group holds. Read off the census, whose `duplicate_rows` name every copy after
 * the first.
 */
export function repeatGroups(
  rows: readonly DuplicateRow[],
): { first: number; row: DuplicateRow; copies: number; files: number[] }[] {
  const groups = new Map<
    number,
    { first: number; row: DuplicateRow; copies: number; files: Set<number> }
  >()
  for (const row of rows) {
    if (row.repeat_of === null) continue
    const group = groups.get(row.repeat_of)
    if (group) {
      group.copies += 1
      group.files.add(row.file)
    } else {
      // The first copy is written, so it is not a row: its file is the group's
      // `repeat_of_file` (#1266).
      const files = new Set([row.file])
      if (row.repeat_of_file !== null) files.add(row.repeat_of_file)
      groups.set(row.repeat_of, { first: row.repeat_of, row, copies: 2, files })
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    files: [...group.files].sort((a, b) => a - b),
  }))
}

/**
 * **The groups the screen and the payload both keep one copy of**: the reader's
 * answer, else the groups spanning files (#1266). One rule, read by the window
 * and by the request, so what is ticked is what is sent.
 */
export function keptAsOne(
  collapsed: ReadonlySet<number> | undefined,
  rows: readonly DuplicateRow[],
): ReadonlySet<number> {
  return collapsed ?? acrossFiles(rows)
}

/**
 * **The groups whose copies come from two files or more** (#1266): the index of
 * each group's first copy. Two overlapping exports are the usual cause, so these
 * start on *write just one*; a group inside one file starts on *write all*.
 */
export function acrossFiles(rows: readonly DuplicateRow[]): Set<number> {
  const across = new Set<number>()
  for (const row of rows) {
    if (row.repeat_of === null || row.repeat_of_file === null) continue
    if (row.file !== row.repeat_of_file) across.add(row.repeat_of)
  }
  return across
}
