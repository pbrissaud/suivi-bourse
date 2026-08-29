/**
 * What the notifications panel holds, in one pure function (#829, ADR-0037).
 *
 * The panel is the app's **one** place to say what it has to say, and it holds
 * three registers together: **health**, **installation facts** and
 * **advisories**. What makes that arrangement work is a split ADR-0037 states
 * and this module is the whole of:
 *
 *  - the **register** — `health` · `fact` · `advisory` — is **never a word on
 *    screen**. It decides what a card *offers*: health offers a link and no
 *    acknowledgement because it is repaired rather than dismissed, an
 *    installation fact is acknowledged for good, an advisory is put to sleep
 *    for thirty days and says so;
 *  - the **subject** — Health, Installation, Portfolio, Accounts — is the group
 *    heading and the destination of the card's link. The reader sees subjects
 *    and infers the rest from what each card lets them do.
 *
 * It is pure — payloads in, entries out — for the reason `lib/installationFacts.ts`
 * is: the badge, the group headings and the *Acknowledge the N acknowledgeable*
 * control are one question asked three times, and a component answering it per
 * render is how a badge and the list under it end up disagreeing.
 *
 * **The banner's three conditions are here now, and they are pinned.** ADR-0021
 * gave the app one interruption and three surfaces; ADR-0037 takes the banner
 * away without replacing it, so *a missing base currency*, *a reconstruction
 * under way* and *a stopped scheduler* are entries like any others — the first
 * two as installation facts, the third as health. What descends instead of the
 * band is its **sentence**, one floor down, into the empty state of each page it
 * used to explain.
 *
 * **One fact has one announcer.** `rebuilding` is a state of the bell's colour
 * *and* the subject of the `reconstruction_running` installation fact, so the
 * health entry is raised for `attention` and `unreachable` only: the colour is a
 * channel and the card is a sentence, and two cards about one reconstruction is
 * the defect the banner-and-badge rule existed against.
 */
import type { Advisory, InstallationFact } from '@/lib/api'
import type { MessageKey, MessageValues } from '@/lib/i18n'
import { factGesture, factText, type ListFormatter } from '@/lib/installationFacts'
import type { InstallationState } from '@/lib/status'

/** What a card offers. Never rendered, never named to the reader. */
export type Register = 'health' | 'fact' | 'advisory'

/**
 * The four headings, **in the order the panel reads them down**. Health first
 * because it is the one register that says *nothing you are looking at is any
 * good*; the two that are about the reader's data last.
 */
export const SUBJECTS = ['health', 'installation', 'portfolio', 'accounts'] as const

export type Subject = (typeof SUBJECTS)[number]

/** A catalogue key and what it interpolates — or a sentence nobody translated. */
export type Said =
  | { key: MessageKey; values?: MessageValues }
  | { text: string }

/**
 * Where a card's link lands. **On the figure, never on the page** (ADR-0037):
 * the account *selected*, the security's sheet *open*, the ledger *reduced* to
 * the events concerned.
 *
 * It is a shape rather than a URL string because the router builds the address:
 * a hand-written query string here would be a second spelling of the reductions
 * `?account=`, `?symbol=` and the ledger's own already carry.
 */
export type Destination =
  | { to: '/settings' }
  | { to: '/accounts'; search: { account: string } }
  | { to: '/shares'; search: { symbol: string } }
  | { to: '/ledger'; search: { symbol: string[] } }

/** Which gesture the card offers, and against which resource. */
export interface Acknowledgement {
  register: Exclude<Register, 'health'>
  key: string
}

export interface Entry {
  /** Stable within one read — the key it is acknowledged by, or its register. */
  id: string
  register: Register
  subject: Subject
  /**
   * Whether it heads its group. The three conditions the banner used to hold
   * are pinned, because they are the ones that say *what is on screen is not
   * what it will be*.
   */
  pinned: boolean
  title: Said
  body: Said
  /** The instant of the observation, or `null` where there is none to state. */
  at: string | null
  /** The one way out, when the app has one to offer. */
  link: { label: MessageKey; to: Destination } | null
  acknowledge: Acknowledgement | null
}

