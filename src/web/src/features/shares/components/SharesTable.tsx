/**
 * The shares table (« Relevé »): the table alone, on the ground, six columns.
 *
 * `Titre` is the name with its symbol and account under it; `Détenu · prix moyen`
 * the quantity over the average purchase price; `Cours · jour` the price over
 * the day's move; `Investi`; `Valorisation · poids`; `Gain` the latent gain over
 * its ratio. A row leads to the title's page, by its name (a link) or anywhere
 * on the row. The totals are the last row, under the columns they sum.
 */
import { Link, useNavigate } from '@tanstack/react-router'
import { TriangleAlert } from 'lucide-react'

import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { positionRenderings, renderFigure } from '@/lib/absence'
import { ABSENT, useFormatters } from '@/lib/format'
import {
  sumRendering,
  termAmount,
  termRendering,
  termTone,
  type GainTerms,
  type Sum,
} from '@/lib/gain'
import { useI18n, type MessageKey } from '@/lib/i18n'
import {
  marketValue,
  unrealised,
  unrealisedRatio,
  weightShare,
  isAnomalous,
  type ShareRow,
  type ShareSort,
  type SortColumn,
} from '@/features/shares/lib/shares'
import { signClass, signOf, toneOf, RATIO_DECIMALS } from '@/lib/sign'
import { cn } from '@/lib/utils'

/** A zero move is `muted-foreground` here, not `foreground`: nothing happened. */
export function dayTone(change: number | null | undefined): string {
  return signOf(change, RATIO_DECIMALS) === 'zero'
    ? 'text-muted-foreground'
    : signClass(change, RATIO_DECIMALS)
}

const COLUMNS: { label: MessageKey; column: SortColumn; numeric: boolean }[] = [
  { label: 'shares.column.symbol', column: 'symbol', numeric: false },
  { label: 'shares.column.held', column: 'quantity', numeric: true },
  { label: 'shares.column.priceDay', column: 'price', numeric: true },
  { label: 'shares.column.invested', column: 'invested', numeric: true },
  { label: 'shares.column.valueWeight', column: 'value', numeric: true },
  { label: 'shares.column.gain', column: 'unrealised', numeric: true },
]

interface SharesTableProps {
  rows: readonly ShareRow[]
  currency: string | null
  sort: ShareSort
  onSort: (column: SortColumn) => void
  /** The day's move of each symbol, as a ratio. */
  moves: ReadonlyMap<string, number | null>
  /** What the weights are shares of. */
  whole: number
  totals: { valuation: Sum; terms: GainTerms; invested: number }
  /** The payload's own ratio of the gain on the securities' cost, when it states one. */
  gainRatio: number | null
}

export function SharesTable({
  rows,
  currency,
  sort,
  onSort,
  moves,
  whole,
  totals,
  gainRatio,
}: SharesTableProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const navigate = useNavigate()
  const { valuation, terms, invested } = totals

  return (
    <Table>
      <caption className="sr-only">{t('shares.table.label')}</caption>
      <TableHeader>
        <TableRow>
          {COLUMNS.map(({ label, column, numeric }) => (
            <TableHead
              key={column}
              numeric={numeric}
              aria-sort={
                sort.column === column
                  ? sort.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : undefined
              }
            >
              <button
                type="button"
                onClick={() => onSort(column)}
                className="rounded underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
              >
                {t(label)}
              </button>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const renderings = positionRenderings(row)
          const gain = unrealised(row)
          const ratio = unrealisedRatio(row)
          const share = weightShare(row, whole)
          const move = moves.get(row.symbol) ?? null
          const unit = row.quantity === 0 ? null : row.cost_basis / row.quantity
          return (
            <TableRow
              key={row.symbol}
              tall
              className="group cursor-pointer"
              onClick={() =>
                void navigate({ to: '/shares/$symbol', params: { symbol: row.symbol } })
              }
            >
              <TableCell className="max-w-72">
                <Link
                  to="/shares/$symbol"
                  params={{ symbol: row.symbol }}
                  onClick={(event) => event.stopPropagation()}
                  className="flex min-w-0 items-center gap-2 text-md font-medium underline-offset-4 group-hover:underline"
                >
                  <span className="truncate">{row.name ?? row.symbol}</span>
                  {isAnomalous(row) ? (
                    <span className="inline-flex shrink-0 items-center text-attention">
                      <TriangleAlert className="size-3.5" aria-hidden />
                      <span className="sr-only">{t('shares.anomaly.repair')}</span>
                    </span>
                  ) : null}
                </Link>
                <span className="block text-xs text-muted-foreground">
                  <span className="fig">{row.symbol}</span>
                  {' · '}
                  {row.accounts.join(', ')}
                </span>
              </TableCell>

              <TableCell numeric>
                {f.quantity(row.quantity)}
                <span className="block text-xs text-muted-foreground">
                  {f.currency(unit, currency)}
                </span>
              </TableCell>

              {/* The native quote: the price the reader's broker shows them. */}
              <TableCell numeric>
                {renderFigure(
                  renderings.price,
                  () => f.currency(row.price?.value ?? null, row.price?.currency ?? currency),
                  t,
                )}
                <span className={cn('block text-xs', dayTone(move))}>
                  {move === null ? ABSENT : f.percent(move)}
                </span>
              </TableCell>

              <TableCell numeric>{f.currency(row.cost_basis, currency)}</TableCell>

              <TableCell numeric>
                {renderFigure(
                  renderings.valuation,
                  () => f.currency(marketValue(row), currency),
                  t,
                )}
                <span className="block text-xs text-muted-foreground">
                  {share === null ? ABSENT : f.percentPoints(share * 100, 1)}
                </span>
              </TableCell>

              <TableCell numeric>
                <span className={toneOf(renderings.unrealised, gain)}>
                  {renderFigure(renderings.unrealised, () => f.signedCurrency(gain, currency), t)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {renderings.unrealised.kind === 'figure' && ratio !== null
                    ? f.percent(ratio)
                    : ABSENT}
                </span>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
      <TableFooter>
        <TableRow tall>
          <th scope="row" className="px-0 py-2 text-left whitespace-nowrap">
            {t('shares.total')}{' '}
            <span className="font-normal text-muted-foreground">
              {t('shares.total.lines', { count: rows.length })}
            </span>
          </th>
          <TableCell />
          <TableCell />
          <TableCell numeric>{f.currency(invested, currency)}</TableCell>
          <TableCell numeric>
            {renderFigure(
              sumRendering(valuation),
              () => f.currency(valuation.known ? valuation.value : null, currency),
              t,
            )}
            <span className="block text-xs font-normal text-muted-foreground">
              {f.percentPoints(100, 0)}
            </span>
          </TableCell>
          <TableCell numeric>
            <span className={termTone(terms, 'unrealised')}>
              {renderFigure(
                termRendering(terms, 'unrealised'),
                () => f.signedCurrency(termAmount(terms, 'unrealised'), currency),
                t,
              )}
            </span>
            {gainRatio === null ? null : (
              <span className="block text-xs font-normal text-muted-foreground">
                {f.percent(gainRatio)}
              </span>
            )}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  )
}
