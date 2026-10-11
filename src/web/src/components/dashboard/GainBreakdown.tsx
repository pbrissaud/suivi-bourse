/**
 * Where the gain comes from — the four terms of the total, on a card of their
 * own (dashboard redesign, direction 1a).
 *
 * **The value is the hero now, and the gain is its subtitle.** The four terms
 * used to sit beside the gain at the top of the page, two by two; with the
 * portfolio's value in that place the gain is a pill under it, and its
 * decomposition comes down here, where it can be read as a decomposition: a
 * list whose rows draw the cascade of the terms onto their total.
 *
 * **Nothing is computed here.** The terms, their rendering, their tone and the
 * total are `lib/gain.ts`'s, exactly as the head used to call them — the four
 * surfaces that show a gain still share one arithmetic and one rule of colour
 * (#860).
 *
 * **The cascade is hand-written** (`shareBar.test.ts` names it beside the
 * accounts rail). Each row carries a track on one scale shared by every row: a
 * term runs from the running sum before it to the one after it — right when it
 * adds, left when it takes away — and the total runs from zero, so the last
 * term ends where the total ends (#1143). It replaces a stacked bar of absolute
 * values, which drew a loss as a positive share and a gain twice its size. The
 * geometry is `gainCascade`'s; no track is drawn when the total has no figure,
 * and the list names the missing term.
 *
 * A segment wears its figure's colour (`termCarriesSign`), at full strength:
 * direction says the sign, so colour is never the only cue.
 */
import { Explain } from '@/components/Explain'
import { Section } from '@/components/ui/section'
import type { PortfolioTotalsResponse, PositionsResponse } from '@/lib/api'
import type { RenderState } from '@/lib/dashboardLayout'
import { renderFigure } from '@/lib/absence'
import { useFormatters } from '@/lib/format'
import {
  GAIN_TERMS,
  gainCascade,
  gainTotal,
  portfolioTerms,
  sumRendering,
  termAmount,
  termCarriesSign,
  termIsRendered,
  termRendering,
  termTone,
  type Cascade,
  type CascadeStep,
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

/** The sign's hue for a signed amount, the neutral ink for the two that are not. */
function segmentClass(term: CascadeStep['term'], amount: number): string {
  if (term !== 'total' && !termCarriesSign(term)) return 'bg-muted-foreground'
  return amount < 0 ? 'bg-loss' : 'bg-gain'
}

/**
 * One row's track: its segment, if it has a step, and the zero mark. On its own
 * line under the label and the figure, which at 390 px it would crush.
 *
 * Nothing is clipped: the zero mark sits on the track's very edge whenever every
 * running sum is on one side of zero, and a segment's 2 px floor grows rightward
 * past the edge when its step ends there — `overflow-hidden` hid both.
 */
function Track({
  cascade,
  term,
  amount,
}: {
  cascade: Cascade
  term: CascadeStep['term']
  amount: number
}) {
  const step = cascade.steps.find((one) => one.term === term)
  return (
    <span
      aria-hidden
      data-cascade-step={term}
      className="relative block h-1.5 w-full rounded-full bg-background"
    >
      {step ? (
        <span
          className={cn(
            'absolute inset-y-0 block min-w-0.5 rounded-full',
            segmentClass(term, amount),
          )}
          style={{ left: `${step.left * 100}%`, width: `${step.width * 100}%` }}
        />
      ) : null}
      <span
        className="absolute -inset-y-0.5 block w-px -translate-x-1/2 bg-foreground"
        style={{ left: `${cascade.zero * 100}%` }}
      />
    </span>
  )
}

interface GainBreakdownProps {
  /** The head's two reads, `null` while either is in flight. */
  positions: PositionsResponse | null
  totals: PortfolioTotalsResponse | null
}

/**
 * What this block renders, and the **one** place it is decided: the block
 * calls it for its own `null`, and the dashboard's grid calls it to know
 * whether the card holds a place (`lib/dashboardLayout`). Two copies of the
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
  const cascade = gainCascade(terms)

  return (
    <Section title={t('dashboard.breakdown.title')}>
      {/* A column whose last line is pushed down: beside a taller card on the
          same row, the gap falls between the terms and their total, and both
          cards end on one line. */}
      <div className="flex flex-1 flex-col gap-4">
        <ul className="flex flex-col gap-2.5 text-sm">
          {shown.map((term) => (
            <li
              key={term}
              role="group"
              aria-label={t(TERM_LABELS[term])}
              className="flex flex-col gap-1"
            >
              <span className="flex items-center justify-between gap-4">
                <span className="truncate text-muted-foreground">{t(TERM_LABELS[term])}</span>
                <span className={cn('tabular font-medium', termTone(terms, term))}>
                  {renderFigure(
                    termRendering(terms, term),
                    () => f.currency(termAmount(terms, term), currency),
                    t,
                  )}
                </span>
              </span>
              {cascade ? (
                <Track cascade={cascade} term={term} amount={termAmount(terms, term) ?? 0} />
              ) : null}
            </li>
          ))}
        </ul>

        {/* The total the terms add up to, under them and ruled off: the sum is
            the reader's to check, and this is where it is checked. */}
        <div
          role="group"
          aria-label={t('dashboard.gainTotal')}
          className="mt-auto flex flex-col gap-1 border-t pt-3 text-sm"
        >
          <span className="flex items-center justify-between gap-4">
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
          </span>
          {cascade && total.known ? (
            <Track cascade={cascade} term="total" amount={total.value} />
          ) : null}
        </div>
      </div>
    </Section>
  )
}