/** One heading and what is under it — what the panel renders, in order. */
export interface Group {
  subject: Subject
  entries: Entry[]
}

/**
 * The installation fact the **panel** pins, and the two it does not.
 *
 * `reconstruction_running` was excluded from the notices block altogether while
 * the banner announced it — one fact, one announcer. The banner is gone, so the
 * exclusion goes with it and the fact becomes an ordinary entry, pinned for the
 * reason it was a band: it says the figures on screen are still moving.
 */
const PINNED_FACTS: readonly string[] = ['reconstruction_running']

/** The link a fact offers, when the app has a power to offer (see `factGesture`). */
function factLink(fact: InstallationFact): Entry['link'] {
  const gesture = factGesture(fact)
  if (gesture !== null) {
    // **The whole set, never the first of it**: the sentence above the button
    // enumerates every security, so the reduction it leads to must too.
    return {
      label: 'notification.link.events',
      to: { to: '/ledger', search: { symbol: gesture.symbols } },
    }
  }
  // The reconstruction is watched from the settings page, where the rebuild
  // block is. The environment is outside the app's reach and its own sentence
  // says what to do out there, so inventing a button would be inventing a
  // power the app does not have.
  if (fact.key === 'reconstruction_running') {
    return { label: 'notification.link.settings', to: { to: '/settings' } }
  }
  return null
}

/** The title a fact's card wears — a short one; the sentence is the body. */
const FACT_TITLES: Record<string, MessageKey> = {
  unread_environment: 'notification.fact.unread_environment',
  reconstruction_running: 'notification.fact.reconstruction_running',
  assumed_base_currency: 'notification.fact.assumed_base_currency',
}

/**
 * One advisory's two sentences and its destination, by family.
 *
 * A family this front does not know still renders: the title falls back to the
 * server's own English `message`, and the card offers the acknowledgement all
 * the same. An entry counted by the badge that renders as nothing is the one
 * outcome a panel cannot afford.
 */
function advisoryEntry(advisory: Advisory): Entry {
  const account = String(advisory.detail.account ?? '')
  const known = advisory.kind === 'cash_share' && account !== ''
  return {
    id: advisory.key,
    register: 'advisory',
    subject: subjectOf(advisory.subject),
    pinned: false,
    title: known
      ? {
          key: 'notification.advisory.cash_share',
          values: {
            label: String(advisory.detail.label ?? account),
            share: Number(advisory.detail.share ?? 0),
          },
        }
      : { text: advisory.message },
    body: known ? { key: 'notification.advisory.cash_share.body' } : { text: '' },
    at: advisory.observed_at,
    link: known
      ? { label: 'notification.link.account', to: { to: '/accounts', search: { account } } }
      : null,
    acknowledge: { register: 'advisory', key: advisory.key },
  }
}

/** A subject this front knows, or the portfolio — the server decides, we render. */
function subjectOf(subject: string): Subject {
  return (SUBJECTS as readonly string[]).includes(subject)
    ? (subject as Subject)
    : 'portfolio'
}

export interface NotificationsInput {
  /**
   * What the bell's colour says, or `null` while the read has not landed. A
   * card is a claim about the reader's installation and a read in flight is not
   * one (ADR-0026), so `null` produces nothing at all rather than *unknown*.
   */
  health: InstallationState | null
  /** `null` — not landed. `[]` is an install with nothing to say, which is a fact. */
  facts: readonly InstallationFact[] | null
  advisories: readonly Advisory[] | null
  /**
   * Whether the reporting currency is unanswered. `undefined` while nothing has
   * been observed about it — the band this replaces waited for a positive
   * observation for the same reason.
   */
  currencyUnanswered: boolean | undefined
  /** How an enumeration is rendered, injected so this module stays pure. */
  list: ListFormatter
}

/**
 * Every open entry, in the order the panel reads them down.
 *
 * The order is **within a subject**: `grouped` is what puts the four headings in
 * their own order, and a pinned entry heads its group rather than the panel —
 * a pinned card in the Accounts group would be a fourth ordering nobody could
 * predict.
 */
