/**
 * The ledger — **eight columns and one gesture** (#723, #834).
 *
 *     Date · Type · De quoi il s'agit · Quantité · Prix unitaire · Frais ·
 *     Montant · Compte
 *
 * Plus a ninth cell holding the row's **removal**, which is a control and not a
 * column: it says the same thing on all 285 rows, and that is exactly what the
 * padlock was refused for — except that a gesture repeating is a gesture
 * offered where it applies, where a *marker* repeating is noise. The row itself
 * opens the editor.
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
 * columns are set in the mono face, both for the same reason: forty rows are
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
import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { LedgerEvent, LedgerEventType } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { accountOf, identityOf, isEditable, rowKey } from '@/lib/ledger'
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
 * The attribution and the dividend own a colour already — `--grant` and
 * `--dividend` are the two marks the share's chart draws its events with — so
 * they wear the same one here and a reader crossing from one surface to the
 * other reads the same mark twice. The purchase takes the quotation's own mint
 * and the sale the loss's red, which is the pair the redesign drew; the two
 * cash movements name no security at all and take an unhued pill, because the
 * product's colour vocabulary has nothing to say about a transfer.
 *
 * **The hue is the ground and the word is the foreground**, which is the one
 * thing here that was measured rather than chosen. The redesign draws these
 * badges as coloured *text* on a wash of its own hue, and that pairing cannot
 * clear 4,5:1 at 12 px on the light ground whatever the wash is set to — the
 * text and the wash share a hue, so raising the wash lowers the contrast and
 * lowering it converges on the token alone, which is 4,77:1 for `--primary` and
 * 4,85:1 for `--attention`. Measured on the light ground, a hovered row
 * included: 4,06 for the purchase and 4,30 for the dividend. Put the hue under
 * the foreground instead and the same six pills read at **12:1 or better on
 * both grounds**, the wash carrying the whole of the colour — which is also the
 * more honest reading of *the badge is coloured*.
 *
 * The risk the other way round would have run — a green pill read as *this row
 * gained* — was never open here either: **no figure in this table is
 * coloured**. The amounts are the plain foreground (`f.currency`, never
 * `signClass`), so `lib/sign.ts` keeps its monopoly on colouring a *figure*,
 * which is the invariant `index.css` states.
 */
const TYPE_BADGE: Record<LedgerEventType, string> = {
  BUY: 'bg-price/20',
  SELL: 'bg-loss/20',
  GRANT: 'bg-grant/20',
  DIVIDEND: 'bg-dividend/20',
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
  /** Asks for a row to be removed — the confirmation is the caller's. */
  onRemove: (event: LedgerEvent) => void
}

/** The classes a column's heading and cells share, by column id. */
const ALIGN: Partial<Record<string, string>> = {
  select: 'w-9 pr-0',
  quantity: 'text-right',
  unitPrice: 'text-right',
  fee: 'text-right',
  amount: 'text-right',
  remove: 'w-11',
}

export function LedgerTable({
  events,
  budget,
  currency,
  rowSelection,
  onRowSelectionChange,
  onEdit,
  onRemove,
}: LedgerTableProps) {
  const { t } = useI18n()
  const f = useFormatters()

  const columns = useMemo<ColumnDef<typeof features, LedgerEvent>[]>(() => {
    // The four money columns are set in the **mono** face on top of the tabular
    // figures: read down a column of forty rows, the two together are what lets
    // a comma line up with a comma.
    const money = (
      id: string,
      heading: MessageKey,
      value: (event: LedgerEvent) => string,
    ): ColumnDef<typeof features, LedgerEvent> => ({
      id,
      header: () => t(heading),
      cell: ({ row }) => <span className="font-mono tabular">{value(row.original)}</span>,
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
          <span className="tabular whitespace-nowrap">{f.date(row.original.date)}</span>
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
                <span className="block text-2xs text-muted-foreground">{identity.label}</span>
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
        // (`AccountDetail`, `AccountsRail`).
        cell: ({ row }) => (
          <span className="inline-block rounded-md bg-accent px-2 py-0.5 font-mono text-2xs text-foreground/85">
            {accountOf(row.original)}
          </span>
        ),
      },
      {
        id: 'remove',
        // The last heading is the row's own gesture, and it is named for a
        // reader who cannot see the icon under it. It is not the provenance
        // column coming back: what it carries discriminates on every row,
        // which is the exact test the padlock failed.
        header: () => <span className="sr-only">{t('data.row.delete')}</span>,
        // The removal, at the unit. It stops the click from reaching the row:
        // the two gestures live on one line, and a reader who asks to delete
        // must not be handed the editor underneath the box that asks them to
        // confirm.
        cell: ({ row }) =>
          isEditable(row.original) ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('data.row.delete')}
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={(click) => {
                click.stopPropagation()
                onRemove(row.original)
              }}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          ) : null,
      },
    ]
  }, [t, f, currency, onEdit, onRemove])

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
  const head =
    'sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_var(--border)]'

  return (
    <Table containerClassName="max-h-[calc(100dvh-22rem)] min-h-64 overflow-y-auto rounded-md border">
      <caption className="sr-only">{t('data.ledger.label')}</caption>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead key={header.id} className={cn(head, ALIGN[header.column.id])}>
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
                  className={cn(
                    ALIGN[cell.column.id],
                    cell.column.id === 'remove' && 'p-0 pr-2 text-right',
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

/**
 * The row's own name — and the **only** editing affordance on the page. It is a
 * button exactly where a row may be edited, which since #816 is every row that
 * has a key. A column for it would fail the same test the padlock failed: one
 * heading repeating on 285 rows what 285 rows already share.
 */
function Identity({
  event,
  onEdit,
}: {
  event: LedgerEvent
  onEdit: (event: LedgerEvent) => void
}) {
  const identity = identityOf(event)
  const name = identity.ticker ?? identity.label

  if (name === null) return <span className="text-muted-foreground">{ABSENT}</span>
  if (!isEditable(event)) return <span className="font-medium">{name}</span>
  return (
    <button
      type="button"
      className="font-medium underline-offset-4 hover:underline"
      onClick={() => onEdit(event)}
    >
      {name}
    </button>
  )
}
