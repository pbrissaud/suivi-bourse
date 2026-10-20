/**
 * The ledger — **eight columns, and a ninth that ticks** (#723, #834, #1264).
 *
 *     Date · Type · De quoi il s'agit · Quantité · Prix unitaire · Frais ·
 *     Montant · Compte
 *
 * The row itself opens the editor, and the editor holds the row's removal: a
 * button repeating on all 285 rows is what the padlock was refused for, and
 * deleting several rows is the selection's job.
 *
 * Two decisions were taken here **against** the interview, both in front of a
 * board mounted on the 285 real events:
 *
 *  - **The identity column is not `Titre`.** The interview had concluded the
 *    free-text label should leave the table, *"empty almost everywhere"*.
 *    Measured, it is the opposite: **278 rows out of 285** carry one, median 36
 *    characters, 101 distinct values — and a `DEPOSIT` or a `WITHDRAWAL` has no
 *    symbol at all (`Apple Pay Top up`, `Incoming transfer from BRISSAUD`), so
 *    there the label **is** the identity. One column does the work for both
 *    families, in place of a `Symbole` empty 105 times out of 285 doubled by a
 *    `Notes` truncated one row in two.
 *  - **`Nom` is not a column.** The security's name is an attribute of the
 *    security, not of each of its 285 events; repeating it is declaration
 *    duplicated, and the ticker already identifies the line.
 *
 * Since #816 there is nothing left for it to have discriminated on — **every**
 * row is editable — so the lock, and the `Provenance` column that carried the
 * same fact more usefully, are both gone.
 *
 * Since #795 the table is also **bounded and revealed**: the header is sticky,
 * the body scrolls inside its own container, and how many rows are in it is the
 * caller's business — this component draws what it is handed and says nothing
 * about what it was not. The type is a coloured badge and the four money
 * columns are set in tabular numerals, both for the same reason: forty rows are
 * read by scanning down a column, not across a row.
 *
 * **The ninth column left with its subject** (#816). It said *"row 14 of
 * 2024.csv"* and linked to the file's revocation, and both halves rested on the
 * same thing: a mounted file was re-read, so its rows had to be named and
 * revoked whole rather than corrected. A file is handed over once now. There is
 * no source to name, no revocation to lead to, and a row that came out of a
 * file is a row — so what the column would carry on all 285 lines is the same
 * nothing the padlock carried.
 *
 * **Zero explanation icons.** The page's two live on the create form, where the
 * sentence can still change a behaviour (#684 D7).
 *
 * **One column gives, the others keep their width** (#1264). The label column
 * absorbs what the rest leave and truncates; the figure columns are as wide as
 * their widest figure. What does not fit goes by the **table's own width** — a
 * container query on the card, not the viewport's, since the sidebar can be
 * open or folded at any width. `LEDGER_COLUMNS` is the budget the classes and
 * the tests both read.
 *
 * **A first column of checkboxes** (#1113), and the table is drawn by TanStack
 * Table for it: the data is every row the reduction retains, and the reveal is
 * a slice of the row model, so the header box ticks the rows not drawn yet too.
 * The selection itself is the caller's state — it outlives a reduction, and a
 * row hidden by a chip comes back ticked when the chip is let go of.
 */
import { useMemo } from 'react'
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
import { accountOf, identityOf, isEditable, rowKey } from '@/features/data/lib/ledger'
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

/**
 * The six types wear one unhued `muted` pill, and the word in it says which (#1283).
 *
 * A type is a kind of event, and a hue would say more than the ledger knows: a
 * tinted *Sell* read as a loss and a mint *Buy* as a gain, when the sign of a
 * row is the amount's and **no figure in this table is coloured** (`f.currency`,
 * never `signClass`). So `lib/sign.ts` keeps its monopoly on colouring a
 * *figure*, which is the invariant `index.css` states. The foreground on the
 * `muted` plane clears 4,5:1 on both grounds, a hovered row included.
 */
const TYPE_BADGE: Record<LedgerEventType, string> = {
  BUY: 'bg-muted',
  SELL: 'bg-muted',
  GRANT: 'bg-muted',
  DIVIDEND: 'bg-muted',
  DEPOSIT: 'bg-muted',
  WITHDRAWAL: 'bg-muted',
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
}

