/**
 * The ledger — the journal, its reduction and its two destructive gestures
 * (#723, #794, #834, « Relevé »).
 *
 * The page is a **revocation** surface more than a repair one: #662's apparatus
 * (the inline editor, the opaque row token, the content fingerprint) existed
 * because the faulty line lived *in* the truth. With the store as the truth a bad
 * file is not imported at all, so what this surface owes is the journal itself,
 * its reduction, the sheet that records an event, and the way in and out of files.
 *
 * **The control line** (mockup `GrandLivre-Refonte.dc.html`) holds, on the left,
 * the search and the three filters (Type, Compte, Période) and, on the right,
 * the page's actions — *Importer*, *Exporter*, then the one filled
 * *Saisir un événement*. The actions of the ticked rows appear on that line only
 * while rows are ticked. The table sits on the ground under it; there is no
 * summary line, no pill and no count: a filter shows its own value.
 *
 * **Infinite scroll.** The table is revealed forty rows at a time, and the budget
 * lives here rather than in the table because it is a property of the
 * *reduction*. Nothing about it is a fetch — `GET /api/events` answered once and
 * handed back the ledger entire — so a sentinel under the table raises the budget
 * as it comes into view, with no button, no wait and no spinner.
 *
 * **A read that did not answer is said where the journal would have been**
 * (#829), so a `503` and *you have recorded nothing yet* are never the same
 * screen. Rows are deleted in bulk by **ticking them** (#1113).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { RowSelectionState } from '@tanstack/react-table'
import { Upload } from 'lucide-react'

import { Unreadable } from '@/components/Unreadable'
import { EmptyState } from '@/components/EmptyState'
import { EntryPair } from '@/components/EntryPair'
import { BulkDelete } from '@/features/data/components/BulkDelete'
import { FormatDocsButton } from '@/features/data/components/FormatDocsButton'
import { ExportMenu } from '@/features/data/components/ExportMenu'
import { EventForm } from '@/features/data/components/EventForm'
import { ProposalReview } from '@/features/data/components/ProposalReview'
import { LedgerFacets } from '@/features/data/components/LedgerFacets'
import { LedgerSearch, SymbolsReduction } from '@/features/data/components/LedgerFilters'
import { LedgerList } from '@/features/data/components/LedgerList'
import { LedgerTable } from '@/features/data/components/LedgerTable'
import { RowDelete } from '@/features/data/components/RowDelete'
import { Button } from '@/components/ui/button'
import { accountsApi } from '@/features/accounts/lib/api'
import { dashboardApi } from '@/features/dashboard/lib/api'
import { dataApi, type LedgerEvent } from '@/features/data/lib/api'
import { useProposalImport } from '@/features/data/lib/proposalImport'
import { handOver } from '@/features/data/lib/handoff'
import { exportable } from '@/features/data/lib/imports'
import { useAccountNames } from '@/hooks/use-account-names'
import { useIsMobile } from '@/hooks/use-mobile'
import { useI18n } from '@/lib/i18n'
import {
  accountsNamed,
  byDateDescending,
  filterEvents,
  NO_FILTERS,
  PAGE,
  titlesNamed,
  type LedgerFilters as Filters,
  type Title,
} from '@/features/data/lib/ledger'
import { oneFailure, readConditions } from '@/lib/status'

export interface LedgerFocus {
  /**
   * The reduction to put in force. **Set, never merged**: what is in force
   * afterwards is exactly what the sender names — a free-text search or a type
   * left behind would subtract from that perimeter in silence, landing the
   * reader on fewer rows than the sentence they have just read announced.
   */
  filters: Filters
}

interface LedgerProps {
  /**
   * A reduction asked for from elsewhere: the assumed-currency notice, which
   * **names the events it was made about** (#724), and since #797 an event
   * result of the ⌘K palette, which arrives by the address.
   *
   * A fresh object per gesture rather than a bare value: the reader may have
   * cleared the reduction in between, and asking twice for the same events has
   * to reduce the ledger twice.
   */
  focus?: LedgerFocus
  /**
   * The reader moved the reduction themselves — so an **address** that
   * delivered one has stopped describing this table, and the page that owns it
   * says so (#797). Fired by every gesture of the control line.
   */
  onReduced?: () => void
  /**
   * *Record an event*, armed from elsewhere — the ⌘K palette's own action
   * (#797). A fresh object per gesture, the `focus` prop's rule: a reader who
   * closed the sheet and asks again has to see it open again.
   */
  compose?: object
  /** The arming has been **made**, and the page that armed it drops it. */
  onComposed?: () => void
  /**
   * An agent proposal to review (#1119): its id, from the address. The window
   * opens on it as it opens on files, and *Importer* merges it.
   */
  proposal?: string
  /** The proposal was merged or put down: the address stops naming it. */
  onProposalClosed?: () => void
}

