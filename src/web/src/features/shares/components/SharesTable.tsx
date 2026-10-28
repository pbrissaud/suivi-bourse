/**
 * The live table — **nine columns** (#684 D3, #791, #831).
 *
 *     Titre · Cours · Détenu · PRU · Valorisation · Latente · Réalisée ·
 *     Dividendes · Compte
 *
 * with the percentage **after the latent gain, on its line** (#1281) rather than in
 * a column of its own. Three columns are absent on purpose and each for its own
 * reason:
 *
 *  - **`Écart unitaire` is dead.** It is `Cours − PRU`, two columns already on
 *    the same line, and a position carried at its cost makes it **nil by
 *    construction** — a column whose remarkable value is a zero that means
 *    nothing.
 *  - **`Investi` does not come in**: it is `Valorisation − latente`, and it
 *    stays on the sheet.
 *  - **There is no fourth `Gain total` column.** The footer row *is* their
 *    sum (#1281), under the columns it sums: five numeric columns of equal
 *    weight say nothing about the last four being *inside* the first.
 *
 * **And `Poids` is not a column either, on the maquette's own evidence**
 * (#831). It was one at #791, was taken out on sight, and came back as a bar at
 * #832 — read off the *source* of the drawing rather than off the drawing.
 * Rendered, the maquette's table has these nine headers and no tenth: the word
 * `Poids` appears three times in it and never once on this page, twice in the
 * account's own surface (#833's *Poids des comptes* and its sortable column)
 * and nowhere else. What the maquette answers the weight with **here** is the
 * `Répartition` above the table — a ring and a legend of bars, a figure of the
 * whole rather than a tenth cell on every line — and that block is mounted on
 * this page now.
 *
 * `placedValue`, `weightShare` and `weightRendering` stay in `features/shares/lib/shares.ts`:
 * they outlived this column once already, and `AccountDetail`'s held lines read
 * them, where a weight is a glance down a dozen rows rather than a column.
 *
 * **Every column sorts, and an absence never rises** (`features/shares/lib/shares.ts`). The
 * order lives on the `<th>` as `aria-sort`, where a reader who cannot see the
 * arrow is told what is in force, and the control inside it is a button —
 * pressing the column already in force turns it round.
 *
 * **Grouping by account is a partition and not a filter**: each group's
 * subtotal is in the **group header**, and the table's own total row (#1281)
 * sums every group.
 *
 * **The market-state pill is not a column.** Eleven rows rendered ten identical
 * *Marché ouvert* and one *Cours figé*: a per-row marker that does not
 * discriminate is noise however correct it is.
 *
 * **And there is no date column.** One mention at the level of the page says
 * *Cours au …*; the rows that depart from it already say so by the absence
 * rule, the em dash in `Cours` being the signal itself.
 */
import { ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react'

import { Explain } from '@/components/Explain'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { positionRenderings, renderFigure } from '@/lib/absence'
import type { DocsAnchor } from '@/lib/docs'
import { ABSENT, useFormatters } from '@/lib/format'
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
  unitCost,
  unrealised,
  unrealisedRatio,
  valuationTotal,
  type ShareGroup,
  type ShareRow,
  type ShareSort,
  type SortColumn,
} from '@/features/shares/lib/shares'
import { signClass, toneOf } from '@/lib/sign'
import { cn } from '@/lib/utils'

/**
 * The four column headers that rest on a convention — and only four. `Cours`
 * and `Valorisation` carry none here because the carrying rule is stated once,
 * on the page header's `Valorisation`, and `Détenu`, `Titre` and `Compte` are
 * facts rather than figures: the test is *would this be verifiable without
 * knowing a rule?*
 *
 */
const COLUMN_EXPLAIN: Partial<Record<MessageKey, { body: MessageKey; anchor: DocsAnchor }>> = {
  'shares.column.avgCost': { body: 'shares.avgCost.explain', anchor: 'avg-cost' },
  'shares.column.unrealised': { body: 'shares.unrealised.explain', anchor: 'latent-gain' },
  'shares.column.realised': { body: 'shares.realised.explain', anchor: 'realized-gain' },
  'shares.column.dividends': { body: 'shares.dividends.explain', anchor: 'dividends' },
}

