import { useMemo, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'

import type { Share } from '@/lib/api'
import {
  formatCurrency,
  formatPercent,
  formatQuantity,
  signClass,
} from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/**
 * #652 déc. 9: six of the baseline's `stat` panels (6, 8, 9, 10, 12, 14) become
 * **columns**, and that alone is the structural argument for the page. Grafana
 * locks those stats inside a row repeated per share, so they cannot be sorted,
 * compared or summed by eye. Here the whole portfolio is one sortable table.
 */

interface Props {
  shares: Share[]
  onSelect: (symbol: string) => void
}

export function SharesTable({ shares, onSelect }: Props) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'market_value', desc: true },
  ])

  const columns = useMemo<ColumnDef<Share>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Titre',
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium">{row.original.name ?? row.original.symbol}</span>
            {/* The symbol is the identity (trap 9 / déc. 3); the name above it
                is display only. Showing both makes that visible rather than
                merely true. */}
            <span className="text-xs text-muted-foreground">{row.original.symbol}</span>
          </div>
        ),
      },
      numeric('price', 'Cours', (share) => formatCurrency(share.price, share.currency)),
      numeric('owned_quantity', 'Détenu', (share) =>
        formatQuantity(share.owned_quantity),
      ),
      numeric('cost_price', 'PRU', (share) =>
        formatCurrency(share.cost_price, share.currency),
      ),
      {
        id: 'unit_gain',
        accessorFn: (share) => share.unit_gain ?? undefined,
        header: 'Écart unitaire',
        meta: { numeric: true },
        sortUndefined: 'last',
        cell: ({ row }) => (
          <span className={cn('tabular', signClass(row.original.unit_gain))}>
            {formatCurrency(row.original.unit_gain, row.original.currency)}
          </span>
        ),
      },
      numeric('market_value', 'Valorisation', (share) =>
        formatCurrency(share.market_value, share.currency),
      ),
      {
        id: 'plus_value_latente',
        accessorFn: (share) => share.plus_value_latente ?? undefined,
        header: 'Plus-value latente',
        meta: { numeric: true },
        sortUndefined: 'last',
        cell: ({ row }) => (
          <div className={cn('flex flex-col items-end tabular', signClass(row.original.plus_value_latente))}>
            <span>{formatCurrency(row.original.plus_value_latente, row.original.currency)}</span>
            <span className="text-xs">{formatPercent(row.original.plus_value_pct)}</span>
          </div>
        ),
      },
      {
        id: 'accounts',
        header: 'Comptes',
        cell: ({ row }) => (
          <div className="flex flex-wrap justify-end gap-1">
            {row.original.accounts.map((position) => (
              <Badge key={position.account} variant="outline" className="font-normal">
                {position.account}
              </Badge>
            ))}
          </div>
        ),
      },
    ],
    [],
  )

  const table = useReactTable({
    data: shares,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const numericColumn = (header.column.columnDef.meta as { numeric?: boolean } | undefined)?.numeric
                const sorted = header.column.getIsSorted()
                return (
                  <TableHead
                    key={header.id}
                    className={cn(numericColumn && 'text-right', header.id === 'accounts' && 'text-right')}
                  >
                    {header.column.getCanSort() ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn('-mx-2 h-8', numericColumn && 'ml-auto')}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === 'asc' ? (
                          <ArrowUp className="size-3.5" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown className="size-3.5" />
                        ) : (
                          <ChevronsUpDown className="size-3.5 opacity-40" />
                        )}
                      </Button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className="cursor-pointer"
              onClick={() => onSelect(row.original.symbol)}
            >
              {row.getVisibleCells().map((cell) => {
                const numericColumn = (cell.column.columnDef.meta as { numeric?: boolean } | undefined)?.numeric
                return (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      numericColumn && 'text-right tabular',
                      cell.column.id === 'accounts' && 'text-right',
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** A right-aligned, tabular, sortable numeric column.
 *
 * The accessor maps `null` to `undefined` for one reason: it is the only value
 * TanStack's `sortUndefined` understands, and absence has to sort **last in
 * both directions**. A missing cost price is not "the smallest cost price" —
 * treated as a number it would float to the top of an ascending sort and open
 * the table on its least informative rows. Keeping `null` in the payload and
 * converting only here means the distinction stays visible in the data and is
 * handled once in the sort.
 */
function numeric(
  key: keyof Share,
  header: string,
  render: (share: Share) => string,
): ColumnDef<Share> {
  return {
    id: key,
    accessorFn: (share) => (share[key] as number | null) ?? undefined,
    header,
    meta: { numeric: true },
    sortUndefined: 'last',
    cell: ({ row }) => <span className="tabular">{render(row.original)}</span>,
  }
}
