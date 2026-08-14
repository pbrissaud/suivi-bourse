/**
 * The bottom of the dashboard, pure (#727, ADR-0018, ADR-0023, ADR-0016).
 *
 * Four rules live here rather than in the three components below them, and each
 * of them is one the components would otherwise re-decide:
 *
 *  - **One chart slot, two readings, and the second reading is a *fallback*.**
 *    *Amounts* is value against net contributed, whose area **is** the gain —
 *    the clearest answer to *did I gain because it went up or because I put more
 *    in*. On an install with no cash event both those members are `NULL`
 *    (#708's per-field rule), so the reading falls back to valuation against
 *    cost, whose area is the **latent** gain — a different figure, therefore a
 *    different name, and there `Performance` is not offered at all: `twr_index`
 *    follows `total_value`, so it is not degraded, it is not computable.
 *  - **The performance curve is rebased on the visible window and carries no
 *    base date.** The head's scalar counts from the series' own origin, which
 *    walks backwards while the reconstruction runs; a curve read against the
 *    first day of the window the reader chose does not move when history appears
 *    before it. At `MAX` the two coincide — the window's first day *is* the
 *    origin — which is the check the ticket asks for: the curve ends exactly on
 *    the head's figure instead of contradicting it.
 *  - **The allocation names what it could not place.** A position quoted with no
 *    resolved rate has no value in the reporting currency, so summing it would
 *    make every *other* percentage silently wrong — and dropping it in silence
 *    is what the code did, with the reason in its own comment and nothing on
 *    screen. It is excluded from the arithmetic **and** named beside it.
 *  - **The movers count what they do not show.** Measured: the portfolio's
 *    second line, at 16,6 % of it, moved 0,00 % — so it entered neither column
 *    and vanished from both. Silence on the second line of a portfolio reads as
 *    *nothing to say*; counting it costs one sentence.
 *
 * The valuation of a position is **not** re-derived here: `lib/shares.ts` owns
 * it, ADR-0004's carrying convention included, so the allocation and the shares
 * page cannot disagree about what a line is worth.
 */
import type {
  Mover,
  PerfPoint,
  PortfolioTotals,
  PortfolioTotalsResponse,
  PositionsResponse,
  ValuationPoint,
} from '@/lib/api'
import { ALLOCATION_SLICES } from '@/lib/alloc'
import { shifted } from '@/lib/accounts'
import { marketValue, type ShareRow } from '@/lib/shares'

// ------------------------------------------------------------------------- //
// The four states of the page
// ------------------------------------------------------------------------- //

/**
 * Which of the four screens the dashboard is on.
 *
 * The two empties are **not** the same and that is the whole of why this is a
 * function rather than a `?.length` at each block:
 *
 *  - `empty` — *no events at all*: one sentence and a link to the data page, and
 *    never a third copy of the pair of entries (#723's `EntryPair`, which #726's
 *    first-run modal is the second copy of). This page reads; it is not where
 *    one enters.
 *  - `portfolio` — events, and possibly **nothing held**, which is a **normal**
 *    page: a figure for the gain (realised + dividends − fees), an em dash for
 *    the latent one, `0,00 €` of securities, and an allocation and a movers
 *    block each saying why it is empty. It is the one place in the product where
 *    the dash and the zero are read side by side at the scale of the portfolio.
 *
 * `pending` renders nothing at all — a read that has not landed is not a fact —
 * and `failed` is the head's band, which is the only announcer of a store that
 * will not answer (`/api/runtime` opens no store, so the shell is silent).
 */
export type DashboardState = 'pending' | 'failed' | 'empty' | 'portfolio'

export function dashboardState(input: {
  failed: boolean
  positions?: PositionsResponse
  totals?: PortfolioTotalsResponse
}): DashboardState {
  if (input.failed) return 'failed'
  if (!input.positions || !input.totals) return 'pending'
  if (input.positions.positions.length === 0 && input.totals.totals === null) return 'empty'
  return 'portfolio'
}

// ------------------------------------------------------------------------- //
// The one range control of the page
// ------------------------------------------------------------------------- //

/**
 * Four presets, and **`3M` is not one of them**: from February to December
 * `YTD` either covers it or contains it, and five buttons on the page's only
 * range control is one too many. `MAX` is offered here — unlike the accounts
 * page, which refuses it (ADR-0019) — because there is **one** series to draw:
 * the amplitude of a single curve is its own subject, and nothing is being
 * crushed into the bottom sixth of a plot by a neighbour's spike.
 */
export const DASHBOARD_RANGES = ['1M', 'YTD', '1Y', 'MAX'] as const

