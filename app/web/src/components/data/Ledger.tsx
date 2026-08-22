/**
 * Tab 1 — the ledger, and where it came from (#723, #794, ADR-0020, ADR-0030).
 *
 * The page was a **repair** surface and becomes a **revocation** one: #662's
 * whole apparatus — the inline editor, the opaque token over `(file, sheet,
 * row)`, the content fingerprint as an `ETag`, its `409` and the *invalid →
 * invalid allowed* rule — existed because the faulty line lived *in* the truth.
 * With the store as the truth a bad file is not imported at all, so the
 * apparatus loses its subject in one go, and none of it has a row-by-row
 * successor: the unit of the gesture is the **import** (#728), not the line.
 *
 * What this tab owes is the journal itself, its reduction, the create form that
 * is the onboarding, and — as **one band above the table** since #794 — the
 * drop zone, the export menu and the sources with their revocation. The
 * declaration of the accounts left at #793 (ADR-0028): a declaration is made
 * where its subject is looked at. The blocks read one ledger between them: the
 * count a refusal is made of, and the count a revocation announces, are that
 * same table grouped two ways.
 *
 * Since #795 the table is **revealed forty rows at a time** (ADR-0031), and the
 * budget lives here rather than in the table because it is a property of the
 * *reduction*: the chips and the search are on this component, so a reduction
 * that moves has to start its reveal over, and the two sentences under the table
 * count what survives them. Nothing about that is a fetch — `GET /api/events`
 * answered once and handed back the ledger entire — which is why the control may
 * speak while the read never could.
 *
 * Reads and failures follow the rule the shares page keeps: `/api/runtime`
 * answers from process memory and never opens the store (#668), so the shell's
 * banner is **silent** on the one failure that empties this tab — and a tab that
 * rendered nothing would make *the store is unreadable* and *you have recorded
 * nothing yet* the same screen, in its worst form, a blank one.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Band } from '@/components/Band'
import { EmptyState } from '@/components/EmptyState'
import { EntryPair } from '@/components/EntryPair'
import { EventForm } from '@/components/data/EventForm'
import { ImportsBlock } from '@/components/data/ImportsBlock'
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
  PAGE,
  reveal,
  type LedgerFilters as Filters,
} from '@/lib/ledger'
import { oneBand, readConditions } from '@/lib/status'

export interface LedgerProps {
  /**
   * A reduction asked for from elsewhere — today, the assumed-currency notice
   * of the other tab, which **names the events it was made about** (#724).
   *
   * Every security it names, never the first of them: the sentence the reader
   * has just read enumerates them all, and a ledger showing one of three states
   * a repair perimeter the notice did not.
   *
   * A fresh object per gesture rather than a bare list: the reader may have
   * cleared the reduction in between, and asking twice for the same securities
   * has to reduce the ledger twice.
   */
  focus?: { symbols: readonly string[] }
}

