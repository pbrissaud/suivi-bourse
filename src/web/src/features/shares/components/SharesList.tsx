/**
 * The shares table under 768 px (« Relevé »): a ruled list. Each line is a link
 * to the title's page — the name and the holding on the left, the valuation and
 * the gain on the right — and the total is its last line.
 */
import { Link } from '@tanstack/react-router'

import { positionRenderings, renderFigure } from '@/lib/absence'
import { useFormatters } from '@/lib/format'
import {
  sumRendering,
  termAmount,
  termRendering,
  termTone,
  type GainTerms,
  type Sum,
} from '@/lib/gain'
import { useI18n } from '@/lib/i18n'
import { marketValue, unrealised, type ShareRow } from '@/features/shares/lib/shares'
import { toneOf } from '@/lib/sign'

interface SharesListProps {
  rows: readonly ShareRow[]
  currency: string | null
  totals: { valuation: Sum; terms: GainTerms }
}

export function SharesList({ rows, currency, totals }: SharesListProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const { valuation, terms } = totals

  return (
    <ul role="list" aria-label={t('shares.table.label')} className="border-t">
      {rows.map((row) => {
        const renderings = positionRenderings(row)
        const gain = unrealised(row)
        return (
          <li key={row.symbol} className="border-b">
            <Link
              to="/shares/$symbol"
              params={{ symbol: row.symbol }}
              className="flex min-h-15 items-center justify-between gap-3 py-2"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-md font-medium">{row.name ?? row.symbol}</span>
                <span className="fig text-xs text-muted-foreground">
                  {row.symbol} · {f.quantity(row.quantity)}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end">
                <span className="fig">
                  {renderFigure(
                    renderings.valuation,
                    () => f.currency(marketValue(row), currency),
                    t,
                  )}
                </span>
                <span className={`fig text-xs ${toneOf(renderings.unrealised, gain)}`}>
                  {renderFigure(renderings.unrealised, () => f.signedCurrency(gain, currency), t)}
                </span>
              </span>
            </Link>
          </li>
        )
      })}
      <li className="flex min-h-12 items-center justify-between gap-3 border-b font-medium">
        <span>
          {t('shares.total')}{' '}
          <span className="font-normal text-muted-foreground">
            {t('shares.total.lines', { count: rows.length })}
          </span>
        </span>
        <span className="flex flex-col items-end">
          <span className="fig">
            {renderFigure(
              sumRendering(valuation),
              () => f.currency(valuation.known ? valuation.value : null, currency),
              t,
            )}
          </span>
          <span className={`fig text-xs ${termTone(terms, 'unrealised')}`}>
            {renderFigure(
              termRendering(terms, 'unrealised'),
              () => f.signedCurrency(termAmount(terms, 'unrealised'), currency),
              t,
            )}
          </span>
        </span>
      </li>
    </ul>
  )
}
