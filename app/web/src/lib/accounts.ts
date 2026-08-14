/**
 * The comparison's arithmetic, pure (#721, ADR-0019, ADR-0016).
 *
 * The accounts page exists to answer *which of my accounts is working*, and the
 * instrument it was answering with was not one. Run on the two real accounts,
 * the stored index reads `pea 171,5` against `TR 115,0` — a figure counted from
 * **30 October 2019** beside one counted from **26 February 2024**. Two numbers
 * sharing a unit is not a comparison. Rebased on a common window the same two
 * accounts **swap places four times over seven windows**, every figure correct
 * along the way.
 *
 * Five rules live here rather than in a component, and each is one the page
 * would otherwise re-decide per cell:
 *
 *  - **Rebasing is the comparison.** Every drawn curve starts at 100 on the
 *    first day of the *visible* window, and the scalar the table's `perf` column
 *    shows is read off that same rebasing — so the chart and the table stop
 *    being two announcers that contradict each other. One window, one arithmetic,
 *    one answer.
 *  - **The longest window is the youngest account's opening, never `MAX`.** What
 *    fails at `MAX` is not the differing bases — an account entering mid-chart
 *    reads perfectly, marker and all — it is that a time-weighted index has **no
 *    bounded amplitude**: `pea` spiked to +542 % in February 2022, the axis runs
 *    −58 % to +542 %, and both accounts' recent history is crushed into the
 *    bottom sixth of the plot. The bound also earns its keep in the table, where
 *    it makes every cell of `perf` cover the same span — which no annotation
 *    could have achieved.
 *  - **The entry marker is never a reason to move the window.** An account
 *    opened three weeks ago still enters in the middle of a one-year window.
 *  - **A column disappears when it is absent for *every* account.** `Liquidités`
 *    follows `total_value`, because without a cash ledger the balance is
 *    `−6 517,26 €` — arithmetically defined and semantically false. Five dashes,
 *    not four. As soon as one account out of two has a ledger the dashes stay:
 *    there they are a **difference between the accounts**, which is the subject
 *    of the page.
 *  - **A row with no figures names its reason.** *Without a cash ledger* (five
 *    dashes) and *being rebuilt* (eight) are indistinguishable otherwise — and
 *    the reason is a reason, never a progress bar with a target date, which
 *    stays on the banner.
 *
 * **And since #722 the account's own panel** (ADR-0018, ADR-0019), which is two
 * rules and not a component's business: the positions a panel sums are **this
 * account's, closed lines included**, and its value-against-contributed curve
 * reads the **whole** series rather than the page's window — the range control
 * drives the comparison, and an account's own history is not one.
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
  PortfolioTotals,
  Position,
} from '@/lib/api'
import type { MessageKey } from '@/lib/i18n'
import { accountOf } from '@/lib/ledger'

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
 * hidden by the bound: an account's whole history already has two homes, the
 * dashboard's single series (which has no scale problem) and the account's own
 * sheet.
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
 * Where the visible window starts.
 *
 * `SINCE_OPENING` is the **youngest** opening — a `max`, not a `min`: a window
 * reaching back before an account existed is the unbounded one under another
 * name, and it is the one this page refuses. `null` is *nothing to compare*,
 * which is what an install whose perf cache is empty looks like.
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
  /** The account id, or {@link PORTFOLIO_KEY} for the row that is not drawn. */
  key: string
  /** The day the rebasing counts from — this series' first day in the window. */
  from: string | null
  points: RebasedPoint[]
  /**
   * The scalar the strip under the chart and the table's `perf` column both
   * read. A **ratio**, so it formats like every other percentage in the product.
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

/** The key the `Portefeuille` row rebases under. It is never drawn (ADR-0019). */
export const PORTFOLIO_KEY = '__portfolio__'

/**
 * The drawn curves, merged into the rows a chart takes: one row per day, one
 * member per curve. A day a curve has no point for is **absent from that row**
 * rather than zero — a curve that had not started yet must not be drawn along
 * the floor.
 */
export function chartRows(series: readonly RebasedSeries[]): Record<string, number | string>[] {
  const days = new Map<string, Record<string, number | string>>()
  for (const one of series) {
    for (const point of one.points) {
      const row = days.get(point.t) ?? { t: point.t }
      row[one.key] = point.index
      days.set(point.t, row)
    }
  }
  return Array.from(days.values()).sort((left, right) => String(left.t).localeCompare(String(right.t)))
}

/**
 * The colour a curve is drawn in — **identity, never rank**.
 *
 * Deliberately not the twelve `--alloc-*` stops: ADR-0023 generates those as one
 * hue in twelve lightnesses precisely because the allocation is sorted and
 * legended, so colour there encodes rank redundantly with the angle. Here the
 * rows are in **declaration order** and colour has to say *which account*, which
 * is what hues do and lightnesses do not. Evenly rotated from the preset's own
 * `--chart-2`, at one lightness and one chroma so no curve reads as more
 * important than another; the strip and the table carry the names, so colour
 * never identifies on its own.
 */