interface ColumnHeadProps {
  label: MessageKey
  column: SortColumn
  sort: ShareSort
  onSort: (column: SortColumn) => void
  numeric?: boolean
  /** Where the column sits, and nothing else: a width. */
  className?: string
}

function ColumnHead({ label, column, sort, onSort, numeric, className }: ColumnHeadProps) {
  const { t } = useI18n()
  const explain = COLUMN_EXPLAIN[label]
  const inForce = sort.column === column
  const Arrow = sort.direction === 'asc' ? ArrowUp : ArrowDown
  return (
    // `aria-sort` is the state, and it is on the cell rather than on the button
    // because that is where a reader jumping by column is told what is in
    // force — the arrow beside it being for the other reader.
    <TableHead
      aria-sort={inForce ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn(numeric && 'text-right', className)}
    >
      {/* On touch the ⓘ's hit area reaches 14 px past its icon: the gap keeps
          it off the sort button's label. */}
      <span
        className={`inline-flex items-center gap-1.5 pointer-coarse:gap-3.5 ${numeric ? 'justify-end' : ''}`}
      >
        {/* The control is the label itself: a table whose every column sorts has
            nine of these, and nine *Trier par …* would be nine sentences saying
            what the cell they sit in already says. */}
        <button
          type="button"
          onClick={() => onSort(column)}
          // 44 px on touch (DESIGN.md › Buttons), and DESIGN.md's 2 px ring.
          className="inline-flex items-center gap-1 rounded underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
        >
          {t(label)}
          {inForce ? <Arrow className="size-3" aria-hidden /> : null}
        </button>
        {explain ? <Explain figure={t(label)} body={explain.body} anchor={explain.anchor} /> : null}
      </span>
    </TableHead>
  )
}

interface SharesTableProps {
  /**
   * The blocks the table is made of — **one** when nothing is grouped, and one
   * per account when it is. A group with no header is the ungrouped table, so
   * there is one rendering of nine columns rather than two.
   */
  groups: readonly ShareGroup[]
  currency: string | null
  sort: ShareSort
  onSort: (column: SortColumn) => void
  onSelect: (symbol: string) => void
  /** What the footer sums (`sharesTotals`) — every group, and the closed lines. */
  totals: { valuation: Sum; terms: GainTerms }
  /** How many closed lines the totals include, folded or not. */
  closedCount: number
}

export function SharesTable({
  groups,
  currency,
  sort,
  onSort,
  onSelect,
  totals,
  closedCount,
}: SharesTableProps) {
  const { t } = useI18n()

  return (
    <Table>
      <caption className="sr-only">{t('shares.table.label')}</caption>
      <TableHeader>
        <TableRow>
          <ColumnHead label="shares.column.symbol" column="symbol" sort={sort} onSort={onSort} />
          <ColumnHead
            label="shares.column.price"
            column="price"
            sort={sort}
            onSort={onSort}
            numeric
          />
          <ColumnHead
            label="shares.column.quantity"
            column="quantity"
            sort={sort}
            onSort={onSort}
            numeric
          />
          <ColumnHead
            label="shares.column.avgCost"
            column="avgCost"
            sort={sort}
            onSort={onSort}
            numeric
          />
          <ColumnHead
            label="shares.column.value"
            column="value"
            sort={sort}
            onSort={onSort}
            numeric
          />
          <ColumnHead
            label="shares.column.unrealised"
            column="unrealised"
            sort={sort}
            onSort={onSort}
            numeric
          />
          <ColumnHead
            label="shares.column.realised"
            column="realised"
            sort={sort}
            onSort={onSort}
            numeric
          />
          <ColumnHead
            label="shares.column.dividends"
            column="dividends"
            sort={sort}
            onSort={onSort}
            numeric
          />
          <ColumnHead label="shares.column.account" column="account" sort={sort} onSort={onSort} />
        </TableRow>
      </TableHeader>
      {groups.map((group) => (
        // One `<tbody>` per group, which is what makes the header row belong to
        // its rows rather than float above them: `scope="rowgroup"` has a
        // rowgroup to name.
        <TableBody key={group.account ?? 'all'}>
          {group.account === null ? null : <GroupHead group={group} currency={currency} />}
          {group.rows.map((row) => (
            <ShareLine
              key={`${group.account ?? ''}·${row.symbol}`}
              row={row}
              currency={currency}
              onSelect={onSelect}
            />
          ))}
        </TableBody>
      ))}
      <TotalRow totals={totals} closedCount={closedCount} currency={currency} />
    </Table>
  )
}