type LedgerColumnId =
  | 'select'
  | 'date'
  | 'type'
  | 'what'
  | 'quantity'
  | 'unitPrice'
  | 'fee'
  | 'amount'
  | 'account'

interface LedgerColumn {
  /** Worst-case width in px, at the `xl` cell padding (16 px each side). */
  min: number
  /** The container width in px the column appears from; absent = always shown. */
  from?: number
  /** The classes that show it from there — written out whole, for Tailwind's scan. */
  show?: string
}

/**
 * **The ledger's column budget** (#1264). A figure is estimated at 7.8 px per digit
 * at 13 px (Geist, tabular numerals); each threshold is the first `rem` step at or above the worst-case
 * sum of the columns shown there. What hides first as the table narrows: fee,
 * then unit price, then quantity, then account. `ledgerColumns.test.ts` checks
 * the arithmetic and that `from` and `show` say the same width.
 */
export const LEDGER_COLUMNS: Record<LedgerColumnId, LedgerColumn> = {
  select: { min: 36 },
  date: { min: 110 },
  type: { min: 104 },
  what: { min: 240 },
  amount: { min: 149 },
  account: { min: 128, from: 768, show: 'hidden @min-[48rem]/ledger:table-cell' },
  quantity: { min: 110, from: 896, show: 'hidden @min-[56rem]/ledger:table-cell' },
  unitPrice: { min: 126, from: 1024, show: 'hidden @min-[64rem]/ledger:table-cell' },
  fee: { min: 110, from: 1120, show: 'hidden @min-[70rem]/ledger:table-cell' },
}

/** The classes a column's heading and cells share, by column id. */
const ALIGN: Partial<Record<LedgerColumnId, string>> = {
  select: 'w-9 pr-0',
  // The only flexible column: with `table-layout: auto` it takes what the others
  // leave, and `max-w-0` is what lets its content truncate instead of widening it.
  what: 'w-full max-w-0',
  quantity: 'text-right',
  unitPrice: 'text-right',
  fee: 'text-right',
  amount: 'text-right',
}

const columnClass = (id: string) =>
  cn(ALIGN[id as LedgerColumnId], LEDGER_COLUMNS[id as LedgerColumnId]?.show)

