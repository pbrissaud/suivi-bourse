/**
 * Tab 1 — the ledger, in its journal half (#723, ADR-0020).
 *
 * The page was a **repair** surface and becomes a **revocation** one: #662's
 * whole apparatus — the inline editor, the opaque token over `(file, sheet,
 * row)`, the content fingerprint as an `ETag`, its `409` and the *invalid →
 * invalid allowed* rule — existed because the faulty line lived *in* the truth.
 * With the store as the truth a bad file is not imported at all, so the
 * apparatus loses its subject in one go, and none of it has a row-by-row
 * successor: the unit of the gesture is the **import** (#728), not the line.
 *
 * What this half owes is the journal itself, its reduction, and the create form
 * that is the onboarding. The import block, the export and the accounts
 * declaration are #728 and #729, and they land under this same tab.
 *
 * Reads and failures follow the rule the shares page keeps: `/api/runtime`
 * answers from process memory and never opens the store (#668), so the shell's
 * banner is **silent** on the one failure that empties this tab — and a tab that
 * rendered nothing would make *the store is unreadable* and *you have recorded
 * nothing yet* the same screen, in its worst form, a blank one.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Band } from '@/components/Band'
import { EmptyState } from '@/components/EmptyState'
import { EntryPair } from '@/components/EntryPair'
import { EventForm } from '@/components/data/EventForm'
import { LedgerFilters } from '@/components/data/LedgerFilters'
import { LedgerTable } from '@/components/data/LedgerTable'
import { Button } from '@/components/ui/button'
import { api, type LedgerEvent } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import {
  accountsNamed,
  byDateDescending,
  filterEvents,
  NO_FILTERS,
  type LedgerFilters as Filters,
} from '@/lib/ledger'
import { oneBand, readConditions } from '@/lib/status'

export interface LedgerProps {
  /**
   * A reduction asked for from elsewhere — today, the assumed-currency notice
   * of the other tab, which **names the events it was made about** (#724).
   *
   * A fresh object per gesture rather than a bare string: the reader may have
   * cleared the field in between, and asking twice for the same symbol has to
   * reduce the ledger twice.
   */
  focus?: { search: string }
}

export function Ledger({ focus }: LedgerProps = {}) {
  const { t } = useI18n()
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)

  useEffect(() => {
    if (!focus) return
    // The search alone: the notice names symbols, and the type and account
    // filters are the reader's own — a gesture that reset them would undo a
    // reduction they made on purpose.
    setFilters((current) => ({ ...current, query: focus.search }))
  }, [focus])
  // `undefined` is *the panel is shut*; `null` is *open on a new event*; a row is
  // *open on that row*. Three states, because "shut" and "creating" are two.
  const [editing, setEditing] = useState<LedgerEvent | null | undefined>(undefined)

  const events = useQuery({ queryKey: ['events'], queryFn: api.events })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  // The reporting currency is an **optional** read here: the ledger is a
  // journal, and a money column with no unit renders as a plain number rather
  // than guessing one (`formatCurrency`). It is not on the events resource —
  // that collection is served as a bare array — so it comes off the one resource
  // that already carries it and costs a single row.
  const totals = useQuery({ queryKey: ['portfolioTotals'], queryFn: api.portfolioTotals })

  const all = useMemo(() => byDateDescending(events.data ?? []), [events.data])
  const shown = useMemo(() => filterEvents(all, filters), [all, filters])

  const failure = oneBand(readConditions({ shellError: runtime.error, errors: [events.error] }))
  const currency = totals.data?.base_currency ?? null

  return (
    <div className="space-y-6">
      {failure ? <Band>{t(failure.message)}</Band> : null}

      {/* A read that has not landed is not a fact: nothing is claimed — and
          above all not *you have recorded nothing* — while it is in flight. */}
      {failure || !events.data ? null : all.length === 0 ? (
        <EntryPair
          entries={[
            {
              title: t('data.empty.file.title'),
              body: t('data.empty.file.body'),
            },
            {
              title: t('data.empty.manual.title'),
              body: t('data.empty.manual.body'),
              action: (
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  {t('data.new')}
                </Button>
              ),
            },
          ]}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <LedgerFilters
              filters={filters}
              onChange={setFilters}
              accounts={accountsNamed(all)}
              shown={shown.length}
            />
            <Button type="button" onClick={() => setEditing(null)}>
              {t('data.new')}
            </Button>
          </div>

          {shown.length === 0 ? (
            <EmptyState title={t('data.filter.none.title')} description={t('data.filter.none.body')} />
          ) : (
            <LedgerTable events={shown} currency={currency} onEdit={setEditing} />
          )}
        </>
      )}

      <EventForm
        open={editing !== undefined}
        event={editing ?? null}
        accounts={accounts.data?.accounts ?? []}
        onClose={() => setEditing(undefined)}
      />
    </div>
  )
}
