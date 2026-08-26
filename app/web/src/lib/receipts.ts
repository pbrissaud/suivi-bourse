/**
 * The gesture receipt (#726) — and the three things it is, said once.
 *
 * A receipt **acknowledges a gesture**, and only a gesture. That single rule
 * settles what goes here and what does not:
 *
 *  - **It never states a condition.** The conditions this product carries do
 *    not resolve, they persist until somebody acts — an unanswered reporting
 *    currency, a reconstruction still running — and a toast at
 *    `duration: Infinity` is a strip that covers the page for as long as one
 *    holds. So a receipt is short-lived by construction, and what states a
 *    condition is a card of the notifications panel (#829, ADR-0037), the
 *    banner's three having landed there when it was retired.
 *  - **It is never the trace of an import** — and since #811 that sentence has
 *    changed sides rather than gone. It was written about the *drop folder*,
 *    which is watched at all times (#697): an import could start with no click,
 *    no promise and no browser open at all, so a receipt would have been a trace
 *    with holes in it. An **upload is a gesture**, made by somebody who is
 *    waiting for its end, and the receipt is what the app owes them for it
 *    (ADR-0032, `CONTEXT.md` § Receipt). What is still refused is the receipt
 *    that pretends to be a *record*: this one is said once, to the reader who
 *    made the gesture, and nothing keeps it.
 *
 * **Four gestures have one.** The currency answered, from the modal and from
 * the settings form alike; the export, since #796; the import, since #811; and
 * since #814 the bulk removal, which is the one of the four with nothing behind
 * it — the reader cannot undo it, so what it took is said rather than counted.
 *
 * **The import's is said twice**, and that is #813's whole shape: once as a
 * forecast the owner may refuse, once as the fact. Same members, same order,
 * only the tense moves — the reader has to recognise afterwards what they read
 * before, or the preview is a second screen to compare rather than the same one
 * read again.
 *
 * **The export's receipt is two sentences and no timer**, which is the whole of
 * #796's criterion: it says what is being made at the click, and what is there
 * when it is there. The rule above still holds — nothing here is given an
 * infinite duration — because the wait it covers is an *operation*, which ends.
 * That is also what separates it from a read in flight: a read is not dressed
 * because nothing may be claimed about a subject nobody has heard from, while a
 * gesture is the reader's own act and the app owes them its end.
 */
import type { ExportFile } from '@/lib/api'
import type { MessageKey, MessageValues } from '@/lib/i18n'

export type Receipt =
  /** The one question the app asks, answered. */
  | { kind: 'currency.saved'; currency: string }
  /** A file is being made, and this says which one (#796). */
  | { kind: 'export.running'; file: ExportFile }
  /** It is on the reader's disk. */
  | { kind: 'export.saved'; file: ExportFile }
  /** A file is on its way in, and this names it (#811). */
  | { kind: 'import.running'; filename: string }
  /**
   * **The same sentence, one moment earlier** (#813, `CONTEXT.md` § Receipt).
   *
   * An import is read back before it is written as well as after: the members
   * are `import.written`'s to the letter, and only the tense moves. Two shapes
   * would make the forecast and the fact two things to compare rather than one
   * to read twice — which is why this is a second *kind* and not a second
   * *shape*.
   */
  | { kind: 'import.forecast'; count: number; from: string; to: string; accounts: number; symbols: number }
  /** The forecast for a file with no row in it: there is nothing to write. */
  | { kind: 'import.forecast.empty'; filename: string }
  /**
   * **What of the file the ledger already has** — said in both moments (#813).
   *
   * Its own sentence rather than a member of the two above, because it is the
   * one figure that changes what the reader does: it is what tells them they are
   * re-uploading an export they already imported, and it is rendered only when
   * there is one to state. Zero duplicates says nothing, out loud.
   */
  | { kind: 'import.known'; count: number }
  | { kind: 'import.known.forecast'; count: number }
  /**
   * It landed: what the gesture produced, in the units the owner counts in.
   *
   * The two days arrive **already rendered**, like `currency.saved`'s code and
   * for the same reason: a day is formatted in the reader's language by
   * `lib/format.ts`, which owns the calendar-day parse (`new Date('2026-02-10')`
   * is UTC midnight and renders a day early west of Greenwich). This module
   * stays pure and holds no second one.
   */
  | { kind: 'import.written'; count: number; from: string; to: string; accounts: number; symbols: number }
  /** It landed and wrote nothing: a header with no row under it. */
  | { kind: 'import.empty'; filename: string }
  /**
   * A reduction was deleted, and this is **what actually left** (#814).
   *
   * The count is the server's, not the table's: the confirmation said what the
   * reduction retained *before* the click, and this says what the store removed.
   * A gesture the reader made, whose end the app owes them — and there is no
   * undo behind it, which is why the number is said out loud rather than left
   * to be counted off a table that has just changed shape.
   */
  | { kind: 'events.removed'; count: number }

/**
 * What the receipt says, as a catalogue key and its values. Pure, so the
 * sentence is decided here and rendered by whoever holds a `t`.
 */
export function receiptMessage(receipt: Receipt): { message: MessageKey; values: MessageValues } {
  switch (receipt.kind) {
    case 'currency.saved':
      return { message: 'receipt.currency.saved', values: { currency: receipt.currency } }
    // Which file it is, as a value the catalogue selects on rather than four
    // keys: the two sentences differ by one noun, and a language that agrees
    // that noun with a verb needs the whole sentence to be its own.
    case 'export.running':
      return { message: 'receipt.export.running', values: { file: receipt.file } }
    case 'export.saved':
      return { message: 'receipt.export.saved', values: { file: receipt.file } }
    case 'import.running':
      return { message: 'receipt.import.running', values: { file: receipt.filename } }
    case 'import.written':
      return {
        message: 'receipt.import.written',
        values: {
          count: receipt.count,
          from: receipt.from,
          to: receipt.to,
          accounts: receipt.accounts,
          symbols: receipt.symbols,
        },
      }
    // The same five values, one moment earlier — see the type above.
    case 'import.forecast':
      return {
        message: 'receipt.import.forecast',
        values: {
          count: receipt.count,
          from: receipt.from,
          to: receipt.to,
          accounts: receipt.accounts,
          symbols: receipt.symbols,
        },
      }
    // **A file that wrote nothing has its own sentence**, not the other one at
    // zero: *0 lines written, from — to —* would state a period the file does
    // not carry, and no plural rule can invent the two days that are missing.
    case 'import.empty':
      return { message: 'receipt.import.empty', values: { file: receipt.filename } }
    case 'import.forecast.empty':
      return { message: 'receipt.import.forecast.empty', values: { file: receipt.filename } }
    case 'import.known':
      return { message: 'receipt.import.known', values: { count: receipt.count } }
    case 'import.known.forecast':
      return { message: 'receipt.import.known.forecast', values: { count: receipt.count } }
    case 'events.removed':
      return { message: 'receipt.events.removed', values: { count: receipt.count } }
  }
}
