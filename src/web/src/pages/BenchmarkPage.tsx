/**
 * The comparison screen of #760 — *the same money, in one fund instead*.
 *
 * Page-level decisions that live here rather than in a block:
 *
 *  - **The head figure is in euros.** `Stat.tsx` states the rule this obeys:
 *    the euro and the percentage are two figures that must never share a line.
 *    Each side's own return is filed one weight down, in a `term` row, and
 *    their gap in points is not printed at all (#1112): a third percentage
 *    beside two is one more rate to tell apart. The euro leads because the head answers *how much is
 *    left*, which is a euro question, and because a percentage gap is ambiguous
 *    on its face — difference of two returns? in points? annualised?
 *  - **The reference comes first** (#1282): the whole page depends on this one
 *    choice, and the header bar is closed to controls, so the picker is the
 *    content's first row in every state that offers it.
 *  - **One reading, since #1018.** Both sides sit in the same wrapper under
 *    the same declared model, so the tax answered a question about the wrapper
 *    and not about the securities — and the account page already publishes
 *    *Impôt projeté* with its assiette and its rate for whoever asks it.
 *  - **The head stays on the securities, and alone.** #1020 printed the date
 *    effect as a second statement under the verdict; the redesign took it off
 *    the screen, and #1048 took the replay behind it out of the payload.
 *  - **The head replays the whole portfolio, from its first purchase.** The
 *    question is what became of every euro put into securities, whichever
 *    wrapper it went through, so opening a CTO in 2024 does not take a 2019
 *    PEA's years out of the headline. The table under it is its breakdown —
 *    each account over its own life, the same seeds and flows — and the total
 *    row prints the head figure at the foot of the gaps to say they add up,
 *    which is the whole explanation: no sentence under the table repeats it.
 *  - **No range control.** A counterfactual replays the flows from the
 *    beginning: narrowing it to a year does not shorten the answer, it asks a
 *    different question. The header subtitle announces the period it covers
 *    instead, on a ready comparison only; what shortens it is said under the
 *    verdict.
 *  - **A gap takes no sign colour** (#1282): it is money not made, not money
 *    lost. Each side's own return is a gain or a loss and keeps its colour.
 *  - **While the reference's backfill is not terminal, no figure at all** —
 *    head included. The state governs the screen, not the presence of a
 *    number: a gap over a half-built series is a wrong figure, not a short one.
 *  - **Truncation is a caption, not an absence.** With a 2024 fund the screen
 *    has a complete, correct answer over a shorter window; nothing is missing,
 *    so neither the em dash nor an empty state applies.
 */
import { useQuery } from '@tanstack/react-query'

import { EmptyState } from '@/components/EmptyState'
import { Explain } from '@/components/Explain'
import { NoBaseCurrency } from '@/components/NoBaseCurrency'
import { ShareBar } from '@/components/ShareBar'
import { Stat } from '@/components/Stat'
import { StaleFigures } from '@/components/StaleFigures'
import { Unreadable } from '@/components/Unreadable'
import { BenchmarkChart } from '@/features/benchmark/components/BenchmarkChart'
import { NothingToCompare } from '@/features/benchmark/components/NothingToCompare'
import { ReferenceRebuild } from '@/features/benchmark/components/ReferenceRebuild'
import { ReferenceSelect } from '@/features/benchmark/components/ReferenceSelect'
import { Section } from '@/components/ui/section'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { benchmarkApi, type BenchmarkResponse } from '@/features/benchmark/lib/api'
import { settingsApi } from '@/features/settings/lib/api'
import { api } from '@/lib/api'
import { currencyUnanswered } from '@/lib/firstRun'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { figureClass, signClass, signOf } from '@/lib/sign'
import { oneFailure, readConditions, stalePerfPass } from '@/lib/status'

