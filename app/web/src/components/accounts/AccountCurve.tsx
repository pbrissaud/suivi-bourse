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
 */
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'

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
    <section className="space-y-3">
      <h3 className="text-sm font-medium">{t('accounts.detail.curve.title')}</h3>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points as ValuePoint[]}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="t" tickFormatter={(value: string) => f.date(value)} minTickGap={32} />
            <YAxis
              // On the data, never on a window asked for — the same rule the
              // price chart's axis follows.
              domain={['dataMin', 'dataMax']}
              tickFormatter={(value: number) => f.currency(value, currency, 0)}
              width={72}
            />
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
      <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <li className="flex items-baseline gap-2">
          <span
            aria-hidden
            className="inline-block size-2.5 rounded-full"
            style={{ backgroundColor: 'var(--color-price)' }}
          />
          {t('accounts.detail.curve.value')}
        </li>
        <li className="flex items-baseline gap-2">
          <span
            aria-hidden
            className="inline-block h-0.5 w-4 border-t-2 border-dashed border-muted-foreground"
          />
          {t('accounts.detail.curve.contributed')}
        </li>
      </ul>
    </section>
  )
}
