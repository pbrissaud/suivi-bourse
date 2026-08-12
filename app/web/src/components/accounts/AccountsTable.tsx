/**
 * The comparison table — **eight columns** (#721, ADR-0019, ADR-0016).
 *
 *     Compte · Valeur totale · Titres · Liquidités · Versé net · Gain total ·
 *     TRI · perf
 *
 * with `Type` folded into the `Compte` cell on a second level rather than
 * spending a column on a word.
 *
 * Four things about it are decisions:
 *
 *  - **It carries `Gain total` alone.** The twelve-column variant, total and its
 *    four terms side by side, **fits** at 1 440 px — which is exactly what
 *    condemns it: the constraint is one of **form**, not of room. Mounted on one
 *    line, `Gain total`, `latente`, `réalisée` and `dividendes` are numeric
 *    columns of equal weight and nothing says the last three are *inside* the
 *    first, which is the addition ADR-0003 says a contributor will attempt. The
 *    four terms live in the sheet's block instead.
 *  - **`Versé net` stays** though it is `Valeur − Gain`: it is the silent
 *    denominator of the two last columns, and it is what makes `−0,62 €` on
 *    `7 049,70 €` legible as *this account went nowhere* rather than as a typo.
 *  - **`Portefeuille`, never `Total`**, at the bottom and behind a rule. Six of
 *    its eight cells describe the whole; `TRI` and `perf` are not sums — two
 *    rates do not add — and they are **not em dashes either**, the store holding
 *    both at portfolio level. At the top the row would read as a header.
 *  - **The click selects, the label opens.** The table becomes the chart's
 *    control without adding a control, which is why the two gestures have to be
 *    visibly distinct at hover: a selection that looks like a missed click is a
 *    selection the reader undoes.
 */
import { Link } from '@tanstack/react-router'

import { Explain } from '@/components/Explain'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  declaredLabel,
  DEFAULT_ACCOUNT_LABEL,
  degradedReason,
  figure,
  isDefaultAccount,
  MONEY_COLUMNS,
  type AccountRow,
  type FigureColumn,
  type Sort,
} from '@/lib/accounts'
import type { DocsAnchor } from '@/lib/docs'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { signClass } from '@/lib/sign'
import { cn } from '@/lib/utils'

const COLUMN_LABELS: Record<FigureColumn, MessageKey> = {
  total_value: 'accounts.column.totalValue',
  holdings_value: 'accounts.column.holdings',
  cash_balance: 'accounts.column.cash',
  net_contributed: 'accounts.column.netContributed',
  gain_absolu: 'accounts.column.gainTotal',
  xirr: 'accounts.column.xirr',
  performance: 'accounts.column.performance',
}

/**
 * **Four icons on this table, and only four** — the fifth of the page's five is
 * the sheet's, on its `Gain total` block, one surface being one place.
 *
 * `Valeur totale`, `Titres` and `Liquidités` carry none: the test is *would this
 * be verifiable without knowing a rule?*, and a balance is. The two rates carry
 * one each and both end on the **same last sentence** — *returns are computed
 * from the dates of your events* — deliberately: the two are far more often
 * misread together than apart. And `perf` is the one bubble in the whole product
 * that **warns against its own figure**, because it is true and nothing else can
 * say it: the number depends on the window, and the ranking can reverse inside
 * it.
 */
const COLUMN_EXPLAIN: Partial<Record<FigureColumn, { body: MessageKey; anchor: DocsAnchor }>> = {
  net_contributed: { body: 'accounts.netContributed.explain', anchor: 'net-contributed' },
  gain_absolu: { body: 'accounts.gainTotal.explain', anchor: 'total-gain' },
  xirr: { body: 'accounts.xirr.explain', anchor: 'xirr' },
  performance: { body: 'accounts.performance.explain', anchor: 'twr' },
}

const REASON_LABELS: Record<'withoutCashLedger' | 'rebuilding' | 'empty', MessageKey> = {
  withoutCashLedger: 'accounts.reason.withoutCashLedger',
  rebuilding: 'accounts.reason.rebuilding',
  empty: 'accounts.reason.empty',
}

export interface AccountsTableProps {
  rows: readonly AccountRow[]
  /**
   * The `Portefeuille` line, or `null` at N = 1 — where it would copy the one
   * row above it word for word and add a rule between a line and itself.
   */
  portfolio: AccountRow | null
  visible: readonly FigureColumn[]
  currency: string | null
  /** Whether the reconstruction is still running. `null` — not observed here. */
  rebuilding: boolean | null
  /** The curve the chart isolates. Clicking a row toggles it. */
  selected: string | null
  /** The preview, **set** and never toggled: `null` puts every curve back. */
  onSelect: (account: string | null) => void
  /** The label, and only the label, opens the account's sheet. */
  onOpen: (account: string) => void
  sort: Sort | null
  onSort: (column: FigureColumn) => void
  /** Where a curve's colour comes from — the same index the chart drew it at. */
  colourOf: (account: string) => string | null
}

