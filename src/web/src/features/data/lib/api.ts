/**
 * The ledger, the import that writes it, and the files it is exported as.
 *
 * The types are the contract of #712 §11 for this domain, and the calls go
 * through the transport of `lib/api.ts`, which also holds every path in
 * `ROUTES`: a route renamed still changes that file and the test harness, and
 * no page test.
 */

import { download, get, ROUTES, remove, send, upload } from '@/lib/api'

function eventPath(id: string): string {
  return ROUTES.event.replace(':id', encodeURIComponent(id))
}

/**
 * The four files a reader can ask for (#796, #836), named so a receipt can say
 * which one is being made. They are names of *files*, not of routes: three of
 * them are one resource — two reductions of it, and one of those in the other
 * shape — and the fourth is a different subject altogether.
 *
 * `portfolio` is that fourth, and it is **the one that is not a backup**: the
 * accounts and their positions, balances and valuations included.
 */
const EXPORT_FILES = ['events', 'workbook', 'selection', 'portfolio'] as const

export type ExportFile = (typeof EXPORT_FILES)[number]

// ------------------------------------------------------------------------- //
// The ledger (#723)
//
// **The shape below is the one `GET /api/events` already serves**, field for
// field, and that is deliberate: #718 mounted a head over two routes nobody had
// written and turned a page from *not built yet* into *the app is not
// answering*, which took #763 to repair. Here the read exists, so the page is
// written on it rather than on a nicer shape somebody would have to catch up
// with — a client that had renamed the members would render an **empty ledger**
// on a full install, which is worse than a 404 because it reads as a fact.
//
// Two members are **additions**, both optional in the type so that today's
// server renders the page whole, and each is what one criterion of #723 rests
// on:
//
//  - **`id`** — every row is editable and editing needs an address. That
//    address is a **primary key**, which is the whole of what killed #662's
//    apparatus: the opaque token over `(file, sheet, row)`, the content
//    fingerprint as an `ETag` and its `409` existed because the *file* was the
//    address, and a file was re-read. A key is not safe because keys cannot go
//    stale — this one went stale for a whole release, `max(id) + 1` handing a
//    deleted row's key to the next writer. It is safe because the server's
//    allocator only climbs (#785), for the life of its process, and refuses a
//    write aimed at a row that has gone instead of landing it on the row that
//    took the key. Absent, the editor is not offered on that row — a shape
//    today's server never sends, and one the type has to allow all the same.
//
// **And the provenance is gone** (#816): the three columns and the sentence
// composed from them described a row a *mounted* file had provisioned, and they
// existed because that file was re-read. A file is a payload now, so there is
// one population of rows and nothing on the wire that could tell two apart.
//
// And one route is genuinely new: **`POST /api/events`**, without which the
// create form has nowhere to write. `PATCH` is its sibling, and since #816 it
// is bounded by nothing: the `409` that refused a row a file had laid down went
// with the mount that justified it.
// ------------------------------------------------------------------------- //

/**
 * The six, in the order the form offers them — the two acquisitions, the
 * disposal, the income, then the two cash movements. The catalogue names them by
 * their **effect** (`Free shares`, `Cash in`, `Cash out`) rather than by their
 * code: six codes are a decoding exercise at the exact moment a first-time owner
 * has nothing yet to decode them against.
 */
