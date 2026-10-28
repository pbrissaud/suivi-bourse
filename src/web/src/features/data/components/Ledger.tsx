/**
 * The ledger — the journal, its reduction and its two destructive gestures
 * (#723, #794, #834).
 *
 * The page was a **repair** surface and became a **revocation** one: #662's
 * whole apparatus — the inline editor, the opaque token over `(file, sheet,
 * row)`, the content fingerprint as an `ETag`, its `409` and the *invalid →
 * invalid allowed* rule — existed because the faulty line lived *in* the truth.
 * With the store as the truth a bad file is not imported at all, so the
 * apparatus lost its subject in one go, and none of it has a row-by-row
 * successor: the unit of the *import* gesture is the file (#728), never the
 * line.
 *
 * What this surface owes is the journal itself, its reduction, the create form
 * that is the onboarding, and the way in and out of files. The declaration of
 * the accounts left at #793: a declaration is made where its subject is looked
 * at.
 *
 * **A table page has no side panel** (#1278): above the table a toolbar holds
 * the search, the three filter menus and the page's gestures (*Importer*,
 * *Exporter*, *Saisir un événement*), and under it **one summary line, always
 * there** — the count, the pastilles, the way out, and the actions of the
 * ticked rows only while there are some. Importing a file is a button of the
 * toolbar or a drop on the table; the dashed band is the empty ledger's own
 * entry and nothing else.
 *
 * Rows are deleted in bulk by **ticking them** (#1113), not by the reduction.
 *
 * **The reduction is laid out in three places since #834**, and they are three
 * questions: the **menus** of the toolbar, where an axis is chosen and every
 * option carries the count it would leave (`LedgerFacets.tsx`); the **search**
 * beside them, the one dimension with no vocabulary to lay out; and the
 * **pastilles** on the summary line, where the reduction is read back and let
 * go of. What lives here is the state they all write to, so a reduction that
 * moves starts its reveal over wherever it was moved from.
 *
 * Since #795 the table is **revealed forty rows at a time**, and the budget
 * lives here rather than in the table because it is a property of the
 * *reduction*: the two sentences under the table count what survives it, and
 * say — since #834 — that it *is* a reduction they are counting. Nothing about
 * that is a fetch — `GET /api/events` answered once and handed back the ledger
 * entire — which is why the control may speak while the read never could.
 *
 * **A read that did not answer is said where the journal would have been**
 * (#829). The banner and the band are retired and not replaced, so a surface
 * that stayed silent over a `503` would make *the store is unreadable* and *you
 * have recorded nothing yet* the same screen, in its worst form, a blank one.
 * `/api/runtime` left the reads here with the band that consulted it — it
 * answers from process memory and never opens the store (#668), so it was in
 * the list to be short-circuited on and nothing else.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RowSelectionState } from '@tanstack/react-table'

import { Unreadable } from '@/components/Unreadable'
import { EmptyState } from '@/components/EmptyState'
import { EntryPair } from '@/components/EntryPair'
import { BulkDelete } from '@/features/data/components/BulkDelete'
import { ExportMenu } from '@/features/data/components/ExportMenu'
import { EventForm } from '@/features/data/components/EventForm'
import { ImportPreview } from '@/features/data/components/ImportPreview'
import { LedgerFacets } from '@/features/data/components/LedgerFacets'
import { LedgerChips, LedgerSearch } from '@/features/data/components/LedgerFilters'
import { LedgerList } from '@/features/data/components/LedgerList'
import { LedgerTable, TYPE_LABEL } from '@/features/data/components/LedgerTable'
import { RowDelete } from '@/features/data/components/RowDelete'
import {
  UploadReceipt,
  UploadZone,
  useEventUpload,
  useFileDrop,
} from '@/features/data/components/UploadZone'
import { Button } from '@/components/ui/button'
import { accountsApi } from '@/features/accounts/lib/api'
import { dashboardApi } from '@/features/dashboard/lib/api'
import { dataApi, type LedgerEvent } from '@/features/data/lib/api'
import { useProposalImport } from '@/features/data/lib/proposalImport'
import { EVENT_FILE_COLUMNS, exportable, templateHref } from '@/features/data/lib/imports'
import { useIsMobile } from '@/hooks/use-mobile'
import { docsPageHref } from '@/lib/docs'
import { useI18n } from '@/lib/i18n'
import {
  accountsNamed,
  byDateDescending,
  filterEvents,
  NO_FILTERS,
  PAGE,
  reduces,
  reveal,
  titlesNamed,
  type LedgerFilters as Filters,
  type Title,
} from '@/features/data/lib/ledger'
import { cn } from '@/lib/utils'
import { oneFailure, readConditions } from '@/lib/status'

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

interface LedgerProps {
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
  const { t, language } = useI18n()
  const isMobile = useIsMobile()
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  // **The gesture is held here and nowhere lower** (#811): the first import
  // fills an empty ledger, which unmounts the entry pair the zone was in and
  // mounts the bar's own — so a receipt held by the zone would be destroyed by
  // the write it announces, for the one reader who has never seen this work.
  const upload = useEventUpload()
  // The drop half of it, taken by the table's card once the ledger has rows.
  const drop = useFileDrop(upload.hand)
  // The same window over the agent's proposal (#1119), and the rows its merge
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
  // The row a removal was asked for, or `null`. Held here rather than in the
  // table, because the box that asks is mounted once for all the rows.
  const [removing, setRemoving] = useState<LedgerEvent | null>(null)

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
   * The titles the create form suggests (#1036) — **`null` until the ledger has
   * answered**, and never `?? []`: an empty list and an unread one are two
   * different sentences, and only one of them is about the reader's portfolio.
   * It is folded here rather than read again, the events carrying the symbol
   * and the name that `/api/positions` would have carried.
   */
  const titles: readonly Title[] | null = useMemo(
    () => (events.data === undefined ? null : titlesNamed(events.data)),
    [events.data],
  )
  const shown = useMemo(() => filterEvents(all, filters), [all, filters])

  // **The ticked rows, by id** (#1113). Held here because the button that
  // deletes them sits above the table, and kept across reductions: a row a
  // chip hides comes back ticked when the chip is let go of. What is deleted
  // is only what the reduction still shows — ids hidden by it stay ticked here
  // and are never sent.
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  // An id the ledger no longer holds — deleted from its sheet, or in
  // another tab — leaves the selection with the re-read: the store may reissue
  // a freed key, and a new row must not arrive ticked. Adjusted during the
  // render, the budget's own pattern below.
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
  // summary line, which is always there, takes the focus instead. It is done
  // after the commit, because the confirmation box still traps focus while the
  // delete resolves, and only for these two gestures: a filter that hides the
  // ticked rows empties the selection too, and must not move the reader's focus.
  const summary = useRef<HTMLDivElement>(null)
  const refocusSummary = useRef(false)
  const clearSelection = () => {
    refocusSummary.current = true
    setRowSelection({})
  }
  useEffect(() => {
    if (selected.length > 0 || !refocusSummary.current) return
    refocusSummary.current = false
    summary.current?.focus()
  }, [selected.length])

  // **The rendering budget**. It is a number of rows and not a page
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

  // **The tab is its ledger, and only its ledger** (#829). There is no
  // band left to raise for the second read: `/api/accounts` failing costs this
  // tab the *choice of account* inside the form, and the form says so itself —
  // `accountChoice`'s `failed` branch, one prop below. Naming it again over a
  // journal that has everything to show is the white screen #718 mounted
  // refusal to abolish, arrived from the other side: `GET /api/events` answers
  // from process memory and has no `503` (#764), so the two reads part company
  // in exactly the state that matters.
  //
  // The events failing is the other news, and it empties the journal — so it is
  // said there, in the space the table would have filled, rather than in a
  // strip above a page that has nothing under it.
  const ledgerFailure = oneFailure(readConditions({ queries: [events] }))
  const currency = totals.data?.base_currency ?? null
  const view = {
    events: shown,
    budget,
    currency,
    rowSelection,
    onRowSelectionChange: setRowSelection,
    onEdit: setEditing,
    fresh,
  }

  return (
    <div className="space-y-6">
      {/* The receipt of the import gesture, mounted **outside** both surfaces
          that offer it: the empty state's band and the toolbar's button are two
          mounts of one control, and the first import swaps one for the other. */}
      {ledgerFailure ? null : <UploadReceipt upload={upload} />}

      {/* And the window the forecast is read in (#835), mounted here for the
          same reason: it is open across the swap the first import makes, and
          the three answers it collects are held by the hook above it. */}
      {ledgerFailure ? null : <ImportPreview upload={proposal ? reviewed : upload} />}

      {/* A read that has not landed is not a fact: nothing is claimed — and
          above all not *you have recorded nothing* — while it is in flight. */}
      {ledgerFailure !== null ? (
        <Unreadable failure={ledgerFailure} />
      ) : !events.data ? null : all.length === 0 ? (
        <EntryPair
          empty
          entries={[
            {
              title: t('data.empty.file.title'),
              body: t('data.empty.file.body'),
              // `EntryPair`'s *an unavailable entry keeps its place and says
              // why* loses its one case with it: there is no mount left to be
              // missing.
              // The band, here and only here: it is the empty ledger's state,
              // and a populated one imports from the toolbar.
              //
              // **It says what a file looks like** (#1266): the columns, from the
              // constant the template is built from so the two cannot disagree,
              // the one thing the header does not say about `account`, a
              // header-only template and the docs page. The picker stays last,
              // lined up with *Saisir un événement*.
              action: (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t('data.empty.file.columns')}
                    </p>
                    <p className="font-mono text-xs break-words">{EVENT_FILE_COLUMNS.join(', ')}</p>
                    <p className="text-xs text-muted-foreground">{t('data.empty.file.account')}</p>
                  </div>
                  <UploadZone upload={upload} />
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                    <a
                      download="suivi-bourse-template.csv"
                      href={templateHref()}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {t('data.empty.file.template')}
                    </a>
                    <a
                      href={docsPageHref(language, 'import-your-events', 'format')}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {t('data.empty.file.docs')}
                    </a>
                  </div>
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
      ) : (
        <>
          {/* **A reduction that came from an address names itself and offers the
              way out** (#797, the clause #724 wrote for the notice's own). What
              it states is what it *retains* — a type, a word and an account —
              and never the row it was asked about: a ledger row has no address,
             so a sentence naming one would promise a reduction the
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

          <div className="space-y-3">
            {/* **The toolbar** (#1278): a plain row in the tab order, and no
                `role="toolbar"`, which would owe the reader arrow-key roving
                focus. The search and the three menus lead; the page's gestures
                ride at the right and wrap to a line of their own, still
                right-aligned, when the row is full. No control is hidden at any
                width. */}
            <div className="flex flex-wrap items-center gap-2">
              <LedgerSearch filters={filters} onChange={reduce} />
              <LedgerFacets
                filters={filters}
                onChange={reduce}
                // The ledger entire, never the rows on screen: a facet count is
                // *what would be left*, which is a question about the whole.
                events={all}
                accounts={accountsNamed(all)}
              />
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <UploadZone upload={upload} compact label={t('data.toolbar.import')} />
                {files.events ? (
                  <ExportMenu
                    files={files}
                    // The chips, at the instant the menu is clicked (#796). They
                    // live here because they reduce the table, and the export's
                    // third entry is the same reduction asked of the store —
                    // which is why what travels is the five parameters and never
                    // the rows they retain.
                    selection={filters}
                    selected={shown.length}
                    // The ledger entire, for the two entries whose perimeter it
                    // is: the count is a note on what the file will hold.
                    total={all.length}
                  />
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  className="pointer-coarse:min-h-11"
                  onClick={() => setEditing(null)}
                >
                  {t('data.new')}
                </Button>
              </div>
            </div>

            {/* **The summary line, always there** (#1278): the count, what the
                reduction retains with its way out, and — at the right, only
                while rows are ticked — what can be done with them. It is there
                with or without a selection, so ticking a box moves nothing
                under the pointer. It is what the reader hears when a filter
                moves. */}
            <div
              ref={summary}
              tabIndex={-1}
              role="status"
              aria-live="polite"
              className={cn(
                'flex min-h-8 flex-wrap items-center gap-2 text-sm outline-none',
                // On a phone the list is long and the page scrolls: the ticked
                // rows' actions stay under the thumb while there are some.
                isMobile && selected.length > 0 && 'sticky top-14 z-20 bg-background',
              )}
            >
              <p className="text-muted-foreground">
                {t('data.filter.count', {
                  count: shown.length,
                  reduced: reduces(filters) ? 'yes' : 'no',
                })}
              </p>
              <LedgerChips filters={filters} onChange={reduce} />
              {reduces(filters) ? (
                <button
                  type="button"
                  onClick={() => reduce(NO_FILTERS)}
                  className="text-xs text-muted-foreground underline underline-offset-4 pointer-coarse:min-h-11"
                >
                  {t('data.facets.reset')}
                </button>
              ) : null}
              {selected.length === 0 ? null : (
                <div className="flex flex-wrap items-center gap-2 max-sm:basis-full sm:ml-auto">
                  <span className="font-medium">
                    {t('data.selection.count', { count: selected.length })}
                  </span>
                  {/* **The destructive gesture sits beside the table it
                      consumes** (#814, #1113), and exists only while there is
                      something to consume. */}
                  <BulkDelete selected={selected} onDeleted={clearSelection} />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="pointer-coarse:min-h-11"
                    onClick={clearSelection}
                  >
                    {t('data.selection.clear')}
                  </Button>
                </div>
              )}
            </div>

            {shown.length === 0 ? (
              <EmptyState
                title={t('data.filter.none.title')}
                description={t('data.filter.none.body')}
              />
            ) : (
              // **The table and its footing sit on the page's background**
              // (#1273), with no plane and no frame: the sentence under the
              // table — *fin de la réduction*, or the count and the reveal —
              // is its footing, under a rule.
              //
              // It is also **where a file is dropped** once the ledger has
              // rows (#1278): the band is gone, and a file over the table
              // draws the outline and says what dropping it does. The overlay
              // is `aria-hidden` — the picker is the accessible way in.
              <div
                {...drop.handlers}
                data-drop="ledger"
                className={cn(
                  '@container/ledger relative',
                  drop.over && 'outline-[1.5px] -outline-offset-1 outline-primary outline-dashed',
                )}
              >
                {drop.over ? (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/80 px-6 text-center text-sm font-medium"
                  >
                    {t('data.drop.over')}
                  </div>
                ) : null}
                {/* Below 768 px the table is a list (#1339): same props, same
                    wrapper, so the drop and the reveal tail are shared. */}
                {isMobile ? <LedgerList {...view} /> : <LedgerTable {...view} />}

                {/* **The reveal speaks, and the read did not**.
                      Both sentences below describe rows the app already holds —
                      one of them counts what is drawn against what the
                      reduction holds, the other says the last of them is drawn
                      — so neither is a claim made on a silence, and the
                      in-flight rule is not in contention here: this whole
                      branch sits behind `events.data`.

                      And there is **no spinner**, in this state or in any
                      other. There is not even a wait to dress: the next forty
                      rows are in memory, and pressing the button is a
                      `setState` and a render. */}
                <div
                  ref={tail}
                  tabIndex={-1}
                  aria-live="polite"
                  className="flex flex-wrap items-center justify-center gap-3 border-t px-4 py-3.5 outline-none"
                >
                  {page.atEnd ? (
                    <p className="text-xs text-muted-foreground">
                      {/* **True of the reduction, and not of the store**:
                           *the end of the ledger*, said over a
                            reduced table, is the sentence that record refuses
                            by name. */}
                      {t('data.ledger.end', {
                        count: page.total,
                        reduced: reduces(filters) ? 'yes' : 'no',
                      })}
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
                        className="pointer-coarse:min-h-11"
                        onClick={() => setBudget((current) => current + PAGE)}
                      >
                        {t('data.ledger.more')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <EventForm
        open={editing !== undefined}
        event={editing ?? null}
        accounts={accounts.data}
        accountsFailed={accounts.isError}
        titles={titles}
        onClose={() => setEditing(undefined)}
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
