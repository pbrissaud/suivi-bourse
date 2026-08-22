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
import { Explain } from '@/components/Explain'
import { Stat } from '@/components/Stat'
import type { Position } from '@/lib/api'
import type { ShareRow } from '@/lib/shares'
import { valuationTotal } from '@/lib/shares'
import { useFormatters } from '@/lib/format'
import { renderFigure } from '@/lib/absence'
import {
  gainTotal,
  securityTerms,
  sumRendering,
  termAmount,
  termCarriesSign,
  termRendering,
  type GainTermName,
} from '@/lib/gain'
import { useI18n, type MessageKey } from '@/lib/i18n'
import type { DocsAnchor } from '@/lib/docs'
import { signClass } from '@/lib/sign'

/**
 * Three terms and not four. `transferFees` is deliberately absent: it belongs
 * to no security, so a header that sums its rows has nothing to sum it from —
 * and rendering it here as a fourth term would make this figure and the
 * dashboard's the same number by hand rather than by construction.
 */
const SHARES_TERMS = ['unrealised', 'realised', 'dividends'] as const

const TERM_LABELS: Record<(typeof SHARES_TERMS)[number], MessageKey> = {
  unrealised: 'gain.term.unrealised',
  realised: 'gain.term.realised',
  dividends: 'gain.term.dividends',
}

const TERM_EXPLAIN: Record<(typeof SHARES_TERMS)[number], { body: MessageKey; anchor: DocsAnchor }> =
  {
    unrealised: { body: 'shares.unrealised.explain', anchor: 'latent-gain' },
    realised: { body: 'shares.realised.explain', anchor: 'realized-gain' },
    dividends: { body: 'shares.dividends.explain', anchor: 'dividends' },
  }

/** Identical to the dashboard head's, and for the same reason: written per site,
 *  the dash wins every time — including where the rule says *name it*. */

export interface SharesHeadProps {
  /**
   * The positions of **the rows the page is showing**, closed ones included —
   * the argument is the decision. Handed the held ones alone this block prints
   * the other correct figure, and handed the whole portfolio while the page
   * shows a subset it stops being the summary of what is under it.
   */
  positions: readonly Position[]
  rows: readonly ShareRow[]
  currency: string | null
}

export function SharesHead({ positions, rows, currency }: SharesHeadProps) {
  const { t } = useI18n()
  const f = useFormatters()

  // The same arithmetic the dashboard's head runs, on a surface where the
  // fourth term has **no subject** — which is `securityTerms` and not
  // `portfolioTerms(positions, null)`: since #775 that `null` says *there is no
  // day to bound the fees by*, and read here it would put an em dash over a
  // table whose rows do add up.
  const terms = securityTerms(positions)
  const total = gainTotal(terms)
  const valuation = valuationTotal(rows)

  return (
    <div className="space-y-6">
      <Stat
        size="head"
        label={t('shares.gainTotal')}
        value={renderFigure(
          sumRendering(total),
          () => f.currency(total.known ? total.value : null, currency),
          t,
        )}
        valueClassName={signClass(total.known ? total.value : null)}
        explain={
          <Explain
            figure={t('shares.gainTotal')}
            body="shares.gainTotal.explain"
            anchor="total-gain"
          />
        }
      />

      {/* The three terms, on their own row and never on the head's — and the
          same three the table carries as columns. */}
      {/* **A row that spreads rather than one that packs left.** `flex
            flex-wrap` put a fixed gap between the figures and left the rest of
            the card empty — invisible while the content column was capped at
            1 280 px, and the whole right half of the card since #792 uncapped it
            (ADR-0022, amended). `auto-fit` collapses the tracks nothing fills,
            so the figures that **do** exist share the width whatever their
            number, which is what these rows need: both render only the terms and
            the statistics this installation has. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-x-6 gap-y-4 border-t pt-4">
        {SHARES_TERMS.map((term) => {
          const value = termAmount(terms, term as GainTermName)
          return (
            <Stat
              key={term}
              size="term"
              label={t(TERM_LABELS[term])}
              value={renderFigure(
                termRendering(terms, term as GainTermName),
                () => f.currency(value, currency),
                t,
              )}
              // Colour only where the sign can turn: a dividend received is
              // never negative, so painting it steals the signal from the red
              // of a realised loss.
              valueClassName={
                value === null
                  ? signClass(null)
                  : termCarriesSign(term as GainTermName)
                    ? signClass(value)
                    : signClass(0)
              }
              explain={
                <Explain
                  figure={t(TERM_LABELS[term])}
                  body={TERM_EXPLAIN[term].body}
                  anchor={TERM_EXPLAIN[term].anchor}
                />
              }
            />
          )
        })}
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-x-6 gap-y-4 border-t pt-4">
        <Stat
          label={t('shares.value')}
          value={renderFigure(
            sumRendering(valuation),
            () => f.currency(valuation.known ? valuation.value : null, currency),
            t,
          )}
          explain={
            <Explain
              figure={t('shares.value')}
              body="shares.value.explain"
              anchor="carrying-price"
            />
          }
        />
      </div>
    </div>
  )
}
