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
 */
import type { Account, PerfPoint, PortfolioTotals } from '@/lib/api'

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
 */
function shifted(now: Date, years: number, months: number): string {
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