export default function BenchmarkPage() {
  const { t } = useI18n()
  const f = useFormatters()

  const comparison = useQuery({ queryKey: ['benchmark'], queryFn: benchmarkApi.benchmark })
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  // The comparison's own curve **is** `account_metrics` (`benchmark_view`,
  // #1018), so this page serves the perf job's figures like the two others —
  // and it is the one read that says whether the last pass wrote them. Same
  // query key as everywhere else: one request, no new API state.
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })

  // The period is declared on a ready comparison only: in flight, withheld or
  // empty, there is no period to state — nor over the screen that says there is
  // no currency, which the two guards below show.
  const covered =
    comparison.data?.state === 'ready' &&
    comparison.data.base_currency !== null &&
    currencyUnanswered(config.data?.settings) !== true
      ? comparison.data
      : null
  usePageHeading(
    t('page.benchmark'),
    covered?.covered_from && covered.covered_to
      ? t('benchmark.period', {
          from: f.date(covered.covered_from),
          to: f.date(covered.covered_to),
        })
      : null,
  )

  // The band's sentence, one floor down (#829). With no reporting currency
  // nothing is converted and there is no curve on either side of the
  // comparison — so this page would be two em dashes with no reason given.
  if (currencyUnanswered(config.data?.settings) === true) {
    return <NoBaseCurrency />
  }

  const failure = oneFailure(readConditions({ queries: [comparison] }))
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
        action={<ReferenceSelect value={null} offered={data.offered} downloaded={data.consulted} />}
      />
    )
  }

  // The content's first row in every state that offers it (#1282). The trigger's
  // own `aria-label` names it; the visible word is for the eye.
  const controls = (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="text-sm whitespace-nowrap text-muted-foreground">
        {t('benchmark.select.compare')}
      </span>
      {/* The trigger takes the rest of the line under 640 px. */}
      <div className="min-w-0 flex-1 sm:flex-none">
        <ReferenceSelect
          value={data.reference}
          offered={data.offered}
          downloaded={data.consulted}
          triggerClassName="sm:w-auto sm:min-w-56"
        />
      </div>
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
        {controls}
        {data.rebuild ? <ReferenceRebuild rebuild={data.rebuild} /> : null}
      </div>
    )
  }

  if (data.state === 'nothing_to_compare') {
    return (
      <div className="space-y-6">
        {controls}
        <NothingToCompare reason={data.reason} />
        <PerAccount data={data} currency={currency} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {controls}

      {/* The only branch of this page that puts figures on screen — the five
          above are empty states, and a sentence about stale figures over a
          screen that has none is a sentence about nothing. */}
      <StaleFigures at={stalePerfPass(runtime.data)} />

      <Head data={data} currency={currency} />

      {/* The sections: 20 px apart, and the hero's 40 above the first. */}
      <div className="mt-4 space-y-5">
        <BenchmarkChart
          points={data.series ?? []}
          index={data.index ?? data.reference ?? ''}
          currency={currency}
        />
        <PerAccount data={data} currency={currency} />
      </div>
    </div>
  )
}

/**
 * The head, on the ground, like the dashboard's and the accounts page's: the
 * gap as the hero, the verdict and the caveats, then the period line and the
 * two returns on one row (#1273).
 *
 * The two returns carry a bar each, on one scale, so *behind, by roughly how
 * much* reads before the digits do. The bars take the curves' own colours —
 * the same two things, drawn twice on the screen — and never a sign colour:
 * the sign is the figure's, through `lib/sign.ts`.
 */
function Head({ data, currency }: { data: BenchmarkResponse; currency: string | null }) {
  const { t } = useI18n()
  const f = useFormatters()

  const shown = data.gap_gross ?? null
  const index = data.index ?? data.reference ?? ''
  const scale =
    Math.max(Math.abs(data.portfolio_return ?? 0), Math.abs(data.reference_return ?? 0)) * 1.25

  return (
    // **`aria-live="polite"`**, because this is the result of a gesture and not
    // an ambient state: switching from `CW8` to `C40` reads the label, the
    // figure and the verdict back. Polite and never assertive — the reader is
    // already looking at the control they pressed, which is `Refusal`'s own
    // reasoning for keeping `role="status"`.
    <div className="space-y-4" aria-live="polite">
      <Stat
        size="head"
        // The picker right above already names the fund and its ticker.
        label={t('benchmark.head.label', { index })}
        value={shown === null ? '—' : f.signedCurrency(shown, currency)}
        valueClassName={figureClass(shown)}
        explain={
          <Explain
            figure={t('benchmark.term.gap')}
            body="benchmark.explain.gap"
            anchor="benchmark"
          />
        }
      />
      {shown === null ? null : (
        <p className="max-w-prose text-base leading-relaxed">
          {signOf(shown) === 'zero'
            ? t('benchmark.verdict.equal', { index })
            : t(signOf(shown) === 'gain' ? 'benchmark.verdict.ahead' : 'benchmark.verdict.behind', {
                gap: f.currency(Math.abs(shown), currency),
                index,
              })}
        </p>
      )}
      <Caveats data={data} />

      <p className="label text-muted-foreground">
        {data.covered_from && data.covered_to
          ? t('benchmark.returns.title', {
              from: f.date(data.covered_from),
              to: f.date(data.covered_to),
            })
          : t('benchmark.returns.titleBare')}
      </p>
      <div data-row="returns" className="flex flex-wrap gap-x-10 gap-y-4">
        <div className="w-56 max-w-full">
          <Stat
            size="figure"
            label={t('benchmark.term.yours')}
            value={points(f, data.portfolio_return)}
            valueClassName={signClass(data.portfolio_return ?? null, POINTS_DECIMALS)}
          >
            <ShareBar
              share={magnitude(data.portfolio_return)}
              scale={scale}
              // The sign's colour, as on the per-account bars: a loss drawn in
              // the gain's green read as a gain (#1112), and a return that reads
              // `0,0 %` takes neither (#1286).
              fill={
                {
                  gain: 'var(--gain)',
                  loss: 'var(--loss)',
                  zero: 'var(--muted-foreground)',
                  absent: 'var(--muted-foreground)',
                }[signOf(data.portfolio_return ?? null, POINTS_DECIMALS)]
              }
              size="block"
              className="mt-1.5"
            />
          </Stat>
        </div>
        <div className="w-56 max-w-full">
          <Stat
            size="figure"
            label={t('benchmark.term.theirs')}
            value={points(f, data.reference_return)}
            valueClassName={signClass(data.reference_return ?? null, POINTS_DECIMALS)}
          >
            <ShareBar
              share={magnitude(data.reference_return)}
              scale={scale}
              fill="var(--muted-foreground)"
              size="block"
              className="mt-1.5"
            />
          </Stat>
        </div>
      </div>
    </div>
  )
}