export const EVENT_TYPES = ['BUY', 'SELL', 'GRANT', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL'] as const

export type LedgerEventType = (typeof EVENT_TYPES)[number]

export interface LedgerEvent {
  /** A calendar day, `YYYY-MM-DD` — never an instant (the store's own rule). */
  date: string | null
  event_type: LedgerEventType
  /** `null` on a cash movement, which names no security at all. */
  symbol: string | null
  /** The security's name. Read by no column of the ledger — see #723. */
  name: string | null
  quantity: number | null
  /** In the reporting currency — an event amount is a debit. */
  unit_price: number | null
  fee: number | null
  amount: number | null
  /** The row's free text. On a cash movement it is the whole identity. */
  notes: string | null
  /** Blank means `default`, which is the aggregator's own rule. */
  account: string
  /** #723: the key a row is addressed by. Optional, never absent in practice. */
  id?: string | null
}

/** A bare collection, as served: `200` + `[]` on an install that has nothing. */
export type EventsResponse = LedgerEvent[]

/**
 * What the form sends. Deliberately **not** a `LedgerEvent` minus a few fields:
 * the row's key is the store's to write, and a client that could name one would
 * be a client that could forge one.
 *
 * `name` is the security's, and it travels only when the form knows it (#1268):
 * the line picked from Yahoo, else the edited row's own. Absent, the server
 * stores `NULL` — and an edit that sent none used to wipe an imported name.
 */
export interface EventDraft {
  date: string
  event_type: LedgerEventType
  account: string
  symbol: string | null
  name: string | null
  notes: string | null
  quantity: number | null
  unit_price: number | null
  fee: number | null
  amount: number | null
}

/** One line of Yahoo's answer (#1268). */
export interface FoundSecurity {
  symbol: string
  name: string | null
  exchange: string | null
}

/**
 * `securities` has three states: a list, `[]` for *Yahoo answered nothing*, and
 * `null` for *Yahoo did not answer* — the form works on without it.
 */
export interface SecuritiesResponse {
  query: string
  securities: FoundSecurity[] | null
}

/**
 * What a bulk removal answers (#814): how many rows the reduction took with it.
 *
 * The **server's** count and not the table's. The front knows what the
 * reduction retained before the click — that is what the confirmation is made
 * of — and this is what actually left, read off the store: the two are two, and
 * the second is the only one that is a fact.
 *
 * It is spelled `events_removed`, the word the revocation this gesture replaces
 * already answered under: the unit did not change road, only the subject did.
 */
interface BulkRemoval {
  events_removed: number
}

// ------------------------------------------------------------------------- //
// The import — a gesture, and no resource behind it (#811, #813)
//
// There was a `GET /api/imports` and a `DELETE /api/imports/<id>` here, with a
// record type and a revocation to go with them. They left with the population
// they existed for (#816): nothing persists that could be listed, and undoing an
// import is `deleteEvents` over its ticked rows. What is left is the
// receipt, which describes a gesture and outlives nothing.
// ------------------------------------------------------------------------- //

/** The period an import covered — its two days, or nothing at all. */
interface ImportPeriod {
  from: string
  to: string
}

/**
 * **What the gesture produced** (#811) — the receipt, in the units the owner
 * counts in: lines written, the period they cover, the accounts and the
 * securities they touched.
 *
 * `period` is an object or `null` and never two nullable members: the two days
 * are absent **together**, on a file with no row in it, and half a period is a
 * figure nobody's file carries.
 *
 * The same shape answers the preview of #813 before anything is written — one
 * object, two moments — so the forecast and the fact are one thing read twice.
 *
 * **Three numbers, and they close**: `rows === written + duplicates`. `rows` is
 * what the file holds, `duplicates` what of it the ledger already has, `written`
 * what was — or will be — added. The period, the accounts and the securities
 * describe the **file**, not the subset that landed, which is what lets the
 * forecast and the fact say the same thing about a file that is half already
 * imported.
 */
export interface ImportReceipt {
  /** The **first** file's name, kept for `curl` and MCP callers; the front reads `files`. */
  filename: string
  /**
   * **One entry per file handed over, in the order sent** (#1266), read off that
   * file before any correspondence. `rows`, `period`, `accounts`, `symbols` and
   * `file_accounts` beside it describe the batch.
   */
  files: ImportFile[]
  rows: number
  written: number
  duplicates: number
  period: ImportPeriod | null
  accounts: string[]
  symbols: string[]
  /**
   * **The accounts the file names, with their volumes** (#835) — the census the
   * modal's lines are made of, read off the file *before* any correspondence is
   * applied, so the question does not move under the reader as they answer it.
   *
   * `name` is the label as the file writes it, `''` for the blank column, which
   * is a line like any other: it means `default` only while nothing is declared
   * and is an error afterwards.
   */
  file_accounts: FileAccount[]
  /**
   * **The one thing that details, rather than summarises** (#835). The rest of
   * this object answers *which*, not *how many times*; a skipped line is argued
   * with one at a time, and a count cannot be argued with.
   *
   * `duplicate_of` is the id of the stored row this line repeats, or `null`
   * where what it repeats is another line of the file itself. Empty under
   * `writeDuplicates`: the flag moves those rows into `written`, so there is
   * nothing skipped left to name.
   */
  duplicate_rows: DuplicateRow[]
  /** What the file declares as its reporting currency, and what is done with it. */
  currency: DeclaredCurrency | null
  /**
   * **The lines quoted outside the base currency** (#1261), sorted by symbol,
   * `currency` already folded to the main unit. Empty when the file declares its
   * own currency or nothing in it is foreign — and then no question is asked.
   */
  foreign_lines: ForeignLine[]
  /** The securities whose currency could not be checked in time. */
  unverified: string[]
}

/** One file of a batch, and what it carries on its own (#1266). */
export interface ImportFile {
  filename: string
  rows: number
  period: ImportPeriod | null
}

/** One security quoted outside the base currency, and how many events carry money. */
export interface ForeignLine {
  symbol: string
  currency: string
  rows: number
}

/** Which currency a file's foreign-quoted amounts are written in (#1261). */
export type AmountsIn = 'base' | 'quote'

/** One account the file names, and how many of its rows carry it (#835). */
export interface FileAccount {
  name: string
  rows: number
}

/** One line of the file the ledger already holds, and the line it repeats. */
export interface DuplicateRow extends LedgerEvent {
  /** The ledger row this line repeats, or `null` where it repeats the file itself. */
  duplicate_of: string | null
  /** The index of the first copy, for a line the file repeats; `null` for a ledger duplicate. */
  repeat_of: number | null
  /** The index in `files` of the file this line comes from (#1266). */
  file: number
  /** The index in `files` of the file holding the group's first copy; `null` for a ledger duplicate. */
  repeat_of_file: number | null
}

/**
 * The reporting currency a file declares (#710) and what this import
 * would do with it: `adopting` is true when the install has never answered the
 * question and this gesture writes the file's answer into the dial. A file that
 * **contradicts** the dial never reaches here — that is a refusal in prose.
 */
interface DeclaredCurrency {
  declared: string
  adopting: boolean
}

/** How the file is to be read — the gesture's parameters (#813, #835). */
export interface ImportOptions {
  /** Judge and count, and **write nothing**: the forecast the owner may refuse. */
  dryRun?: boolean
  /** *These are real orders, write them* — the rows the ledger already has. */
  writeDuplicates?: boolean
  /**
   * The groups of identical lines in the file to write **whole** (#1267): the
   * index of each group's first copy. Sent as form fields, not on the query
   * string — see `upload`.
   */
  writeRepeats?: readonly number[]
  /**
   * **Where each account the file names is to go** (#835) — file label to the id
   * of a declared account. Sent as one JSON object, on the query string with the
   * rest of *how the file is to be read*.
   *
   * Its **presence** is itself an answer: it says the modal is collecting the
   * correspondence, so the preview reports the account column rather than
   * refusing a file over the very question it is being asked to put. That is why
   * it is sent from the first preview on, empty object and all.
   */
  mapping?: Record<string, string>
  /** The labels to declare as accounts with the import — repeated `declare=`. */
  declaring?: readonly string[]
  /** Decline the reporting currency the file offers. Absent means *take it up*. */
  declineCurrency?: boolean
  /**
   * **The one question about the foreign-quoted lines** (#1261). Absent means
   * unanswered: on a forecast it converts nothing, and on a write it keeps the
   * behaviour of a caller that never heard of the question.
   */
  amountsIn?: AmountsIn
  /**
   * The `SYMBOL:CCY` pairs the last forecast listed — write only. The server
   * applies the answer to exactly these, without a lookup, so it converts what
   * the forecast judged.
   */
  foreign?: readonly string[]
}

export const dataApi = {
  events: () => get<EventsResponse>(ROUTES.events),
  searchSecurities: (q: string) =>
    get<SecuritiesResponse>(`${ROUTES.securities}?q=${encodeURIComponent(q)}`),
  createEvent: (draft: EventDraft) => send<LedgerEvent>(ROUTES.events, 'POST', draft),
  updateEvent: (id: string, draft: EventDraft) => send<LedgerEvent>(eventPath(id), 'PATCH', draft),
  /**
   * **One row, removed** (#834).
   *
   * The pair of the edit above, and the gesture the bulk one is not: an event
   * recorded twice, or on the wrong day, is removed rather than corrected — and
   * a reduction that would retain it retains its neighbours too. The server
   * refuses nothing here that `PATCH` does not, the population being one since
   * #816; a ledger that would not replay without the row is the `409` both
   * meet.
   */
  removeEvent: (id: string) => remove<{ id: string; removed: boolean }>(eventPath(id)),
  /**
   * The ticked rows, deleted whole (#1113).
   *
   * The ids travel in a JSON body and never in the query string: a few
   * thousand of them overflow a proxy's URL limit. An id already gone is
   * skipped by the server, and the answer counts what actually left.
   */
  deleteEvents: (ids: readonly string[]) => send<BulkRemoval>(ROUTES.events, 'DELETE', { ids }),
  // The way in (#811), and since #813 it is made twice on purpose: once with
  // `dryRun` for the forecast, once without it to commit — **the same file**,
  // re-sent. There is no pending-import id to hold instead, because holding one
  // would be the table this lot deleted under another name.
  importEvents: (files: readonly File[], options: ImportOptions = {}) =>
    upload<ImportReceipt>(
      ROUTES.eventsImport,
      files,
      [
        ...(options.dryRun ? ['dry_run=1'] : []),
        ...(options.writeDuplicates ? ['write_duplicates=1'] : []),
        // The correspondence and its two companions (#835). `mapping` is sent
        // whenever there is one to send, empty object included: the parameter's
        // presence is what tells the preview it is being asked a question rather
        // than being asked to judge.
        ...(options.mapping ? [`map=${encodeURIComponent(JSON.stringify(options.mapping))}`] : []),
        ...(options.declaring ?? []).map((label) => `declare=${encodeURIComponent(label)}`),
        ...(options.declineCurrency ? ['adopt_currency=0'] : []),
        ...(options.amountsIn ? [`amounts_in=${options.amountsIn}`] : []),
        ...(options.foreign ?? []).map((pair) => `foreign=${encodeURIComponent(pair)}`),
      ],
      { write_repeat: (options.writeRepeats ?? []).map(String) },
    ),
  // The way back out (#710, #796). It answers bytes and a name rather than a
  // payload, and it is the one call whose result no cache holds: a file is
  // handed to the reader, not rendered.
  download: (path: string) => download(path),
}
