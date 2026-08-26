/**
 * The account's arithmetic, pure (ADR-0028, ADR-0019, ADR-0016).
 *
 * The page this serves used to be a comparison — eight columns under one range
 * control, answering *which of my accounts is working*. ADR-0028 moved that
 * question to the dashboard's accounts card and made this page a
 * **master-detail**: a rail carrying the accounts' relative weight and their
 * names, and beside it **one** account read in depth. The trade is a loss before
 * it is a gain, and it is stated in the record rather than here.
 *
 * What stayed, because the dashboard's card inherited it and the detail's own
 * chart re-applies it one account down:
 *
 *  - **Rebasing is the reading.** A drawn curve starts at 100 on the first day
 *    of the *visible* window, and the rate shown beside it is read off that same
 *    rebasing — so a curve and a percentage cannot answer *how did this period
 *    go* twice.
 *  - **The longest window is the youngest opening, never `MAX`.** A
 *    time-weighted index has no bounded amplitude, so one account's ancient
 *    volatility would set the scale for every other.
 *  - **The entry marker is never a reason to move the window.**
 *
 * What the master-detail added, and each is a rule the components would
 * otherwise re-decide:
 *
 *  - **An account's weight is what it is worth** — `total_value`, or the
 *    securities alone where no cash ledger was ever recorded (#708). Left out of
 *    the weights, an account holding six hundred euros of shares would draw a
 *    portfolio smaller than it is.
 *  - **A row with no figures names its reason.** *Without a cash ledger* and
 *    *being rebuilt* look alike — every figure absent — and the sentences do
 *    not. A reason, never a progress with a target date, which belongs to the
 *    reconstruction's own card in the notifications panel (#829, ADR-0037).
 *  - **Which account the detail shows is a URL**, so it survives a reload and
 *    can be handed to somebody else; an id naming nothing falls back to the
 *    first declared account rather than to an empty page.
 *
 * **And since #722 the account's own block** (ADR-0018): the positions it sums
 * are **this account's, closed lines included**, and its
 * value-against-contributed curve is the one surface in the product where that
 * shape exists per account.
 *
 * **And since #729 the declaration's own rules** (ADR-0013, ADR-0002), because
 * they are rules about the same rows and a second module would be a second
 * authority on them. Three of them, each already stated by the server somewhere:
 *
 *  - **The row set is what `/api/accounts` serves, and nothing else.** It holds
 *    `default` under the server's own rule — as soon as an event names it, and
 *    always while nothing else is declared — so the block joins the ledger's
 *    counts to those rows and synthesises none. Rebuilding the seeded row in the
 *    client was the copy losing a branch in its worst form: the one field the
 *    copy could not invent was the one the block exists to change.
 *  - **Why a removal is not offered.** ADR-0013 refuses three of them, and the
 *    interface's obligation is the opposite of the API's: a control that is
 *    present and refuses teaches nothing, so it is **absent and names its
 *    reason** — *« 71 événements nomment ce compte »* — which generalises *a row
 *    with no figures names its reason* one notch.
 *  - **What the create form may offer as an account.** Its states are different
 *    repairs and exactly one of them is the reader's (#764's deferral): *you have
 *    declared none* is not *the list has not arrived* is not *the list could not
 *    be read*. Rendered as one empty `<select>` under a required-field refusal,
 *    the onboarding form was unusable on precisely the install ADR-0005 wrote it
 *    for.
 */
import type {
  Account,
  AccountsResponse,
  LedgerEvent,
  PerfPoint,
  Position,
} from '@/lib/api'
import type { MessageKey } from '@/lib/i18n'
import { accountOf, byDateDescending } from '@/lib/ledger'

/**
 * The bucket of the unassigned, and the one account id the **product** writes
 * rather than the owner (#745). Its label and its type are therefore read off
 * the catalogue and never off the payload: it is the only row every install
 * owns, headless ones included, and a value seeded once in a file will never
 * follow the reader's language. Every other account shows what it declares.
 */
export const DEFAULT_ACCOUNT_ID = 'default'

export function isDefaultAccount(id: string): boolean {
  return id === DEFAULT_ACCOUNT_ID
}

