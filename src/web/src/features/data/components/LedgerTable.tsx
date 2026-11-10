/**
 * The ledger — **a table on the ground** (« Relevé », mockup
 * `GrandLivre-Refonte.dc.html`): a ticking column, then
 *
 *     Date · Type · Événement · Quantité · Prix unitaire · Montant · Compte
 *
 * with a rule under every row, 48 px rows (the name has a sub-line) and the
 * figures right-aligned in `.fig`. The *Date* header says `aria-sort` — the
 * ledger is served newest first — and that alone makes it `foreground`; no glyph.
 *
 * The row opens the editor, and the editor holds the row's removal: a button
 * repeating on all 285 rows is what the padlock was refused for, and deleting
 * several rows is the selection's job. The name underlines on hover and is the
 * keyboard's way in; the row takes no background.
 *
 * **The event column leads with the security's name**, « CW8 · libellé du
 * courtier » under it (DESIGN.md › Return figures); a transfer has no security,
 * so its label is the name and the sub-line is absent. Fees are not a column:
 * they live in the event sheet, and a buy's or a sale's sit in its amount.
 *
 * **One column gives, the others keep their width** (#1264). The event column
 * absorbs what the rest leave and truncates; the figure columns are as wide as
 * their widest figure. What does not fit goes by the **table's own width** — a
 * container query on the wrapper, not the viewport's, since the sidebar can be
 * open or folded at any width. `LEDGER_COLUMNS` is the budget the classes and
 * the tests both read.
 *
 * The table is drawn by TanStack Table for the first column of checkboxes
 * (#1113): the data is every row the reduction retains, and the reveal is a
 * slice of the row model, so the header box ticks the rows not drawn yet too.
 * The selection itself is the caller's state — it outlives a reduction.
 */
import { useMemo, useRef } from 'react'
import {
  flexRender,
  rowSelectionFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type OnChangeFn,
  type RowSelectionState,
} from '@tanstack/react-table'

import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { LedgerEvent, LedgerEventType } from '@/features/data/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import {
  accountOf,
  cashFlow,
  identityOf,
  nameOf,
  isEditable,
  rowKey,
  selectionState,
} from '@/features/data/lib/ledger'
import { cn } from '@/lib/utils'

const features = tableFeatures({ rowSelectionFeature })

/** The six, named by their **effect** and never by their code. */
export const TYPE_LABEL: Record<LedgerEventType, MessageKey> = {
  BUY: 'event.type.BUY',
  SELL: 'event.type.SELL',
  GRANT: 'event.type.GRANT',
  DIVIDEND: 'event.type.DIVIDEND',
  DEPOSIT: 'event.type.DEPOSIT',
  WITHDRAWAL: 'event.type.WITHDRAWAL',
}

interface LedgerTableProps {
  /** Every row the reduction retains — not only the ones drawn. */
  events: readonly LedgerEvent[]
  /** How many of them are drawn: the reveal's budget. */
  budget: number
  currency: string | null
  /** The ticked rows, by id — held by the caller. */
  rowSelection: RowSelectionState
  onRowSelectionChange: OnChangeFn<RowSelectionState>
  /** Opens the panel on a row. Offered for every row that has a key. */
  onEdit: (event: LedgerEvent) => void
  /** The rows a merge has just written (#1119): marked, then let go of. */
  fresh?: ReadonlySet<string>
  /** An account by the name the reader knows it by (its libellé). */
  accountName?: (id: string) => string
}

type LedgerColumnId =
  | 'select'
  | 'date'
  | 'type'
  | 'what'
  | 'quantity'
  | 'unitPrice'
  | 'amount'
  | 'account'

interface LedgerColumn {
  /** Worst-case width in px, at the 12 px cell padding. */
  min: number
  /** The container width in px the column appears from; absent = always shown. */
  from?: number
  /** The classes that show it from there — written out whole, for Tailwind's scan. */
  show?: string
}

/**
 * **The ledger's column budget** (#1264). A figure is estimated at 7.8 px per
 * character at 13 px (Geist Mono); each threshold is the first `rem` step at or
 * above the worst-case sum of the columns shown there. What hides first as the
 * table narrows: unit price, then quantity, then account.
 * `ledgerColumns.test.ts` checks the arithmetic and that `from` and `show` say
 * the same width.
 */
export const LEDGER_COLUMNS: Record<LedgerColumnId, LedgerColumn> = {
  select: { min: 36 },
  date: { min: 120 },
  type: { min: 104 },
  what: { min: 240 },
  amount: { min: 144 },
  account: { min: 128, from: 800, show: 'hidden @min-[50rem]/ledger:table-cell' },
  quantity: { min: 110, from: 896, show: 'hidden @min-[56rem]/ledger:table-cell' },
  unitPrice: { min: 126, from: 1024, show: 'hidden @min-[64rem]/ledger:table-cell' },
}

/** The classes a column's heading and cells share, by column id. */
const ALIGN: Partial<Record<LedgerColumnId, string>> = {
  select: 'w-9 pr-0',
  // The only flexible column: with `table-layout: auto` it takes what the others
  // leave, and `max-w-0` is what lets its content truncate instead of widening it.
  what: 'w-full max-w-0',
}

