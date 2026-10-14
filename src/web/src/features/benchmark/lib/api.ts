/**
 * The comparison against a reference (#760).
 *
 * The types are the contract of #712 §11 for this domain, and the calls go
 * through the transport of `lib/api.ts`, which also holds every path in
 * `ROUTES`: a route renamed still changes that file and the test harness, and
 * no page test.
 */

import { get, ROUTES } from '@/lib/api'

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

/** The reconstruction bar, fed from the store and never from the recorder. */
export interface BenchmarkRebuild {
  symbol: string
  /** How far back the backward pass has reached, or `null`. */
  reached: string | null
  /** Where it is heading — the fund's own inception. */
  target: string | null
  /** `0`…`1`, or `null` when there is nothing to take a ratio of. */
  ratio: number | null
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
  reference: string | null
  index?: string | null
  inception?: string | null
  offered: OfferedBenchmark[]
  /**
   * The references this install already holds a series for — the *déjà
   * téléchargé* column, and the only thing that makes #760's promise visible:
   * the series of an offered reference already consulted is kept alive so
   * switching back is instant. Offered ones only (#1034): a reference this
   * list can no longer propose is one nothing will ever switch back to.
   */
  consulted: string[]
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
}