/**
 * The one catalogue entry that names it, **wherever it is rendered** (#729).
 *
 * A key and not a string: the accounts page and the declaration block must not
 * name one thing two ways, and the only mechanism that makes that true by
 * construction is a single entry the two of them read.
 */
export const DEFAULT_ACCOUNT_LABEL: MessageKey = 'accounts.default.label'
export const DEFAULT_ACCOUNT_TYPE: MessageKey = 'accounts.default.type'

/** The two members a naming rule needs — an `Account` or an {@link AccountRow}. */
export interface NamedAccount {
  id: string
  label?: string | null
  type?: string | null
}

/**
 * What the owner calls this account, or `null` where nothing they wrote says.
 *
 * `null` means **read {@link DEFAULT_ACCOUNT_LABEL}**, and it happens on exactly
 * one row: the seeded one, while it still wears the name the product gave it.
 * The moment somebody relabels it — which #729's block is the only place to do —
 * the name they gave wins, on this page and on the accounts page alike, because
 * both read this function. A rename rendered nowhere is not a rename.
 *
 * **The recognising is the server's** (`accounts.as_declared`): the seed's own
 * words are written there, so the wire already carries `null` and this fold has
 * no copy of them. Written here instead — and it was — the front held a third
 * copy of a server-owned string across HTTP, where nothing spans both ends: the
 * only faked edge here is MSW, so the fixtures would have gone on agreeing with
 * themselves while a reworded seed rendered as a name its owner had typed.
 *
 * What is left is the fold the reader needs: a declared account with no label
 * falls back to the id it is addressed by, since a row must be nameable on
 * screen even where a file left the column empty.
 */
export function declaredLabel(account: NamedAccount): string | null {
  const label = account.label?.trim() || null
  return isDefaultAccount(account.id) ? label : label ?? account.id
}

/** The same clause on the other seeded column. `null` — nothing was declared. */
export function declaredType(account: NamedAccount): string | null {
  return account.type?.trim() || null
}

// ------------------------------------------------------------------------- //
// The one range control
// ------------------------------------------------------------------------- //

/**
 * The four presets — and **`MAX` is not among them** (ADR-0019). Nothing is
 * hidden by the bound: the dashboard's own series is drawn over the whole
 * history and has no scale problem, where a time-weighted index read across
 * accounts does.
 */
export const RANGES = ['1M', 'YTD', '1Y', 'SINCE_OPENING'] as const

export type Range = (typeof RANGES)[number]

/**
 * The default, and it is the one preset that does **not** depend on the data:
 * *since the opening* is a `max` over the accounts, so a page opening on it
 * would render a different window depending on how old an account happens to
 * be, before the reader has asked anything.
 */
export const DEFAULT_RANGE: Range = '1Y'

