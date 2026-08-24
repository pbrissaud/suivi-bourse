/**
 * The live table — **ten columns** (#684 D3, #791, ADR-0016, ADR-0017).
 *
 *     Titre · Cours · Détenu · PRU · Valorisation · Poids · Latente ·
 *     Réalisée · Dividendes · Compte
 *
 * with the percentage on a **second line under the latent gain** rather than in
 * a column of its own. Three columns are absent on purpose and each for its own
 * reason:
 *
 *  - **`Écart unitaire` is dead.** It is `Cours − PRU`, two columns already on
 *    the same line, and a position carried at its cost makes it **nil by
 *    construction** — a column whose remarkable value is a zero that means
 *    nothing.
 *  - **`Investi` does not come in**: it is `Valorisation − latente`, and it
 *    stays on the sheet.
 *  - **There is no fourth `Gain total` column.** The header *is* their sum, and
 *    a total never shares a row with its terms (ADR-0016): five numeric columns
 *    of equal weight say nothing about the last four being *inside* the first.
 *
 * **`Poids` sits beside the figure it divides** (#791). The percentage is exact
 * and comparing two of them is arithmetic; the bar is the glance — and it is
 * drawn by `ShareBar`, the one component that draws a share (#800), never by
 * markup written here. `src/shareBar.test.ts` is what holds that.
 *
 * **The bar's fill encodes nothing, and that is the decision this table had to
 * take.** ADR-0023's ramp encodes *rank*, redundantly with an angle, and it is
 * licensed only by a list that is **sorted and legended** — which this table
 * stops being the moment the reader orders it by `PRU` or groups it by account.
 * A ramp mounted here would spell a rank the rows are no longer in. So one
 * fill, the brand's own accent, saying only *this is the weight*.
 *
 * **Every column sorts, and an absence never rises** (`lib/shares.ts`). The
 * order lives on the `<th>` as `aria-sort`, where a reader who cannot see the
 * arrow is told what is in force, and the control inside it is a button —
 * pressing the column already in force turns it round.
 *
 * **Grouping by account is a partition and not a filter**: each group's
 * subtotal is in the **group header**, never in a footer row, because a total
 * and its terms do not share a row (ADR-0016) — here one level down, the terms
 * being the rows underneath.
 *
 * **The market-state pill is not a column.** Eleven rows rendered ten identical
 * *Marché ouvert* and one *Cours figé*: a per-row marker that does not
 * discriminate is noise however correct it is. What is left is an icon glued to
 * the `Titre` cell of a share **the app** cannot price — never one the market
 * simply has closed — which is the single exception ADR-0016 allows to *icons
 * never go on a cell*, its text being a repair rather than a convention.
 *
 * **And there is no date column.** One mention at the level of the page says
 * *Cours au …*; the rows that depart from it already say so by the absence rule,
 * the em dash in `Cours` being the signal itself.
 */
import { ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react'

import { Explain } from '@/components/Explain'
import { ShareBar } from '@/components/ShareBar'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { positionRenderings, renderFigure, type Rendering } from '@/lib/absence'
import type { DocsAnchor } from '@/lib/docs'
import { ABSENT, useFormatters } from '@/lib/format'
import { gainTotal, securityTerms, sumRendering } from '@/lib/gain'
import { useI18n, type MessageKey } from '@/lib/i18n'
import {
  isAnomalous,
  marketValue,
  unitCost,
  unrealised,
  unrealisedRatio,
  valuationTotal,
  weightRendering,
  weightShare,
  type ShareGroup,
  type ShareRow,
  type ShareSort,
  type SortColumn,
} from '@/lib/shares'
import { signClass } from '@/lib/sign'
import { cn } from '@/lib/utils'

/** The colour of a cell whose content is not a number at all. */
function toneOf(rendering: Rendering, value: number | null): string {
  return rendering.kind === 'figure' ? signClass(value) : signClass(null)
}

/**
 * The weight bar's fill, and it is **one colour for every row**.
 *
 * The two ramps of the product are earned by what their surface guarantees —
 * ADR-0023's rank ramp by a sorted, legended list, the rail's wheel by a stable
 * identity — and this table guarantees neither: its order is the reader's, by
 * any of ten columns, and its rows are partitioned by account on request. A
 * third ramp invented here would say a rank that is not on screen. What is
 * left is the brand's own accent, which carries no rank and no identity — the
 * two ramps live in `--alloc-*` and neither of them is this.
 */
const WEIGHT_FILL = 'var(--primary)'

/**
 * The four column headers that rest on a convention — and only four. `Cours`
 * and `Valorisation` carry none here because the carrying rule is stated once,
 * on the page header's `Valorisation`, and `Détenu`, `Titre` and `Compte` are
 * facts rather than figures: the test is *would this be verifiable without
 * knowing a rule?*
 *
 * `Poids` is a fifth candidate and fails that test the other way round: it is
 * this row's `Valorisation` over the header's, both of them written on the
 * screen the reader is looking at, so there is no rule to state — only a
 * division they could do themselves.
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
      <span className={`inline-flex items-center gap-1.5 ${numeric ? 'justify-end' : ''}`}>
        {/* The control is the label itself: a table whose every column sorts has
            ten of these, and ten *Trier par …* would be ten sentences saying
            what the cell they sit in already says. */}
        <button
          type="button"
          onClick={() => onSort(column)}
          className="inline-flex items-center gap-1 rounded underline-offset-4 hover:underline"
        >
          {t(label)}
          {inForce ? <Arrow className="size-3" aria-hidden /> : null}
        </button>
        {explain ? (
          <Explain figure={t(label)} body={explain.body} anchor={explain.anchor} />
        ) : null}
      </span>
    </TableHead>
  )
}