export function AccountsTable({
  rows,
  portfolio,
  visible,
  currency,
  rebuilding,
  selected,
  onSelect,
  onOpen,
  sort,
  onSort,
  colourOf,
}: AccountsTableProps) {
  const { t } = useI18n()

  return (
    <Table>
      <caption className="sr-only">{t('accounts.table.label')}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>{t('accounts.column.account')}</TableHead>
          {visible.map((column) => {
            const explain = COLUMN_EXPLAIN[column]
            return (
              <TableHead key={column} className="text-right">
                <span className="inline-flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => onSort(column)}
                    aria-label={t('accounts.sortBy', { column: t(COLUMN_LABELS[column]) })}
                    className="underline-offset-4 hover:underline"
                  >
                    {t(COLUMN_LABELS[column])}
                    {sort?.column === column ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : null}
                  </button>
                  {explain ? (
                    <Explain
                      figure={t(COLUMN_LABELS[column])}
                      body={explain.body}
                      anchor={explain.anchor}
                    />
                  ) : null}
                </span>
              </TableHead>
            )
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const reason = degradedReason(row, visible, rebuilding)
          const colour = colourOf(row.id)
          // **A row with no curve has no curve to isolate.** Selected, it would
          // dim every drawn series and highlight none — the plot going out for
          // a gesture with no subject, on a line that would nonetheless read as
          // chosen. The swatch says the same thing: no colour, no curve.
          const selectable = colour !== null
          // **One gesture per row**: pointing at it *previews* — the curve lifts
          // out of the others — and clicking it *opens*, anywhere along the row.
          // The first spelling put two clicks on one row, the row isolating the
          // curve and the name opening the panel, which is why it then had to
          // make the two hover affordances tell each other apart. There is one
          // thing to do here, so there is one thing to show.
          //
          // Two measured defects left with it: the label's `hover:text-primary`
          // was a no-op — the preset gives `--primary` the value of
          // `--foreground`, black on black in the light theme and white on white
          // in the dark — and the name carried the browser's `cursor: default`
          // inside a row carrying `pointer`, so the affordance *lost* its
          // pointer over the very word that opened the panel.
          //
          // A preview that only answers to a mouse is no preview at all for a
          // keyboard, so the name's focus does what the pointer's hover does. A
          // finger has neither and taps straight through to the panel, which is
          // the gesture carrying the figures anyway.
          return (
            <TableRow
              key={row.id}
              aria-selected={selectable ? selected === row.id : undefined}
              onClick={() => onOpen(row.id)}
              onMouseEnter={selectable ? () => onSelect(row.id) : undefined}
              onMouseLeave={selectable ? () => onSelect(null) : undefined}
              className={cn(
                'cursor-pointer hover:bg-muted/60',
                selected === row.id && 'bg-muted',
              )}
            >
              <TableCell>
                <span className="flex items-center gap-2">
                  {colour === null ? null : (
                    <span
                      aria-hidden
                      className="inline-block size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: colour }}
                    />
                  )}
                  {/* The row is the click target; this stays a **button** so the
                      panel has a name in the tab order and a keyboard way in —
                      a `<tr>` given a `tabIndex` is announced as neither. It
                      does what the row does, so the propagation is stopped only
                      to keep one call per gesture. Its focus carries the preview
                      the pointer gets from hovering. */}
                  <button
                    type="button"
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                    onFocus={selectable ? () => onSelect(row.id) : undefined}
                    onBlur={selectable ? () => onSelect(null) : undefined}
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpen(row.id)
                    }}
                  >
                    {/* The catalogue's name while the seeded row still wears the
                        one the product gave it, and the owner's the moment
                        #729's declaration block relabels it — **one function**,
                        read here and there, so the two pages cannot name one
                        thing two ways. */}
                    {declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)}
                  </button>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {isDefaultAccount(row.id) ? t('accounts.default.type') : row.type ?? row.id}
                </span>
                {/* The reason a row has no figures — a **reason**, never a
                    progress with a target date, which stays on the banner. */}
                {reason === null ? null : (
                  <span className="block text-xs text-attention">{t(REASON_LABELS[reason])}</span>
                )}
                {/* The one line the promise *your declared accounts* does not
                    cover, and the only one carrying a way to repair it. */}
                {isDefaultAccount(row.id) ? (
                  <Link
                    to="/donnees"
                    onClick={(event) => event.stopPropagation()}
                    className="block text-xs underline underline-offset-4"
                  >
                    {t('accounts.default.reassign')}
                  </Link>
                ) : null}
              </TableCell>
              {visible.map((column) => (
                <Cell key={column} row={row} column={column} currency={currency} />
              ))}
            </TableRow>
          )
        })}

        {portfolio === null ? null : (
          <TableRow className="border-t-2 hover:bg-transparent">
            <TableCell className="font-medium">{t('accounts.portfolio')}</TableCell>
            {visible.map((column) => (
              <Cell key={column} row={portfolio} column={column} currency={currency} />
            ))}
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}

/**
 * One figure. The two rates are percentages and the five others are money, and
 * a zero wears the colour of text rather than the grey of absence (`lib/sign`).
 */
function Cell({
  row,
  column,
  currency,
}: {
  row: AccountRow
  column: FigureColumn
  currency: string | null
}) {
  const f = useFormatters()
  const value = figure(row, column)
  const money = (MONEY_COLUMNS as readonly string[]).includes(column)
  // Colour goes to the figures that can turn — the gain and the two rates. A
  // total value or a cash balance painted green would steal the signal from
  // them, which is the rationing `lib/sign.ts` states and does not decide.
  const coloured = column === 'gain_absolu' || !money
  return (
    <TableCell className={`text-right tabular ${coloured ? signClass(value) : ''}`}>
      {money ? f.currency(value, currency) : f.percent(value)}
    </TableCell>
  )
}
