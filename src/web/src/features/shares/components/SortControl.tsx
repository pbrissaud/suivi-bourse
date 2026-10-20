/**
 * The sort a phone offers in place of the nine column heads (#1338): a native
 * select and a direction button, both through `nextSort`. Both are 44 px on
 * touch.
 */
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useId } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n, type MessageKey } from '@/lib/i18n'
import type { ShareSort, SortColumn } from '@/features/shares/lib/shares'

/** Label of every sortable column; `symbol` reads as *Nom* here. */
const SORT_LABELS: Record<SortColumn, MessageKey> = {
  value: 'shares.column.value',
  unrealised: 'shares.column.unrealised',
  symbol: 'shares.sort.name',
  price: 'shares.column.price',
  quantity: 'shares.column.quantity',
  avgCost: 'shares.column.avgCost',
  realised: 'shares.column.realised',
  dividends: 'shares.column.dividends',
  account: 'shares.column.account',
}

/**
 * The three orderings a portfolio is read by. Any other column the desktop left
 * in force joins them, so the select never states an order it is not in.
 */
const PHONE_SORTS: readonly SortColumn[] = ['value', 'unrealised', 'symbol']

interface SortControlProps {
  sort: ShareSort
  onSort: (column: SortColumn) => void
}

export function SortControl({ sort, onSort }: SortControlProps) {
  const { t } = useI18n()
  const id = useId()
  const columns = PHONE_SORTS.includes(sort.column) ? PHONE_SORTS : [...PHONE_SORTS, sort.column]
  const Arrow = sort.direction === 'asc' ? ArrowUp : ArrowDown
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="label">
        {t('shares.sort.label')}
      </label>
      <select
        id={id}
        value={sort.column}
        onChange={(event) => onSort(event.target.value as SortColumn)}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-md outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11 dark:bg-input/30"
      >
        {columns.map((column) => (
          <option key={column} value={column}>
            {t(SORT_LABELS[column])}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={t(sort.direction === 'asc' ? 'shares.sort.asc' : 'shares.sort.desc')}
        onClick={() => onSort(sort.column)}
        className="pointer-coarse:size-11"
      >
        <Arrow aria-hidden />
      </Button>
    </div>
  )
}