export function notifications(input: NotificationsInput): Entry[] {
  const entries: Entry[] = []

  // Health, and **only where it needs a hand**. `rebuilding` is carried by the
  // installation fact below, `ok` and `unknown` are not entries at all: a panel
  // that listed *everything is fine* would count it in the badge.
  if (input.health === 'attention' || input.health === 'unreachable') {
    entries.push({
      id: `health:${input.health}`,
      register: 'health',
      subject: 'health',
      pinned: true,
      title: { key: 'notification.health.title', values: { state: input.health } },
      body: { key: 'notification.health.body', values: { state: input.health } },
      at: null,
      // Health is **repaired, never dismissed** — so it offers a link and no
      // acknowledgement, and the link goes where the jobs and the store are.
      link: { label: 'notification.link.settings', to: { to: '/settings' } },
      acknowledge: null,
    })
  }

  // The band's own condition, one floor down and unacknowledgeable: *seen* is
  // not an answer to *no currency has been chosen*, which is why this was never
  // one of the acknowledgement table's keys.
  if (input.currencyUnanswered === true) {
    entries.push({
      id: 'currency',
      register: 'fact',
      subject: 'installation',
      pinned: true,
      title: { key: 'notification.currency.title' },
      body: { key: 'notification.currency.body' },
      at: null,
      link: { label: 'notification.link.currency', to: { to: '/settings' } },
      acknowledge: null,
    })
  }

  for (const fact of input.facts ?? []) {
    if (fact.acknowledged) continue
    const said = factText(fact, input.list)
    entries.push({
      id: fact.key,
      register: 'fact',
      subject: 'installation',
      pinned: PINNED_FACTS.includes(fact.key),
      // A key outside the closed list of three renders the server's English
      // sentence rather than nothing at all — the fallback `lib/installationFacts.ts`
      // already argues, kept here because a card with no title is unreadable.
      title:
        FACT_TITLES[fact.key] === undefined
          ? { text: fact.message }
          : { key: FACT_TITLES[fact.key] },
      body: said === null ? { text: fact.message } : said,
      at: fact.first_seen_at,
      link: factLink(fact),
      acknowledge: { register: 'fact', key: fact.key },
    })
  }

  for (const advisory of input.advisories ?? []) {
    entries.push(advisoryEntry(advisory))
  }

  return entries
}

/**
 * The entries by subject, headings in `SUBJECTS` order, empty groups dropped.
 *
 * Within a group the pinned entries come first and the rest keep the order the
 * server declared them in — stable, because a panel whose contents reshuffle
 * between two reads is a panel nobody trusts.
 */
export function grouped(entries: readonly Entry[]): Group[] {
  return SUBJECTS.map((subject) => ({
    subject,
    entries: entries
      .filter((entry) => entry.subject === subject)
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) =>
        left.entry.pinned === right.entry.pinned
          ? left.index - right.index
          : left.entry.pinned
            ? -1
            : 1,
      )
      .map(({ entry }) => entry),
  })).filter((group) => group.entries.length > 0)
}

/**
 * What the badge counts: **every open entry**, and not the acknowledgeable ones.
 *
 * ADR-0037 accepts the objection this answers rather than going round it: three
 * of the four sources never decrement on their own, so this count can sit at two
 * for a week. The alternative is a badge that counts *some* of what the panel
 * holds, and a reader who opens a panel expecting three things and finds five
 * has been lied to by a number. What is owed in exchange is the control below.
 */
export function openCount(entries: readonly Entry[]): number {
  return entries.length
}

/** The entries a single gesture can clear — what *Acknowledge the N* names. */
export function acknowledgeable(entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => entry.acknowledge !== null)
}

/**
 * How many of the open entries **end by themselves** — the count the disabled
 * control states its reason with.
 *
 * It is the counterpart of a badge that cannot reach zero: *Acknowledge all*
 * would be a promise this panel cannot keep, so the control names its scope and,
 * when there is nothing in it, says why in prose instead of sitting there greyed
 * out with nothing to explain itself.
 */
export function selfEnding(entries: readonly Entry[]): number {
  return entries.length - acknowledgeable(entries).length
}
