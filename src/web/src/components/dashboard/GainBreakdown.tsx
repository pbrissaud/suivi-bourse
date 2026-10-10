/**
 * Where the gain comes from — the four terms of the total, on a card of their
 * own (dashboard redesign, direction 1a).
 *
 * **The value is the hero now, and the gain is its subtitle.** The four terms
 * used to sit beside the gain at the top of the page, two by two; with the
 * portfolio's value in that place the gain is a pill under it, and its
 * decomposition comes down here, where it can be read as a decomposition: a
 * bar that closes a whole, and the list it is the drawing of.
 *
 * **Nothing is computed here.** The terms, their rendering, their tone and the
 * total are `lib/gain.ts`'s, exactly as the head used to call them — the four
 * surfaces that show a gain still share one arithmetic and one rule of colour
 * (#860).
 *
 * **The stacked bar is hand-written, and it is the second one** after the
 * accounts rail's (`shareBar.test.ts` names both). Its segments are adjacent
 * parts of one total, which no per-line `ShareBar` can say. It is drawn only
 * when every term is a figure: a whole with a term missing is not that whole,
 * and the list under it names the missing one.
 */
import { Explain } from '@/components/Explain'
import { Section } from '@/components/ui/section'
import type { PortfolioTotalsResponse, PositionsResponse } from '@/lib/api'
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

/**
 * One shade of the gain per term, from the strongest to the faintest, and the
 * loss for whatever took money out. The shade is the term's identity in the
 * bar; the sign is said by the hue, and again by the figure in the list.
 */
const GAIN_SHADES: Record<GainTermName, string> = {
  unrealised: 'bg-gain',
  realised: 'bg-gain/60',
  dividends: 'bg-gain/30',
  transferFees: 'bg-gain/20',
}
const LOSS_SHADE = 'bg-loss/60'

interface GainBreakdownProps {
  /** The head's two reads, `null` while either is in flight. */
  positions: PositionsResponse | null
  totals: PortfolioTotalsResponse | null
}

export function GainBreakdown({ positions, totals }: GainBreakdownProps) {
  const { t } = useI18n()
  const f = useFormatters()

  if (!positions || !totals) return null
  const rows = positions.positions
  const totalsRow = totals.totals
  // *No events at all* is the head's sentence and link; there is no gain to
  // decompose under it.
  if (rows.length === 0 && totalsRow === null) return null

  const currency = positions.base_currency ?? totals.base_currency ?? null
  const terms = portfolioTerms(rows, totalsRow?.transfer_fees ?? null)
  const total = gainTotal(terms)
  const shown = GAIN_TERMS.filter((term) => termIsRendered(term, termAmount(terms, term)))
  const shadeOf = (term: GainTermName) => {
    const amount = termAmount(terms, term)
    return amount !== null && amount < 0 ? LOSS_SHADE : GAIN_SHADES[term]
  }

  // The bar closes a whole only when every term it would draw is a figure.
  const segments = shown.map((term) => ({
    term,
    amount: termRendering(terms, term).kind === 'figure' ? termAmount(terms, term) : null,
  }))
  const whole = segments.every((one) => one.amount !== null)
    ? segments.reduce((sum, one) => sum + Math.abs(one.amount ?? 0), 0)
    : 0

  return (
    <Section title={t('dashboard.breakdown.title')}>
      <div className="space-y-4">
        {whole === 0 ? null : (
          <div
            aria-hidden
            className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
          >
            {segments.map(({ term, amount }) =>
              amount === 0 ? null : (
                <span
                  key={term}
                  className={cn('block h-full', shadeOf(term))}
                  style={{ width: `${(Math.abs(amount ?? 0) / whole) * 100}%` }}
                />
              ),
            )}
          </div>
        )}

        <ul className="flex flex-col gap-1.5 text-sm">
          {shown.map((term) => (
            <li
              key={term}
              role="group"
              aria-label={t(TERM_LABELS[term])}
              className="flex items-center justify-between gap-4"
            >
              <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <span aria-hidden className={cn('size-2 shrink-0 rounded-full', shadeOf(term))} />
                <span className="truncate">{t(TERM_LABELS[term])}</span>
              </span>
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
          className="flex items-center justify-between gap-4 border-t pt-3 text-sm"
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