export const SERIES_HUES = [264, 324, 24, 84, 144, 204] as const

export function seriesColour(index: number): string {
  return `oklch(0.62 0.15 ${SERIES_HUES[index % SERIES_HUES.length]})`
}

/**
 * How far a curve that is not selected fades.
 *
 * The floor is an acceptance criterion rather than a taste: below roughly a
 * sixth of full opacity the highlight stops being a highlight and becomes a
 * filter, which loses the context that was the whole reason to draw the other
 * curves at all.
 */
export const DIMMED_OPACITY = 0.35

// ------------------------------------------------------------------------- //
// The table
// ------------------------------------------------------------------------- //

/** The five money columns, in the order the table renders them. */
export const MONEY_COLUMNS = [
  'total_value',
  'holdings_value',
  'cash_balance',
  'net_contributed',
  'gain_absolu',
] as const

/** The two rates, which are the two columns that are **not** sums. */
export const RATE_COLUMNS = ['xirr', 'performance'] as const

export const FIGURE_COLUMNS = [...MONEY_COLUMNS, ...RATE_COLUMNS] as const

export type FigureColumn = (typeof FIGURE_COLUMNS)[number]

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
  /** The rebased scalar over the visible window, never the stored index. */
  performance: number | null
  /**
   * ADR-0018's fourth term for this account (#722). **No column of the table
   * shows it** — the table carries `Gain total` alone — and it exists on the
   * row because the account's panel is where the four terms are decomposed.
   */
  transfer_fees: number | null
}

export function figure(row: AccountRow, column: FigureColumn): number | null {
  return row[column]
}

/**
 * The rows, in **declaration order** — the order the resource answers in.
 *
 * Not sorted by value and above all not by `perf`: sorting by the one column
 * that depends on the range control would make the ranking a property of the
 * window, and the rows would jump on every click of a preset. Sorting by a
 * header stays available, and it is then the reader's own choice.
 */
export function buildAccountRows(
  accounts: readonly Account[],
  performance: ReadonlyMap<string, number | null>,
): AccountRow[] {
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
    performance: performance.get(account.id) ?? null,
    transfer_fees: account.transfer_fees ?? null,
  }))
}

/**
 * The `Portefeuille` row — **read, never summed**.
 *
 * Six of its eight cells are sums in the sense that they describe the whole, but
 * none of them is computed here: the consolidated figures have exactly one
 * source, `portfolio_totals`, and a second arithmetic path to the same number is
 * how the two eventually disagree by a few euros. The other two are not sums at
 * all — two money-weighted rates do not add, and neither do two indices — **and
 * they are not em dashes either**, the store holding both at portfolio level.
 * Naming the row for its subject rather than `Total` is what makes it honest
 * across all eight at once.
 */
export function portfolioRow(
  totals: PortfolioTotals | null,
  performance: number | null,
): AccountRow {
  return {
    id: PORTFOLIO_KEY,
    label: null,
    type: null,
    as_of: totals?.day ?? null,
    total_value: totals?.total_value ?? null,
    holdings_value: totals?.holdings_value ?? null,
    cash_balance: (totals?.total_value ?? null) === null ? null : totals?.cash_balance ?? null,
    net_contributed: totals?.net_contributed ?? null,
    gain_absolu: totals?.gain_absolu ?? null,
    xirr: totals?.xirr ?? null,
    performance,
    transfer_fees: totals?.transfer_fees ?? null,
  }
}

/**
 * The columns that have something to say — **absent for every account is
 * absent** (ADR-0019).
 *
 * Computed over the accounts alone and never over the `Portefeuille` row: that
 * row is a read of another table, and letting it keep a column alive would
 * print a line of dashes above one figure. The rule is a rule about the
 * comparison.
 */
export function visibleColumns(rows: readonly AccountRow[]): FigureColumn[] {
  return FIGURE_COLUMNS.filter((column) => rows.some((row) => figure(row, column) !== null))
}

/**
 * Why a row has no figures — one reason, in words, on a second line of its
 * `Compte` cell.
 *
 * Three answers and not two, and the third is not an invention: *being rebuilt*
 * is a claim about what the app is **doing**, so it needs the observation that
 * says so. `runtime.rebuilding === false` on an account with no series at all
 * means the reconstruction is over and this account still has nothing — which is
 * an empty account, not a slow one, and telling its owner to wait would be a
 * sentence that never comes true. A runtime read that has **not landed** keeps
 * the rebuild's sentence, exactly as the dashboard's year-to-date does: it names
 * something repaired by waiting rather than making a claim about the reader's
 * own data on silence (#709's third answer, #763).
 */
