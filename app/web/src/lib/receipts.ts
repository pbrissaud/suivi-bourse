/**
 * The gesture receipt (#726) — and the three things it is, said once.
 *
 * A receipt **acknowledges a gesture**, and only a gesture. That single rule
 * settles what goes here and what does not:
 *
 *  - **It never replaces the banner.** The conditions this product carries do
 *    not resolve, they persist until somebody acts — an unanswered reporting
 *    currency, a reconstruction still running — and a toast at
 *    `duration: Infinity` is a band that covers the page instead of sitting at
 *    the top of the column. So a receipt is short-lived by construction, and the
 *    band is what states a condition.
 *  - **It is never the trace of an import.** The drop folder is watched at all
 *    times (#697), so an import can start with no click, no promise and no
 *    browser open at all. What traces an import is the import list, which has
 *    its `Imported at` column already; a toast that fired only for the imports
 *    somebody happened to be looking at would be a trace with holes in it.
 *
 * **Three receipts, and they are a closed list.** Only the first has a gesture
 * in the product today: the currency answered, from the modal and from the
 * settings form alike. It was written with two more, held for an in-app import
 * gesture #728 was expected to bring — and #728 landed without one, because an
 * import comes from the drop folder, which is a watcher and not a gesture:
 * *« an import started by the watcher has no receipt, its record is its
 * provenance »* (`CONTEXT.md` § Receipt). The two variants are gone rather than
 * left waiting for a call site the product has decided against.
 */
import type { MessageKey, MessageValues } from '@/lib/i18n'

export type Receipt =
  /** The one question the app asks, answered. */
  { kind: 'currency.saved'; currency: string }

/**
 * What the receipt says, as a catalogue key and its values. Pure, so the
 * sentence is decided here and rendered by whoever holds a `t`.
 */
export function receiptMessage(receipt: Receipt): { message: MessageKey; values: MessageValues } {
  switch (receipt.kind) {
    case 'currency.saved':
      return { message: 'receipt.currency.saved', values: { currency: receipt.currency } }
  }
}
