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
 * drop zone, the export menu and the sources with their revocation. Since #814
 * the reduction earns a gesture of its own: **deleting everything it retains**,
 * which is what makes losing the revocation by file survivable (ADR-0032). It
 * sits beside the chips rather than in the band, because the chips are its
 * subject — `BulkDelete.tsx` holds the argument. The
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
import { BulkDelete } from '@/components/data/BulkDelete'
import { EventForm } from '@/components/data/EventForm'
import { ImportsBlock } from '@/components/data/ImportsBlock'
import { LedgerFilters } from '@/components/data/LedgerFilters'
import { LedgerTable, TYPE_LABEL } from '@/components/data/LedgerTable'
import { UploadReceipt, UploadZone, useEventUpload } from '@/components/data/UploadZone'
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

export interface LedgerFocus {
  /**
   * The reduction to put in force. **Set, never merged**: what is in force
   * afterwards is exactly what the sender names — a free-text search or a type
   * left behind would subtract from that perimeter in silence, landing the
   * reader on fewer rows than the sentence they have just read announced.
   */
  filters: Filters
  /**
   * Whether the reduction has to **name itself** here.
   *
   * `false` for the notice's set of securities, which draws its own line in the
   * bar below (#724). `true` for one that arrived by the **address** (#797):
   * nothing on screen would otherwise say that a ledger the reader has just
   * landed on is shorter than their ledger.
   */
  named: boolean
}

export interface LedgerProps {
  /**
   * A reduction asked for from elsewhere: the assumed-currency notice of the
   * other tab, which **names the events it was made about** (#724), and since
   * #797 an event result of the ⌘K palette, which arrives by the address.
   *
   * A fresh object per gesture rather than a bare value: the reader may have
   * cleared the reduction in between, and asking twice for the same events has
   * to reduce the ledger twice.
   */
  focus?: LedgerFocus
  /**
   * The reader moved the reduction themselves — so an **address** that
   * delivered one has stopped describing this table, and the page that owns it
   * says so (#797). Fired by every gesture of the bar, the way out included.
   */
  onReduced?: () => void
  /**
   * *Record an event*, armed from elsewhere — the ⌘K palette's own action
   * (#797). A fresh object per gesture, the `focus` prop's rule: a reader who
   * closed the form and asks again has to see it open again.
   */
  compose?: object
  /**
   * The arming has been **made**, and the page that armed it drops it.
   *
   * Without this the gesture outlives itself: Radix unmounts the inactive tab,
   * so a reader who closed the form and came back through *the notices* would
   * find it open again — the effect below firing on the remount, on a gesture
   * made two tabs ago. A gesture is spent once, and this is where it is spent.
   */
  onComposed?: () => void
}