export type DashboardRange = (typeof DASHBOARD_RANGES)[number]

export const DEFAULT_DASHBOARD_RANGE: DashboardRange = '1Y'

/** The two readings of the one slot. A **reading**, never a range. */
export const READINGS = ['amounts', 'performance'] as const

export type Reading = (typeof READINGS)[number]

/**
 * The first day the window shows, or `null` for *everything the series holds*.
 *
 * The series is daily and dense over the calendar, and it is kept **whole**:
 * there is no ladder here (ADR-0010 is about observed prices, of which five
 * years is tens of thousands of points), so a window is a filter and never a
 * bucketing. That is also why the domain below is read off the data.
 */
export function windowFloor(range: DashboardRange, now: Date): string | null {
  if (range === '1M') return shifted(now, 0, 1)
  if (range === '1Y') return shifted(now, 1, 0)
  if (range === 'YTD') return `${now.getUTCFullYear()}-01-01`
  return null
}

function within(t: string | null, floor: string | null): t is string {
  return t !== null && (floor === null || t >= floor)
}

// ------------------------------------------------------------------------- //
// The chart's two readings
// ------------------------------------------------------------------------- //

/** One drawn day of *Amounts*: the two curves, and the area between them. */
export interface AmountsRow {
  t: string
  value: number | null
  contributed: number | null
}

/** One drawn day of *Performance*, as a ratio from the window's own first day. */
export interface PerformanceRow {
  t: string
  performance: number | null
}

/**
 * Is there a cash ledger under these figures? (#708)
 *
 * The discriminant of the whole block, and it is read off `total_value` rather
 * than off the events: the per-field rule writes that member — and
 * `net_contributed` and `twr_index` with it — only where a `DEPOSIT` or a
 * `WITHDRAWAL` exists. `totals === null` (no ledger at all, or a reporting
 * currency nobody has answered) counts as *no*: there is no perf series to draw
 * either way, and the fallback reading is computed from the positions, which are
 * under no such constraint.
 */
export function hasCashLedger(totals: PortfolioTotals | null | undefined): boolean {
  return (totals ?? null) !== null && totals?.total_value !== null
}

export function amountsFromTotals(
  points: readonly PerfPoint[],
  floor: string | null,
): AmountsRow[] {
  const rows: AmountsRow[] = []
  for (const point of points) {
    if (!within(point.t, floor)) continue
    rows.push({ t: point.t, value: point.total_value, contributed: point.net_contributed })
  }
  return rows
}

/**
 * The fallback, in the **same shape**: one row type, one chart component, one
 * caption slot. Two shapes here would be two charts, and the second would drift.
 */
export function amountsFromValuation(
  points: readonly ValuationPoint[],
  floor: string | null,
): AmountsRow[] {
  const rows: AmountsRow[] = []
  for (const point of points) {
    if (!within(point.t, floor)) continue
    rows.push({ t: point.t, value: point.value, contributed: point.invested })
  }
  return rows
}

/**
 * The time-weighted curve, rebased to the first day of the visible window.
 *
 * The base is the **first day that carries an index**, not the first day of the
 * payload: a series may open with days whose index is `NULL` (an account with no
 * cash event contributes none), and dividing by one of those would answer
 * infinity. Before that day the rows are dropped rather than drawn at zero — a
 * flat run at `0 %` is a claim that the portfolio did not move, where the truth
 * is that nothing was measured yet.
 */
export function performanceRows(
  points: readonly PerfPoint[],
  floor: string | null,
): PerformanceRow[] {
  let base: number | null = null
  const rows: PerformanceRow[] = []
  for (const point of points) {
    if (!within(point.t, floor)) continue
    if (base === null) {
      if (point.twr_index === null || point.twr_index === 0) continue
      base = point.twr_index
    }
    rows.push({
      t: point.t,
      performance: point.twr_index === null ? null : point.twr_index / base - 1,
    })
  }
  return rows
}

/**
 * Where the value axis starts: **zero when nothing drawn is negative**.
 *
 * Left to itself Recharts fitted the data and put `−1 411 €` under a series that
 * has never been negative — a graduation the reader has no way to know is an
 * artefact. `'auto'` is kept the moment a real negative appears: there the floor
 * is information, and forcing zero would clip the curve out of the plot.
 */
export function yFloor(values: readonly (number | null)[]): 0 | 'auto' {
  return values.some((value) => value !== null && value < 0) ? 'auto' : 0
}

/** Every number the *Amounts* reading draws — the argument {@link yFloor} takes. */
export function amountsValues(rows: readonly AmountsRow[]): (number | null)[] {
  return rows.flatMap((row) => [row.value, row.contributed])
}

