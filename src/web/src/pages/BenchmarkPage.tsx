/**
 * The comparison screen of #760 — *the same money, in one fund instead*, in the
 * « Relevé » composition: a sentence hero whose underlined fund opens the
 * picker, two bars on one scale, the chart under two text tabs, and the
 * account-by-account section.
 *
 * Page-level decisions that live here rather than in a block:
 *
 *  - **The reference comes first** (#1282): the whole page depends on this one
 *    choice, so the picker is the first line of the content in every state that
 *    offers it. **It offers the followed funds**; only those whose history is
 *    complete can be chosen (#1312), and with none ready the screen says why.
 *  - **One reading, since #1018.** Both sides sit in the same wrapper under the
 *    same declared model, so the tax answered a question about the wrapper and
 *    not about the securities.
 *  - **The head replays the whole portfolio, from its first purchase.** The
 *    table under the chart is its breakdown — each account over its own life.
 *  - **The period is the header's**, on a ready comparison only; what shortened
 *    it is said under the verdict.
 *  - **While the reference's backfill is not terminal, no figure at all** —
 *    head included. The state governs the screen, not the presence of a number:
 *    a gap over a half-built series is a wrong figure, not a short one.
 *  - **Truncation is a caption, not an absence.**
 */
import { useQuery } from '@tanstack/react-query'

import { NoBaseCurrency } from '@/components/NoBaseCurrency'
import { StaleFigures } from '@/components/StaleFigures'
import { Unreadable } from '@/components/Unreadable'
import { AccountsTable } from '@/features/benchmark/components/AccountsTable'
import { ChartBlock } from '@/features/benchmark/components/ChartBlock'
import { ComparisonHead } from '@/features/benchmark/components/ComparisonHead'
import { FundPicker } from '@/features/benchmark/components/FundPicker'
import { NothingFollowed } from '@/features/benchmark/components/NothingFollowed'
import { NothingToCompare } from '@/features/benchmark/components/NothingToCompare'
import { ReferenceRebuild } from '@/features/benchmark/components/ReferenceRebuild'
import { benchmarkApi } from '@/features/benchmark/lib/api'
import { settingsApi } from '@/features/settings/lib/api'
import { api } from '@/lib/api'
import { currencyUnanswered } from '@/lib/firstRun'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
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
    return <NothingFollowed />
  }

  // The content's first line in every state that offers it (#1282): the
  // sentence's underlined word. With none ready there is nothing to pick, and
  // the screen below says why.
  const followed = data.offered.filter((entry) => data.followed.includes(entry.symbol))
  const picker =
    data.reference === null || data.ready.length === 0 ? null : (
      <FundPicker value={data.reference} offered={followed} ready={data.ready} />
    )
  const lead =
    picker === null ? null : (
      <div className="text-md text-muted-foreground">
        {t('benchmark.lead')} {picker}
      </div>
    )

  // Two withheld states, one rendering. `splits_unknown` is a store that
  // fetched this fund before its split ratios were persisted: the series is
  // there and the history behind it is not established, so a replay counting
  // units could walk through a split it cannot see. What the reader needs to
  // know is the same in both cases — the figure is coming, the next fetch
  // brings it.
  if (data.state === 'rebuilding' || data.state === 'splits_unknown') {
    return (
      <div className="space-y-6">
        {lead}
        {data.rebuild ? (
          <ReferenceRebuild rebuild={data.rebuild} index={data.index ?? data.reference ?? ''} />
        ) : null}
      </div>
    )
  }

  if (data.state === 'nothing_to_compare') {
    return (
      <div className="space-y-6">
        {lead}
        <NothingToCompare reason={data.reason} />
        <AccountsTable data={data} currency={currency} />
      </div>
    )
  }

  return (
    <div>
      {/* The only branch of this page that puts figures on screen — the ones
          above are empty states, and a sentence about stale figures over a
          screen that has none is a sentence about nothing. */}
      <StaleFigures at={stalePerfPass(runtime.data)} />

      <ComparisonHead data={data} currency={currency} picker={picker} />
      <ChartBlock
        points={data.series ?? []}
        index={data.index ?? data.reference ?? ''}
        currency={currency}
      />
      <AccountsTable data={data} currency={currency} />
    </div>
  )
}
