import { useMemo } from 'react'
import type { ColumnDef } from '@tanstack/react-table'

import type { Share } from '@/lib/api'
import {
  formatCurrency,
  formatPercent,
  formatQuantity,
  signClass,
} from '@/lib/format'
import { cn } from '@/lib/utils'
import { DataTable, numericColumn, type ColumnMeta } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'

/**
 * #652 déc. 9: six of the baseline's `stat` panels (6, 8, 9, 10, 12, 14) become
 * **columns**, and that alone is the structural argument for the page. Grafana
 * locks those stats inside a row repeated per share, so they cannot be sorted,
 * compared or summed by eye. Here the whole portfolio is one sortable table.
 *
 * The chrome (sorting, alignment, the clickable row) moved to `DataTable` when
 * #661 gave the accounts page the same grammar; what stays here is the columns,
 * which is the part that carries meaning.
 */

interface Props {
  shares: Share[]
  onSelect: (symbol: string) => void
}

export function SharesTable({ shares, onSelect }: Props) {
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
      numericColumn<Share>('price', 'Cours', (s) => s.price, (s) =>
        formatCurrency(s.price, s.currency),
      ),
      numericColumn<Share>('owned_quantity', 'Détenu', (s) => s.owned_quantity, (s) =>
        formatQuantity(s.owned_quantity),
      ),
      numericColumn<Share>('cost_price', 'PRU', (s) => s.cost_price, (s) =>
        formatCurrency(s.cost_price, s.currency),
      ),
      numericColumn<Share>(
        'unit_gain',
        'Écart unitaire',
        (s) => s.unit_gain,
        (s) => formatCurrency(s.unit_gain, s.currency),
        (s) => signClass(s.unit_gain),
      ),
      numericColumn<Share>('market_value', 'Valorisation', (s) => s.market_value, (s) =>
        formatCurrency(s.market_value, s.currency),
      ),
      {
        id: 'plus_value_latente',
        accessorFn: (share) => share.plus_value_latente ?? undefined,
        header: 'Plus-value latente',
        meta: { numeric: true } satisfies ColumnMeta,
        sortUndefined: 'last',
        cell: ({ row }) => (
          <div
            className={cn(
              'flex flex-col items-end tabular',
              signClass(row.original.plus_value_latente),
            )}
          >
            <span>{formatCurrency(row.original.plus_value_latente, row.original.currency)}</span>
            <span className="text-xs">{formatPercent(row.original.plus_value_pct)}</span>
          </div>
        ),
      },
      {
        id: 'accounts',
        header: 'Comptes',
        meta: { align: 'right' } satisfies ColumnMeta,
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

  return (
    <DataTable
      columns={columns}
      rows={shares}
      initialSorting={[{ id: 'market_value', desc: true }]}
      rowKey={(share) => share.symbol}
      onSelect={(share) => onSelect(share.symbol)}
    />
  )
}