export function Ledger({ focus }: LedgerProps = {}) {
  const { t } = useI18n()
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)

  useEffect(() => {
    if (!focus) return
    // **The reduction is set, never merged.** What is in force afterwards is
    // exactly what the notice names — a free-text search or a type left behind
    // would subtract from the notice's own perimeter in silence, landing the
    // reader on fewer rows than the sentence above the button announced. Radix
    // unmounts the inactive tab, so nothing survives the switch today and this
    // is not repairing an observed defect; it is what keeps the property from
    // depending on that.
    setFilters({ ...NO_FILTERS, symbols: focus.symbols })
  }, [focus])
  // `undefined` is *the panel is shut*; `null` is *open on a new event*; a row is
  // *open on that row*. Three states, because "shut" and "creating" are two.
  const [editing, setEditing] = useState<LedgerEvent | null | undefined>(undefined)
  // The source a provenance cell asked to see. A fresh object per gesture, the
  // `focus` prop's own rule: following two rows of the same file in a row has to
  // mark it twice, and the reader may have scrolled away in between.
  const [highlighted, setHighlighted] = useState<{ id: number } | undefined>(undefined)

  const events = useQuery({ queryKey: ['events'], queryFn: api.events })
  // The sources. A **needed** read of the block below and of nothing else: with
  // it in flight that block renders nothing at all, which is ADR-0026's rule and
  // not a local decision — *you have imported nothing* is a claim about the
  // reader's own data.
  const imports = useQuery({ queryKey: ['imports'], queryFn: api.imports })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  // The reporting currency is an **optional** read here: the ledger is a
  // journal, and a money column with no unit renders as a plain number rather
  // than guessing one (`formatCurrency`). It is not on the events resource —
  // that collection is served as a bare array — so it comes off the one resource
  // that already carries it and costs a single row.
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: api.portfolioTotals })

  const all = useMemo(() => byDateDescending(events.data ?? []), [events.data])
  const shown = useMemo(() => filterEvents(all, filters), [all, filters])

  // **The rendering budget** (ADR-0031). It is a number of rows and not a page
  // index, and the difference is the whole record: `GET /api/events` answered
  // once, from the published snapshot in process memory, and handed back the
  // ledger entire — so raising this asks nobody anything.
  const [budget, setBudget] = useState(PAGE)
  // A reduction that moved is a different table, and it starts at its own first
  // row: a reader who revealed a hundred and sixty rows and then pressed a type
  // chip would otherwise get every event of that type at once, which is the
  // budget silently not applying at the exact moment the reader asked a
  // question. `filters` is a fresh object per gesture, which is what makes this
  // fire on the gesture and not on the value.
  //
  // Adjusted **during the render** and not in an effect, which is React's own
  // pattern for a state derived from a prop that changed and is the difference
  // between resetting and *flashing*: an effect runs after the commit, so the
  // render that first sees the new reduction would draw it at the old budget —
  // a hundred rows and « 100 sur 100 affichés » painted for one frame, on every
  // keystroke in the search field, before the reset lands.
  const [reduced, setReduced] = useState(filters)
  if (reduced !== filters) {
    setReduced(filters)
    setBudget(PAGE)
  }
  const page = reveal(shown, budget)

  // **The last packet takes the control the reader just pressed with it.** With
  // nothing done about it the focus falls to `<body>` and a reader without a
  // pointer loses their place in a table of two hundred rows; the region that
  // replaced the button takes the focus instead. It is also the one thing on
  // this surface worth announcing — forty rows arriving is a change with no
  // sound — so the region is polite and holds both sentences rather than each
  // of them holding its own.
  const tail = useRef<HTMLDivElement>(null)
  const offeredMore = useRef(false)
  useEffect(() => {
    if (!page.atEnd) {
      offeredMore.current = true
      return
    }
    if (offeredMore.current && document.activeElement === document.body) {
      tail.current?.focus()
    }
    offeredMore.current = false
  }, [page.atEnd])

  // The accounts read joins the causal order rather than failing quietly: it is
  // a second read of the same store, and this tab now renders a table off it —
  // so *the store is unreadable* must not come out as *you have declared
  // nothing*. `oneBand` keeps it to one band on screen or none.
  const failure = oneBand(
    readConditions({ shellError: runtime.error, errors: [events.error, accounts.error] }),
  )
  // **The band names both reads; the masking follows only the ledger's own.**
  // Folded into one condition, a failed `/api/accounts` erased the whole journal
  // half — the 285 events, the filters, the only button that opens the form —
  // while its own read had answered. And that is not a corner: `GET /api/events`
  // answers from process memory and has no `503` (#764), so *the store is
  // unreadable* is exactly the state where the two reads part company. A band
  // over a page that still has everything to show is the white screen #718
  // mounted `Band` to abolish, arrived from the other side.
  const ledgerFailure = oneBand(
    readConditions({ shellError: runtime.error, errors: [events.error] }),
  )
  const currency = totals.data?.base_currency ?? null

  return (
    <div className="space-y-6">
      {failure ? <Band>{t(failure.message)}</Band> : null}

      {/* **Above the table, and one band** (#794, ADR-0030): the drop zone, the
          export menu and the sources with their revocation. It renders beside
          the two others and at every N, the empty ledger included — an install
          that has imported an accounts file and no event has a source to
          forget, and one that has only ever typed has something to export. What
          it renders on nothing at all is nothing, and the drop zone is then the
          empty state's own entry, one line below. */}
      {failure || !events.data ? null : (
        <ImportsBlock
          imports={imports.data ?? null}
          events={all}
          accounts={accounts.data ?? null}
          highlight={highlighted}
        />
      )}

      {/* A read that has not landed is not a fact: nothing is claimed — and
          above all not *you have recorded nothing* — while it is in flight. */}
      {ledgerFailure || !events.data ? null : all.length === 0 ? (
        <EntryPair
          empty
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
          <div className="flex flex-wrap items-center justify-between gap-3">
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
            <div className="space-y-3">
              <LedgerTable
                events={page.rows}
                currency={currency}
                onEdit={setEditing}
                // Offered only once the list it leads to is on screen: a label
                // that marked a block nobody can see would be a click that does
                // nothing, and it is the same rule one notch down as the block
                // rendering nothing while its own read is in flight.
                onShowImport={
                  imports.data
                    ? (id) => {
                        setHighlighted({ id })
                        document.getElementById(`import-${id}`)?.scrollIntoView({ block: 'center' })
                      }
                    : null
                }
              />

              {/* **The reveal speaks, and the read did not** (ADR-0031). Both
                  sentences below describe rows the app already holds — one of
                  them counts what is drawn against what the reduction holds,
                  the other says the last of them is drawn — so neither is a
                  claim made on a silence, and the in-flight rule is not in
                  contention here: this whole branch sits behind `events.data`.

                  And there is **no spinner**, in this state or in any other.
                  There is not even a wait to dress: the next forty rows are in
                  memory, and pressing the button is a `setState` and a render. */}
              <div
                ref={tail}
                tabIndex={-1}
                aria-live="polite"
                className="flex flex-wrap items-center justify-center gap-3 outline-none"
              >
                {page.atEnd ? (
                  <p className="text-xs text-muted-foreground">
                    {t('data.ledger.end', { count: page.total })}
                  </p>
                ) : (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {t('data.ledger.shown', { shown: page.shown, total: page.total })}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setBudget((current) => current + PAGE)}
                    >
                      {t('data.ledger.more')}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <EventForm
        open={editing !== undefined}
        event={editing ?? null}
        accounts={accounts.data}
        accountsFailed={accounts.isError}
        onClose={() => setEditing(undefined)}
      />
    </div>
  )
}