export type DegradedReason = 'withoutCashLedger' | 'rebuilding' | 'empty'

export function degradedReason(
  row: AccountRow,
  visible: readonly FigureColumn[],
  rebuilding: boolean | null | undefined,
): DegradedReason | null {
  // Nothing missing among what is on screen: a column the page has dropped is
  // not an absence the reader can see, so it is not one to explain.
  if (visible.every((column) => figure(row, column) !== null)) return null
  if (row.as_of === null) return rebuilding === false ? 'empty' : 'rebuilding'
  return 'withoutCashLedger'
}

export type SortDirection = 'asc' | 'desc'

export interface Sort {
  column: FigureColumn
  direction: SortDirection
}

/**
 * The rows in the order they are shown. `null` is the declaration order, which
 * is the default and the only order the range control cannot move.
 */
export function sortRows(rows: readonly AccountRow[], sort: Sort | null): AccountRow[] {
  if (sort === null) return [...rows]
  const sign = sort.direction === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    const a = figure(left, sort.column)
    const b = figure(right, sort.column)
    // An absence has no place in an ordering, so it goes last in both
    // directions rather than sorting as a very small number.
    if (a === null && b === null) return left.id.localeCompare(right.id)
    if (a === null) return 1
    if (b === null) return -1
    return (a - b) * sign
  })
}

/**
 * The day the money figures are arrested at — one mention, at the level of the
 * page. A table of money with no date reads as *now*, and these figures are a
 * **day**: today's point is rewritten in place as prices move.
 */
export function figuresAsOf(rows: readonly AccountRow[]): string | null {
  return rows.reduce<string | null>(
    (newest, row) =>
      row.as_of !== null && (newest === null || row.as_of > newest) ? row.as_of : newest,
    null,
  )
}

// ------------------------------------------------------------------------- //
// The account's own panel (#722) — what the table cannot say
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
export function positionCount(
  positions: readonly Position[],
  account: string,
): number {
  return new Set(accountPositions(positions, account).map((one) => one.symbol)).size
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
 * **The whole series, never the page's window.** The range control drives the
 * comparison, and this is not one: ADR-0019 says an account's full history is
 * its own subject and already has this surface for a home. A day with no
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
 * Where a row's declaration comes from, and it is **three** answers rather than
 * `source_id === null`. The seeded row carries no `source_id` either, so read as
 * a pair the column said *declared in the app* about the one row nobody
 * declared — on the first-run screen, where it is the only row there is.
 */
export type Origin = 'file' | 'app' | 'seed'

export function originOf(account: Account): Origin {
  if ((account.source_id ?? null) !== null) return 'file'
  // A file may take the seeded row over (#698), and it is then a file's row like
  // any other — which the branch above has already answered. What is left here
  // is the row as the schema wrote it, and a name the owner gave it is what says
  // they have taken it over themselves.
  return isDefaultAccount(account.id) && declaredLabel(account) === null ? 'seed' : 'app'
}

/**
 * The three refusals and the offer.
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
  | { kind: 'fromFile' }

export function removalOf(account: Account, events: number): Removal {
  // `accounts.delete_account`'s order, and it is not alphabetical: the seeded
  // row first (there is always at least one account), then the events that name
  // it, then the file that declared it. The middle one comes before the last on
  // purpose — both apply to a file-provisioned account an event names, and only
  // one of them is actionable, since forgetting the import is refused in cascade
  // for exactly the same reason.
  if (isDefaultAccount(account.id)) return { kind: 'seeded' }
  if (events > 0) return { kind: 'namedByEvents', count: events }
  if (account.editable === false) return { kind: 'fromFile' }
  return { kind: 'offered' }
}

export interface DeclarationRow {
  account: Account
  /** How many events name it, off the ledger the tab has already read. */
  events: number
  removal: Removal
}

/**
 * The declaration, as one table: the rows the resource served, each with the
 * events that name it and the reason its removal is not offered.
 *
 * **Nothing is synthesised.** The server's list already holds `default` wherever
 * the block needs it — while an event names it, and always while nothing else is
 * declared — so there is one authority instead of two, and the `label` a rename
 * writes is on the row rather than absent from a copy. An empty result therefore
 * means one thing only: the read has not landed. `/api/accounts` never serves an
 * empty list (ADR-0013 — there is always at least one account).
 */
export function declarationRows(
  payload: AccountsResponse | undefined,
  events: readonly LedgerEvent[],
): DeclarationRow[] {
  const counts = countByAccount(events)

  return (payload?.accounts ?? []).map((account) => {
    const count = counts.get(account.id) ?? 0
    return { account, events: count, removal: removalOf(account, count) }
  })
}

function countByAccount(events: readonly LedgerEvent[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const event of events) {
    const id = accountOf(event)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
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
