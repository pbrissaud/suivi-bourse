/**
 * The header of the shares page — **the sum of the lines it sits above**
 * (ADR-0017, ADR-0016).
 *
 * That sentence is the whole ticket. What is written over a table is read as
 * that table's summary, and no note undoes the reading; coupled with a *hide
 * closed positions* switch it manufactures a **second correct figure** — on the
 * real portfolio, hiding the seven closed lines moves the gain from `+977,61 €`
 * to `+1 686,53 €`, and nothing on screen says which one equals the dashboard's.
 * So the closed positions never leave the table: they **fold**, the fold is not
 * a filter, and this figure does not move when the section opens.
 *
 *     Σ latent + Σ realised + Σ dividends  ==  gain_absolu
 *             (closed positions included)
 *
 * **The total is computed here and its terms are the table's columns**, which is
 * ADR-0016's form for a table: subordination is vertical, and the three columns
 * hang under this block rather than beside a fourth `Gain total` column that
 * would make five numeric columns of equal weight and invite exactly the
 * addition ADR-0018 exists to prevent.
 *
 * **One term is missing and it is stated in the bubble rather than in a
 * footnote.** ADR-0017's identity is exact on a portfolio whose transfers are
 * free and short by the fees taken from deposits and withdrawals otherwise
 * (ADR-0018) — and no position can carry them, so this page can never show that
 * term. The dashboard's head does; that is why the two figures can differ and
 * why the reader has to be told which is which.
 *
 * **Five icons here, four in the table's header row.** ADR-0016's rule is *one
 * per figure and per surface*, and the header block and the column headers are
 * two surfaces — deliberately, since a table is read scrolled with the page's
 * header off screen. The folded section is not a surface but a part of the page,
 * which is what takes eleven icons down to nine (#684 D7).
 */
import type { ReactNode } from 'react'

import type { Position } from '@/lib/api'
import type { ShareRow } from '@/lib/shares'
import { valuationTotal } from '@/lib/shares'
import { useFormatters } from '@/lib/format'
import { renderFigure } from '@/lib/absence'
import {
  securityTerms,
  sumRendering,
  termAmount,
  termCarriesSign,
  termRendering,
  type GainTermName,
} from '@/lib/gain'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { signClass } from '@/lib/sign'
import { cn } from '@/lib/utils'

/**
 * Three terms and not four. `transferFees` is deliberately absent: it belongs
 * to no security, so a header that sums its rows has nothing to sum it from —
 * and rendering it here as a fourth term would make this figure and the
 * dashboard's the same number by hand rather than by construction.
 */
const SHARES_TERMS = ['unrealised', 'realised', 'dividends'] as const

const TERM_LABELS: Record<(typeof SHARES_TERMS)[number], MessageKey> = {
  unrealised: 'shares.column.unrealised',
  realised: 'shares.column.realised',
  dividends: 'shares.column.dividends',
}


/** Identical to the dashboard head's, and for the same reason: written per site,
 *  the dash wins every time — including where the rule says *name it*. */

export interface SharesHeadProps {
  positions: readonly Position[]
  rows: readonly ShareRow[]
  currency: string | null
}

export function SharesHead({ positions, rows, currency }: SharesHeadProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const terms = securityTerms(positions)
  const valuation = valuationTotal(rows)
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b px-4 py-3.5">
      <h2 className="eyebrow">
        {t('shares.head.title')}
      </h2>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
        <Figure
          label={t('shares.column.value')}
          value={renderFigure(
            sumRendering(valuation),
            () => f.currency(valuation.known ? valuation.value : null, currency),
            t,
          )}
        />
        {SHARES_TERMS.map((term) => {
          const value = termAmount(terms, term as GainTermName)
          return (
            <Figure
              key={term}
              label={t(TERM_LABELS[term])}
              value={renderFigure(
                termRendering(terms, term as GainTermName),
                () => f.currency(value, currency),
                t,
              )}
              tone={
                value === null
                  ? signClass(null)
                  : termCarriesSign(term as GainTermName)
                    ? signClass(value)
                    : signClass(0)
              }
            />
          )
        })}
      </div>
    </div>
  )
}

/**
 * One of the strip's four: the label at the size of a caption, the figure a
 * rung above it in the mono face — subordination said in size, on one line,
 * which is what a header of a table has room for.
 */
function Figure({
  label,
  value,
  tone,
}: {
  label: string
  value: ReactNode
  tone?: string
}) {
  return (
    <span
      role="group"
      aria-label={label}
      className="flex items-baseline gap-1.5 text-xs text-muted-foreground"
    >
      <span>{label}</span>
      <span className={cn('tabular font-mono text-sm font-semibold text-foreground', tone)}>
        {value}
      </span>
    </span>
  )
}
