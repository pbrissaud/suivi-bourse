import { useMemo } from 'react'
import type { ColumnDef } from '@tanstack/react-table'

import type { AccountSummary } from '@/lib/api'
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  signClass,
} from '@/lib/format'
import { DataTable, numericColumn } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'

/**
 * The accounts comparison table — #652 déc. 13.
 *
 * Its first figure is `total_value`, and that is the ticket's smallest and most
 * telling item: the app has been **writing it since v4.1 and displaying it
 * nowhere**. The baseline's per-account row shows cash, XIRR and absolute gain,
 * and leaves out the one number a human asks for first.
 *
 * Every amount is formatted with **that row's own currency**, read from the
 * declaration (trap 14 — the baseline hardcodes `currencyEUR` as a panel unit).
 * That is also what lets this table stand while the consolidated dashboard
 * refuses a mixed-currency portfolio: each row is internally coherent, and
 * nothing here adds two of them together. There is deliberately no total row —
 * the consolidated figures have one source, `portfolio_totals`, and a second
 * path to the same number is how the two would come to disagree.
 */

interface Props {
  accounts: AccountSummary[]
  onSelect: (account: AccountSummary) => void
}

export function AccountsTable({ accounts, onSelect }: Props) {
  const columns = useMemo<ColumnDef<AccountSummary>[]>(
    () => [
      {
        accessorKey: 'label',
        header: 'Compte',
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium">{row.original.label}</span>
            <span className="text-xs text-muted-foreground">{row.original.id}</span>
          </div>
        ),
      },
      {
        id: 'type',
        accessorKey: 'type',
        header: 'Type',
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            <Badge variant="secondary">{row.original.type}</Badge>
            <Badge variant="outline" className="font-normal">
              {row.original.currency}
            </Badge>
          </div>
        ),
      },
      numericColumn<AccountSummary>(
        'total_value',
        'Valeur totale',
        (a) => a.total_value,
        (a) => formatCurrency(a.total_value, a.currency),
      ),
      numericColumn<AccountSummary>(
        'holdings_value',
        'Titres',
        (a) => a.holdings_value,
        (a) => formatCurrency(a.holdings_value, a.currency),
      ),
      numericColumn<AccountSummary>(
        'cash_balance',
        'Liquidités',
        (a) => a.cash_balance,
        (a) => formatCurrency(a.cash_balance, a.currency),
      ),
      numericColumn<AccountSummary>(
        'net_contributed',
        'Versements nets',
        (a) => a.net_contributed,
        (a) => formatCurrency(a.net_contributed, a.currency),
      ),
      numericColumn<AccountSummary>(
        'gain_absolu',
        'Gain',
        (a) => a.gain_absolu,
        (a) => formatCurrency(a.gain_absolu, a.currency),
        (a) => signClass(a.gain_absolu),
      ),
      // Two rates answering two different questions, exactly as the dashboard
      // head shows them: the TRI is what *your* deposits earned, the TWR is what
      // the holdings did regardless of when you funded them. Both null-tolerant
      // — a TRI without an external flow is absent, not zero (trap 3).
      numericColumn<AccountSummary>(
        'xirr',
        'TRI',
        (a) => a.xirr,
        (a) => formatPercent(a.xirr),
        (a) => signClass(a.xirr),
      ),
      numericColumn<AccountSummary>(
        'twr_index',
        'TWR',
        (a) => a.twr_index,
        (a) => formatNumber(a.twr_index, 1),
      ),
    ],
    [],
  )

  return (
    <DataTable
      columns={columns}
      rows={accounts}
      initialSorting={[{ id: 'total_value', desc: true }]}
      rowKey={(account) => account.id}
      onSelect={onSelect}
    />
  )
}
