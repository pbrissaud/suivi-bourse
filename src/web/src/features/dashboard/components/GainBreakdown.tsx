/**
 * Where the gain comes from — the four terms of the total, on a card of their
 * own (dashboard redesign, direction 1a).
 *
 * **The value is the hero now, and the gain is its subtitle.** The four terms
 * used to sit beside the gain at the top of the page, two by two; with the
 * portfolio's value in that place the gain is a pill under it, and its
 * decomposition comes down here, where it can be read as a decomposition.
 *
 * **A statement, no drawing** (#1175): four ruled rows and a ruled-off total,
 * like an account section. With four figures the figures are the content; a
 * cascade of bars (#1143) read as four progress bars, and a window chosen in
 * the card (#1156) taught little that the year-to-date pill does not.
 *
 * **Nothing is computed here.** The terms, their rendering, their tone and the
 * total are `lib/gain.ts`'s, exactly as the head used to call them — the four
 * surfaces that show a gain still share one arithmetic and one rule of colour
 * (#860).
 */
import { Explain } from '@/components/Explain'
import { Section } from '@/components/ui/section'
import type { PortfolioTotalsResponse } from '@/features/dashboard/lib/api'
import type { PositionsResponse } from '@/features/shares/lib/api'
import type { RenderState } from '@/features/dashboard/lib/dashboardLayout'
import { renderFigure } from '@/lib/absence'
import { useFormatters } from '@/lib/format'
import {
  GAIN_TERMS,
  gainTotal,
  portfolioTerms,
  sumRendering,
  termAmount,
  termIsRendered,
  termRendering,
  termTone,
  type GainTermName,
} from '@/lib/gain'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { signClass } from '@/lib/sign'
import { cn } from '@/lib/utils'

export const TERM_LABELS: Record<GainTermName, MessageKey> = {
  unrealised: 'gain.term.unrealised',
  realised: 'gain.term.realised',
  dividends: 'gain.term.dividends',
  transferFees: 'gain.term.transferFees',
}

interface GainBreakdownProps {
  /** The head's two reads, `null` while either is in flight. */
  positions: PositionsResponse | null
  totals: PortfolioTotalsResponse | null
}

/**
 * What this block renders, and the **one** place it is decided: the block
 * calls it for its own `null`, and the dashboard's grid calls it to know
 * whether the card holds a place (`features/dashboard/lib/dashboardLayout`). Two copies of the
 * rule would leave a half-row empty the day they disagree.
 *
 * *No events at all* is the head's sentence and link; there is no gain to
 * decompose under it.
 */
export function gainBreakdownRenderState({ positions, totals }: GainBreakdownProps): RenderState {
  if (!positions || !totals) return 'pending'
  return positions.positions.length === 0 && totals.totals === null ? 'nothing' : 'renders'
}

export function GainBreakdown({ positions, totals }: GainBreakdownProps) {
  const { t } = useI18n()
  const f = useFormatters()

  if (gainBreakdownRenderState({ positions, totals }) !== 'renders' || !positions || !totals) {
    return null
  }
  const rows = positions.positions
  const totalsRow = totals.totals

  const currency = positions.base_currency ?? totals.base_currency ?? null
  const terms = portfolioTerms(rows, totalsRow?.transfer_fees ?? null)
  const total = gainTotal(terms)
  const shown = GAIN_TERMS.filter((term) => termIsRendered(term, termAmount(terms, term)))

  return (
    <Section title={t('dashboard.breakdown.title')}>
      {/* A column whose last line is pushed down: beside a taller card on the
          same row, the gap falls between the terms and their total, and both
          cards end on one line. */}
      <div className="flex flex-1 flex-col gap-4">
        <ul className="divide-y text-sm">
          {shown.map((term) => (
            <li
              key={term}
              role="group"
              aria-label={t(TERM_LABELS[term])}
              className="flex items-center justify-between gap-4 py-2"
            >
              <span className="truncate text-muted-foreground">{t(TERM_LABELS[term])}</span>
              <span className={cn('tabular font-medium', termTone(terms, term))}>
                {renderFigure(
                  termRendering(terms, term),
                  () => f.currency(termAmount(terms, term), currency),
                  t,
                )}
              </span>
            </li>
          ))}
        </ul>

        {/* The total the terms add up to, under them and ruled off: the sum is
            the reader's to check, and this is where it is checked. */}
        <div
          role="group"
          aria-label={t('dashboard.gainTotal')}
          className="mt-auto flex items-center justify-between gap-4 border-t pt-3 text-sm"
        >
          <span className="flex items-center gap-1.5 font-medium">
            {t('dashboard.gainTotal')}
            <Explain
              figure={t('dashboard.gainTotal')}
              body="dashboard.gainTotal.explain"
              anchor="total-gain"
            />
          </span>
          <span
            className={cn('tabular font-semibold', signClass(total.known ? total.value : null))}
          >
            {renderFigure(
              sumRendering(total),
              () => f.currency(total.known ? total.value : null, currency),
              t,
            )}
          </span>
        </div>
      </div>
    </Section>
  )
}
