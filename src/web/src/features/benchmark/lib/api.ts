/**
 * The comparison against a reference (#760).
 *
 * The types are the contract of #712 §11 for this domain, and the calls go
 * through the transport of `lib/api.ts`, which also holds every path in
 * `ROUTES`: a route renamed still changes that file and the test harness, and
 * no page test.
 */

import { get, ROUTES, send } from '@/lib/api'

// ------------------------------------------------------------------------- //
// The comparison against a reference (#760)
// ------------------------------------------------------------------------- //

/** One of the five references the selector offers. */
export interface OfferedBenchmark {
  symbol: string
  /** The index it tracks. Named **first**; the ticker is subordinate. */
  index: string
  /**
   * The fund's first quoted day — what truncation costs, said *before* the
   * click. A 2024 fund silently drops eleven years of a 2013 owner's history.
   */
  inception: string
}

/**
 * One offered ETF, as the progress read publishes it (#1312): is it followed,
 * is its history complete, and how far has the download got.
 *
 * `ready` is the comparison's own gate and not `ratio === 1`: the download
 * stops at the ledger's first day, while the ratio is measured to the fund's
 * inception, so a late ledger never sees an old fund at 100 %.
 */
export interface BenchmarkReference {
  symbol: string
  index: string
  /** The fund's first quoted day. */
  inception: string
  followed: boolean
  ready: boolean
  /** Not followed, and its series is spared by the purge. */
  kept: boolean
  /** Not followed, and the owner stopped keeping it: it goes at the next purge. */
  freed: boolean
  /** Why a followed, incomplete ETF is not moving: `no_events`, or `queued` after another. */
  waiting: 'no_events' | 'queued' | null
  /** The symbol it queues behind, on `queued`. */
  after: string | null
  reached: string | null
  /** The later of its inception and the ledger's first day. */
  target: string | null
  ratio: number | null
  /** The backward pass has asked for a first window: the fund has had its turn. */
  requested: boolean
}

/** The reconstruction bar, fed from the store and never from the recorder. */
export interface BenchmarkRebuild {
  symbol: string
  /** How far back the backward pass has reached, or `null`. */
  reached: string | null
  /** Where it is heading — the fund's own inception. */
  target: string | null
  /** `0`…`1`, or `null` when there is nothing to take a ratio of. */
  ratio: number | null
  /** The backward pass has asked for a first window: the reference has had its turn. */
  requested: boolean
}

/**
 * One account's own comparison, over **its own** window (#1014).
 *
 * The breakdown of the head: the head replays every account's money in one
 * reference from the first purchase on, and these rows replay the same seeds
 * and flows one account at a time, so their gaps add up to `gap_gross`. Each
 * row states its own period beside its own figures — an account opened in
 * 2024 is not judged on 2019 — which is why the period is not optional on it.
 */
export interface BenchmarkAccountRow {
  account: string
  covered_from: string
  covered_to: string
  /** Why this account's period ended early, or `null`. Its own, not the head's. */
  ended: string | null
  portfolio_value: number | null
  reference_value: number | null
  gap_gross: number | null
  portfolio_return: number | null
  reference_return: number | null
}

/** One day of the two curves, on a shared axis. */
export interface BenchmarkPoint {
  t: string
  /** `null` where one account of the perimeter has no value that day. */
  portfolio: number | null
  reference: number
}

/**
 * The whole screen, in one read.
 *
 * `state` governs everything under it, and the page branches on **it** rather
 * than on the presence of `gap_gross`: a figure that is absent and a figure
 * that is withheld are different facts, and this screen renders them
 * differently on purpose.
 *
 * `splits_unknown` is the second withheld state and it looks like `rebuilding`
 * to the reader on purpose: the fund's history is there but its split ratios
 * were never established, and the next fetch is what repairs both.
 */
export interface BenchmarkResponse {
  base_currency: string | null
  state: 'no_reference' | 'rebuilding' | 'splits_unknown' | 'nothing_to_compare' | 'ready'
  /**
   * Why there is nothing to compare, on `nothing_to_compare` only (#1207).
   * Only `no_events` is an empty ledger; absent or unknown reads as it.
   */
  reason?: 'no_events' | 'not_computed' | 'nothing_held' | 'no_rate_on_seed'
  reference: string | null
  index?: string | null
  inception?: string | null
  offered: OfferedBenchmark[]
  /** The ETFs the owner follows, in the order they were turned on (#1312). */
  followed: string[]
  /** The followed ones whose history is complete: what the picker proposes. */
  ready: string[]
  rebuild?: BenchmarkRebuild
  covered_from?: string
  covered_to?: string
  /** The first day the perimeter was written, before any seeding. */
  portfolio_from?: string
  /**
   * Whether the **fund** is what shortened the period. `false` when the
   * accounts simply start later than it does: same date, different cause, and
   * naming the wrong one sends the reader looking for a history that is
   * already there.
   */
  truncated_by_fund?: boolean
  /** Why the period ended early, or `null` — `exhausted`, `awaiting_rate`. */
  ended?: string | null
  /** The perimeter, and the two terms the head figure is the difference of. */
  accounts?: string[]
  portfolio_value?: number | null
  reference_value?: number
  /** The head figure, in euros. `null` when the portfolio is unvalued. */
  gap_gross?: number | null
  portfolio_return?: number | null
  reference_return?: number | null
  /** The same comparison per account, each over its own window (#1014). */
  per_account?: BenchmarkAccountRow[]
  series?: BenchmarkPoint[]
}

export const benchmarkApi = {
  benchmark: () => get<BenchmarkResponse>(ROUTES.benchmark),
  references: () => get<BenchmarkReference[]>(ROUTES.benchmarkReferences),
  /** Keep (`true`) or stop keeping (`false`) an unfollowed ETF's series. */
  keep: (symbol: string, kept: boolean) =>
    send<BenchmarkReference[]>(
      ROUTES.benchmarkReference.replace(':symbol', encodeURIComponent(symbol)),
      'PUT',
      { kept },
    ),
}