export interface SharesTableProps {
  /**
   * The blocks the table is made of — **one** when nothing is grouped, and one
   * per account when it is. A group with no header is the ungrouped table, so
   * there is one rendering of ten columns rather than two.
   */
  groups: readonly ShareGroup[]
  /**
   * What the `Poids` column divides, for the **whole** table: a weight is a
   * share of what the header above states, so grouping partitions the rows and
   * never the whole — the bars of two groups stay comparable.
   */
  whole: number
  currency: string | null
  sort: ShareSort
  onSort: (column: SortColumn) => void
  onSelect: (symbol: string) => void
}

export function SharesTable({
  groups,
  whole,
  currency,
  sort,
  onSort,
  onSelect,
}: SharesTableProps) {
  const { t } = useI18n()

  return (
    <Table>
      <caption className="sr-only">{t('shares.table.label')}</caption>
      <TableHeader>
        <TableRow>
          <ColumnHead label="shares.column.symbol" column="symbol" sort={sort} onSort={onSort} />
          <ColumnHead label="shares.column.price" column="price" sort={sort} onSort={onSort} numeric />
          <ColumnHead
            label="shares.column.quantity"
            column="quantity"
            sort={sort}
            onSort={onSort}
            numeric
          />
          <ColumnHead label="shares.column.avgCost" column="avgCost" sort={sort} onSort={onSort} numeric />
          <ColumnHead label="shares.column.value" column="value" sort={sort} onSort={onSort} numeric />
          {/* Narrow on purpose: the bar under the figure is `w-full` of its
              cell, so the column has to be the reader's ruler and not the
              longest string that ever lands in it. */}
          <ColumnHead
            label="shares.column.weight"
            column="weight"
            sort={sort}
            onSort={onSort}
            numeric
            className="w-20"
          />
          <ColumnHead
            label="shares.column.unrealised"
            column="unrealised"
            sort={sort}
            onSort={onSort}
            numeric
          />
          <ColumnHead label="shares.column.realised" column="realised" sort={sort} onSort={onSort} numeric />
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
              whole={whole}
              currency={currency}
              onSelect={onSelect}
            />
          ))}
        </TableBody>
      ))}
    </Table>
  )
}

/**
 * A group's own header — **the subtotal, and never a footer row** (ADR-0016).
 *
 * A total and its terms are not read at equal weight; in a table subordination
 * is vertical, so the account's figures go *above* the lines they sum exactly
 * as the page's own header sits above the table. A pied de groupe would put the
 * same two figures at the same rank as the columns they are the sum of.
 *
 * The two figures are the page header's two, one level down: what this account
 * is worth, and what it has gained — computed by the same functions, so a group
 * cannot drift from the page it decomposes.
 */
function GroupHead({ group, currency }: { group: ShareGroup; currency: string | null }) {
  const { t } = useI18n()
  const f = useFormatters()
  const total = gainTotal(securityTerms(group.positions))
  const valuation = valuationTotal(group.rows)

  return (
    <TableRow className="bg-muted/40 hover:bg-muted/40">
      <th scope="rowgroup" colSpan={10} className="px-3 py-2 text-left [[data-density=compact]_&]:px-2 [[data-density=compact]_&]:py-1.5">
        <span className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <span className="text-sm font-medium">{group.account}</span>
          <span className="text-xs text-muted-foreground">
            {t('shares.column.value')}{' '}
            <span className="tabular">
              {renderFigure(
                sumRendering(valuation),
                () => f.currency(valuation.known ? valuation.value : null, currency),
                t,
              )}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">
            {t('shares.gainTotal')}{' '}
            <span className={`tabular ${signClass(total.known ? total.value : null)}`}>
              {renderFigure(
                sumRendering(total),
                () => f.currency(total.known ? total.value : null, currency),
                t,
              )}
            </span>
          </span>
        </span>
      </th>
    </TableRow>
  )
}