export function Ledger({ focus, onReduced, compose, onComposed }: LedgerProps = {}) {
  const { t } = useI18n()
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  // **The gesture is held here and nowhere lower** (#811): the first import
  // fills an empty ledger, which unmounts the entry pair the zone was in and
  // mounts the band's own — so a receipt held by the zone would be destroyed by
  // the write it announces, for the one reader who has never seen this work.
  const upload = useEventUpload()

  useEffect(() => {
    if (!focus) return
    // Radix unmounts the inactive tab, so nothing survives the switch today and
    // this is not repairing an observed defect; it is what keeps the property
    // from depending on that.
    setFilters(focus.filters)
  }, [focus])

  // **The reduction is named while it is the one that was delivered**, and the
  // identity is the test: the reader's first gesture on the bar hands back a
  // fresh object, and the sentence goes with the reduction it described.
  //
  // The sentence is composed **here**, off the reduction in force, rather than
  // handed over by the page: it is a rendering of the three dimensions, and the
  // language it is read in is this component's own. The two members it names are
  // required — an address carrying one dimension of the three is named by the
  // chip or the field it presses, each of which is on screen with its own way
  // out — so the line appears for the shape the palette sends and for no other.
  const delivered =
    focus?.named === true &&
    filters === focus.filters &&
    filters.type !== null &&
    filters.account !== null
      ? { type: filters.type, account: filters.account, query: filters.query }
      : null

  /** Every reduction the reader makes by hand — the way out being one of them. */
  const reduce = (next: Filters) => {
    setFilters(next)
    onReduced?.()
  }
  // `undefined` is *the panel is shut*; `null` is *open on a new event*; a row is
  // *open on that row*. Three states, because "shut" and "creating" are two.
  const [editing, setEditing] = useState<LedgerEvent | null | undefined>(undefined)

  useEffect(() => {
    if (!compose) return
    setEditing(null)
    onComposed?.()
  }, [compose, onComposed])
  const events = useQuery({ queryKey: ['events'], queryFn: api.events })
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

      {/* **Above the table, and one band** (#794, ADR-0030, ADR-0032): the drop
          zone and the export menu. The sources with their revocation were the
          third and left with the population they described (#816) — undoing an
          import is the deletion on the reduction, below. What this renders on
          nothing at all is nothing, and the drop zone is then the empty state's
          own entry, one line below. */}
      {failure || !events.data ? null : (
        <ImportsBlock
          upload={upload}
          events={all}
          // The chips, at the instant the menu is clicked (#796). They live
          // here because they reduce the table, and the export's third entry is
          // the same reduction asked of the store — which is why what travels
          // is the five parameters and never the rows they retain.
          selection={filters}
          selected={shown.length}
        />
      )}

      {/* The receipt of the gesture above, mounted **outside** both surfaces
          that offer it: the empty state's entry and the band's zone are two
          mounts of one control, and the first import swaps one for the other. */}
      {failure ? null : <UploadReceipt upload={upload} />}

      {/* A read that has not landed is not a fact: nothing is claimed — and
          above all not *you have recorded nothing* — while it is in flight. */}
      {ledgerFailure || !events.data ? null : all.length === 0 ? (
        <EntryPair
          empty
          entries={[
            {
              title: t('data.empty.file.title'),
              body: t('data.empty.file.body'),
              // **The entry carries the gesture itself** since #811: the band
              // above does not render on a ledger with nothing in it, so this
              // is the whole of the file entrance on a fresh install — which is
              // exactly the install ADR-0032 exists for, the one that never
              // mounted anything. `EntryPair`'s *an unavailable entry keeps its
              // place and says why* loses its one case with it: there is no
              // mount left to be missing.
              action: <UploadZone upload={upload} compact />,
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
          {/* **A reduction that came from an address names itself and offers the
              way out** (#797, the clause #724 wrote for the notice's own). What
              it states is what it *retains* — a type, a word and an account —
              and never the row it was asked about: a ledger row has no address
              (ADR-0020), so a sentence naming one would promise a reduction the
              product cannot make. */}
          {delivered === null ? null : (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <p>
                {t('data.reduced', {
                  named: delivered.query.trim() === '' ? 'no' : 'yes',
                  subject: delivered.query,
                  type: t(TYPE_LABEL[delivered.type]),
                  account: delivered.account,
                })}
              </p>
              <button
                type="button"
                onClick={() => reduce(NO_FILTERS)}
                className="text-muted-foreground underline underline-offset-4"
              >
                {t('data.reduced.undo')}
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <LedgerFilters
              filters={filters}
              onChange={reduce}
              accounts={accountsNamed(all)}
              shown={shown.length}
            />
            <div className="flex flex-wrap items-center gap-2">
              {/* **The destructive gesture sits under the reduction it
                  consumes** (#814, ADR-0032), and not in the band above where
                  the export menu is: what it acts on is the chips, and a button
                  one surface away from its subject is how somebody deletes two
                  hundred rows believing they are removing one thing. It renders
                  nothing at all while nothing is reduced. */}
              <BulkDelete selection={filters} selected={shown.length} />
              <Button type="button" onClick={() => setEditing(null)}>
                {t('data.new')}
              </Button>
            </div>
          </div>

          {shown.length === 0 ? (
            <EmptyState title={t('data.filter.none.title')} description={t('data.filter.none.body')} />
          ) : (
            <div className="space-y-3">
              <LedgerTable
                events={page.rows}
                currency={currency}
                onEdit={setEditing}
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
