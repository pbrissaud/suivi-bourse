/**
 * The live lines **as a list, under 768 px** (#1338): the nine columns of
 * `SharesTable` do not fit a phone, and a table that scrolls sideways hides its
 * valuation behind a swipe. One item per held line says the three things the
 * table is read for — *which line*, *what it is worth*, *what it gained* — and
 * the rest is one tap away, in the sheet.
 *
 * Every figure comes off the same functions as the table's cells, so the two
 * cannot disagree: `positionRenderings` and `renderFigure` give the absences,
 * `sharesTotals` the foot. Nothing is boxed — the list sits on the page's
 * background like the table it stands in for (#1273) — and every figure is
 * Geist with tabular numerals; Geist Mono is the ticker and the account ids.
 */
import { TriangleAlert } from 'lucide-react'
import { useId } from 'react'

import { positionRenderings, renderFigure } from '@/lib/absence'
import { useFormatters } from '@/lib/format'
import {
  sumRendering,
  termAmount,
  termRendering,
  termTone,
  type GainTermName,
  type GainTerms,
  type Sum,
} from '@/lib/gain'
import { useI18n, type MessageKey } from '@/lib/i18n'
import {
  isAnomalous,
  marketValue,
  unrealised,
  unrealisedRatio,
  valuationTotal,
  type ShareGroup,
  type ShareRow,
} from '@/features/shares/lib/shares'
import { toneOf } from '@/lib/sign'

/**
 * The recipe of a tappable item, shared by the live lines and the closed ones:
 * the name is a button stretched over the item (`ITEM_NAME`), so the whole item
 * opens the sheet and its accessible name is the name alone, and the focus ring
 * is drawn on the item by `has-focus-visible`. The rule between items is the
 * list's `divide-y`, not a border on the item, so a radius never tapers it.
 */
export const LIST_ITEM =
  'relative flex min-h-15 cursor-pointer gap-0.5 py-2.5 has-focus-visible:rounded-md has-focus-visible:ring-2 has-focus-visible:ring-primary has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-background'
export const ITEM_NAME =
  'min-w-0 truncate text-left text-md font-medium outline-none after:absolute after:inset-0'

interface SharesListProps {
  /** One group when nothing is grouped, one per account when it is — as the table's. */
  groups: readonly ShareGroup[]
  currency: string | null
  onSelect: (symbol: string) => void
  /** What the foot sums (`sharesTotals`) — every group, and the closed lines. */
  totals: { valuation: Sum; terms: GainTerms }
  /** How many closed lines the totals include, folded or not. */
  closedCount: number
}

export function SharesList({ groups, currency, onSelect, totals, closedCount }: SharesListProps) {
  const { t } = useI18n()
  const id = useId()

  return (
    <div>
      {groups.map((group, index) =>
        group.account === null ? (
          // Every line closed: there is no list to name, only the totals below.
          group.rows.length === 0 ? null : (
            // `role="list"`: preflight's `list-style: none` makes WebKit drop the
            // list semantics of a bare `<ul>`.
            <ul key="all" role="list" aria-label={t('shares.table.label')} className="divide-y">
              {group.rows.map((row) => (
                <ShareItem
                  key={row.symbol}
                  row={row}
                  grouped={false}
                  currency={currency}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          )
        ) : (
          <section key={group.account} className="not-first:border-t">
            <GroupHead id={`${id}-${index}`} group={group} currency={currency} />
            <ul role="list" aria-labelledby={`${id}-${index}`} className="divide-y">
              {group.rows.map((row) => (
                <ShareItem
                  key={row.symbol}
                  row={row}
                  grouped
                  currency={currency}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          </section>
        ),
      )}
      <Totals totals={totals} closedCount={closedCount} currency={currency} />
    </div>
  )
}

/** The account's valuation and nothing else, drawn like the table's `GroupHead`. */
function GroupHead({
  id,
  group,
  currency,
}: {
  id: string
  group: ShareGroup
  currency: string | null
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const valuation = valuationTotal(group.rows)
  return (
    <h3 id={id} className="label border-b py-2 text-primary">
      {group.account}
      {' · '}
      <span className="tabular">
        {renderFigure(
          sumRendering(valuation),
          () => f.currency(valuation.known ? valuation.value : null, currency),
          t,
        )}
      </span>
    </h3>
  )
}

interface ShareItemProps {
  row: ShareRow
  /** Under a group head the account is said once, by the head. */
  grouped: boolean
  currency: string | null
  onSelect: (symbol: string) => void
}

function ShareItem({ row, grouped, currency, onSelect }: ShareItemProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const renderings = positionRenderings(row)
  const value = marketValue(row)
  const gain = unrealised(row)
  const ratio = unrealisedRatio(row)

  return (
    <li className={`${LIST_ITEM} flex-col justify-center`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <button type="button" className={ITEM_NAME} onClick={() => onSelect(row.symbol)}>
            {row.name ?? row.symbol}
          </button>
          {isAnomalous(row) ? (
            <span className="inline-flex shrink-0 items-center text-attention">
              <TriangleAlert className="size-4" aria-hidden />
              <span className="sr-only">{t('shares.anomaly.repair')}</span>
            </span>
          ) : null}
        </span>
        <span className={`shrink-0 text-md font-medium tabular ${toneOf(renderings.valuation, 0)}`}>
          {renderFigure(renderings.valuation, () => f.currency(value, currency), t)}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
          {row.symbol}
          {grouped || row.accounts.length === 0 ? null : ` · ${row.accounts.join(', ')}`}
        </span>
        <span
          className={`shrink-0 text-xs font-medium tabular ${toneOf(renderings.unrealised, gain)}`}
        >
          {renderFigure(renderings.unrealised, () => f.currency(gain, currency), t)}
          {renderings.unrealised.kind === 'figure' && ratio !== null ? (
            <span className="label ml-1.5">{f.percent(ratio)}</span>
          ) : null}
        </span>
      </div>
    </li>
  )
}

/** The table's total row, as four ruled rows — the same calls, the same figures. */
function Totals({
  totals,
  closedCount,
  currency,
}: {
  totals: SharesListProps['totals']
  closedCount: number
  currency: string | null
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const { valuation, terms } = totals
  const term = (name: Exclude<GainTermName, 'transferFees'>, label: MessageKey) => (
    <div className="flex items-baseline justify-between gap-3 py-2.5 text-md">
      <dt className="text-muted-foreground">{t(label)}</dt>
      <dd className={`text-right tabular ${termTone(terms, name)}`}>
        {renderFigure(
          termRendering(terms, name),
          () => f.currency(termAmount(terms, name), currency),
          t,
        )}
      </dd>
    </div>
  )
  return (
    <dl className="divide-y border-t">
      <div className="flex items-baseline justify-between gap-3 py-2.5 text-md">
        <dt>
          {t('shares.total')}
          {closedCount > 0 ? (
            <span className="label">
              {' · '}
              {t('shares.total.closed', { count: closedCount })}
            </span>
          ) : null}
        </dt>
        <dd className="text-right font-semibold tabular">
          {renderFigure(
            sumRendering(valuation),
            () => f.currency(valuation.known ? valuation.value : null, currency),
            t,
          )}
        </dd>
      </div>
      {term('unrealised', 'shares.column.unrealised')}
      {term('realised', 'shares.column.realised')}
      {term('dividends', 'shares.column.dividends')}
    </dl>
  )
}