const NUMERIC: ReadonlySet<string> = new Set(['quantity', 'unitPrice', 'amount'])

const columnClass = (id: string) =>
  cn(ALIGN[id as LedgerColumnId], LEDGER_COLUMNS[id as LedgerColumnId]?.show)

export function LedgerTable({
  events,
  budget,
  currency,
  rowSelection,
  onRowSelectionChange,
  onEdit,
  fresh,
  accountName,
}: LedgerTableProps) {
  const { t } = useI18n()
  const f = useFormatters()
  // Read at render time and kept out of the columns' dependencies: the names
  // arrive after the rows, and rebuilding the columns would remount the header's
  // checkbox under the reader's hand.
  const names = useRef(accountName)
  names.current = accountName

  const columns = useMemo<ColumnDef<typeof features, LedgerEvent>[]>(() => {
    // A figure the event does not have is a dash, quiet: read down a column,
    // the gaps are as much the reading as the figures.
    const figure = (
      id: string,
      heading: MessageKey,
      value: (event: LedgerEvent) => string | null,
    ): ColumnDef<typeof features, LedgerEvent> => ({
      id,
      header: () => t(heading),
      cell: ({ row }) =>
        value(row.original) ?? <span className="text-muted-foreground">{ABSENT}</span>,
    })
    return [
      {
        id: 'select',
        // Ticks **every** row the reduction retains, drawn or not. Its state
        // is read off those rows only (`selectionState`): the table's own
        // `getIsSomeRowsSelected` counts the raw selection, ids a filter hides
        // included, and would leave the box indeterminate over a table where
        // nothing is ticked.
        // The columns are memoised without `rowSelection` (it would remount the
        // box at every tick), so the header reads the data and the selection off
        // `table.options`.
        header: ({ table }) => {
          const rows = table.options.data as readonly LedgerEvent[]
          const ticks = selectionState(rows, table.options.state?.rowSelection ?? {})
          return (
            <Checkbox
              aria-label={t('data.select.all', { count: rows.filter(isEditable).length })}
              checked={ticks === 'all' ? true : ticks === 'some' ? 'indeterminate' : false}
              onCheckedChange={(value) => table.toggleAllRowsSelected(!!value)}
            />
          )
        },
        // The click stops here: ticking a row must not open its editor.
        cell: ({ row }) => (
          <Checkbox
            aria-label={t('data.select.row', {
              date: f.date(row.original.date),
              type: t(TYPE_LABEL[row.original.event_type]),
              symbol: nameOf(row.original) ?? ABSENT,
            })}
            checked={row.getIsSelected()}
            disabled={!row.getCanSelect()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            onClick={(click) => click.stopPropagation()}
          />
        ),
      },
      {
        id: 'date',
        header: () => t('data.column.date'),
        cell: ({ row }) => <span className="fig">{f.date(row.original.date)}</span>,
      },
      {
        id: 'type',
        header: () => t('data.column.type'),
        cell: ({ row }) => <TypeWord type={row.original.event_type} />,
      },
      {
        id: 'what',
        header: () => t('data.column.what'),
        cell: ({ row }) => <Identity event={row.original} onEdit={onEdit} />,
      },
      figure('quantity', 'data.column.quantity', (event) =>
        event.quantity === null ? null : f.quantity(event.quantity),
      ),
      figure('unitPrice', 'data.column.unitPrice', (event) =>
        event.unit_price === null ? null : f.currency(event.unit_price, currency),
      ),
      {
        id: 'amount',
        header: () => t('data.column.amount'),
        // Every row that moves cash has its amount (#1425). A grant moves none, so
        // below the quantity column's threshold its `× quantity` stands in; from
        // there the cell keeps its dash and the quantity is read in its own column
        // (#1355).
        cell: ({ row }) => {
          const event = row.original
          const amount = <EventFigure event={event} currency={currency} />
          return (
            <span className="font-medium">
              {cashFlow(event) !== null ? (
                amount
              ) : (
                <>
                  <span className="@min-[56rem]/ledger:hidden">{amount}</span>
                  <span className="hidden @min-[56rem]/ledger:inline">{ABSENT}</span>
                </>
              )}
            </span>
          )
        },
      },
      {
        id: 'account',
        header: () => t('data.column.account'),
        cell: ({ row }) => (
          <AccountId event={row.original} name={(id) => names.current?.(id) ?? id} />
        ),
      },
    ]
  }, [t, f, currency, onEdit])

  const table = useTable({
    features,
    columns,
    data: events as LedgerEvent[],
    getRowId: (event, index) => rowKey(event, index),
    // A row with no key is addressable by nothing, so it cannot be ticked.
    enableRowSelection: (row) => isEditable(row.original),
    state: { rowSelection },
    onRowSelectionChange,
  })

  return (
    <Table>
      <caption className="sr-only">{t('data.ledger.label')}</caption>
      <TableHeader className="[&_th]:pt-4">
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead
                key={header.id}
                numeric={NUMERIC.has(header.column.id)}
                // The ledger is served newest first: the one sorted column.
                aria-sort={header.column.id === 'date' ? 'descending' : undefined}
                className={columnClass(header.column.id)}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {/* The reveal is a slice of the row model, never of the data: what is
            not drawn yet is still in the table, and still tickable. */}
        {table
          .getRowModel()
          .rows.slice(0, Math.max(budget, 0))
          .map((row) => (
            // **The whole row opens the editor** (#834); the button on the name
            // stays, and it is the keyboard's way in rather than a duplicate. A
            // row with no key is addressable by nothing, so it opens nothing.
            <TableRow
              key={row.id}
              tall
              data-row-id={row.original.id ?? undefined}
              data-state={row.getIsSelected() ? 'selected' : undefined}
              data-fresh={fresh?.has(String(row.original.id)) ? '' : undefined}
              className={cn(
                'group',
                isEditable(row.original) && 'cursor-pointer',
                // The rows a merge just wrote: a plain tint, never a movement.
                'data-fresh:bg-primary/10 motion-reduce:transition-none',
              )}
              onClick={isEditable(row.original) ? () => onEdit(row.original) : undefined}
            >
              {row.getAllCells().map((cell) => (
                <TableCell
                  key={cell.id}
                  numeric={NUMERIC.has(cell.column.id)}
                  className={cn(
                    columnClass(cell.column.id),
                    cell.column.id === 'account' && 'text-muted-foreground',
                  )}
                  // A click that misses the box by a few pixels is still a
                  // tick, never the editor.
                  onClick={
                    cell.column.id === 'select' ? (click) => click.stopPropagation() : undefined
                  }
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
      </TableBody>
    </Table>
  )
}

/** A ledger type: a word in `muted-foreground` — no pill — the table's and the phone list's alike. */
export function TypeWord({ type }: { type: LedgerEventType }) {
  const { t } = useI18n()
  return <span className="text-muted-foreground">{t(TYPE_LABEL[type])}</span>
}

/**
 * The event's amount (`cashFlow`, #1425): the cash that entered or left the
 * account, fees in, its direction **in its sign** and never in a colour — the
 * sign is fixed by the type. A grant moves no cash and shows `× quantity` in
 * muted text: `× 0,1661` beside `10,20 €` is a quantity, a bare `0,1661` is
 * read as money. One component, so the ledger, its phone list and an
 * account's last events say the same figure.
 */
export function EventFigure({ event, currency }: { event: LedgerEvent; currency: string | null }) {
  const f = useFormatters()
  const cash = cashFlow(event)
  if (cash !== null) return <>{f.signedCurrency(cash, currency)}</>
  if (event.quantity === null) return <>{ABSENT}</>
  return <span className="text-muted-foreground">{`× ${f.quantity(event.quantity)}`}</span>
}

/**
 * An account's identifiant, as the ledger and the imports show it: Geist in
 * `muted-foreground`, capped at 12 characters — identifiants have no length bound
 * on the server.
 */
export function AccountId({
  event,
  name,
}: {
  event: LedgerEvent
  /** The libellé the reader gave the account; the identifier stands in without one. */
  name?: (id: string) => string
}) {
  const shown = name ? name(accountOf(event)) : accountOf(event)
  return (
    <span title={shown} className="inline-block max-w-[calc(12ch+1rem)] truncate align-middle">
      {shown}
    </span>
  )
}

/**
 * The event column: the security's name in 500 with « CW8 · libellé » under it,
 * or the label alone on a transfer (`nameOf`). The name is a button exactly where
 * a row may be edited — every row that has a key (#816) — and underlines when the
 * row is hovered.
 */
function Identity({ event, onEdit }: { event: LedgerEvent; onEdit: (event: LedgerEvent) => void }) {
  const identity = identityOf(event)
  const name = nameOf(event)

  if (name === null) return <span className="text-muted-foreground">{ABSENT}</span>
  // The ticker leads the sub-line only when the name took the first line; the
  // label follows it, or stands alone under a ticker that took the first line.
  const sub = [
    identity.name === null ? null : identity.ticker,
    identity.ticker === null ? null : identity.label,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  const shape = 'block min-w-0 max-w-full truncate text-left font-medium'
  const title = identity.ticker !== null && identity.name === null ? undefined : name
  return (
    <>
      {isEditable(event) ? (
        <button
          type="button"
          title={title}
          data-row-open=""
          className={cn(shape, 'underline-offset-4 group-hover:underline')}
          onClick={() => onEdit(event)}
        >
          {name}
        </button>
      ) : (
        <span title={title} className={shape}>
          {name}
        </span>
      )}
      {sub === '' ? null : (
        <span title={sub} className="block truncate text-xs text-muted-foreground">
          {sub}
        </span>
      )}
    </>
  )
}

/** A ticker beside a security's name: Geist Mono, small, muted — every page alike (#1433). */
export function Ticker({ symbol }: { symbol: string }) {
  return <span className="fig shrink-0 text-xs text-muted-foreground">{symbol}</span>
}
