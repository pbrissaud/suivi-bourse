/**
 * The value-against-contributed curve, **per account and nowhere else** (#722,
 * ADR-0019).
 *
 * It is the one shape the comparison above refuses. Mounted there it is four
 * curves at two accounts and ten at five, the pairs overlap and **no surface is
 * anybody's gain**; here there is one account, two lines, and the space between
 * them is exactly what the block over it decomposes into four terms. That is the
 * whole reason this surface exists rather than a second copy of the table row.
 *
 * Two decisions about the drawing itself:
 *
 *  - **The contributed line is dashed and in the colour of text**, never a
 *    second mark of its own. It is the reference the value is read against, not
 *    a second measurement — and a second saturated hue on a two-line chart makes
 *    the reader choose which one to look at.
 *  - **A day with no contribution is a hole, never a zero** (`connectNulls`
 *    false), the same rule the price chart follows one page over: an install
 *    with no cash event has `net_contributed` at `null` for ever (#708), and a
 *    line drawn along the floor would say the owner put nothing in.
 *  - **The drawing states the span it covers** (ADR-0028, #833). The clause is
 *    *carry the period or carry no figure*, and nothing above the chart says it
 *    any more: the range control left with ADR-0028's correction, and what is
 *    drawn is the account's history end to end. The legend is therefore the one
 *    place the extent is stated, at the end of the very row the maquette puts it
 *    on — a curve with no stated extent beside a total is the unbounded-window
 *    failure in miniature. It is a **word** and not a stamp of the two dates: the
 *    span is a fact about the account rather than a choice, and two dates would
 *    date a drawing whose whole subject is that it is not cut.
 */
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'

import { ChartTooltip } from '@/components/ChartTooltip'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ValuePoint } from '@/lib/accounts'

export interface AccountCurveProps {
  points: readonly ValuePoint[]
  currency: string | null
}

export function AccountCurve({ points, currency }: AccountCurveProps) {
  const { t } = useI18n()
  const f = useFormatters()

  return (
    // **No heading of its own** (#838): the curve is drawn inside the head card
    // it is the history of, under the figure it plots — a title over it would
    // name the card a second time. Its accessible name is kept on the section,
    // for a screen reader and for a test.
    <section aria-label={t('accounts.detail.curve.title')} className="space-y-2">
      <div className="h-26">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points as ValuePoint[]}>
            {/* **Hidden, not removed** — the dashboard's chart to the letter
                (#787): the grid and the gradations left, and what the axes
                *decide* stayed. The domain is on the data and never on a window
                asked for, so the two curves fill the plot they are drawn in. */}
            <XAxis dataKey="t" hide />
            <YAxis domain={['dataMin', 'dataMax']} hide />
            {/* The exact figure is a hover away, which is what makes a chart
                with no gradations readable at all — and this one had no pointer
                to answer until the axes went. */}
            <ChartTooltip format={(value) => f.currency(value, currency)} />
            <Line
              type="monotone"
              dataKey="value"
              name={t('accounts.detail.curve.value')}
              stroke="var(--color-price)"
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="contributed"
              name={t('accounts.detail.curve.contributed')}
              stroke="var(--color-muted-foreground)"
              strokeDasharray="4 4"
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* The legend is written rather than drawn by the chart: it has to be
          readable by a test and by a screen reader, and Recharts' own is
          neither. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-2 text-2xs text-muted-foreground">
        <li className="flex items-baseline gap-2">
          <span
            aria-hidden
            className="inline-block h-0.5 w-3.5"
            style={{ backgroundColor: 'var(--color-price)' }}
          />
          {t('accounts.detail.curve.value')}
        </li>
        <li className="flex items-baseline gap-2">
          <span
            aria-hidden
            className="inline-block h-0 w-3.5 border-t-[1.5px] border-dashed border-muted-foreground"
          />
          {t('accounts.detail.curve.contributed')}
        </li>
        {/* The span, at the end of the row the maquette puts it on. `ml-auto`
            and never a third legend entry: it names no mark on the chart, it
            names the extent of both. */}
        <li className="sm:ml-auto">{t('accounts.detail.curve.period')}</li>
      </ul>
    </section>
  )
}
