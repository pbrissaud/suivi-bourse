/**
 * The bottom of the dashboard, pure (#727).
 *
 * Four rules live here rather than in the three components below them, and each
 * of them is one the components would otherwise re-decide:
 *
 *  - **One chart slot, two readings, and the second reading is a *fallback*.**
 *    *Amounts* is value against net contributed, whose area **is** the gain —
 *    the clearest answer to *did I gain because it went up or because I put
 *    more in*. On an install with no cash event both those members are `NULL`
 *    (#708's per-field rule), so the reading falls back to valuation against
 *    cost, whose area is the **latent** gain — a different figure, therefore a
 *    different name, and there `Performance` is not offered at all: `twr_index`
 *    follows `total_value`, so it is not degraded, it is not computable.
 *  - **The performance curve is rebased on the visible window and carries no
 *    base date.** The head's scalar counts from the series' own origin, which
 *    walks backwards while the reconstruction runs; a curve read against the
 *    first day of the window the reader chose does not move when history
 *    appears before it. At `MAX` the two coincide — the window's first day *is*
 *    the origin — which is the check the ticket asks for: the curve ends
 *    exactly on the head's figure instead of contradicting it.
 *  - **The allocation is not here any more** (#831). It divided the *shares*
 *    page's own table from the day the maquette was read rendered, so
 *    `allocation` moved to `features/shares/lib/shares.ts` with the block that draws it. What
 *    stays behind is the one line of it this file still needs: `moversSplit`
 *    reduces the payload with `isClosed`, which was `features/shares/lib/shares.ts`'s all
 *    along.
 *  - **The movers count what they do not show.** Measured: the portfolio's
 *    second line, at 16,6 % of it, moved 0,00 % — so it entered neither column
 *    and vanished from both. Silence on the second line of a portfolio reads as
 *    *nothing to say*; counting it costs one sentence. And **the sentence's two
 *    members describe one set**: `moversSplit` reduces the payload to the held
 *    lines with the allocation's own predicate — `isClosed`, one module over —
 *    before counting either of them, a sold line being served on purpose and
 *    comparing equal to its own frozen baseline.
 *
 * `isClosed` comes from there for the same reason.
 */
import type { PerfPoint } from '@/features/accounts/lib/api'
import type {
  Mover,
  PortfolioTotals,
  PortfolioTotalsResponse,
  ValuationPoint,
} from '@/features/dashboard/lib/api'
import type { Position, PositionsResponse } from '@/features/shares/lib/api'
import type { RuntimeState } from '@/lib/api'
import { absenceCase } from '@/lib/absence'
import { shifted } from '@/features/accounts/lib/accounts'
import { isClosed, type ShareRow } from '@/features/shares/lib/shares'

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
 *    the latent one, `0,00 €` of securities, and blocks that each say why they
 *    are empty. It is the one place in the product where the dash and the zero
 *    are read side by side at the scale of the portfolio.
 *
 * `pending` renders nothing at all — a read that has not landed is not a fact —
 * and `failed` is the page's own empty state since #829: the two
 * reads it is made of refused, so there is nothing to draw and the page says
 * why, where the figures would have been. There is no band above it.
 */
type DashboardState = 'pending' | 'failed' | 'empty' | 'portfolio'

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
 * page, which refuses it — because there is **one** series to draw:
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
 * That is also why the domain below is read off the data.
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
 * Where the value axis starts, and it is **two rules and not one**.
 *
 * The first is the defect it was written against: left to itself Recharts fitted
 * the data and put `−1 411 €` under a series that has never been negative — a
 * graduation the reader has no way to know is an artefact. Nothing drawn being
 * negative, nothing graduated may be.
 *
 * The second is what forcing **zero** cost, measured on the real portfolio: a
 * series living between 9 000 € and 17 000 € was drawn on an axis running from
 * 0 to 18 000, so half the plot was empty and every move of the year was
 * squashed into its top third. *Never graduate below zero* and *start at zero*
 * are not the same instruction, and only the first one is owed to the reader.
 *
 * So the floor is the lowest point with a tenth of the amplitude of air under
 * it, **clamped at zero** — and `'auto'` the moment a real negative appears,
 * where the floor is information and forcing anything would clip the curve out
 * of the plot.
 */
export function yFloor(values: readonly (number | null)[]): number | 'auto' {
  const drawn = values.filter((value): value is number => value !== null)
  // Nothing drawn: there is no amplitude to breathe around, and zero is the one
  // floor that cannot be wrong about a series nobody has seen.
  if (drawn.length === 0) return 0
  const low = Math.min(...drawn)
  if (low < 0) return 'auto'
  const high = Math.max(...drawn)
  // A flat series has no amplitude to take a tenth of, and a flat series at zero
  // has no magnitude either — hence the two fallbacks, in that order.
  const air = (high - low) / 10 || Math.abs(low) / 10 || 1
  return Math.max(0, low - air)
}

/** Every number the *Amounts* reading draws — the argument {@link yFloor} takes. */
export function amountsValues(rows: readonly AmountsRow[]): (number | null)[] {
  return rows.flatMap((row) => [row.value, row.contributed])
}

// ------------------------------------------------------------------------- //
// The movers
// ------------------------------------------------------------------------- //