/**
 * **The totals are the table's last row, under the columns they sum** (#1281).
 * It sums what is on screen — the live lines shown and every closed one, folded
 * or not — so the fold never moves it. Cours, Détenu, PRU and Compte are never
 * summed; a group's subtotal stays in its head, and this row sums every group.
 */
function TotalRow({
  totals,
  closedCount,
  currency,
}: {
  totals: SharesTableProps['totals']
  closedCount: number
  currency: string | null
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const { valuation, terms } = totals
  const term = (name: Exclude<GainTermName, 'transferFees'>) => (
    <TableCell className={`text-right tabular ${termTone(terms, name)}`}>
      {renderFigure(
        termRendering(terms, name),
        () => f.currency(termAmount(terms, name), currency),
        t,
      )}
    </TableCell>
  )
  return (
    <TableFooter>
      <TableRow>
        <th
          scope="row"
          className="px-1.5 py-3 text-left whitespace-nowrap xl:px-4 [[data-density=compact]_&]:py-1.5"
        >
          {t('shares.total')}
          {closedCount > 0 ? (
            <span className="label">
              {' · '}
              {t('shares.total.closed', { count: closedCount })}
            </span>
          ) : null}
        </th>
        <TableCell />
        <TableCell />
        <TableCell />
        <TableCell className="text-right tabular">
          {renderFigure(
            sumRendering(valuation),
            () => f.currency(valuation.known ? valuation.value : null, currency),
            t,
          )}
        </TableCell>
        {term('unrealised')}
        {term('realised')}
        {term('dividends')}
        <TableCell />
      </TableRow>
    </TableFooter>
  )
}

/**
 * A group's own header — **the subtotal**, above the lines it sums.
 *
 * It is the account's **valuation** and nothing else (#838): the four totals of
 * the whole are read in the table's total row, computed by the same functions,
 * so a group cannot drift from the page it decomposes.
 */
function GroupHead({ group, currency }: { group: ShareGroup; currency: string | null }) {
  const { t } = useI18n()
  const f = useFormatters()
  const valuation = valuationTotal(group.rows)
  return (
    <TableRow className="bg-background hover:bg-background">
      {/* It is the account's **valuation** and nothing else since #838 — the
      drawing puts one figure here, and the strip above the table is where the
      four totals of the whole are read. */}
      <th scope="rowgroup" colSpan={9} className="px-1.5 py-2 text-left label text-primary xl:px-4">
        {group.account}
        {' · '}
        <span className="tabular">
          {renderFigure(
            sumRendering(valuation),
            () => f.currency(valuation.known ? valuation.value : null, currency),
            t,
          )}
        </span>
      </th>
    </TableRow>
  )
}

interface ShareLineProps {
  row: ShareRow
  currency: string | null
  onSelect: (symbol: string) => void
}

function ShareLine({ row, currency, onSelect }: ShareLineProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const renderings = positionRenderings(row)
  const value = marketValue(row)
  const gain = unrealised(row)
  const ratio = unrealisedRatio(row)

  return (
    // **The whole row opens the sheet** (#791). The button on the name stays,
    // and it is not a duplicate: it is the keyboard's way in and the one thing
    // a reader tabbing through the table can reach. The two gestures land on
    // the same call, which sets an address — pressing it twice is pressing it
    // once, so the click bubbling up from the button costs nothing.
    <TableRow className="cursor-pointer" onClick={() => onSelect(row.symbol)}>
      <TableCell>
        <span className="flex items-center gap-2">
          {/* **The one column of nine whose width the reader's data decides**,
              so it is the one that is bounded (#832). Every other cell is a
              figure of known length; a name is whatever the ledger says, and
              `whitespace-nowrap` on the cell turns a long one into width the
              eight columns beside it then have to be found somewhere else. The
              ticker beside it is never truncated — it is what the reader
              recognises the line by, and it is short by construction. */}
          <button
            type="button"
            className="max-w-[10rem] truncate text-md font-medium underline-offset-4 hover:underline"
            onClick={() => onSelect(row.symbol)}
          >
            {row.name ?? row.symbol}
          </button>
          {/* The ticker follows the name on the same line (#1281): outside the
              button, so the button's name is the name alone, and never
              truncated — it is what the reader recognises the line by. */}
          <span className="shrink-0 font-mono text-2xs text-muted-foreground">{row.symbol}</span>
          {isAnomalous(row) ? (
            <span className="inline-flex items-center text-attention">
              <TriangleAlert className="size-4" aria-hidden />
              {/* The count is already written in the price cell, where *no price*
              is what is true (#845); a second copy of it would be the marker
              saying nothing new, where what the reader is missing is that the
              line is theirs to mend. */}
              <span className="sr-only">{t('shares.anomaly.repair')}</span>
            </span>
          ) : null}
        </span>
      </TableCell>

      {/* The native quote, deliberately: it is the price the reader's
          broker shows them, and the converted one is what the value
          column is built from. */}
      <TableCell className="text-right tabular">
        {renderFigure(
          renderings.price,
          () => f.currency(row.price?.value ?? null, row.price?.currency ?? currency),
          t,
        )}
      </TableCell>

      <TableCell className="text-right tabular">{f.quantity(row.quantity)}</TableCell>

      {/* Undefined on a closed position, which is the truth: it has a
          realised gain instead. */}
      <TableCell className="text-right tabular">{f.currency(unitCost(row), currency)}</TableCell>

      {/* **The valuation takes no sign colour** (#907, ADR-0018): it is a market
          value, positive on every line that holds anything, so `signClass` on it
          painted every held row green — permanently, and the reader's eye lost
          the two columns beside it that do carry a sign. A zero handed to the
          one predicate keeps the other two answers intact: the colour of text
          on a figure, the grey of absence on a rendering that is not one. It is
          `gain.ts`'s own idiom for a term that carries no sign. */}
      <TableCell className={`text-right tabular ${toneOf(renderings.valuation, 0)}`}>
        {renderFigure(renderings.valuation, () => f.currency(value, currency), t)}
      </TableCell>

      <TableCell className={`text-right tabular ${toneOf(renderings.unrealised, gain)}`}>
        {renderFigure(renderings.unrealised, () => f.currency(gain, currency), t)}
        {/* The percentage follows the amount, never a tenth column. */}
        {renderings.unrealised.kind === 'figure' && ratio !== null ? (
          <span className="label ml-1.5">{f.percent(ratio)}</span>
        ) : null}
      </TableCell>

      {/* Realised and dividends are figures on **every** row, closed or
          not — a zero is a figure and wears the colour of text, never
          the grey of absence. */}
      <TableCell className={`text-right tabular ${signClass(row.realised)}`}>
        {f.currency(row.realised, currency)}
      </TableCell>
      <TableCell className={`text-right tabular ${signClass(0)}`}>
        {f.currency(row.dividends, currency)}
      </TableCell>

      <TableCell>{renderAccounts(row.accounts)}</TableCell>
    </TableRow>
  )
}

/**
 * The account a line sits in, **as a chip** (#838). The drawing sets an account
 * id in a filled mark rather than as running text: it is an identifier and not
 * a word, it is the same id the ledger's own rows carry, and one folded line
 * may name two of them — where a comma-separated sentence in a cell of nine
 * would be the only prose in the table.
 */
const ACCOUNT_CHIP =
  'inline-block rounded-md bg-accent px-2 py-0.5 font-mono text-2xs text-foreground/85'

export function renderAccounts(accounts: readonly string[]) {
  if (accounts.length === 0) return ABSENT
  if (accounts.length === 1) return <span className={ACCOUNT_CHIP}>{accounts[0]}</span>
  return (
    <ul className="flex flex-wrap gap-1">
      {accounts.map((account) => (
        <li key={account} className={ACCOUNT_CHIP}>
          {account}
        </li>
      ))}
    </ul>
  )
}