interface ShareLineProps {
  row: ShareRow
  whole: number
  currency: string | null
  onSelect: (symbol: string) => void
}

function ShareLine({ row, whole, currency, onSelect }: ShareLineProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const renderings = positionRenderings(row)
  const value = marketValue(row)
  const gain = unrealised(row)
  const ratio = unrealisedRatio(row)
  const weight = weightShare(row, whole)

  return (
    // **The whole row opens the sheet** (#791). The button on the name stays,
    // and it is not a duplicate: it is the keyboard's way in and the one thing
    // a reader tabbing through the table can reach. The two gestures land on
    // the same call, which sets an address — pressing it twice is pressing it
    // once, so the click bubbling up from the button costs nothing.
    <TableRow className="cursor-pointer" onClick={() => onSelect(row.symbol)}>
      <TableCell>
        <span className="flex items-center gap-2">
          <button
            type="button"
            className="font-medium underline-offset-4 hover:underline"
            onClick={() => onSelect(row.symbol)}
          >
            {row.name ?? row.symbol}
          </button>
          {isAnomalous(row) ? (
            <span className="inline-flex items-center text-attention">
              <TriangleAlert className="size-4" aria-hidden />
              {/* **The repair, and not the count again** (ADR-0016: the one
                  icon allowed on a cell is one whose text *is* a repair). The
                  count is already written in the three cells this row's
                  absence governs; a fourth copy of it would be the marker
                  saying nothing new, where what the reader is missing is that
                  the line is theirs to mend. */}
              <span className="sr-only">{t('shares.anomaly.repair')}</span>
            </span>
          ) : null}
        </span>
        <span className="block text-xs text-muted-foreground">{row.symbol}</span>
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
          realised gain instead (ADR-0003). */}
      <TableCell className="text-right tabular">{f.currency(unitCost(row), currency)}</TableCell>

      <TableCell className={`text-right tabular ${toneOf(renderings.valuation, value)}`}>
        {renderFigure(renderings.valuation, () => f.currency(value, currency), t)}
      </TableCell>

      {/* The share of the table's own whole, written and drawn. The bar is
          `aria-hidden` and it is the percentage above it that is announced —
          two announcers for one figure is the defect this page refuses
          everywhere else. A **null** share draws nothing at all, which is not
          the same claim as a zero share's empty track.

          **A stated width, and the one cell of the row that wraps.** The bar
          is `w-full` of this cell, so a column sized by its longest string
          would rescale every bar in it the day one line names its absence —
          *en attente du taux* is longer than any percentage and, left
          `nowrap`, it would take that width off the nine columns beside it at
          976 px. The `?? 0` is unreachable: the figure branch is taken only
          where `weightRendering` found a share. */}
      <TableCell className="w-20 text-right tabular whitespace-normal">
        {renderFigure(weightRendering(row, whole), () => f.percentPoints((weight ?? 0) * 100), t)}
        <ShareBar share={weight} fill={WEIGHT_FILL} className="mt-1" />
      </TableCell>

      <TableCell className={`text-right tabular ${toneOf(renderings.unrealised, gain)}`}>
        {renderFigure(renderings.unrealised, () => f.currency(gain, currency), t)}
        {/* The percentage is a second line, never an eleventh column. */}
        {renderings.unrealised.kind === 'figure' && ratio !== null ? (
          <span className="block text-xs text-muted-foreground">{f.percent(ratio)}</span>
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
 * One account is **plain text, never a list of one** (#684 D11). The model stays
 * multi-account — the same ETF on a PEA and on a CTO is the most ordinary case
 * of the domain, and that none of the nineteen real symbols shows it is
 * contingent — so it is the rendering that bends, not the shape.
 */
export function renderAccounts(accounts: readonly string[]) {
  if (accounts.length === 0) return ABSENT
  if (accounts.length === 1) return <span>{accounts[0]}</span>
  return (
    <ul className="flex flex-wrap gap-1">
      {accounts.map((account) => (
        <li key={account} className="rounded border px-1.5 py-0.5 text-xs">
          {account}
        </li>
      ))}
    </ul>
  )
}