/**
 * Five lines on half the width, ten across the full width (Paul, 11/10/2026):
 * a card takes the full width only if it shows more there, and the movers'
 * more is the next five. Twenty would be the table one page down.
 */
export const MOVERS_ROWS = { half: 5, full: 10 } as const

/**
 * The ticker as a badge: what comes before the first `.` or `-`, four
 * characters at most — `MC.PA` is `MC`, `BTC-EUR` is `BTC`. The place suffix
 * and the quote currency are noise at this size; the name beside it says the rest.
 */
export function tickerBadge(symbol: string): string {
  return (symbol.split(/[.-]/)[0] || symbol).slice(0, 4)
}

/**
 * **One list, ordered by what moved most** (#838).
 *
 * The block was two columns — *Hausses* over *Baisses* — and the drawing has
 * one: the `limit` lines that moved most (five, or ten across the full
 * width), either way, ranked by the size of the move — `−3,8 %` above
 * `+1,4 %`. The rank is what the block is about: which lines moved the most,
 * the sign being the colour's to say. The split cost a heading and a *nothing
 * went down* per column to say what the list says by being short.
 *
 * The three members still describe **one set**: the payload is reduced to the
 * lines actually held (`isClosed`, the shares page's own predicate), so a
 * position sold this morning is neither in the list nor in the sentence under
 * it.
 */
interface MoversReading {
  rows: Mover[]
  others: number
  unchanged: number
}

export function moversList(
  movers: readonly Mover[],
  rows: readonly ShareRow[],
  limit: number = MOVERS_ROWS.half,
): MoversReading {
  const held = rows.filter((row) => !isClosed(row))
  const holds = new Set(held.map((row) => row.symbol))
  const shown = movers.filter((mover) => holds.has(mover.symbol))
  // **Chosen and ranked by size** (#1096). Sorted best first and cut at five,
  // the list was the day's five best and never its worst: on a day when twelve
  // lines moved, `BNP.PA −3,82 %` sat under the cut while `EUNL.DE −0,44 %`
  // closed the list. The cut is taken on the magnitude, and so is the order: a
  // list re-laid from the best to the worst put a `+0,09 %` above a `−1,02 %`
  // under ranks that then said nothing about how much either moved.
  const moved = shown
    .filter((mover) => mover.change_pct !== null && mover.change_pct !== 0)
    .sort((left, right) => Math.abs(right.change_pct ?? 0) - Math.abs(left.change_pct ?? 0))
    .slice(0, limit)
  return {
    rows: moved,
    others: Math.max(held.length - moved.length, 0),
    unchanged: shown.filter((mover) => mover.change_pct === 0).length,
  }
}

export function dayMove(points: readonly PerfPoint[] | null, now: Date): number | null {
  // A read in flight is not an absence, and it reaches here as `null` rather
  // than as an empty array. One point is not a difference.
  if (points === null || points.length < 2) return null

  const last = points[points.length - 1]
  if (last.t !== now.toISOString().slice(0, 10)) return null

  const gain = (point: PerfPoint) =>
    point.total_value === null || point.net_contributed === null
      ? null
      : point.total_value - point.net_contributed

  const today = gain(last)
  const yesterday = gain(points[points.length - 2])
  if (today === null || yesterday === null) return null
  return today - yesterday
}

// ------------------------------------------------------------------------- //
// The hero over a row from a past day (#1260)
// ------------------------------------------------------------------------- //

type HeroReading = 'valued' | 'partial' | 'pending'

/**
 * Is the newest `portfolio_totals` row **today's**? While the history is being
 * rebuilt it is not: a held line with no close caps the series the day before
 * its acquisition, so the row is a day when the portfolio held only cash — and
 * moving it toward now with the live gain is impossible, that gain being
 * unknown for the very lines that cap it.
 *
 * ```
 * totals.day >= today                                  → valued
 * totals.day <  today ∧ runtime not answered           → pending
 * totals.day <  today ∧ runtime.rebuilding === true    → partial
 * totals.day <  today ∧ otherwise                      → valued
 * ```
 *
 * `today` is the **server's** UTC day (`runtime.now`), the one the perf pass
 * uses; the browser's is only the fallback while the runtime has not answered.
 * The last `valued` is a pass not yet run since 00:00 UTC, or a failed one —
 * `StaleFigures` already speaks there. Only called where `totals.totals` is
 * not `null`.
 */
export function heroReading(
  totals: PortfolioTotals,
  runtime: RuntimeState | undefined | null,
  now: Date,
): HeroReading {
  const today = (runtime?.now ?? now.toISOString()).slice(0, 10)
  if (totals.day >= today) return 'valued'
  if (!runtime) return 'pending'
  return runtime.rebuilding ? 'partial' : 'valued'
}

/**
 * The held lines with no converted close — the ones a rebuild is waiting for —
 * by `name ?? symbol`, once across accounts, in `localeCompare` order.
 */
export function unpricedLines(positions: readonly Position[]): string[] {
  const names = new Set<string>()
  for (const position of positions) {
    const which = absenceCase({
      quantity: position.quantity,
      price: position.price,
      converted: position.converted,
      terminal: position.terminal,
      consecutiveFailures: 0,
    })
    if (which === 'rebuilding' || which === 'awaitingRate') {
      names.add(position.name ?? position.symbol)
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}
