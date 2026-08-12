/**
 * What the *Notices* block shows, what the tab's badge counts, and what gesture
 * each notice carries (#724, ADR-0021).
 *
 * Pure — advisories in, decisions out — because all three of those are one
 * question asked three times, and a component answering it per render is how a
 * badge and the block under it end up disagreeing about what is standing.
 *
 * **The badge counts unacknowledged notices and nothing else.** That sentence is
 * the criterion, and it is written here as an exclusion list because the three
 * things it excludes are three things that *look* countable:
 *
 *  - **the ephemeral store** — its predicate is never acknowledgeable (a
 *    container either keeps nothing or it does), so counting it would give a
 *    permanent badge, which is noise and takes the notices that matter down
 *    with it. It is not an advisory at all: `boot_conditions.py` says it, and
 *    ADR-0015's own rule is *the banner shows conditions the owner can end, the
 *    badge counts facts they can only acknowledge*;
 *  - **the orphan symbols** — a choice, not a waste. Nobody is being told
 *    anything;
 *  - **the reconstruction** — it has exactly **one** announcer, the banner
 *    (#726). It is one of the five keys, and that is precisely why it has to be
 *    named here: dropping it from the badge alone would leave it in the block
 *    and make the badge under-count what the reader can see, while leaving it in
 *    both would put two announcers on one fact.
 */
import type { Advisory } from '@/lib/api'

/**
 * The advisory the banner owns. It is excluded from the block **and** from the
 * badge together, because a badge is a promise that something is there to read.
 */
export const BANNER_ADVISORY = 'reconstruction_running'

/**
 * What the *Notices* block renders: standing, not acknowledged, and not the
 * one the banner announces.
 *
 * **An acknowledged notice disappears.** Kept greyed out it would make the
 * notice of somebody who decided to keep their `config.yaml` for ever a
 * permanent fixture of their screen — which is the acknowledgement being
 * refused after the fact. The server keeps the row while the predicate stands
 * (that is what makes a predicate coming back true **re-arm** the notice, with
 * a fresh date and a fresh log line); what the interface owes is not to show it.
 *
 * Order is the server's, which is declared and stable rather than sorted by
 * date — a badge whose contents reshuffle between two reads is a badge nobody
 * trusts.
 */
export function shownAdvisories(advisories: readonly Advisory[]): Advisory[] {
  return advisories.filter(
    (advisory) => advisory.key !== BANNER_ADVISORY && !advisory.acknowledged,
  )
}

/**
 * The badge. It counts **exactly what the block shows**, which is what makes
 * *a badge promises something to find* true by construction rather than by
 * inspection: the two read one list.
 */
export function unacknowledgedCount(advisories: readonly Advisory[]): number {
  return shownAdvisories(advisories).length
}

/**
 * The gesture a notice carries **in the app**, when it has one.
 *
 * One key has one today, and it is the only one that can: the assumed-currency
 * notice *names the events it was made about* — the join is re-derived on every
 * read, which is the whole trick — so the gesture is to go and look at them,
 * with the ledger already reduced to the symbols it names. The others are about
 * things that live outside the app (a file on disk, variables in the container's
 * environment), and their sentence already says what to do out there; inventing
 * a button for them would be inventing a power the app does not have.
 */
export type AdvisoryGesture = { kind: 'ledger'; search: string } | null

export function advisoryGesture(advisory: Advisory): AdvisoryGesture {
  if (advisory.key !== 'assumed_base_currency') return null
  const symbols = advisory.detail?.symbols
  if (!Array.isArray(symbols) || symbols.length === 0) return null
  // One term, because the ledger's search is a single field and a list of
  // symbols is not a query. The first is enough to land the reader *in* the
  // rows the notice is about, which is what the gesture is for.
  return { kind: 'ledger', search: String(symbols[0]) }
}
