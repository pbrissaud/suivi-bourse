/**
 * **The three filters** of the ledger's control line (#834, #1278, « Relevé »):
 * Type, Compte and Période, each a `FilterButton` — a text button that shows its
 * value only, `foreground` once it narrows, and opens a listbox. Pressing an
 * option applies it and closes the list; the way back is the first option
 * (« Tous les types », « Tous les comptes », « Depuis le début »).
 *
 * **The period is one axis with one control**: « Depuis le début » or one of the
 * years the ledger names. A period no year spells — an interval that arrived on
 * the address (`?since=&until=`) — is an option of its own, worded as the
 * interval, so the button always names what is in force.
 *
 * The account filter is offered only where there are two accounts to tell apart.
 * The exception is a reduction already in force, because a filter with no way out
 * is worse than a filter that cannot filter.
 */
import { useMemo } from 'react'

import { periodSentence } from '@/features/data/components/LedgerFilters'
import { TYPE_LABEL } from '@/features/data/components/LedgerTable'
import { FilterButton } from '@/components/FilterButton'
import { EVENT_TYPES, type LedgerEvent, type LedgerEventType } from '@/features/data/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { yearBounds, yearsNamed, type LedgerFilters as Filters } from '@/features/data/lib/ledger'

interface LedgerFacetsProps {
  filters: Filters
  onChange: (filters: Filters) => void
  /** The ledger entire — the years it names. */
  events: readonly LedgerEvent[]
  /** The accounts the ledger actually names, never the declared list. */
  accounts: readonly string[]
  /** An account by its libellé; the identifier stands in without one. */
  accountName?: (id: string) => string
}

const ALL = ''
const CUSTOM = 'custom'

export function LedgerFacets({
  filters,
  onChange,
  events,
  accounts,
  accountName,
}: LedgerFacetsProps) {
  const { t } = useI18n()
  const f = useFormatters()

  const named = useMemo(
    () =>
      filters.account !== null && !accounts.includes(filters.account)
        ? [...accounts, filters.account]
        : accounts,
    [accounts, filters.account],
  )

  // The period in force as one of the options: none, a whole year, or "custom".
  const years = useMemo(() => yearsNamed(events), [events])
  const inForce = (() => {
    if (filters.since === null && filters.until === null) return ALL
    const year = years.find((candidate) => {
      const bounds = yearBounds(candidate)
      return filters.since === bounds.since && filters.until === bounds.until
    })
    return year ?? CUSTOM
  })()
  const periods = [
    { value: ALL, label: t('data.filter.period.all') },
    ...years.map((year) => ({ value: year, label: year })),
    ...(inForce === CUSTOM ? [{ value: CUSTOM, label: periodSentence(t, f, filters) }] : []),
  ]

  return (
    <>
      <FilterButton<LedgerEventType | typeof ALL>
        label={t('data.filter.type')}
        value={filters.type ?? ALL}
        options={[
          { value: ALL, label: t('data.filter.type.all') },
          ...EVENT_TYPES.map((type) => ({ value: type, label: t(TYPE_LABEL[type]) })),
        ]}
        onChange={(type) => onChange({ ...filters, type: type === ALL ? null : type })}
      />

      {named.length > 1 || filters.account !== null ? (
        <FilterButton
          label={t('data.filter.account')}
          value={filters.account ?? ALL}
          options={[
            { value: ALL, label: t('data.filter.account.all') },
            ...named.map((account) => ({
              value: account,
              label: accountName ? accountName(account) : account,
            })),
          ]}
          onChange={(account) =>
            onChange({ ...filters, account: account === ALL ? null : account })
          }
        />
      ) : null}

      <FilterButton
        label={t('data.filter.period')}
        value={inForce}
        options={periods}
        onChange={(period) => {
          // Re-choosing the custom interval changes nothing.
          if (period === CUSTOM) return
          onChange({
            ...filters,
            ...(period === ALL ? { since: null, until: null } : yearBounds(period)),
          })
        }}
      />
    </>
  )
}