/** How long the rows a merge wrote stay marked. */
const FRESH_MS = 2000
const NO_ROWS: ReadonlySet<string> = new Set()

export function Ledger({
  focus,
  onReduced,
  compose,
  onComposed,
  proposal,
  onProposalClosed,
}: LedgerProps = {}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const chooser = useRef<HTMLInputElement>(null)
  const isMobile = useIsMobile()
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  // The window over the agent's proposal (#1119), and the rows its merge
  // wrote, marked for a moment so the reader sees where they landed.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NO_ROWS)
  const reviewed = useProposalImport(proposal, {
    onMerged: (ids) => setFresh(new Set(ids)),
    onClose: () => onProposalClosed?.(),
  })
  useEffect(() => {
    if (fresh.size === 0) return
    const timer = window.setTimeout(() => setFresh(NO_ROWS), FRESH_MS)
    return () => window.clearTimeout(timer)
  }, [fresh])

  useEffect(() => {
    if (!focus) return
    setFilters(focus.filters)
  }, [focus])

  /** Every reduction the reader makes by hand. */
  const reduce = (next: Filters) => {
    setFilters(next)
    onReduced?.()
  }
  // `undefined` is *the panel is shut*; `null` is *open on a new event*; a row is
  // *open on that row*. Three states, because "shut" and "creating" are two.
  const [editing, setEditing] = useState<LedgerEvent | null | undefined>(undefined)
  // The row a removal was asked for, or `null`. Held here rather than in the
  // table, because the box that asks is mounted once for all the rows.
  const [removing, setRemoving] = useState<LedgerEvent | null>(null)
  // The row the sheet was opened on, so that closing it hands the focus back to
  // that row and not to the page.
  const opener = useRef<string | null>(null)
  // Stable: the table's columns close over it, and rebuilding them remounts
  // the header's checkbox.
  const openSheet = useCallback((event: LedgerEvent) => {
    opener.current = event.id ?? null
    setEditing(event)
  }, [])
  const restoreFocus = () => {
    const id = opener.current
    if (id === null) return
    const row = [...document.querySelectorAll<HTMLElement>('[data-row-id]')].find(
      (candidate) => candidate.dataset.rowId === id,
    )
    row?.querySelector<HTMLElement>('[data-row-open]')?.focus()
  }
  const accountName = useAccountNames()

  useEffect(() => {
    if (!compose) return
    setEditing(null)
    onComposed?.()
  }, [compose, onComposed])
  const events = useQuery({ queryKey: ['events'], queryFn: dataApi.events })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })
  // The reporting currency is an **optional** read here: the ledger is a
  // journal, and a money column with no unit renders as a plain number rather
  // than guessing one (`formatCurrency`). It is not on the events resource —
  // that collection is served as a bare array — so it comes off the one resource
  // that already carries it and costs a single row.
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: dashboardApi.portfolioTotals })

  const all = useMemo(() => byDateDescending(events.data ?? []), [events.data])
  const files = exportable(all)
  /**
   * The titles the sheet suggests (#1036) — **`null` until the ledger has
   * answered**, and never `?? []`: an empty list and an unread one are two
   * different sentences, and only one of them is about the reader's portfolio.
   */
  const titles: readonly Title[] | null = useMemo(
    () => (events.data === undefined ? null : titlesNamed(events.data)),
    [events.data],
  )
  const shown = useMemo(() => filterEvents(all, filters), [all, filters])

  // **The ticked rows, by id** (#1113). Held here because the button that
  // deletes them sits on the control line, and kept across reductions: a row a
  // filter hides comes back ticked when the filter is let go of. What is deleted
  // is only what the reduction still shows — ids hidden by it stay ticked here
  // and are never sent.
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  // An id the ledger no longer holds — deleted from its sheet, or in another tab
  // — leaves the selection with the re-read: the store may reissue a freed key,
  // and a new row must not arrive ticked. Adjusted during the render, the
  // budget's own pattern below.
  const [held, setHeld] = useState(all)
  if (held !== all) {
    setHeld(all)
    const ids = new Set(all.map((event) => event.id))
    setRowSelection((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))),
    )
  }
  const selected = useMemo(
    () =>
      shown.flatMap((event) =>
        typeof event.id === 'string' && rowSelection[event.id] ? [event.id] : [],
      ),
    [shown, rowSelection],
  )

  // **The selection's actions take the focus they were pressed with** (#1278).
  // *Désélectionner* and *Supprimer* sit in a group that unmounts the moment the
  // selection is spent, so a keyboard reader would be dropped on `<body>`; the
  // status region, which is always there, takes the focus instead. It is done
  // after the commit, because the confirmation box still traps focus while the
  // delete resolves, and only for these two gestures: a filter that hides the
  // ticked rows empties the selection too, and must not move the reader's focus.
  const status = useRef<HTMLDivElement>(null)
  const refocusStatus = useRef(false)
  const clearSelection = () => {
    refocusStatus.current = true
    setRowSelection({})
  }
  useEffect(() => {
    if (selected.length > 0 || !refocusStatus.current) return
    refocusStatus.current = false
    status.current?.focus()
  }, [selected.length])

  // **The rendering budget**. It is a number of rows and not a page index, and
  // the difference is the whole record: `GET /api/events` answered once and
  // handed back the ledger entire — so raising this asks nobody anything.
  const [budget, setBudget] = useState(PAGE)
  // A reduction that moved is a different table, and it starts at its own first
  // row. Adjusted **during the render** and not in an effect, which is the
  // difference between resetting and *flashing*: an effect runs after the
  // commit, so the render that first sees the new reduction would draw it at the
  // old budget for one frame, on every keystroke in the search field.
  const [reduced, setReduced] = useState(filters)
  if (reduced !== filters) {
    setReduced(filters)
    setBudget(PAGE)
  }
  const atEnd = budget >= shown.length
  const more = useCallback(() => setBudget((current) => current + PAGE), [])

  // **The next forty arrive as the tail comes into view.** The page scrolls, the
  // rows are in memory: no button, no wait, a `setState` and a render.
  const tail = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = tail.current
    if (atEnd || !node || typeof IntersectionObserver === 'undefined') return
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more()
      },
      { rootMargin: '0px 0px 300px 0px' },
    )
    watch.observe(node)
    return () => watch.disconnect()
  }, [atEnd, budget, more])

  // **The tab is its ledger, and only its ledger** (#829). `/api/accounts`
  // failing costs the sheet the *choice of account*, and the sheet says so
  // itself. The events failing is the other news, and it empties the journal —
  // so it is said there, in the space the table would have filled.
  const ledgerFailure = oneFailure(readConditions({ queries: [events] }))
  const currency = totals.data?.base_currency ?? null
  const view = {
    events: shown,
    budget,
    currency,
    rowSelection,
    onRowSelectionChange: setRowSelection,
    onEdit: openSheet,
    fresh,
    accountName,
  }

  return (
    <div className="space-y-6">
      {/* The window the agent's proposal is read in. A file is imported on its
          own page (`/ledger/import`). */}
      {ledgerFailure ? null : <ProposalReview upload={reviewed} />}

      {/* A read that has not landed is not a fact: nothing is claimed — and
          above all not *you have recorded nothing* — while it is in flight. */}
      {ledgerFailure !== null ? (
        <Unreadable failure={ledgerFailure} />
      ) : !events.data ? null : all.length === 0 ? (
        <>
          <EntryPair
            empty
            entries={[
              {
                title: t('data.empty.file.title'),
                body: t('data.empty.file.body'),
                // The door, here and on the control line: the import page. The
                // format's page quietly under it.
                action: (
                  <div className="flex flex-wrap items-center gap-2">
                    {/* One gesture: the chosen file goes straight to the preview. */}
                    <input
                      ref={chooser}
                      type="file"
                      accept=".csv,.xlsx"
                      className="sr-only"
                      tabIndex={-1}
                      aria-label={t('import.choose')}
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        event.target.value = ''
                        if (!file) return
                        handOver(file)
                        void navigate({ to: '/ledger/import', search: {} })
                      }}
                    />
                    <Button type="button" onClick={() => chooser.current?.click()}>
                      {t('data.toolbar.import')}
                    </Button>
                    <FormatDocsButton />
                  </div>
                ),
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
          <p className="text-sm">
            <Link to="/" search={{ open: 'first-run' }} className="underline underline-offset-4">
              {t('empty.resumeSetup')}
            </Link>
          </p>
        </>
      ) : (
        <div>
          {/* **The control line**: the search and the filters on the left, the
              page's actions on the right (outline buttons, then the one filled
              one). A plain row in the tab order, and no `role="toolbar"`, which
              would owe the reader arrow-key roving focus. It wraps; no control
              is hidden at any width. */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b pb-4">
            <LedgerSearch filters={filters} onChange={reduce} />
            <div
              role="group"
              aria-label={t('data.filters.label')}
              className="flex flex-wrap items-center gap-x-5 gap-y-2"
            >
              <LedgerFacets
                filters={filters}
                onChange={reduce}
                events={all}
                accounts={accountsNamed(all)}
                accountName={accountName}
              />
              <SymbolsReduction filters={filters} onChange={reduce} />
            </div>

            {/* The ticked rows' actions, only while there are some. The region is
                always there: it is what the reader hears when the selection
                moves, and where the focus lands when it is spent. */}
            <div
              ref={status}
              tabIndex={-1}
              role="status"
              aria-live="polite"
              className="flex flex-wrap items-center gap-2 text-sm outline-none"
            >
              {selected.length === 0 ? null : (
                <>
                  <span className="font-medium">
                    {t('data.selection.count', { count: selected.length })}
                  </span>
                  {/* **The destructive gesture sits beside the table it
                      consumes** (#814, #1113), and exists only while there is
                      something to consume. */}
                  <BulkDelete selected={selected} onDeleted={clearSelection} />
                  <Button
                    type="button"
                    variant="outline"
                    className="pointer-coarse:min-h-11"
                    onClick={clearSelection}
                  >
                    {t('data.selection.clear')}
                  </Button>
                </>
              )}
            </div>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button asChild variant="outline" className="pointer-coarse:h-11">
                <Link to="/ledger/import">
                  <Upload aria-hidden />
                  {t('data.toolbar.import')}
                </Link>
              </Button>
              {files.events ? (
                <ExportMenu
                  files={files}
                  // The filters, at the instant the menu is clicked (#796). They
                  // live here because they reduce the table, and the export's
                  // third entry is the same reduction asked of the store —
                  // which is why what travels is the parameters and never the
                  // rows they retain.
                  selection={filters}
                  selected={shown.length}
                  // The ledger entire, for the two entries whose perimeter it is.
                  total={all.length}
                />
              ) : null}
              <Button
                type="button"
                variant="primary"
                className="pointer-coarse:min-h-11"
                onClick={() => setEditing(null)}
              >
                {t('data.new')}
              </Button>
            </div>
          </div>

          {shown.length === 0 ? (
            <EmptyState
              title={t('data.filter.none.title')}
              description={t('data.filter.none.body')}
              action={
                <Button type="button" variant="outline" onClick={() => reduce(NO_FILTERS)}>
                  {t('data.facets.reset')}
                </Button>
              }
            />
          ) : (
            // **The table sits on the page's background** (#1273), with no plane
            // and no frame.
            <div className="@container/ledger relative">
              {/* Below 768 px the table is a list (#1339): same props, same
                  wrapper, so the reveal tail is shared. */}
              {isMobile ? <LedgerList {...view} /> : <LedgerTable {...view} />}

              {/* The reveal's sentinel: nothing is said under the table. */}
              <div ref={tail} aria-hidden className="h-px" />
            </div>
          )}
        </div>
      )}

      <EventForm
        open={editing !== undefined}
        event={editing ?? null}
        accounts={accounts.data}
        accountsFailed={accounts.isError}
        titles={titles}
        currency={currency}
        onClose={() => setEditing(undefined)}
        onRestoreFocus={restoreFocus}
        onDelete={() => setRemoving(editing ?? null)}
      />

      {/* One box for all the rows, handed the one it is about (#834). */}
      <RowDelete
        event={removing}
        onClose={() => setRemoving(null)}
        onDeleted={() => setEditing(undefined)}
      />
    </div>
  )
}