/**
 * Each account against the reference, over its own life (#1014) — the
 * breakdown of the head.
 *
 * The head replays every account's money in one reference; these rows replay
 * the same seeds and the same flows one account at a time, so their gaps add
 * up to the head figure, and the total row prints it at the foot of the column
 * to say so. A row that ended early says so on itself — its own reference
 * could not fund a withdrawal the others' did in the head — and only that row
 * stops adding up.
 *
 * Each row carries its own period in the same line as its figures: an account
 * opened in 2024 is not judged on 2019, and the reader has to see which years
 * each gap covers.
 *
 * **Nothing at all on a single account**, where the row would repeat the head
 * figure by figure and the period with it.
 */
function PerAccount({ data, currency }: { data: BenchmarkResponse; currency: string | null }) {
  const { t } = useI18n()
  const f = useFormatters()

  const rows = data.per_account ?? []
  if (rows.length < 2) return null

  const hasTotal = data.gap_gross !== undefined
  const scale = Math.max(0, ...rows.map((row) => Math.abs(row.gap_gross ?? 0)))

  // **One table, two layouts.** On a phone each row stacks into a card — the
  // same cells, `display` changed — so a row stays a `<tr>` for every reader
  // and nothing is rendered twice.
  const stack = 'max-sm:block max-sm:border-0 max-sm:p-0 max-sm:whitespace-normal'
  // On the section's plane: no strip under the header, and rows that are not
  // interactive do not answer the pointer.
  const bare = 'bg-transparent'
  const still = 'hover:bg-transparent'

  return (
    <Section title={t('benchmark.accounts.title')}>
      <Table className="max-sm:block">
        <caption className="sr-only">{t('benchmark.accounts.caption')}</caption>
        <TableHeader className="max-sm:hidden">
          <TableRow>
            <TableHead className={`pl-0 xl:pl-0 ${bare}`}>
              {t('benchmark.accounts.column.account')}
            </TableHead>
            <TableHead className={bare}>{t('benchmark.accounts.column.period')}</TableHead>
            <TableHead className={`text-right ${bare}`}>
              {t('benchmark.accounts.column.gap')}
            </TableHead>
            <TableHead className={`pr-0 text-right xl:pr-0 ${bare}`}>
              {t('benchmark.accounts.column.returns')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="max-sm:block">
          {rows.map((row) => (
            <TableRow
              key={row.account}
              className={`${still} max-sm:flex max-sm:flex-col max-sm:gap-2.5 max-sm:border-b max-sm:p-4`}
            >
              <TableCell className={`pl-0 font-semibold xl:pl-0 ${stack}`}>{row.account}</TableCell>
              <TableCell className={`text-muted-foreground ${stack}`}>
                {t('benchmark.accounts.period', {
                  from: f.date(row.covered_from),
                  to: f.date(row.covered_to),
                })}
                {/* Its own reason, on its own row: the head ran on, funded by
                    the other accounts' money. */}
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
              <TableCell className={`sm:min-w-44 ${stack}`}>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-xs text-muted-foreground sm:hidden">
                    {t('benchmark.accounts.column.gap')}
                  </span>
                  <span className={`tabular ml-auto font-semibold ${figureClass(row.gap_gross)}`}>
                    {row.gap_gross === null ? '—' : f.signedCurrency(row.gap_gross, currency)}
                  </span>
                </div>
                <ShareBar
                  share={magnitude(row.gap_gross)}
                  scale={scale}
                  // A gap is not a gain or a loss: the weight colour, whichever side it falls.
                  fill="var(--muted-foreground)"
                  size="block"
                  className="mt-2"
                />
              </TableCell>
              <TableCell
                className={`tabular text-xs text-muted-foreground sm:text-right sm:pr-0 xl:pr-0 ${stack}`}
              >
                <Returns f={f} yours={row.portfolio_return} theirs={row.reference_return} />
              </TableCell>
            </TableRow>
          ))}
          {/* The head figure at the foot of the column that sums to it. The
              same number as above, on purpose: the claim being made is that
              these rows add up to it, and the only way to make that claim
              checkable is to print it where the addition ends. */}
          {hasTotal ? (
            // The 1 px `rule` above it is the last account row's own bottom border:
            // `TableBody` zeroes the border of its last row.
            <TableRow
              className={`${still} font-semibold max-sm:flex max-sm:flex-col max-sm:gap-2.5 max-sm:p-4`}
            >
              <TableCell className={`label pl-0 xl:pl-0 ${stack}`}>
                {t('benchmark.accounts.total')}
              </TableCell>
              <TableCell className={`max-sm:hidden ${stack}`} />
              <TableCell
                className={`tabular text-right ${figureClass(data.gap_gross ?? null)} ${stack}`}
              >
                {data.gap_gross === null || data.gap_gross === undefined
                  ? '—'
                  : f.signedCurrency(data.gap_gross, currency)}
              </TableCell>
              <TableCell
                className={`tabular text-xs font-normal text-muted-foreground sm:pr-0 sm:text-right xl:pr-0 ${stack}`}
              >
                <Returns f={f} yours={data.portfolio_return} theirs={data.reference_return} />
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </Section>
  )
}

/** *Vous +x % · Référence +y %*, the two returns of one row. */
function Returns({
  f,
  yours,
  theirs,
}: {
  f: ReturnType<typeof useFormatters>
  yours: number | null | undefined
  theirs: number | null | undefined
}) {
  const { t } = useI18n()
  return (
    <>
      {t('benchmark.accounts.yours')}{' '}
      <span className={signClass(yours ?? null, POINTS_DECIMALS)}>{points(f, yours)}</span>
      {' · '}
      {t('benchmark.accounts.theirs')}{' '}
      <span className={signClass(theirs ?? null, POINTS_DECIMALS)}>{points(f, theirs)}</span>
    </>
  )
}

/**
 * A figure's size, for a bar drawn beside it — `null` stays *no bar*. The bars
 * compare magnitudes on one scale (`ShareBar`'s own), and the sign is the
 * written figure's, in its colour.
 */
function magnitude(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.abs(value)
}

/**
 * One of the three subordinate figures, at **one** decimal.
 *
 * Two decimals are right for a figure that leads a screen and too much for
 * three that sit under a euro: the row is read as a shape — ahead, behind, by
 * roughly how much — and a second decimal on each of them is three digits of
 * noise across it.
 *
 * The sign is carried, because a gap of zero is a figure and an unsigned
 * `6,4 %` beside a signed euro reads as a different kind of number. `Intl`
 * places it on the rounded figure, so `+0,04 %` is `0,0 %` (#1286), and its
 * colour is read at the same {@link POINTS_DECIMALS}.
 */
function points(f: ReturnType<typeof useFormatters>, value: number | null | undefined): string {
  return f.percent(value, 1, 1)
}

/** A ratio at one decimal of percent. */
const POINTS_DECIMALS = 3

/**
 * What shortened the period, under the verdict — the period itself is the
 * header's subtitle, which truncates and is hidden under 768 px, so a sentence
 * about what the gap leaves out stays next to the gap.
 *
 * It reads the **computed** period and never the fund's inception alone: the
 * seed lands at the later of the fund's first close and the account's first
 * written day, and an exhausted reference or a missing rate can end it early.
 * A caption naming a period the arithmetic did not honour is worse than none.
 */
function Caveats({ data }: { data: BenchmarkResponse }) {
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

  const sentences = [
    lost > 0
      ? t('benchmark.period.truncated', { from: f.date(data.covered_from), years: lost })
      : null,
    data.ended === 'exhausted'
      ? t('benchmark.period.exhausted', { to: f.date(data.covered_to) })
      : data.ended === 'awaiting_rate'
        ? t('benchmark.period.awaitingRate', { to: f.date(data.covered_to) })
        : null,
  ].filter((sentence) => sentence !== null)
  if (sentences.length === 0) return null

  return <p className="max-w-prose text-sm text-muted-foreground">{sentences.join(' ')}</p>
}

/**
 * Whole years between two `YYYY-MM-DD` days, never a difference of year parts.
 *
 * Under a year the caption stays silent, which says no less: *eleven months of
 * your history are outside this gap* is not what the sentence is for — it exists
 * for the case where truncation actually bites, and the subtitle already names
 * both ends.
 */
function elapsedYears(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const whole = ty - fy
  return tm > fm || (tm === fm && td >= fd) ? whole : whole - 1
}
