import { useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'

/**
 * A sortable table whose rows open something.
 *
 * Extracted from #659's shares table by #661, which needs the *same grammar* on
 * a different measurement: a comparison table opening a detail sheet. What is
 * shared is only the chrome — the sort affordance, the alignment rule, the
 * clickable row — while each page keeps its own columns, which is where all the
 * meaning lives.
 *
 * The alignment rule is worth keeping in one place: numbers right, tabular
 * figures, and the header button pushed to the same edge as the values under it.
 * Two tables disagreeing about that is the kind of drift nobody files a bug for
 * and everybody notices.
 */

export interface ColumnMeta {
  /** Right-aligned and `tabular`: a column of numbers read down. */
  numeric?: boolean
  /** Right-aligned without the tabular figures — a column of badges. */
  align?: 'right'
}

interface Props<T> {
  columns: ColumnDef<T>[]
  rows: T[]
  initialSorting: SortingState
  rowKey: (row: T) => string
  onSelect?: (row: T) => void
}

export function DataTable<T>({ columns, rows, initialSorting, rowKey, onSelect }: Props<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting)

  const table = useReactTable({
    data: rows,
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
                const meta = header.column.columnDef.meta as ColumnMeta | undefined
                const right = meta?.numeric || meta?.align === 'right'
                const sorted = header.column.getIsSorted()
                return (
                  <TableHead key={header.id} className={cn(right && 'text-right')}>
                    {header.column.getCanSort() ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn('-mx-2 h-8', right && 'ml-auto')}
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
              key={rowKey(row.original)}
              className={cn(onSelect && 'cursor-pointer')}
              onClick={onSelect ? () => onSelect(row.original) : undefined}
            >
              {row.getVisibleCells().map((cell) => {
                const meta = cell.column.columnDef.meta as ColumnMeta | undefined
                return (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      meta?.numeric && 'text-right tabular',
                      meta?.align === 'right' && 'text-right',
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

/**
 * A right-aligned, tabular, sortable numeric column.
 *
 * The accessor maps `null` to `undefined` for one reason: it is the only value
 * TanStack's `sortUndefined` understands, and absence has to sort **last in both
 * directions**. A missing cost price is not "the smallest cost price" — treated
 * as a number it would float to the top of an ascending sort and open the table
 * on its least informative rows. Keeping `null` in the payload and converting
 * only here means the distinction stays visible in the data and is handled once
 * in the sort.
 */
export function numericColumn<T>(
  id: string,
  header: string,
  value: (row: T) => number | null,
  render: (row: T) => string,
  className?: (row: T) => string | undefined,
): ColumnDef<T> {
  return {
    id,
    accessorFn: (row) => value(row) ?? undefined,
    header,
    meta: { numeric: true } satisfies ColumnMeta,
    sortUndefined: 'last',
    cell: ({ row }) => (
      <span className={cn('tabular', className?.(row.original))}>{render(row.original)}</span>
    ),
  }
}
