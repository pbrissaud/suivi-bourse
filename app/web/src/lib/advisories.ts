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
 *    (#726). It is one of the three keys, and that is precisely why it has to be
 *    named here: dropping it from the badge alone would leave it in the block
 *    and make the badge under-count what the reader can see, while leaving it in
 *    both would put two announcers on one fact.
 */
import type { Advisory } from '@/lib/api'
import type { MessageKey, MessageValues } from '@/lib/i18n'

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
 * notice of somebody who decided to keep a v4 `.env` sourced into their
 * container for ever a permanent fixture of their screen — which is the
 * acknowledgement being refused after the fact. The server keeps the row while the predicate stands
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

/* -------------------------------------------------------------------------- *
 * The sentence itself (#768, ADR-0024, ADR-0021)
 * -------------------------------------------------------------------------- */

/**
 * **The front composes the sentence from `key` and `detail`; the server's
 * `message` stays what it always was — the log line and the headless payload.**
 *
 * That is the first of the three forms #768 put on the table, and the choice is
 * taken here because here is where it is paid for. The other two are refused
 * for reasons of their own:
 *
 *  - **removing `message` from the payload** is cleaner on paper and takes from
 *    a client with no interface the one sentence that says what to do — and
 *    *headless means without an interface, not without HTTP* (ADR-0015). The
 *    three keys are stable identifiers a client may branch on, but a key is
 *    not a sentence, and asking every consumer to write three of its own is
 *    asking each of them to redo this file;
 *  - **negotiating the language on the server** (`Accept-Language`) has no
 *    subject: the reader's language is a three-state `localStorage` preference
 *    with **no dial in the store** (ADR-0024), so the server does not have that
 *    information and the product decided it never would. It is the same cost
 *    ADR-0024 already refused to pay for `problem.py`.
 *
 * The cost accepted is that one sentence is written twice, which this repository
 * otherwise refuses. What defends it is that the two are not one sentence in two
 * places but **two texts for two audiences under two contracts**: a logfmt line
 * an operator greps, in one language for ever because a log has no reader
 * preference, against a paragraph a reader reads in theirs. #709 made *logged
 * once, in English, at the instant the row is created* a property of the
 * mechanism; nothing here touches it.
 *
 * What crosses the boundary is therefore **data, never prose**: an array of
 * variables rather than `', '.join(...)`, a count rather than a `(s)`. The `(s)`
 * is exactly the approximate pluralisation ICU exists to replace, and a
 * separator is not how a language enumerates — English closes on *and*, French
 * on *et*, and `formatList` (`Intl.ListFormat`) is what says so.
 */

/** How an enumeration is rendered — injected, so this module stays pure. */
export type ListFormatter = (items: readonly string[]) => string

/** A catalogue key and what it interpolates. The component calls `t` with it. */
export interface AdvisoryText {
  key: MessageKey
  values?: MessageValues
}

interface Sentence {
  /** What the notice says when this process observed what it names. */
  named: MessageKey
  /**
   * What it says otherwise — the parallel of `AdvisorySpec.doc` on the server,
   * which is what `message` falls back to when `detail` is `null`. It states
   * what the advisory *is* and claims no specifics it has not read.
   */
  unobserved: MessageKey
  /** `null` when the detail is there and does not carry what the sentence needs. */
  values: (detail: Record<string, unknown>, list: ListFormatter) => MessageValues | null
}

/** A member that has to be a non-empty string — a currency code. */
function text(detail: Record<string, unknown>, member: string): string | null {
  const value = detail[member]
  return typeof value === 'string' && value !== '' ? value : null
}

/** A member that has to be a finite number — the two halves of a progress. */
function count(detail: Record<string, unknown>, member: string): number | null {
  const value = detail[member]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A member that has to be a non-empty list. Its length is what plurals turn on. */
function items(detail: Record<string, unknown>, member: string): string[] | null {
  const value = detail[member]
  if (!Array.isArray(value) || value.length === 0) return null
  return value.map((entry) => String(entry))
}

/**
 * The three keys and their two sentences each. A closed list (ADR-0021), written
 * out rather than derived: `MessageKey` is `keyof typeof en`, so a catalogue key
 * that does not exist — or a French catalogue that drifts from the English one —
 * is a compile error rather than a notice rendering as its own key.
 *
 * It was five, and the two that left are ADR-0032's: `legacy_config_file` and
 * `legacy_settings_file` were a `stat` on a v4 file found in a folder the app
 * read, and there is no folder. Their sentence is said at the refusal of the
 * upload instead, where it is read at the instant of the gesture.
 */
const SENTENCES: Record<string, Sentence> = {
  unread_environment: {
    named: 'installation.advisory.unread_environment',
    unobserved: 'installation.advisory.unread_environment.unobserved',
    values: (detail, list) => {
      const variables = items(detail, 'variables')
      return variables === null
        ? null
        : { count: variables.length, variables: list(variables) }
    },
  },
  reconstruction_running: {
    named: 'installation.advisory.reconstruction_running',
    unobserved: 'installation.advisory.reconstruction_running.unobserved',
    values: (detail) => {
      const complete = count(detail, 'complete')
      const total = count(detail, 'total')
      return complete === null || total === null ? null : { complete, total }
    },
  },
  assumed_base_currency: {
    named: 'installation.advisory.assumed_base_currency',
    unobserved: 'installation.advisory.assumed_base_currency.unobserved',
    values: (detail, list) => {
      const base = text(detail, 'base_currency')
      const events = items(detail, 'events')
      const symbols = items(detail, 'symbols')
      const currencies = items(detail, 'currencies')
      if (base === null || !events || !symbols || !currencies) return null
      return {
        base,
        events: events.length,
        lines: symbols.length,
        symbols: list(symbols),
        currencies: list(currencies),
      }
    },
  },
}

/**
 * What the reader is told, in their own language — or `null`.
 *
 * `null` has exactly one cause and it is not an absence of translation: a key
 * outside the closed list of three. The caller then renders the server's
 * `message`, which is the honest degradation — a fourth advisory shipping before
 * its catalogue entry says its English sentence rather than nothing at all, and
 * an empty notice is the one outcome a block that exists to be read cannot
 * afford.
 *
 * A `detail` this process could not observe (`null`, #709's third answer) or one
 * that does not carry what the sentence interpolates falls back to the notice's
 * *unobserved* sentence rather than to a paragraph with `undefined` in it — the
 * same move the server makes when it falls back to `AdvisorySpec.doc`.
 */
export function advisoryText(advisory: Advisory, list: ListFormatter): AdvisoryText | null {
  const sentence = SENTENCES[advisory.key]
  if (!sentence) return null
  if (!advisory.detail) return { key: sentence.unobserved }
  const values = sentence.values(advisory.detail, list)
  return values === null ? { key: sentence.unobserved } : { key: sentence.named, values }
}

/** The three keys the catalogues answer for, in the server's declared order. */
export const ADVISORY_KEYS = Object.keys(SENTENCES)
