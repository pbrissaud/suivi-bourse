/**
 * *Am I beating the index?*, on the dashboard (#1205) — the head of the
 * Benchmark page, said as a line of a statement.
 *
 * **The gap is in Section title, never larger**: the hero keeps the only large
 * figure on the screen. `portfolio_value` and `reference_value` are not shown:
 * dated at `covered_to`, they would read as the hero's value.
 *
 * **The state governs the card, not the presence of `gap_gross`**, as on the
 * page: a gap over a half-built reference is a wrong figure, not a short one.
 *
 * **The full width adds the curves**, and it is the *configured* width that
 * decides: a card set full keeps them under 768 px, where the grid draws every
 * card half.
 */
import { Link } from '@tanstack/react-router'

import { EmptyState } from '@/components/EmptyState'
import { NoBaseCurrency } from '@/components/NoBaseCurrency'
import { Unreadable } from '@/components/Unreadable'
import { BenchmarkChart } from '@/features/benchmark/components/BenchmarkChart'
import { NothingToCompare } from '@/features/benchmark/components/NothingToCompare'
import { ReferenceRebuild } from '@/features/benchmark/components/ReferenceRebuild'
import { Section } from '@/components/ui/section'
import type { BenchmarkAccountRow, BenchmarkResponse } from '@/features/benchmark/lib/api'
import type { Width } from '@/features/dashboard/lib/dashboardBlocks'
import type { RenderState } from '@/features/dashboard/lib/dashboardLayout'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { figureClass, signOf } from '@/lib/sign'
import type { ReadFailure } from '@/lib/status'

interface BenchmarkProps {
  benchmark: BenchmarkResponse | null
  failure?: ReadFailure | null
  /** The width the owner set — not the one the grid draws (see above). */
  width?: Width
}

/** What this block renders: the block's own `null` and the grid's, one rule. */
export function benchmarkRenderState({
  benchmark,
  failure = null,
}: Pick<BenchmarkProps, 'benchmark' | 'failure'>): RenderState {
  return benchmark === null && failure === null ? 'pending' : 'renders'
}

const LINK = 'font-medium underline underline-offset-4'

/**
 * To the cent, half away from zero as `Intl` rounds, and `−0` is a zero:
 * `±0,004 €` is *à égalité*, `±0,005 €` is a cent either way.
 *
 * The product is trimmed to 15 significant digits before rounding: `1.005 * 100`
 * is `100.49999999999999` in binary, and the decimal the owner reads is 1,005.
 */
function toCents(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const cents = Math.round(Number((Math.abs(value) * 100).toPrecision(15)))
  return (Math.sign(value) * cents) / 100 || 0
}

const VERDICT = {
  gain: 'dashboard.benchmark.ahead',
  loss: 'dashboard.benchmark.behind',
  zero: 'dashboard.benchmark.equal',
} as const

export function Benchmark({ benchmark, failure = null, width = 'half' }: BenchmarkProps) {
  const { t } = useI18n()
  const f = useFormatters()
  if (benchmark === null) return failure === null ? null : <Unreadable failure={failure} />

  const data = benchmark
  const currency = data.base_currency
  const index = data.index ?? data.reference ?? ''
  const gap = toCents(data.gap_gross)
  const ready = currency !== null && data.state === 'ready'

  const toPage = (
    <Link to="/benchmark" className={LINK}>
      {t('dashboard.benchmark.link')}
    </Link>
  )

  function body() {
    if (currency === null) return <NoBaseCurrency />
    switch (data.state) {
      case 'no_reference':
        return (
          <EmptyState
            title={t('benchmark.empty.title')}
            description={t('benchmark.empty.body')}
            action={
              <Link to="/benchmark" className={LINK}>
                {t('dashboard.benchmark.choose')}
              </Link>
            }
          />
        )
      case 'rebuilding':
      case 'splits_unknown':
        return data.rebuild ? <ReferenceRebuild rebuild={data.rebuild} /> : null
      case 'nothing_to_compare':
        // The page's sentences, by the server's `reason` (#1207); the accounts
        // that could be compared keep their rows when the total could not.
        return (
          <>
            <NothingToCompare reason={data.reason} />
            <Accounts rows={data.per_account} currency={currency} />
          </>
        )
      case 'ready':
        return (
          <>
            {/* A null gap has no verdict, and keeps its period. */}
            <p className="label">
              {[
                gap === null ? null : t(VERDICT[signOf(gap) as keyof typeof VERDICT]),
                data.covered_from && data.covered_to
                  ? `${f.date(data.covered_from)} → ${f.date(data.covered_to)}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {width === 'full' ? (
              <div className="mt-4">
                <BenchmarkChart points={data.series ?? []} index={index} currency={currency} />
              </div>
            ) : null}
            <Accounts rows={data.per_account} currency={currency} />
            <p className="mt-3 text-sm">{toPage}</p>
          </>
        )
    }
  }

  return (
    <Section
      // The index as soon as one is chosen, so the title does not change when
      // its rebuild ends.
      title={
        currency !== null && index !== ''
          ? t('dashboard.benchmark.against', { index })
          : t('dashboard.benchmark.title')
      }
      aside={
        ready ? (
          <p className={`tabular text-2xl font-semibold ${figureClass(gap)}`}>
            {gap === null ? '—' : f.signedCurrency(gap, currency)}
          </p>
        ) : null
      }
    >
      {body()}
    </Section>
  )
}

/** One row per account, signed — only with two of them, where they say more than the head. */
function Accounts({
  rows = [],
  currency,
}: {
  rows?: readonly BenchmarkAccountRow[]
  currency: string
}) {
  const { t } = useI18n()
  const f = useFormatters()
  if (rows.length < 2) return null
  return (
    <ul aria-label={t('benchmark.accounts.title')} className="mt-3">
      {rows.map((row) => {
        const gap = toCents(row.gap_gross)
        return (
          <li
            key={row.account}
            className="flex items-baseline justify-between gap-3 border-t py-2.25 text-sm first:border-t-0"
          >
            <span className="min-w-0 truncate">{row.account}</span>
            <span className={`tabular shrink-0 font-semibold ${figureClass(gap)}`}>
              {gap === null ? '—' : f.signedCurrency(gap, currency)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
