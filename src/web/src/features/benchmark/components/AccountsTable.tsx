/**
 * Each account against the reference, over its own life (#1014) — the
 * breakdown of the head.
 *
 * The head replays every account's money in one reference; these rows replay
 * the same seeds and the same flows one account at a time, so their gaps add up
 * to the head figure, and the *Ensemble* row prints it at the foot of the column
 * to say so. A row that ended early says so on itself — its own reference could
 * not fund a withdrawal the others' did in the head — and only that row stops
 * adding up.
 *
 * Each row carries its own period: an account opened in 2024 is not judged on
 * 2019. A gap takes no sign colour (it is money not made, not money lost); each
 * side's return, under its value, keeps its own.
 *
 * **Nothing at all on a single account**, where the row would repeat the head
 * figure by figure and the period with it.
 */
import { Section } from '@/components/ui/section'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { BenchmarkResponse } from '@/features/benchmark/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { signClass } from '@/lib/sign'

const POINTS_DECIMALS = 3

export function AccountsTable({
  data,
  currency,
}: {
  data: BenchmarkResponse
  currency: string | null
}) {
  const { t } = useI18n()
  const f = useFormatters()

  const rows = data.per_account ?? []
  if (rows.length < 2) return null

  const index = data.index ?? data.reference ?? ''
  const hasTotal = data.gap_gross !== undefined
  const money = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : f.currency(value, currency)

  /** A value and, one line under it, the return it made. */
  const sided = (value: number | null | undefined, ratio: number | null | undefined) => (
    <TableCell numeric>
      <span className="flex flex-col items-end">
        <span>{money(value)}</span>
        <span className={`text-xs ${signClass(ratio ?? null, POINTS_DECIMALS)}`}>
          {f.percent(ratio, 1, 1)}
        </span>
      </span>
    </TableCell>
  )

  return (
    <Section title={t('benchmark.accounts.title')} className="mt-10">
      <Table>
        <caption className="sr-only">{t('benchmark.accounts.caption')}</caption>
        <TableHeader>
          <TableRow>
            <TableHead>{t('benchmark.accounts.column.account')}</TableHead>
            <TableHead>{t('benchmark.accounts.column.period')}</TableHead>
            <TableHead numeric>{t('benchmark.accounts.column.yours')}</TableHead>
            <TableHead numeric>{t('benchmark.accounts.column.theirs', { index })}</TableHead>
            <TableHead numeric>{t('benchmark.accounts.column.gap')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.account} tall>
              <TableCell className="font-medium">{row.account}</TableCell>
              <TableCell className="text-muted-foreground">
                {t('benchmark.accounts.period', {
                  from: f.date(row.covered_from),
                  to: f.date(row.covered_to),
                })}
                {/* Its own reason, on its own row: the head ran on, funded by
                    the other accounts' money. */}
                {row.ended === null ? null : (
                  <span className="block text-xs">
                    {t(
                      row.ended === 'exhausted'
                        ? 'benchmark.accounts.ended.exhausted'
                        : 'benchmark.accounts.ended.awaitingRate',
                    )}
                  </span>
                )}
              </TableCell>
              {sided(row.portfolio_value, row.portfolio_return)}
              {sided(row.reference_value, row.reference_return)}
              <TableCell numeric className="font-medium">
                {row.gap_gross === null ? '—' : f.signedCurrency(row.gap_gross, currency)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        {hasTotal ? (
          // The head figure at the foot of the column that sums to it: the only
          // way to make « these rows add up to it » checkable is to print it
          // where the addition ends.
          <TableFooter>
            <TableRow>
              <TableCell>{t('benchmark.accounts.total')}</TableCell>
              <TableCell />
              <TableCell numeric>{money(data.portfolio_value)}</TableCell>
              <TableCell numeric>{money(data.reference_value)}</TableCell>
              <TableCell numeric>
                {data.gap_gross === null || data.gap_gross === undefined
                  ? '—'
                  : f.signedCurrency(data.gap_gross, currency)}
              </TableCell>
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
    </Section>
  )
}
