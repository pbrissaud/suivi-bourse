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
 * with the ledger already reduced to **every** security it names. The others are
 * about things that live outside the app (a file on disk, variables in the
 * container's environment), and their sentence already says what to do out
 * there; inventing a button for them would be inventing a power the app does
 * not have.
 *
 * **The whole set, never the first of it.** A portfolio reporting in EUR and
 * holding USD, GBP and CHF lines is the ordinary case, not a corner:
 * `_observe_assumed_base_currency` builds `symbols` as
 * `sorted({event['symbol'] for event in events})`, and the sentence rendered two
 * lines above the button enumerates all of them. Landing on one of the three,
 * with a reduction bar that names a single security, would state a repair
 * perimeter smaller than the one the notice just announced — on the one notice
 * the app cannot recompute, and which this ticket protects from being swept
 * away unread.
 *
 * **The unit is the security and not the event**, for two independent reasons.
 * `GET /api/events` publishes no `event.id` today (#723's deferral, carried by
 * #764), so the ids in `detail.events` address nothing the ledger renders; and
 * the server names the symbols beside them precisely because they *are* the
 * actionable unit — one re-export repairs every line of a security. Rebuilding
 * an address out of `(date, type, symbol, account)` to be exact instead would
 * be #662's opaque token over `(file, sheet, row)` under another name, which
 * ADR-0020 removed.
 */
export type AdvisoryGesture = { kind: 'ledger'; symbols: string[] } | null

export function advisoryGesture(advisory: Advisory): AdvisoryGesture {
  if (advisory.key !== 'assumed_base_currency') return null
  const symbols = advisory.detail?.symbols
  if (!Array.isArray(symbols)) return null
  const named = symbols.map((symbol) => String(symbol)).filter((symbol) => symbol !== '')
  if (named.length === 0) return null
  return { kind: 'ledger', symbols: named }
}
