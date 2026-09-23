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
 *  - **The head keeps the intersection, and the accounts keep their own
 *    windows** (#1014). One headline figure names one period, so the aggregate
 *    has to stop at the youngest account's start — but a table under it gives
 *    each account its own period, gap and returns, so that opening a CTO in
 *    2024 no longer takes a 2019 PEA out of the only screen that judges it.
 *  - **And that table carries a column that sums to the head** (#1032). Sitting
 *    under a headline figure, it is read as its breakdown, and the own-window
 *    column is not one: a reader adds two rows and lands hundreds of euros
 *    away, or concludes both accounts beat a portfolio that is behind. The
 *    shared-window gaps are the head's own terms, so they add up — and the
 *    total row prints the head figure at the foot of that column to say so.
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
import { StaleFigures } from '@/components/StaleFigures'
import { Unreadable } from '@/components/Unreadable'
import { BenchmarkChart } from '@/components/benchmark/BenchmarkChart'
import { ReferenceRebuild } from '@/components/benchmark/ReferenceRebuild'
import { ReferenceSelect } from '@/components/benchmark/ReferenceSelect'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  api,
  type BenchmarkExclusion,
  type BenchmarkResponse,
} from '@/lib/api'
import { currencyUnanswered } from '@/lib/firstRun'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { signClass, signOf } from '@/lib/sign'
import { oneFailure, readConditions, stalePerfPass } from '@/lib/status'

export default function BenchmarkPage() {
  const { t } = useI18n()

  const comparison = useQuery({ queryKey: ['benchmark'], queryFn: api.benchmark })
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  // The comparison's own curve **is** `account_metrics` (`benchmark_view`,
  // #1018), so this page serves the perf job's figures like the two others —
  // and it is the one read that says whether the last pass wrote them. Same
  // query key as everywhere else: one request, no new API state.
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })

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
    // **Two emptinesses, and the rows are what tell them apart.** Nothing
    // replayed at all is *record your first events*. Accounts that each
    // replayed but share no single day is the same state for the head — no
    // period, so no headline figure — and the exact opposite reading for the
    // owner: every account has a complete comparison, and the sentence below
    // would send them to a ledger that is already full.
    const rows = data.per_account ?? []
    return (
      <div className="space-y-6">
        {rows.length > 1 ? (
          <EmptyState
            title={t('benchmark.empty.noOverlap.title')}
            description={t('benchmark.empty.noOverlap.body')}
          />
        ) : (
          <EmptyState
            title={t('benchmark.empty.noEvents.title')}
            description={t('benchmark.empty.noEvents.body')}
            action={
              <Link to="/ledger" className="font-medium underline underline-offset-4">
                {t('benchmark.empty.noEvents.link')}
              </Link>
            }
          />
        )}
        <PerAccount data={data} currency={currency} />
        <Excluded rows={data.excluded_accounts ?? []} />
        {controls}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* The only branch of this page that puts figures on screen — the five
          above are empty states, and a sentence about stale figures over a
          screen that has none is a sentence about nothing. */}
      <StaleFigures at={stalePerfPass(runtime.data)} />

      <Head data={data} currency={currency} />
      <PerAccount data={data} currency={currency} />
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
 * Each account against the reference — over the **shared** period, then over
 * its own (#1014, #1032).
 *
 * The head sums over the intersection of the accounts' periods, and that
 * intersection is the *youngest* account's start: a CTO opened in 2024 pushes
 * a PEA that has run since 2019 out of four years of its own history, and
 * opening a second account is an ordinary act with no business shortening the
 * judgement of the first. The replays are already there — the server runs one
 * per account over its own window to build the head — so this table publishes
 * them rather than recomputing anything.
 *
 * **Two columns, because a table under a figure is read as its breakdown**
 * (#1032). The own-window column is not one: it is measured over a different
 * period per row, so two accounts both ahead of the reference sit under a head
 * that is behind, and a reader who adds two rows lands hundreds of euros from
 * the figure above. The shared column adds up — it is literally the terms the
 * head was summed from — and the total row under it says so by printing the
 * head figure again at the foot of that column.
 *
 * **Below the head, never instead of it.** A single headline figure has to name
 * a single period, so the aggregate keeps the intersection; these rows explain
 * why it starts where it does. Each one therefore carries its own period in the
 * same line as its figures, and a row that ends early says so on itself: a
 * reason read off the head would name the wrong account.
 *
 * **Nothing at all on a single account**, where the row would repeat the head
 * figure by figure and the period with it. The table exists to show the
 * divergence between windows; with one window there is none.
 */
function PerAccount({ data, currency }: { data: BenchmarkResponse; currency: string | null }) {
  const { t } = useI18n()
  const f = useFormatters()

  const rows = data.per_account ?? []
  if (rows.length < 2) return null

  // Absent on `nothing_to_compare`: no intersection, so no shared window to
  // state and the table is #1014's alone. The column follows the aggregate.
  const shared = new Map((data.per_account_shared ?? []).map((row) => [row.account, row]))
  const hasShared = shared.size > 0 && Boolean(data.covered_from)

  return (
    <section className="rounded-xl border bg-card">
      <h2 className="px-5 py-3.5 text-sm font-medium">{t('benchmark.accounts.title')}</h2>
      <div className="border-t">
        <Table>
          <caption className="sr-only">{t('benchmark.accounts.caption')}</caption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('benchmark.accounts.column.account')}</TableHead>
              {hasShared ? (
                <TableHead className="text-right">
                  {t('benchmark.accounts.column.gapShared')}
                </TableHead>
              ) : null}
              <TableHead>{t('benchmark.accounts.column.period')}</TableHead>
              <TableHead className="text-right">{t('benchmark.accounts.column.gap')}</TableHead>
              <TableHead className="text-right">{t('benchmark.term.yours')}</TableHead>
              <TableHead className="text-right">{t('benchmark.term.theirs')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const common = shared.get(row.account)?.gap_gross ?? null
              return (
                <TableRow key={row.account}>
                  <TableCell className="font-medium">{row.account}</TableCell>
                  {hasShared ? (
                    <TableCell className={`text-right tabular ${signClass(common)}`}>
                      {common === null ? '—' : f.signedCurrency(common, currency)}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-muted-foreground">
                    {t('benchmark.accounts.period', {
                      from: f.date(row.covered_from),
                      to: f.date(row.covered_to),
                    })}
                    {/* Its own reason, on its own row: the head names the account
                        that closed the *aggregate*, which is rarely this one. */}
                    {row.ended === null ? null : (
                      <span className="block text-2xs">
                        {t(
                          row.ended === 'exhausted'
                            ? 'benchmark.accounts.ended.exhausted'
                            : 'benchmark.accounts.ended.awaitingRate',
                        )}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className={`text-right tabular ${signClass(row.gap_gross)}`}>
                    {row.gap_gross === null ? '—' : f.signedCurrency(row.gap_gross, currency)}
                  </TableCell>
                  <TableCell className={`text-right tabular ${signClass(row.portfolio_return)}`}>
                    {points(f, row.portfolio_return)}
                  </TableCell>
                  <TableCell className={`text-right tabular ${signClass(row.reference_return)}`}>
                    {points(f, row.reference_return)}
                  </TableCell>
                </TableRow>
              )
            })}
            {/* The head figure at the foot of the column that sums to it. The
                same number as above, on purpose: the claim being made is that
                these rows add up to it, and the only way to make that claim
                checkable is to print it where the addition ends. */}
            {hasShared ? (
              <TableRow className="font-medium">
                <TableCell>{t('benchmark.accounts.total')}</TableCell>
                <TableCell
                  className={`text-right tabular ${signClass(data.gap_gross ?? null)}`}
                >
                  {data.gap_gross === null || data.gap_gross === undefined
                    ? '—'
                    : f.signedCurrency(data.gap_gross, currency)}
                </TableCell>
                <TableCell colSpan={4} />
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      {hasShared ? (
        <p className="max-w-prose border-t px-5 py-3 text-sm text-muted-foreground">
          {t('benchmark.accounts.shared', { from: f.date(data.covered_from as string) })}
        </p>
      ) : null}
    </section>
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
