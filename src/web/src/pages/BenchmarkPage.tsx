/**
 * The comparison screen of #760 — *the same money, in one fund instead*.
 *
 * Page-level decisions that live here rather than in a block:
 *
 *  - **The head figure is in euros.** `Stat.tsx` states the rule this obeys:
 *    the euro and the percentage are two figures that must never share a line.
 *    The percentage gap is filed one weight down, in a `term` row with each
 *    side's own return. The euro leads because the toggle answers *how much is
 *    left*, which is a euro question, and because a percentage gap is ambiguous
 *    on its face — difference of two returns? in points? annualised?
 *  - **The controls come last in reading order**, on a row of their own between
 *    the head and the chart. The page answers before it asks.
 *  - **The verdict is the gross one.** #760's toggle answers *how much is
 *    left*, not *who wins*, so the untoggled state is the verdict and the
 *    after-tax reading is a second look at the same slot.
 *  - **The inversion line is conditional and silent otherwise** — rendered only
 *    when the two signs actually differ, both sides computed and compared. Not
 *    on the weaker predicate *the accounts have different rates*, which is true
 *    of almost every French owner and would be a permanent warning nobody
 *    reads.
 *  - **No range control.** A counterfactual replays the flows from the
 *    beginning: narrowing it to a year does not shorten the answer, it asks a
 *    different question. The page announces the period it covers instead.
 *  - **While the reference's backfill is not terminal, no figure at all** —
 *    head included. The state governs the screen, not the presence of a
 *    number: a gap over a half-built series is a wrong figure, not a short one.
 *  - **Truncation is a caption, not an absence.** With a 2024 fund the screen
 *    has a complete, correct answer over a shorter window; nothing is missing,
 *    so neither the em dash nor an empty state applies.
 */
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { EmptyState } from '@/components/EmptyState'
import { Explain } from '@/components/Explain'
import { NoBaseCurrency } from '@/components/NoBaseCurrency'
import { Segmented } from '@/components/Segmented'
import { Stat } from '@/components/Stat'
import { Unreadable } from '@/components/Unreadable'
import { BenchmarkChart } from '@/components/benchmark/BenchmarkChart'
import { ReferenceRebuild } from '@/components/benchmark/ReferenceRebuild'
import { ReferenceSelect } from '@/components/benchmark/ReferenceSelect'
import { Card, CardContent } from '@/components/ui/card'
import { api, type BenchmarkExclusion, type BenchmarkResponse } from '@/lib/api'
import { currencyUnanswered } from '@/lib/firstRun'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { signClass, signOf } from '@/lib/sign'
import { oneFailure, readConditions } from '@/lib/status'

type Mode = 'gross' | 'net'

export default function BenchmarkPage() {
  const { t } = useI18n()
  const f = useFormatters()
  const [mode, setMode] = useState<Mode>('gross')

  const comparison = useQuery({ queryKey: ['benchmark'], queryFn: api.benchmark })
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })

  usePageHeading(t('page.benchmark'))

  // The band's sentence, one floor down (#829). With no reporting currency
  // nothing is converted and there is no curve on either side of the
  // comparison — so this page would be two em dashes with no reason given.
  if (currencyUnanswered(config.data?.settings) === true) {
    return <NoBaseCurrency />
  }

  const failure = oneFailure(readConditions({ errors: [comparison.error] }))
  if (failure !== null) {
    return <Unreadable failure={failure} />
  }

  // In flight: nothing at all, title included. An emptiness declared over a
  // request still on the wire is a claim about the reader's own data.
  const data = comparison.data ?? null
  if (data === null) return null

  const currency = data.base_currency

  if (data.state === 'no_reference') {
    return (
      <EmptyState
        title={t('benchmark.empty.title')}
        description={t('benchmark.empty.body')}
        // The one way out **is** the selector: this empty state's action is the
        // control itself, not a link to somewhere the control lives.
        action={
          <ReferenceSelect
            hint
            value={null}
            offered={data.offered}
            downloaded={data.consulted}
          />
        }
      />
    )
  }

  // The same `flex-wrap` + `justify-between` fold the dashboard's control row
  // uses. Nothing new, and nothing removed by width: both controls go full
  // width when they fold rather than shrinking under the touch minimum.
  const controls = (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <ReferenceSelect
        value={data.reference}
        offered={data.offered}
        downloaded={data.consulted}
      />
      {data.state !== 'ready' ? null : (
        // `Segmented` sizes its options for a card's corner — 32 px, under the
        // 44 px a thumb can hit. Widened here rather than through a new prop
        // on a primitive four other surfaces draw: this screen is the only one
        // whose toggle is a full-width control on a phone.
        <Segmented
          bordered
          mode="pressed"
          label={t('benchmark.mode.label')}
          value={mode}
          onChange={setMode}
          className="w-full [&>button]:min-h-11 [&>button]:flex-1 sm:w-auto sm:[&>button]:min-h-0 sm:[&>button]:flex-none"
          options={[
            { value: 'gross', label: t('benchmark.mode.gross') },
            { value: 'net', label: t('benchmark.mode.net') },
          ]}
        />
      )}
    </div>
  )

  // Two withheld states, one rendering. `splits_unknown` is a store that
  // fetched this fund before its split ratios were persisted: the series is
  // there and the history behind it is not established, so a replay counting
  // units could walk through a split it cannot see. What the reader needs to
  // know is the same in both cases — the figure is coming, the next fetch
  // brings it — and inventing a second panel would be inventing a second
  // explanation for one wait.
  if (data.state === 'rebuilding' || data.state === 'splits_unknown') {
    return (
      <div className="space-y-6">
        {data.rebuild ? <ReferenceRebuild rebuild={data.rebuild} /> : null}
        {controls}
      </div>
    )
  }

  if (data.state === 'nothing_to_compare') {
    return (
      <div className="space-y-6">
        <EmptyState
          title={t('benchmark.empty.noEvents.title')}
          description={t('benchmark.empty.noEvents.body')}
          action={
            <Link to="/ledger" className="font-medium underline underline-offset-4">
              {t('benchmark.empty.noEvents.link')}
            </Link>
          }
        />
        <Excluded rows={data.excluded_accounts ?? []} />
        {controls}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Head data={data} mode={mode} currency={currency} />
      {controls}
      <BenchmarkChart
        points={data.series ?? []}
        index={data.index ?? data.reference ?? ''}
        currency={currency}
      />
      <Excluded rows={data.excluded_accounts ?? []} />
      {data.idle_cash ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          {t('benchmark.cash', { amount: f.currency(data.idle_cash, currency) })}
        </p>
      ) : null}
    </div>
  )
}

