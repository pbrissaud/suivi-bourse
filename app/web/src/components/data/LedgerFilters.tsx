/**
 * The reduction bar — and it is what pays for *no pagination* (#723, ADR-0020).
 *
 * A ledger is opened to check what has just happened, so the rows come sorted by
 * date descending and they all stay: *« page 4 sur 6 »* means nothing on an axis
 * of dates, and a reader looking for last Tuesday would have to guess which page
 * holds it. What reduces is here instead.
 *
 * **The full-text search is not a convenience.** It is the consequence of the
 * identity column: on nineteen purchases of the same ETF the free-text label is
 * the only discriminant a row owns, and on a cash movement it is the only name
 * at all. It reads the ticker, the label and the account — everything the
 * identity and account columns show — with accents folded.
 *
 * The account filter appears **at N ≥ 2 only**. ADR-0013 seeds a `default` row
 * that is never removed, so a single-account install would get a control with
 * one option: a filter that cannot filter, which is the same defect as a column
 * that cannot discriminate.
 *
 * **A reduction that came from a gesture names itself and can be undone** (#724).
 * The securities filter has no control to type into — it arrives from the
 * assumed-currency notice of the other tab, which names *every* security it
 * concerns — so without a line stating it the ledger would simply be shorter
 * than the reader expects, with the search field empty and nothing on screen
 * saying why or how to get the rest back. It lists them all, in one line, for
 * the same reason: a set stated as its first element reads as its whole.
 */
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EVENT_TYPES, type LedgerEventType } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { LedgerFilters as Filters } from '@/lib/ledger'
import { TYPE_LABEL } from '@/components/data/LedgerTable'

const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

export interface LedgerFiltersProps {
  filters: Filters
  onChange: (filters: Filters) => void
  /** The accounts the ledger actually names — never the declared list. */
  accounts: readonly string[]
  /** How many rows survive the reduction, stated because nothing paginates. */
  shown: number
}

export function LedgerFilters({ filters, onChange, accounts, shown }: LedgerFiltersProps) {
  const { t } = useI18n()

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="grow space-y-1 sm:max-w-xs">
        <label htmlFor="ledger-search" className="text-sm text-muted-foreground">
          {t('data.search.label')}
        </label>
        <Input
          id="ledger-search"
          type="search"
          value={filters.query}
          placeholder={t('data.search.placeholder')}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="ledger-type" className="text-sm text-muted-foreground">
          {t('data.filter.type')}
        </label>
        <select
          id="ledger-type"
          className={SELECT_CLASS}
          value={filters.type ?? ''}
          onChange={(event) =>
            onChange({
              ...filters,
              type: event.target.value === '' ? null : (event.target.value as LedgerEventType),
            })
          }
        >
          <option value="">{t('data.filter.all')}</option>
          {EVENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(TYPE_LABEL[type])}
            </option>
          ))}
        </select>
      </div>

      {accounts.length > 1 ? (
        <div className="space-y-1">
          <label htmlFor="ledger-account" className="text-sm text-muted-foreground">
            {t('data.filter.account')}
          </label>
          <select
            id="ledger-account"
            className={SELECT_CLASS}
            value={filters.account ?? ''}
            onChange={(event) =>
              onChange({ ...filters, account: event.target.value === '' ? null : event.target.value })
            }
          >
            <option value="">{t('data.filter.all')}</option>
            {accounts.map((account) => (
              <option key={account} value={account}>
                {account}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <p className="ml-auto text-sm text-muted-foreground">
        {t('data.filter.count', { count: shown })}
      </p>

      {filters.symbols && filters.symbols.length > 0 ? (
        <div className="flex w-full flex-wrap items-center gap-3 rounded-md border border-dashed border-input px-3 py-2">
          <p className="text-sm text-muted-foreground">
            {t('data.filter.symbols', {
              count: filters.symbols.length,
              symbols: filters.symbols.join(', '),
            })}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => onChange({ ...filters, symbols: null })}
          >
            {t('data.filter.symbols.clear')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