// ------------------------------------------------------------------------- //
// The allocation
// ------------------------------------------------------------------------- //

export interface AllocationSlice {
  /** The security, or `null` on the tail — which names no single line. */
  symbol: string | null
  /** What to write. `null` on the tail: the catalogue names it with its count. */
  label: string | null
  value: number
  /** Of the placed total, `0`…`1`. The legend renders it beside the name. */
  share: number
  /** How many lines this slice folds. `1` everywhere but on the tail. */
  count: number
}

export interface Allocation {
  /** Descending by value, **at most twelve**, the tail last if there is one. */
  slices: AllocationSlice[]
  total: number
  /**
   * The held lines that could **not** be placed — quoted, and the rate has not
   * resolved. Named on screen, never summed: summing them would make every other
   * percentage silently wrong, and dropping them in silence is what happened.
   */
  unplaced: string[]
}

/**
 * The whole portfolio in one figure, **twelve slices and the full width**.
 *
 * Eight was the threshold and it is measurably wrong: the tail *Autres (4)* was
 * worth **10,1 %**, more than four of the named slices put together. What
 * decided the *layout* is what that threshold costs at half width — four names
 * out of twelve folded, a block twice the height of the movers beside it, and
 * 350 px of nothing under them.
 *
 * A **closed** line is not a slice: it is worth exactly zero and a legend of
 * zeros is noise, so the folded section of the shares page is where it lives. A
 * held line worth zero stays — that is a figure about a line the owner holds.
 */
export function allocation(rows: readonly ShareRow[]): Allocation {
  const placed: AllocationSlice[] = []
  const unplaced: string[] = []

  for (const row of rows) {
    if (row.quantity === 0) continue
    const value = marketValue(row)
    if (value === null) {
      unplaced.push(row.symbol)
      continue
    }
    placed.push({
      symbol: row.symbol,
      label: row.name ?? row.symbol,
      value,
      share: 0,
      count: 1,
    })
  }

  placed.sort((left, right) =>
    left.value === right.value
      ? (left.symbol ?? '').localeCompare(right.symbol ?? '')
      : right.value - left.value,
  )

  // The ramp has twelve stops (ADR-0023) and the tail is one slice like any
  // other, so it takes the twelfth: the least contrasted rank, which is what a
  // fold of the smallest lines should be.
  let slices = placed
  if (placed.length > ALLOCATION_SLICES) {
    const named = placed.slice(0, ALLOCATION_SLICES - 1)
    const rest = placed.slice(ALLOCATION_SLICES - 1)
    slices = [
      ...named,
      {
        symbol: null,
        label: null,
        value: rest.reduce((sum, slice) => sum + slice.value, 0),
        share: 0,
        count: rest.length,
      },
    ]
  }

  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  return {
    slices: slices.map((slice) => ({
      ...slice,
      share: total === 0 ? 0 : slice.value / total,
    })),
    total,
    unplaced,
  }
}

// ------------------------------------------------------------------------- //
// The movers
// ------------------------------------------------------------------------- //

/** Five each way. Ten lines is a block; twenty is the table one page down. */
export const MOVERS_ROWS = 5

export interface MoversSplit {
  /** Biggest riser first. */
  risers: Mover[]
  /** Biggest faller first. */
  fallers: Mover[]
  /** Held lines shown in neither column — the sentence's own figure. */
  others: number
  /** How many of those moved by exactly nothing, which is why they are counted. */
  unchanged: number
}

/**
 * The two columns, and **what is left over**.
 *
 * `held` is the number of lines the portfolio holds, and it is an argument
 * rather than a derivation: a share with no baseline at all — its first day — is
 * not in the collection the server serves, so a count taken from `movers` alone
 * would leave it out of the sentence too, which is the same disappearance one
 * step further along.
 */
export function moversSplit(movers: readonly Mover[], held: number): MoversSplit {
  const moved = (mover: Mover) => mover.change_pct ?? 0
  const risers = movers
    .filter((mover) => mover.change_pct !== null && mover.change_pct > 0)
    .sort((left, right) => moved(right) - moved(left))
    .slice(0, MOVERS_ROWS)
  const fallers = movers
    .filter((mover) => mover.change_pct !== null && mover.change_pct < 0)
    .sort((left, right) => moved(left) - moved(right))
    .slice(0, MOVERS_ROWS)

  return {
    risers,
    fallers,
    others: Math.max(held - risers.length - fallers.length, 0),
    unchanged: movers.filter((mover) => mover.change_pct === 0).length,
  }
}