/** The one `Card`: a total and its terms, subordinated vertically. */
function Head({
  data,
  mode,
  currency,
}: {
  data: BenchmarkResponse
  mode: Mode
  currency: string | null
}) {
  const { t } = useI18n()
  const f = useFormatters()

  const gross = data.gap_gross ?? null
  const net = data.gap_net ?? null
  const shown = mode === 'net' ? net : gross
  const index = data.index ?? data.reference ?? ''

  // Both sides computed and their signs compared — never *the accounts have
  // different rates*, which is true of almost everyone and would be a
  // permanent warning nobody reads. A zero is a figure, so `signOf` decides.
  const inverted =
    gross !== null && net !== null && signOf(gross) !== signOf(net) && signOf(net) !== 'zero'

  return (
    // **`aria-live="polite"`**, because this is the result of a gesture and not
    // an ambient state: switching from `CW8` to `C40` reads the eyebrow, the
    // figure and the verdict back, and so does the gross/net toggle. Polite and
    // never assertive — the reader is already looking at the control they
    // pressed, which is `Refusal`'s own reasoning for keeping `role="status"`.
    <Card className="bg-linear-160 from-chart-2/9 to-card" aria-live="polite">
      <CardContent className="space-y-4 py-6">
        <Stat
          size="head"
          // The ticker without its venue suffix, as the selector renders it:
          // `CW8` and not `CW8.PA`. The exchange is an addressing detail of the
          // fetch, and the eyebrow is the one place the reader meets the fund.
          label={t('benchmark.head.label', {
            index,
            symbol: (data.reference ?? '').split('.')[0],
          })}
          value={shown === null ? '—' : f.signedCurrency(shown, currency)}
          valueClassName={signClass(shown)}
          explain={
            <Explain
              figure={t('benchmark.term.gap')}
              body="benchmark.explain.gap"
              anchor="benchmark"
            />
          }
        />

        <div className="max-w-prose space-y-1 text-sm">
          {shown === null ? null : (
            <p>
              {signOf(shown) === 'zero'
                ? t('benchmark.verdict.equal', { index })
                : t(
                    signOf(shown) === 'gain'
                      ? 'benchmark.verdict.ahead'
                      : 'benchmark.verdict.behind',
                    { gap: f.currency(Math.abs(shown), currency), index },
                  )}
            </p>
          )}
          {inverted ? (
            <p>
              {t(signOf(net) === 'gain' ? 'benchmark.inversion.ahead' : 'benchmark.inversion.behind')}
            </p>
          ) : null}
          <Period data={data} />
          <NetUnavailable rows={data.net_unavailable ?? []} />
        </div>

        <div className="grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-3">
          <Stat
            size="term"
            label={t('benchmark.term.gap')}
            value={points(f, gap(data.portfolio_return, data.reference_return))}
          />
          <Stat
            size="term"
            label={t('benchmark.term.yours')}
            value={points(f, data.portfolio_return)}
            valueClassName={signClass(data.portfolio_return ?? null)}
          />
          <Stat
            size="term"
            label={t('benchmark.term.theirs')}
            value={points(f, data.reference_return)}
            valueClassName={signClass(data.reference_return ?? null)}
          />
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * One of the three subordinate figures, at **one** decimal.
 *
 * `formatPercent` is fixed at two, which is right for a figure that leads a
 * screen and too much for three that sit under a euro: the row is read as a
 * shape — ahead, behind, by roughly how much — and a second decimal on each of
 * them is three digits of noise across it. `percentPoints` is the front's own
 * one-decimal path (`AccountDetail`, `AccountsRail`).
 *
 * The sign is carried explicitly, because a gap of zero is a figure and an
 * unsigned `6,4 %` beside a signed euro reads as a different kind of number.
 */
function points(f: ReturnType<typeof useFormatters>, value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const scaled = value * 100
  return `${scaled > 0 ? '+' : ''}${f.percentPoints(scaled, 1)}`
}

/** The difference of two returns, which share a denominator by construction. */
function gap(
  yours: number | null | undefined,
  theirs: number | null | undefined,
): number | null {
  if (yours === null || yours === undefined || theirs === null || theirs === undefined) return null
  return yours - theirs
}

/**
 * The covered period, always — and what truncation cost, when it bit.
 *
 * It reads the **computed** period and never the fund's inception alone: the
 * seed lands at the later of the fund's first close and the account's first
 * written day, and an exhausted reference or a missing rate can end it early.
 * A caption naming a period the arithmetic did not honour is worse than none.
 */
function Period({ data }: { data: BenchmarkResponse }) {
  const { t } = useI18n()
  const f = useFormatters()

  if (!data.covered_from || !data.covered_to) return null

  // **The fund is named as the cause only when it is one.** A period starting
  // in 2024 because the fund launched then and one starting in 2024 because
  // the account did are the same date and two different sentences — and the
  // wrong one points the reader at a fund history that is sitting right there.
  // The server decides, because it is the only side that knows both dates.
  // Whole years **elapsed**, from the two dates. Subtracting the year parts
  // calls 31 Dec 2023 → 1 Jan 2024 a lost year and 1 Jan 2024 → 31 Dec 2024
  // none: a figure the owner can check against their own ledger has to be
  // counted the way they would count it.
  const lost =
    data.truncated_by_fund === true && data.portfolio_from
      ? elapsedYears(data.portfolio_from, data.covered_from)
      : 0

  return (
    <p className="text-muted-foreground">
      {lost > 0
        ? t('benchmark.period.truncated', { from: f.date(data.covered_from), years: lost })
        : t('benchmark.period', {
            from: f.date(data.covered_from),
            to: f.date(data.covered_to),
          })}
      {data.ended === 'exhausted' ? (
        <> {t('benchmark.period.exhausted', { to: f.date(data.covered_to) })}</>
      ) : data.ended === 'awaiting_rate' ? (
        <> {t('benchmark.period.awaitingRate', { to: f.date(data.covered_to) })}</>
      ) : null}
    </p>
  )
}

/** Why there is no after-tax figure, and which account stopped it. */
function NetUnavailable({ rows }: { rows: readonly BenchmarkExclusion[] }) {
  const { t } = useI18n()

  if (rows.length === 0) return null
  return (
    <p className="text-muted-foreground">
      {t('benchmark.net.unavailable', { accounts: names(rows), count: rows.length })}
    </p>
  )
}

/**
 * Whole years between two `YYYY-MM-DD` days, never a difference of year parts.
 *
 * Under a year the caption falls back to stating the period, which is true and
 * says no less: *eleven months of your history are outside this gap* is not
 * what the sentence is for — it exists for the case where truncation actually
 * bites, and the period line already names both ends.
 */
function elapsedYears(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const whole = ty - fy
  return tm > fm || (tm === fm && td >= fd) ? whole : whole - 1
}

/** The accounts a grant with no declared price took out of the perimeter. */
function Excluded({ rows }: { rows: readonly BenchmarkExclusion[] }) {
  const { t } = useI18n()

  if (rows.length === 0) return null
  return (
    <p className="max-w-prose text-sm text-muted-foreground">
      {t('benchmark.excluded', { accounts: names(rows), count: rows.length })}
    </p>
  )
}

function names(rows: readonly BenchmarkExclusion[]): string {
  return rows.map((row) => row.account).join(', ')
}