/** A calendar day in UTC — the shape every perf point carries. */
function day(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/**
 * The same calendar day, N years or N months back — **clamped to the target
 * month's own length**, never overflowed into the next one. `Date.UTC(y, m, 31)`
 * on a month of 28 days answers the 3rd of the month after, so a `1M` window
 * asked for on a 31st would cover 28 days instead of the month, and `1Y` on a
 * 29 February would start on 1 March.
 *
 * Exported for `lib/dashboard.ts`, which offers three of the same presets over
 * another series (#727). The clamp is the reason it is shared rather than
 * copied: it is one branch, it fires on four days a month, and a copy that lost
 * it would be wrong on exactly those days — in a module nobody would re-read.
 */
export function shifted(now: Date, years: number, months: number): string {
  const year = now.getUTCFullYear() - years
  const month = now.getUTCMonth() - months
  // Day 0 of the month after is the last day of the month itself.
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return day(new Date(Date.UTC(year, month, Math.min(now.getUTCDate(), lastOfMonth))))
}

/** The first day this series says anything about — its opening, in practice. */
export function firstDay(points: readonly PerfPoint[]): string | null {
  for (const point of points) {
    if (point.t !== null && point.twr_index !== null) return point.t
  }
  return null
}

/**
 * The N series, or `null` while **any one of them** is still in flight
 * (ADR-0026).
 *
 * *Tout ou rien par objet*: the comparison **is** the object here, and an
 * account landing after the others moves `windowStart` — so every curve is
 * rebased on another day and the whole plot is redrawn under the reader's eyes,
 * which is the figure-swap #718 forbade on the dashboard's head. The account
 * panel's own curve is not under this rule: it is about one account and waits
 * only for its own read.
 *
 * The shape is `readonly PerfPoint[] | null` per read and the page passes
 * `?? null`, never `?? []` — an empty array is a **payload** (an account whose
 * perf cache says nothing over this window) and reading a request in flight as
 * one is what made the comparison render *« rien à comparer »* about series
 * nobody had answered for yet.
 */
export function settledSeries(
  series: readonly (readonly PerfPoint[] | null)[],
): readonly (readonly PerfPoint[])[] | null {
  const landed: (readonly PerfPoint[])[] = []
  for (const one of series) {
    if (one === null) return null
    landed.push(one)
  }
  return landed
}

/**
 * Where the visible window starts.
 *
 * `SINCE_OPENING` is the **youngest** opening — a `max`, not a `min`: a window
 * reaching back before an account existed is the unbounded one under another
 * name, and it is the one this page refuses. `null` is *nothing to compare*,
 * which is what an install whose perf cache is empty looks like.
 *
 * It takes the **landed** series (see {@link settledSeries}): the day the window
 * starts on is a fact about every account at once.
 */
export function windowStart(
  range: Range,
  now: Date,
  series: readonly (readonly PerfPoint[])[],
): string | null {
  if (range === '1M') return shifted(now, 0, 1)
  if (range === '1Y') return shifted(now, 1, 0)
  if (range === 'YTD') return `${now.getUTCFullYear()}-01-01`

  const openings = series.map(firstDay).filter((opening): opening is string => opening !== null)
  if (openings.length === 0) return null
  return openings.reduce((youngest, opening) => (opening > youngest ? opening : youngest))
}

// ------------------------------------------------------------------------- //
// The rebasing — the page's one arithmetic
// ------------------------------------------------------------------------- //

export interface RebasedPoint {
  t: string
  /** Base 100 at {@link RebasedSeries.from}. */
  index: number
}

export interface RebasedSeries {
  /** The account the curve belongs to. */
  key: string
  /** The day the rebasing counts from — this series' first day in the window. */
  from: string | null
  points: RebasedPoint[]
  /**
   * The rate the detail renders **beside** the curve, off the same rebasing
   * and over the same window. A **ratio**, so it formats like every other
   * percentage in the product.
   * `null` — the series says nothing over this window, which since #708 is what
   * an account with no cash event looks like: `twr_index` follows `total_value`.
   */
  performance: number | null
  /**
   * Where this curve **enters the drawing**, when it starts after the window
   * does. `null` is a curve that starts with the window — the ordinary case, and
   * the one a marker would only clutter.
   */
  entry: RebasedPoint | null
}

/**
 * One series, rebased to 100 at the start of the visible window.
 *
 * The base is the first point *inside* the window rather than the point nearest
 * its left edge: an account that opened later has no earlier point to borrow,
 * and inventing one would be drawing a curve where the account did not exist.
 * That is exactly the case the entry marker exists to say out loud.
 */
export function rebase(key: string, points: readonly PerfPoint[], from: string): RebasedSeries {
  const inside = points.filter(
    (point): point is PerfPoint & { t: string; twr_index: number } =>
      point.t !== null && point.twr_index !== null && point.t >= from,
  )
  const base = inside[0]?.twr_index ?? null
  // A base of zero is not a base: the division would answer `Infinity`, which
  // renders as a plausible-looking figure rather than as the absence it is.
  if (base === null || base === 0) {
    return { key, from: null, points: [], performance: null, entry: null }
  }

  const rebased = inside.map((point) => ({ t: point.t, index: (point.twr_index / base) * 100 }))
  const last = rebased[rebased.length - 1]
  return {
    key,
    from: rebased[0].t,
    points: rebased,
    performance: last.index / 100 - 1,
    entry: rebased[0].t > from ? rebased[0] : null,
  }
}

// ------------------------------------------------------------------------- //
// The rows
// ------------------------------------------------------------------------- //

export interface AccountRow {
  id: string
  /** As declared. The catalogue owns `default`'s (#745), and it owns it late. */
  label: string | null
  type: string | null
  /** The day the money figures describe. `null` — no cycle wrote this account. */
  as_of: string | null
  total_value: number | null
  holdings_value: number | null
  cash_balance: number | null
  net_contributed: number | null
  gain_absolu: number | null
  xirr: number | null
  /**
   * ADR-0018's fourth term for this account (#722). It belongs to no position,
   * so the detail could not read it off `/api/positions` with the other three.
   */
  transfer_fees: number | null
}

/**
 * The rows, in **declaration order** — the order the resource answers in, which
 * is the order the rail lists them in and the order the detail falls back to.
 *
 * Not sorted by value: the rail draws the weights, so the eye already has the
 * ranking, and a list that re-ordered itself as figures land would move the
 * entry under the reader's pointer.
 */
export function buildAccountRows(accounts: readonly Account[]): AccountRow[] {
  return accounts.map((account) => ({
    id: account.id,
    label: account.label ?? null,
    type: account.type ?? null,
    as_of: account.as_of ?? null,
    total_value: account.total_value ?? null,
    holdings_value: account.holdings_value ?? null,
    // **`Liquidités` follows `total_value`.** The two are written together or
    // not at all since #708, and reading the balance on its own is how a page
    // shows `−6 517,26 €` of cash to an owner who never recorded a transfer:
    // the replay debits every purchase, so with no `DEPOSIT` the balance is
    // exactly minus what was invested. Defined, and false.
    cash_balance: (account.total_value ?? null) === null ? null : account.cash_balance ?? null,
    net_contributed: account.net_contributed ?? null,
    gain_absolu: account.gain_absolu ?? null,
    xirr: account.xirr ?? null,
    transfer_fees: account.transfer_fees ?? null,
  }))
}

/**
 * Why a row has no figures — one reason, in words, under the account's name in
 * the rail and again at the head of its detail.
 *
 * Three answers and not two. *Without a cash ledger* and *being rebuilt* look
 * exactly alike — the same figures absent — and only the sentence tells them
 * apart; *nothing recorded at all* is the third, and it is the one the reader
 * cannot repair by waiting.
 */
export type DegradedReason = 'withoutCashLedger' | 'rebuilding' | 'empty'

export function degradedReason(
  row: AccountRow,
  rebuilding: boolean | null | undefined,
): DegradedReason | null {
  // The day first: with no cycle at all there is nothing to say about a cash
  // ledger, and *being rebuilt* is a claim about what the app is **doing**, so
  // it needs the observation that says so. `rebuilding === false` on a row with
  // no day means the reconstruction is over and this account still has nothing
  // — an empty account, not a slow one, and telling its owner to wait would be
  // a sentence that never comes true. A runtime read that has **not landed**
  // keeps the rebuild's sentence rather than making a claim about the reader's
  // own data on a silence (#763).
  if (row.as_of === null) return rebuilding === false ? 'empty' : 'rebuilding'
  // `total_value` is the discriminant and not a scan of every member: #708
  // writes it, the balance, the contribution and the money-weighted rate
  // together or not at all, and `holdings_value` is written either way.
  return row.total_value === null ? 'withoutCashLedger' : null
}


// ------------------------------------------------------------------------- //
// The rail — the weights, and which account the detail is about
// ------------------------------------------------------------------------- //

/**
 * What an account is worth, for the purpose of weighing it against the others.
 *
 * `total_value` where a cash ledger exists, and the **securities alone** where
 * none does: #708 writes the balance, the contribution and the total together or
 * not at all, so an account nobody ever recorded a transfer on has `null` there
 * and six hundred euros of shares all the same. Read as `total_value` and
 * nothing else, that account would weigh zero and the rail would draw a
 * portfolio smaller than it is — the failure being silent, since the bar would
 * still add up to a hundred per cent.
 *
 * `null` is *nothing has been written about this account at all*, which is the
 * eight-dashes shape and not a weight of zero.
 */
export function accountWorth(row: AccountRow): number | null {
  return row.total_value ?? row.holdings_value
}

/**
 * The rail's bar, and the figure beside each name: what share of the whole this
 * account is.
 *
 * `null` per account is *this one has nothing to weigh*; `null` for every one of
 * them is what an install with no cycle behind it looks like, and the rail then
 * draws no bar rather than twelve equal slices. **A zero total is not a
 * division**: an install whose accounts are all worth nothing has no shares to
 * state, and `0 / 0` would render as `NaN %`.
 */
export function accountWeights(rows: readonly AccountRow[]): Map<string, number | null> {
  const worths = rows.map((row) => [row.id, accountWorth(row)] as const)
  // **A share of a whole is defined on a non-negative part.** An account whose
  // withdrawals ran past its holdings is worth less than nothing, and the share
  // it would get is negative: printed, `−12,50 %` of a portfolio; drawn, a
  // `width: -12.5%` the browser drops, so the other segments silently over-fill
  // the bar past a hundred per cent. Such an account has no weight to state,
  // which is what the em dash says.
  const total = worths.reduce<number>(
    (sum, [, worth]) => sum + (worth !== null && worth > 0 ? worth : 0),
    0,
  )
  return new Map(
    worths.map(([id, worth]) => [
      id,
      worth === null || worth < 0 || total <= 0 ? null : worth / total,
    ]),
  )
}

/**
 * Which account the detail is about — **the one the URL names**, and the first
 * declared one where it names nothing or names something that is gone.
 *
 * The fallback is not a convenience: an id that no longer exists is exactly what
 * a bookmark becomes when an account is renamed away or an import is revoked,
 * and answering it with an empty detail beside a full rail would read as a
 * broken page rather than as a stale link.
 */
export function chooseAccount(
  rows: readonly AccountRow[],
  requested: string | null | undefined,
): AccountRow | null {
  return rows.find((row) => row.id === requested) ?? rows[0] ?? null
}

/** How many of an account's events the detail shows before handing over. */
export const LAST_EVENTS = 5

/**
 * The account's last events, newest first.
 *
 * **A blank account is `default`** — the aggregator's own rule, read here off
 * `lib/ledger.ts` rather than spelled a second time — so the seeded row's detail
 * shows the events an install recorded before it declared anything, which is
 * precisely the population #725 exists for.
 *
 * The block is a summary and says so by leading to the ledger: nothing here
 * paginates, and the count it caps at is the one the reader can take in without
 * scrolling.
 */
export function accountEvents(
  events: readonly LedgerEvent[],
  account: string,
  limit: number = LAST_EVENTS,
): LedgerEvent[] {
  return byDateDescending(events.filter((event) => accountOf(event) === account)).slice(0, limit)
}

// ------------------------------------------------------------------------- //
// The detail (#722, ADR-0028) — what eight columns could not hold
// ------------------------------------------------------------------------- //

/**
 * The positions this account holds, closed lines included (ADR-0017).
 *
 * The three position terms are summed over **this** set, and a sold line stays
 * in it: its realised gain and its dividends are the two figures it has left to
 * say, and dropping them here would produce the other correct figure — the one
 * the shares page spent a session refusing to show as the owner's gain.
 */
export function accountPositions(
  positions: readonly Position[],
  account: string,
): Position[] {
  return positions.filter((position) => position.account === account)
}

/**
 * How many lines the shares page shows for this account — **symbols, not
 * holdings**, because that page folds `(account, symbol)` into one row
 * (`lib/shares.ts`). The link announces the count it is about to lead to, so
 * the two have to count the same thing.
 */
export function distinctSymbols(positions: readonly Position[]): number {
  return new Set(positions.map((one) => one.symbol)).size
}

/** One day of the account's own curve — value against what was paid in. */
export interface ValuePoint {
  t: string
  value: number
  /** `null` — the day exists and the contribution does not. Never a zero. */
  contributed: number | null
}

/**
 * The value-against-contributed curve, **per account and only here**.
 *
 * The comparison chart above draws one rebased index per account and refuses
 * this shape at N accounts — four curves at two accounts, ten at five, the
 * pairs overlapping and no surface being anybody's gain (ADR-0019). At one
 * account the surface between the two lines *is* the gain, which is why the
 * shape has exactly two homes: the dashboard, and here.
 *
 * **It answers the whole series, and the caller windows it.** The rebasing and
 * this curve are two readings of one range control (ADR-0028), so the window is
 * applied once — where the control's value is — and not twice, in two functions
 * that could then disagree about which days are on screen. A day with no
 * `total_value` is a day this account has no value to state — #708 writes it
 * and `net_contributed` together or not at all — so it is **absent** rather
 * than drawn at zero.
 */
export function valueSeries(points: readonly PerfPoint[]): ValuePoint[] {
  const series: ValuePoint[] = []
  for (const point of points) {
    if (point.t === null || point.total_value === null) continue
    series.push({
      t: point.t,
      value: point.total_value,
      contributed: point.net_contributed,
    })
  }
  return series
}

// ------------------------------------------------------------------------- //
// The declaration (#729) — where a row comes from, and why it cannot go
// ------------------------------------------------------------------------- //

/**
 * Is this the row **nobody declared** — the seed, still saying what it said?
 *
 * The same rule the server states on the other side of the seam
 * (`accounts.default_is_declared`), read off the two fields the payload carries
 * it in: `as_declared` nulls the two seeded columns exactly when they still hold
 * the seed's own words. There was a third road — a file taking the row over —
 * and it left with the accounts file (ADR-0034). It cannot be the same function
 * object — that one is Python, in another process — so what travels is the rule,
 * and this is the one place the front spells it (`lib/absence.ts`'s `isQuoted`
 * is the precedent, #774).
 *
 * Both seeded columns, not the label alone: an owner who retyped the row has
 * declared it as much as one who renamed it, and #725's whole correctness rests
 * on *has anybody declared this* rather than on *does it have a name*.
 */
export function isSeededOnly(account: Account): boolean {
  return (
    isDefaultAccount(account.id) &&
    declaredLabel(account) === null &&
    declaredType(account) === null
  )
}

/**
 * The two refusals and the offer.
 *
 * The **count** is what makes the refusal a sentence rather than a shrug, and it
 * comes off the ledger the tab has already read — never off a second resource,
 * and never guessed: the block is not rendered at all until that read has
 * landed, which is #718's rule that *a read that has not landed is not a fact*,
 * applied where it would otherwise print `0 événement` under a full ledger.
 */
export type Removal =
  | { kind: 'offered' }
  | { kind: 'seeded' }
  | { kind: 'namedByEvents'; count: number }

export function removalOf(account: Account, events: number): Removal {
  // `accounts.delete_account`'s order: the seeded row first (there is always at
  // least one account), then the events that name it. A third stood between
  // them while a file could declare a row and be forgotten; the file is gone
  // (ADR-0034) and the refusal with it.
  if (isDefaultAccount(account.id)) return { kind: 'seeded' }
  if (events > 0) return { kind: 'namedByEvents', count: events }
  return { kind: 'offered' }
}

// ------------------------------------------------------------------------- //
// The reassignment — réaffecter, jamais refuser (#725, ADR-0013, ADR-0006)
// ------------------------------------------------------------------------- //

/**
 * What the declaration owes the events nobody assigned: **two renderings of one
 * condition**, and the absence of both where the condition does not hold.
 *
 * The condition is the one the server bounds its exception by: events still
 * naming the seeded row, at an instant where a blank `account` column has
 * stopped meaning `default` and started meaning an error. What splits the
 * rendering in two is *which side of that instant the reader is on* —
 *
 *  - **`firstDeclaration`** — nothing is declared yet, so the gesture has no
 *    target to name: it rides **inside** the declaration itself, as a box
 *    checked by default, and the same request does both. Offering a target
 *    picker here would be asking the reader to choose between an empty list and
 *    the account they are in the middle of creating.
 *  - **`standing`** — something is declared and rows are still under the seeded
 *    row. That state needs **no file at all** to reach (ADR-0034): months of
 *    events typed into the app before anything was declared leave the `account`
 *    column blank and land under the seeded row, and the declaration made
 *    afterwards does not claim them — the back proves exactly that trap from
 *    the keyboard. So the offer stands on its own, with the declared accounts
 *    as its targets.
 *
 * **No correspondence layer** is built here, and that is the criterion rather
 * than an omission: a `default → pea` map beside the events would be a second
 * truth about the account an event names (ADR-0006). What crosses the wire is
 * one target id, and the population is the column's own value.
 *
 * `none` covers *the read has not landed* as well as *there is nothing to move*,
 * which is safe **because the block above renders nothing at all** while the
 * accounts read is in flight (ADR-0026) — this function is never asked the
 * question on a silence.
 */
export type Reassignment =
  | { kind: 'none' }
  | { kind: 'firstDeclaration'; count: number }
  | { kind: 'standing'; count: number; targets: readonly Account[] }

export function reassignmentOf(
  payload: AccountsResponse | undefined,
  events: readonly LedgerEvent[],
): Reassignment {
  if (payload === undefined) return { kind: 'none' }

  // **Naming `default` is not the whole predicate.** The seeded row can *become*
  // a declaration — renamed, retyped, or taken over by a file (#698, #729) — and
  // its events then name the account their owner named. Counted here, the block
  // would have said *« ils ne nomment aucun de vos comptes »* about the one line
  // the reader had themselves put a name on, and offered to move it off.
  const seed = payload.accounts.find((account) => isDefaultAccount(account.id))
  if (seed !== undefined && !isSeededOnly(seed)) return { kind: 'none' }

  const count = events.filter((event) => isDefaultAccount(accountOf(event))).length
  if (count === 0) return { kind: 'none' }

  if (!payload.declared) return { kind: 'firstDeclaration', count }

  // The seeded row is in the payload whenever an event names it — which here it
  // always does — and it is the one account that cannot be a target: reassigning
  // `default` onto `default` is a gesture with no subject, and the server
  // refuses it by name.
  const targets = payload.accounts.filter((account) => !isDefaultAccount(account.id))
  return targets.length === 0 ? { kind: 'none' } : { kind: 'standing', count, targets }
}

// ------------------------------------------------------------------------- //
// What the create form may offer as an account (#764's deferral)
// ------------------------------------------------------------------------- //

/**
 * The five states of the account field, and they are five renderings.
 *
 * `unassigned` is the one the deferral is about: #698's rule is that a **blank
 * account means `default` until something is declared**, and the form has to
 * reflect it rather than demand a choice from an empty list. The blank is sent
 * as a blank — the server resolves it at the write, where `ledger._insert_events`
 * resolves the file's own empty cell — so the two roads keep one rule.
 */
export type AccountChoice =
  /**
   * Nothing is declared, so there is nothing to choose — but the row still has
   * a **name**, and it is the one the store holds rather than the catalogue's
   * unconditionally. Dropping it here is what let the table and the form on the
   * *same tab* call one account two things the moment its owner renamed it.
   */
  | { kind: 'unassigned'; account?: Account }
  | { kind: 'single'; account: Account }
  | { kind: 'choose'; accounts: readonly Account[] }
  | { kind: 'pending' }
  | { kind: 'failed' }

export function accountChoice(
  payload: AccountsResponse | undefined,
  failed: boolean,
): AccountChoice {
  // The failure first: a read that failed and a read in flight both leave the
  // payload undefined, and only one of them is going to arrive.
  if (payload === undefined) return failed ? { kind: 'failed' } : { kind: 'pending' }
  if (!payload.declared || payload.accounts.length === 0) {
    return { kind: 'unassigned', account: payload.accounts[0] }
  }
  // The one case that answers itself. It is not a shortcut: with a single
  // declared account there is nothing to choose, and a select of one entry is a
  // question whose answer is already known.
  if (payload.accounts.length === 1) return { kind: 'single', account: payload.accounts[0] }
  return { kind: 'choose', accounts: payload.accounts }
}

/** What the form sends for the account, or the sentence that refuses to. */
export type SubmittedAccount = { account: string } | { error: MessageKey }

export function submittedAccount(choice: AccountChoice, typed: string): SubmittedAccount {
  switch (choice.kind) {
    case 'unassigned':
      // The blank, on purpose. Resolving it here would be a second spelling of
      // #698's rule, on the one road that could then disagree with the file's.
      return { account: '' }
    case 'single':
      return { account: choice.account.id }
    case 'choose': {
      const chosen = typed.trim()
      return chosen === '' ? { error: 'data.form.required' } : { account: chosen }
    }
    // Neither of these blames the reader for an empty field: the list is not
    // there, and *this kind of event needs this field* would send them looking
    // for a control that is empty for reasons of its own.
    case 'pending':
      return { error: 'data.form.account.pending' }
    case 'failed':
      return { error: 'data.form.account.failed' }
  }
}