export function LedgerTable({
  events,
  budget,
  currency,
  rowSelection,
  onRowSelectionChange,
  onEdit,
}: LedgerTableProps) {
  const { t } = useI18n()
  const f = useFormatters()

  const columns = useMemo<ColumnDef<typeof features, LedgerEvent>[]>(() => {
    // The four money columns are Geist with tabular numerals (#1281): read down
    // a column of forty rows, that is what lets a comma line up with a comma.
    const money = (
      id: string,
      heading: MessageKey,
      value: (event: LedgerEvent) => string,
    ): ColumnDef<typeof features, LedgerEvent> => ({
      id,
      header: () => t(heading),
      cell: ({ row }) => <span className="tabular">{value(row.original)}</span>,
    })
    return [
      {
        id: 'select',
        // Ticks **every** row the reduction retains, drawn or not. Its state
        // is read off those rows only: the table's own `getIsSomeRowsSelected`
        // counts the raw selection, ids a filter hides included, and would
        // leave the box indeterminate over a table where nothing is ticked.
        header: ({ table }) => {
          const rows = table.getCoreRowModel().rows.filter((row) => row.getCanSelect())
          const ticked = rows.filter((row) => row.getIsSelected()).length
          return (
            <Checkbox
              aria-label={t('data.select.all', { count: rows.length })}
              checked={
                rows.length > 0 && ticked === rows.length
                  ? true
                  : ticked > 0
                    ? 'indeterminate'
                    : false
              }
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
              symbol: identityOf(row.original).ticker ?? identityOf(row.original).label ?? ABSENT,
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
        cell: ({ row }) => (
          <span className="tabular whitespace-nowrap">{f.day(row.original.date)}</span>
        ),
      },
      {
        id: 'type',
        header: () => t('data.column.type'),
        cell: ({ row }) => (
          <span
            className={cn(
              'inline-block rounded-md px-2 py-0.5 text-2xs font-medium',
              TYPE_BADGE[row.original.event_type],
            )}
          >
            {t(TYPE_LABEL[row.original.event_type])}
          </span>
        ),
      },
      {
        id: 'what',
        header: () => t('data.column.what'),
        // The ticker in first rank, the label in second — and the label alone
        // where there is no security to name.
        cell: ({ row }) => {
          const identity = identityOf(row.original)
          return (
            <>
              <Identity event={row.original} onEdit={onEdit} />
              {identity.ticker !== null && identity.label !== null ? (
                <span
                  title={identity.label}
                  className="block truncate text-2xs text-muted-foreground"
                >
                  {identity.label}
                </span>
              ) : null}
            </>
          )
        },
      },
      money('quantity', 'data.column.quantity', (event) => f.quantity(event.quantity)),
      money('unitPrice', 'data.column.unitPrice', (event) =>
        f.currency(event.unit_price, currency),
      ),
      money('fee', 'data.column.fee', (event) => f.currency(event.fee, currency)),
      money('amount', 'data.column.amount', (event) => f.currency(event.amount, currency)),
      {
        id: 'account',
        header: () => t('data.column.account'),
        // An account id is typed, not written: the mono face is what says so,
        // and it is the one the accounts page already sets an id in
        // (`AccountDetail`, `AccountsBar`).
        cell: ({ row }) => (
          // Capped at 12 characters plus the chip's own padding: account ids have no
          // length bound on the server.
          <span
            title={accountOf(row.original)}
            className="inline-block max-w-[calc(12ch+1rem)] truncate rounded-md bg-accent px-2 py-0.5 align-middle font-mono text-2xs text-foreground/85"
          >
            {accountOf(row.original)}
          </span>
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

  // The header stays put while the body scrolls under it: on a table revealed
  // forty rows at a time, a heading that leaves the viewport takes the meaning
  // of ten columns with it. The ground is opaque because the rows pass beneath.
  // The rule under it is a `box-shadow` and not the row's `border-b`: preflight
  // sets `border-collapse: collapse`, and under collapsed borders the border
  // belongs to the table box rather than to the cell — so a stuck header keeps
  // its ground and lets its own separator scroll away with the rows.
  const head = 'sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_var(--border)]'

  return (
    <Table containerClassName="max-h-[calc(100dvh-22rem)] min-h-64 overflow-y-auto">
      <caption className="sr-only">{t('data.ledger.label')}</caption>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead key={header.id} className={cn(head, columnClass(header.column.id))}>
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
            // **The whole row opens the editor** (#834), which is the shares
            // table's own gesture one page over: the button on the name stays,
            // and it is the keyboard's way in rather than a duplicate. A row
            // with no key is addressable by nothing, so it opens nothing.
            <TableRow
              key={row.id}
              data-state={row.getIsSelected() ? 'selected' : undefined}
              className={cn(isEditable(row.original) && 'cursor-pointer')}
              onClick={isEditable(row.original) ? () => onEdit(row.original) : undefined}
            >
              {row.getAllCells().map((cell) => (
                <TableCell
                  key={cell.id}
                  className={columnClass(cell.column.id)}
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

/**
 * The row's own name — and the **only** editing affordance on the page. It is a
 * button exactly where a row may be edited, which since #816 is every row that
 * has a key. A column for it would fail the same test the padlock failed: one
 * heading repeating on 285 rows what 285 rows already share.
 */
function Identity({ event, onEdit }: { event: LedgerEvent; onEdit: (event: LedgerEvent) => void }) {
  const identity = identityOf(event)
  const name = identity.ticker ?? identity.label

  if (name === null) return <span className="text-muted-foreground">{ABSENT}</span>
  // A ticker is short and takes one line; with none, the label is the identity
  // and may take two — never more, so the row is no taller than a ticker row.
  // The whole text stays in the DOM and in the `title`.
  const shape =
    identity.ticker !== null
      ? 'block max-w-full truncate text-left font-medium'
      : 'line-clamp-2 whitespace-normal break-words text-left font-medium'
  const title = identity.ticker !== null ? undefined : name
  if (!isEditable(event))
    return (
      <span title={title} className={shape}>
        {name}
      </span>
    )
  return (
    <button
      type="button"
      title={title}
      className={cn(shape, 'underline-offset-4 hover:underline')}
      onClick={() => onEdit(event)}
    >
      {name}
    </button>
  )
}
