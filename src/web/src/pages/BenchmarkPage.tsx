/**
 * The comparison screen of #760 — *the same money, in one fund instead*.
 *
 * Page-level decisions that live here rather than in a block:
 *
 *  - **The head figure is in euros.** `Stat.tsx` states the rule this obeys:
 *    the euro and the percentage are two figures that must never share a line.
 *    The percentage gap is filed one weight down, in a `term` row with each
 *    side's own return. The euro leads because the head answers *how much is
 *    left*, which is a euro question, and because a percentage gap is ambiguous
 *    on its face — difference of two returns? in points? annualised?
 *  - **The controls come last in reading order**, on a row of their own between
 *    the head and the chart. The page answers before it asks.
 *  - **One reading, since #1018.** Both sides sit in the same wrapper under
 *    the same declared model, so the tax answered a question about the wrapper
 *    and not about the securities — and the account page already publishes
 *    *Impôt projeté* with its assiette and its rate for whoever asks it.
 *  - **The head stays on the securities, and the dates join it** (#1020). The
 *    date effect is a second statement under the verdict, not a second head:
 *    the two terms share a middle and sum to the gap against a disciplined
 *    index investor, but the figure the owner has learned to read is the first
 *    of them alone.
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

import { EmptyState } from '@/components/EmptyState'
import { Explain } from '@/components/Explain'
import { NoBaseCurrency } from '@/components/NoBaseCurrency'
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

export default function BenchmarkPage() {
  const { t } = useI18n()

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

  // **And again on the payload itself.** The guard above reads `/api/config`,
  // a *different* request: when it is slow or refuses, the page would render
  // amounts with no unit on the strength of a predicate that never ran. The
  // comparison carries its own `base_currency`, so the invariant is local —
  // no unit, no figures — instead of inferred from two reads agreeing.
  if (data.base_currency === null) {
    return <NoBaseCurrency />
  }

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

  // One control left on the row since #1018 took the reading toggle out, and
  // it keeps the row rather than moving: the page still answers before it asks.
  const controls = (
    <ReferenceSelect value={data.reference} offered={data.offered} downloaded={data.consulted} />
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
      <Head data={data} currency={currency} />
      {controls}
      <BenchmarkChart
        points={data.series ?? []}
        index={data.index ?? data.reference ?? ''}
        currency={currency}
      />
      <Excluded rows={data.excluded_accounts ?? []} />
    </div>
  )
}

/** The one `Card`: a total and its terms, subordinated vertically. */
function Head({ data, currency }: { data: BenchmarkResponse; currency: string | null }) {
  const { t } = useI18n()
  const f = useFormatters()

  const shown = data.gap_gross ?? null
  const index = data.index ?? data.reference ?? ''

  return (
    // **`aria-live="polite"`**, because this is the result of a gesture and not
    // an ambient state: switching from `CW8` to `C40` reads the eyebrow, the
    // figure and the verdict back. Polite and never assertive — the reader is
    // already looking at the control they pressed, which is `Refusal`'s own
    // reasoning for keeping `role="status"`.
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
          <DateEffect data={data} currency={currency} />
          <Period data={data} />
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
 * What the **dates** did — the other half of #983's decomposition.
 *
 * **A second statement, not a second head** (#1020, option A). The two are
 * `portfolio − reference(your days)` and `reference(your days) − smoothed`:
 * they share a middle term and sum to the gap against a disciplined index
 * investor, but the head figure is the *first* of them. Printing this one
 * under a head that already reads −4 401,96 would say the head contains both,
 * which it does not — so the head stays where the owner learned to read it and
 * this sentence explains the gap rather than enlarging it.
 *
 * **Zero is a figure here.** A perfectly regular contributor gets exactly
 * zero, and *your timing cost nothing* is the answer — not the em dash that
 * `null` gets. `null` is the all-or-nothing case of #1017: the smoothed replay
 * exhausted the reference on a day the real one did not, so there is no
 * decomposition at all, and it gets a sentence saying so rather than a dash.
 */
function DateEffect({ data, currency }: { data: BenchmarkResponse; currency: string | null }) {
  const { t } = useI18n()
  const f = useFormatters()

  const effect = data.date_effect ?? null
  const sign = signOf(effect)

  if (sign === 'absent') return <p>{t('benchmark.dates.unavailable')}</p>
  if (sign === 'zero') return <p>{t('benchmark.dates.none')}</p>
  return (
    <p>
      {t(sign === 'gain' ? 'benchmark.dates.earned' : 'benchmark.dates.cost', {
        amount: f.currency(Math.abs(effect as number), currency),
      })}
    </p>
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

/**
 * The accounts a grant with no declared price took out of the perimeter.
 *
 * **One line per account, and each names its own symbols.** Knowing a wrapper
 * is out is not actionable; knowing which grant did it is the whole gesture —
 * the reader goes to the ledger and prices that line. The payload has carried
 * `symbols` since #760, so the join below is the only thing that was missing.
 */
function Excluded({ rows }: { rows: readonly BenchmarkExclusion[] }) {
  const { t } = useI18n()

  if (rows.length === 0) return null
  return (
    <div className="max-w-prose space-y-1 text-sm text-muted-foreground">
      {rows.map((row) => {
        const symbols = (row.symbols ?? '').split(',').filter(Boolean)
        return (
          <p key={row.account}>
            {t('benchmark.excluded', {
              account: row.account,
              symbols: symbols.join(', '),
              count: symbols.length,
            })}
          </p>
        )
      })}
    </div>
  )
}
