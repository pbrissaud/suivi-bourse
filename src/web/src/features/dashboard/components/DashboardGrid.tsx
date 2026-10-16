/**
 * The dashboard's grid of cards, and the edit mode that arranges it
 * (dashboard grid, design doc of 11/10/2026).
 *
 * ```
 *  GET /api/dashboard/layout ── in flight ─► the grid waits; the head does not (D6)
 *        │ failed ─► the default layout, and « Modifier » disabled with its reason
 *        ▼
 *  normalizeLayout ─► Placement[] ─► resolveLayout ─► cells ─► <DashboardCell>
 *                          ▲
 *     edit mode: a local draft, changed by each card's ⋯ menu
 *     « Terminé » ─► PUT (or DELETE after « Réinitialiser »), one write per session
 * ```
 *
 * **The grid reads one thing, the layout**; every card's own reads stay the
 * page's (#799), and each card tells the grid what it renders through its
 * `xxxRenderState` — the same function the card calls for its own `null`.
 *
 * **A card's place is held while its read is in flight** (D4): a `pending`
 * card is drawn as an empty plane at its registry height, so the grid
 * recomposes only when a card ends with nothing to say.
 *
 * **Edit mode** (design review, passes 1 to 7, and Paul's notes on the
 * interactive mock-up): the entry sits on the grid's top edge; the cards' menu
 * goes in their own title row; the cards' content is `inert`; every action
 * keeps the focus on the card it moved and says what it did through one live
 * region; under 768 px the bar sticks to the top and there is no width choice.
 *
 * **Dragging** (PR 2) is the mouse's shortcut to the menu, with no rule of its
 * own: the ⠿ handle, desktop only, previews {@link dropBlock} from the order
 * the drag began with, at the widths it began with (a card does not resize
 * under the pointer), and the drop lands in the same draft as the menu.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Accessibility, defaultPreset } from '@dnd-kit/dom'
import { SortableKeyboardPlugin } from '@dnd-kit/dom/sortable'
import {
  DragDropProvider,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'
import { GripVertical, MoreHorizontal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SectionControlsContext } from '@/components/ui/section'
import { useIsMobile } from '@/hooks/use-mobile'
import { dashboardApi } from '@/features/dashboard/lib/api'
import { blockSpec, type BlockId, type Width } from '@/features/dashboard/lib/dashboardBlocks'
import {
  defaultLayout,
  dropBlock,
  moveBlock,
  mustWrite,
  newBlocks,
  normalizeLayout,
  positionOf,
  resolveLayout,
  sameLayout,
  toStored,
  withHidden,
  withWidth,
  type Placement,
  type RenderState,
} from '@/features/dashboard/lib/dashboardLayout'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export interface GridBlock {
  state: RenderState
  /**
   * The card has no title of its own to carry the menu: it failed (its
   * `Unreadable` is not a section), so the frame draws a reduced title row.
   */
  bare: boolean
  /**
   * The card at the width the grid draws it, and at the one its placement
   * asks for — the two part under 768 px, where every card is drawn half.
   */
  render: (width: Width, configured: Width) => ReactNode
}

const LAYOUT_KEY = ['dashboard-layout'] as const

type FocusTarget =
  | { kind: 'menu'; id: BlockId }
  | { kind: 'handle'; id: BlockId }
  | { kind: 'hidden' }
  | { kind: 'title' }
  | { kind: 'entry' }
  | { kind: 'confirm' }
  | { kind: 'reset' }

const FOCUS_SELECTORS: Record<Exclude<FocusTarget['kind'], 'menu' | 'handle'>, string> = {
  hidden: '[data-hidden-cards]',
  title: '[data-edit-title]',
  entry: '[data-edit-entry]',
  confirm: '[data-confirm-reset]',
  reset: '[data-reset]',
}

/** The keyboard focus ring DESIGN.md asks of every control: 2 px `primary`, 2 px off. */
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

/** ⠿ and ⋯ share one look (11A): a 28 px ghost button, `text-muted` turning `foreground`. */
const CONTROL =
  'inline-grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:text-foreground'

/**
 * No optimistic sorting: dnd-kit would reorder the DOM by its own list rule,
 * and the grid's rule is the menu's ({@link dropBlock}). The keyboard plugin
 * stays, so the arrows go from card to card.
 */
const SORTABLE_PLUGINS = [SortableKeyboardPlugin]

/**
 * Only the gesture moves (DESIGN.md › Motion): the other cards slide to their
 * new place in 200 ms, and dnd-kit drops it to nothing under
 * `prefers-reduced-motion`. A move from the menu does not animate (`idle`).
 */
const SLIDE = { duration: 200, easing: 'ease-in-out', idle: false }

interface Drag {
  /** The draft when the drag began: every preview is one drop away from it. */
  start: Placement[]
  /** The order on screen now, which says on what side of a card the pointer is. */
  shown: Placement[]
  /** The spans and widths the drag began with, frozen until the drop. */
  frozen: Map<BlockId, { span: 1 | 2; width: Width }>
}

export function DashboardGrid({
  blocks,
  onEditingChange,
  onShownChange,
}: {
  blocks: Record<BlockId, GridBlock>
  /** Edit mode began or ended — the page freezes the hero while it lasts (12B). */
  onEditingChange?: (editing: boolean) => void
  /**
   * The cards the grid draws — the draft's while editing, the saved layout's
   * otherwise — so the page arms a card's read only once it is shown (#1205).
   */
  onShownChange?: (shown: readonly BlockId[]) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const columns = useIsMobile() ? 1 : 2
  const root = useRef<HTMLDivElement>(null)

  const layout = useQuery({ queryKey: LAYOUT_KEY, queryFn: dashboardApi.dashboardLayout })
  const [draft, setDraft] = useState<Placement[] | null>(null)
  const [toDelete, setToDelete] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [said, setSaid] = useState('')
  const [focus, setFocus] = useState<FocusTarget | null>(null)
  // The drag in progress: in state for the render, mirrored in a ref for
  // dnd-kit's handlers, which can run twice before a render.
  const [dragging, setDragging] = useState<Drag | null>(null)
  const drag = useRef<Drag | null>(null)
  // The announcement and the grid read one result per `dragover`, whichever
  // of the two dnd-kit calls first.
  const outcomes = useRef(new WeakMap<DragOverEvent, Placement[]>())
  // The order on screen, for the `dragstart` announcement: dnd-kit builds
  // its announcer once, and reads it through this.
  const latest = useRef<Placement[]>([])

  const editing = draft !== null
  // **Unread is only « never read »** (D6): a background refetch that fails
  // keeps the layout already read — react-query holds `data` through it — so
  // the owner's arrangement never falls back to the default behind their back.
  const unread = layout.data === undefined
  const saved = layout.data ?? null
  const placements = dragging?.shown ?? draft ?? normalizeLayout(saved)
  const fresh = unread ? [] : newBlocks(saved)

  const write = useMutation({
    mutationFn: async (next: Placement[] | 'default') => {
      if (next === 'default') await dashboardApi.forgetDashboardLayout()
      else await dashboardApi.saveDashboardLayout(toStored(next))
    },
    // What was written is what the server now holds: put it in the cache
    // rather than wait on a refetch (and its retries) to leave edit mode.
    onSuccess: (_, next) => {
      queryClient.setQueryData(LAYOUT_KEY, next === 'default' ? null : toStored(next))
      leave(t('dashboard.edit.saved'))
    },
  })

  // **The focus follows the card** (design review 13A): React may move a
  // keyed node while reordering, and a moved node can lose the focus, so it is
  // put back explicitly once the new order is in the document.
  useLayoutEffect(() => {
    if (focus === null || root.current === null) return
    const selector =
      focus.kind === 'menu'
        ? `[data-card-menu="${focus.id}"]`
        : focus.kind === 'handle'
          ? `[data-card-handle="${focus.id}"]`
          : FOCUS_SELECTORS[focus.kind]
    // After the menu has closed: Radix hands the focus back on its own way
    // out, and this has to land after it.
    const scope = root.current
    const timer = window.setTimeout(() => {
      const target = scope.querySelector<HTMLElement>(selector)
      // A card dropped with the mouse is still flying to its cell, lifted out
      // of the page, where it would lose the focus on landing: it takes it then.
      const landing = target?.closest('[data-dashboard-grid] > *')?.getAnimations() ?? []
      const before = document.activeElement
      void Promise.all(landing.map((one) => one.finished.catch(() => undefined))).then(() => {
        // Unless the owner has gone elsewhere in the meantime.
        if (document.activeElement === before || document.activeElement === document.body) {
          target?.focus()
        }
      })
      setFocus(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [focus])

  useLayoutEffect(() => {
    onEditingChange?.(editing)
    // The grid can leave the page mid-edit (the page leaves `portfolio`):
    // the hero must not stay frozen behind it.
    return () => onEditingChange?.(false)
  }, [editing, onEditingChange])

  useLayoutEffect(() => {
    latest.current = placements
  })

  // Nothing is shown before the layout is read: a card hidden in it must not
  // be asked for in the meantime. Sorted and joined, so a drag that only
  // reorders the same cards reports nothing.
  const shown = unread
    ? ''
    : placements
        .filter((one) => !one.hidden)
        .map((one) => one.id)
        .sort()
        .join(' ')
  useLayoutEffect(() => {
    onShownChange?.(shown === '' ? [] : (shown.split(' ') as BlockId[]))
    // The grid can leave the page mid-edit: a card shown only in the draft
    // must not stay armed behind it.
    return () => onShownChange?.([])
  }, [shown, onShownChange])

  // Under 768 px the menu is the way to move a card (15A); a coarse pointer
  // hides the handle in CSS. A save in flight ends the session: nothing more
  // can land in the draft it is writing.
  const draggable = editing && columns === 2 && !write.isPending

  // dnd-kit's live region is mounted only while a card can be dragged: the
  // page keeps its two permanent announcers, and no more.
  const plugins = useMemo(() => {
    const cardName = (id: unknown) => t(blockSpec(id as BlockId).label)
    if (!draggable) return defaultPreset.plugins.filter((one) => one !== Accessibility)
    return [
      ...defaultPreset.plugins,
      Accessibility.configure({
        // Said at once: a position announced late would land after the drop's.
        debounce: 0,
        screenReaderInstructions: { draggable: t('dashboard.edit.dragInstructions') },
        announcements: {
          dragstart: ({ operation: { source } }: DragStartEvent) =>
            source
              ? t('dashboard.edit.picked', {
                  card: cardName(source.id),
                  ...positionOf(latest.current, source.id as BlockId),
                })
              : undefined,
          dragover: (event: DragOverEvent) => {
            const next = outcomeOf(event)
            const id = event.operation.source?.id as BlockId | undefined
            return next && id
              ? t('dashboard.edit.over', { card: cardName(id), ...positionOf(next, id) })
              : undefined
          },
          // A drop is said by the grid's own live region, as the menu's moves are.
          dragend: ({ canceled }: DragEndEvent) =>
            canceled ? t('dashboard.edit.dragCancelled') : undefined,
        },
      }),
    ]
    // `outcomeOf` reads refs only.
  }, [t, draggable])

  /**
   * The draft a `dragover` previews: {@link dropBlock} from the order the
   * drag began with, on the side of the card under the pointer as the grid
   * shows it now. Same event, same result.
   */
  function outcomeOf(event: DragOverEvent): Placement[] | null {
    const now = drag.current
    const { source, target } = event.operation
    if (now === null || !source || !target || source.id === target.id) return null
    let next = outcomes.current.get(event)
    if (next === undefined) {
      const ids = (placements: Placement[]) =>
        placements.filter((one) => !one.hidden).map((one) => one.id)
      const order = ids(now.shown)
      const active = source.id as BlockId
      const over = target.id as BlockId
      // The card now standing where the dragged one began is the way back:
      // without this, a half swapped away could not be brought home.
      const home = order.indexOf(over) === ids(now.start).indexOf(active)
      const side = order.indexOf(over) < order.indexOf(active) ? 'before' : 'after'
      next = home ? now.start : (dropBlock(now.start, active, over, side) ?? now.start)
      outcomes.current.set(event, next)
    }
    return next
  }

  function track(next: Drag | null) {
    drag.current = next
    setDragging(next)
  }

  // The grid waits for the layout it is drawn from (D6); the head above has
  // not waited for anything.
  if (layout.isPending) return null

  const announce = (text: string) => setSaid(text)

  function enter() {
    setDraft(normalizeLayout(saved))
    setToDelete(false)
    write.reset()
    setFocus({ kind: 'title' })
  }

  function leave(outcome: string) {
    setDraft(null)
    setConfirming(false)
    setToDelete(false)
    // A failed save abandoned with « Annuler » leaves no alert, nor a
    // « Réessayer » with nothing left to retry, in reading mode.
    write.reset()
    setFocus({ kind: 'entry' })
    announce(outcome)
  }

  function edit(next: Placement[], focusTo: FocusTarget, text: string) {
    setDraft(next)
    setToDelete(false)
    setFocus(focusTo)
    announce(text)
  }

  function done() {
    if (draft === null) return
    if (toDelete) {
      write.mutate('default')
      return
    }
    // A save with nothing changed writes nothing (4A) — unless a card is still
    // *Nouveau*: writing it in, visible or hidden, is what ends that (18A).
    if (!mustWrite(draft, saved)) {
      leave(t('dashboard.edit.unchanged'))
      return
    }
    write.mutate(draft)
  }

  const resolved = resolveLayout(placements, stateMap(blocks), editing ? 'edit' : 'read', columns)
  // While a drag lasts the cards keep the spans it began with, and the free
  // halves go: the grid leaves its own gaps, and the drop resolves again.
  const cells =
    dragging === null
      ? resolved
      : resolved.flatMap((cell) =>
          cell.kind === 'block' ? [{ ...cell, ...dragging.frozen.get(cell.id) }] : [],
        )
  const name = (id: BlockId) => t(blockSpec(id).label)

  function onDragStart() {
    track({
      start: placements,
      shown: placements,
      frozen: new Map(
        resolved.flatMap((cell) =>
          cell.kind === 'block' ? [[cell.id, { span: cell.span, width: cell.width }] as const] : [],
        ),
      ),
    })
  }

  function onDragOver(event: DragOverEvent) {
    const now = drag.current
    const next = outcomeOf(event)
    if (now === null || next === null || sameLayout(next, now.shown)) return
    track({ ...now, shown: next })
  }

  function onDragEnd({ operation, canceled }: DragEndEvent) {
    const now = drag.current
    track(null)
    const id = operation.source?.id as BlockId | undefined
    // The grid went under 768 px, or the session ended, under the pointer.
    if (now === null || id === undefined || !draggable) return
    const handle: FocusTarget = { kind: 'handle', id }
    if (canceled) {
      setFocus(handle)
      return
    }
    const text = t('dashboard.edit.dropped', { card: name(id), ...positionOf(now.shown, id) })
    if (sameLayout(now.shown, now.start)) {
      setFocus(handle)
      announce(text)
    } else {
      edit(now.shown, handle, text)
    }
  }

  const atDefault = editing && sameLayout(draft, defaultLayout())
  let sortIndex = 0
  const hidden = placements
    .filter((one) => one.hidden)
    .sort(
      (a, b) =>
        Number(fresh.includes(b.id)) - Number(fresh.includes(a.id)) ||
        name(a.id).localeCompare(name(b.id)),
    )

  return (
    <div ref={root} className="flex flex-col gap-3">
      {/* One live region for the whole session, mounted outside the edit bar
          so the session's end is said too (13A). */}
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
      {editing ? (
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-x-4 gap-y-2',
            // Under 768 px the column is long, and « Terminé » must stay in
            // reach while the cards at the bottom are arranged (15A).
            columns === 1 && 'sticky top-0 z-10 bg-background py-2',
          )}
        >
          <h2 tabIndex={-1} data-edit-title className="text-2xl font-semibold outline-none">
            {t('dashboard.edit.title')}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {atDefault ? (
              <span id="dashboard-at-default" className="label font-normal">
                {t('dashboard.edit.atDefault')}
              </span>
            ) : null}
            <Button
              variant="ghost"
              data-reset
              disabled={atDefault || write.isPending}
              aria-describedby={atDefault ? 'dashboard-at-default' : undefined}
              onClick={() => {
                setConfirming(true)
                setFocus({ kind: 'confirm' })
              }}
            >
              {t('dashboard.edit.reset')}
            </Button>
            <Button
              variant="outline"
              disabled={write.isPending}
              onClick={() => leave(t('dashboard.edit.cancelled'))}
            >
              {t('dashboard.edit.cancel')}
            </Button>
            <Button disabled={write.isPending} onClick={done}>
              {write.isPending ? t('dashboard.edit.saving') : t('dashboard.edit.done')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {fresh.length > 0 ? (
            <span className="label">{t('dashboard.edit.newCards', { count: fresh.length })}</span>
          ) : null}
          <button
            type="button"
            data-edit-entry
            disabled={unread}
            aria-describedby={unread ? 'dashboard-layout-unread' : undefined}
            onClick={enter}
            className={cn(
              'label -my-1 inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm underline underline-offset-4 hover:text-foreground pointer-coarse:-my-3.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:pointer-events-none disabled:opacity-50',
              FOCUS_RING,
            )}
          >
            {t('dashboard.edit.open')}
          </button>
          {unread ? (
            <span id="dashboard-layout-unread" className="label font-normal">
              {t('dashboard.edit.layoutUnreadable')}
            </span>
          ) : null}
        </div>
      )}

      {confirming ? (
        // A destructive confirmation is one of the few things DESIGN.md lets
        // a card be (5A); a modal would freeze the page for a choice
        // « Annuler » can still undo.
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-card p-3.5">
          <p className="min-w-0 flex-1 text-sm">{t('dashboard.edit.confirm')}</p>
          <Button
            variant="outline"
            data-confirm-reset
            onClick={() => {
              setDraft(defaultLayout())
              setToDelete(true)
              setConfirming(false)
              setFocus({ kind: 'title' })
              announce(t('dashboard.edit.resetDone'))
            }}
          >
            {t('dashboard.edit.confirmYes')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setConfirming(false)
              setFocus({ kind: 'reset' })
            }}
          >
            {t('dashboard.edit.confirmNo')}
          </Button>
        </div>
      ) : null}

      {write.isError ? (
        <p role="alert" className="flex flex-wrap items-center gap-3 text-sm text-loss">
          {t('dashboard.edit.saveFailed')}
          <Button variant="outline" onClick={done}>
            {t('dashboard.edit.retry')}
          </Button>
        </p>
      ) : null}

      <DragDropProvider
        plugins={plugins}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div data-dashboard-grid className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {cells.map((cell, index) => {
            if (cell.kind === 'free') {
              return editing ? (
                <div
                  key={`free-${index}`}
                  aria-hidden
                  className="grid min-h-48 place-items-center rounded-section border border-dashed"
                >
                  <span className="label">{t('dashboard.edit.free')}</span>
                </div>
              ) : (
                <div key={`free-${index}`} aria-hidden />
              )
            }
            const block = blocks[cell.id]
            const placement = placements.find((one) => one.id === cell.id) as Placement
            const menu = editing ? (
              <CardMenu
                id={cell.id}
                name={name(cell.id)}
                placements={placements}
                savedWidth={placement.width}
                orphan={cell.orphan}
                widthsOffered={columns === 2 && blockSpec(cell.id).widths.length > 1}
                onMove={(direction) => {
                  const next = moveBlock(placements, cell.id, direction)
                  if (next === null) return
                  const { position, total } = positionOf(next, cell.id)
                  edit(
                    next,
                    { kind: 'menu', id: cell.id },
                    t('dashboard.edit.moved', { card: name(cell.id), position, total }),
                  )
                }}
                onWidth={(width) =>
                  edit(
                    withWidth(placements, cell.id, width),
                    { kind: 'menu', id: cell.id },
                    t(width === 'full' ? 'dashboard.edit.widened' : 'dashboard.edit.narrowed', {
                      card: name(cell.id),
                    }),
                  )
                }
                onHide={() => {
                  const visible = placements.filter((one) => !one.hidden)
                  const at = visible.findIndex((one) => one.id === cell.id)
                  const neighbour = visible[at + 1] ?? visible[at - 1]
                  edit(
                    withHidden(placements, cell.id, true),
                    neighbour ? { kind: 'menu', id: neighbour.id } : { kind: 'hidden' },
                    t('dashboard.edit.hiddenOne', { card: name(cell.id) }),
                  )
                }}
              />
            ) : null
            return (
              <SortableCell
                key={cell.id}
                id={cell.id}
                index={sortIndex++}
                span={cell.span}
                draggable={draggable}
                label={t('dashboard.edit.drag', { card: name(cell.id) })}
                role={t('dashboard.edit.draggable')}
              >
                {(handle) => (
                  <Cell
                    id={cell.id}
                    name={name(cell.id)}
                    block={block}
                    width={cell.width}
                    configured={placement.width}
                    editing={editing}
                    handle={handle}
                    menu={menu}
                    nothing={t('dashboard.edit.nothing')}
                  />
                )}
              </SortableCell>
            )
          })}
        </div>
      </DragDropProvider>

      {editing ? (
        <section
          aria-labelledby="dashboard-hidden-title"
          tabIndex={-1}
          data-hidden-cards
          className="mt-2 rounded-section bg-muted px-6 py-5 outline-none"
        >
          <h2 id="dashboard-hidden-title" className="text-2xl font-semibold">
            {t('dashboard.edit.hidden')}
          </h2>
          {hidden.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">{t('dashboard.edit.hiddenNone')}</p>
          ) : (
            <ul className="mt-3">
              {hidden.map((one) => (
                <li key={one.id} className="flex items-center gap-3 border-t py-2 first:border-t-0">
                  <span className="text-sm">{name(one.id)}</span>
                  {fresh.includes(one.id) ? (
                    <span className="label rounded-full border px-2 text-foreground">
                      {t('dashboard.edit.new')}
                    </span>
                  ) : null}
                  <Button
                    variant="outline"
                    className="ml-auto"
                    onClick={() =>
                      edit(
                        withHidden(placements, one.id, false),
                        { kind: 'menu', id: one.id },
                        t('dashboard.edit.shown', { card: name(one.id) }),
                      )
                    }
                  >
                    {t('dashboard.edit.show')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  )
}

function stateMap(blocks: Record<BlockId, GridBlock>): Record<BlockId, RenderState> {
  return Object.fromEntries(
    Object.entries(blocks).map(([id, block]) => [id, (block as GridBlock).state]),
  ) as Record<BlockId, RenderState>
}

/**
 * One card in its cell. A card that renders draws its own section, and the
 * menu reaches that section's title row through the context; a card with no
 * title of its own (in flight, failed, or with nothing to say) gets a reduced
 * row with its name, so it can still be arranged.
 */
function Cell({
  id,
  name,
  block,
  width,
  configured,
  editing,
  handle,
  menu,
  nothing,
}: {
  id: BlockId
  name: string
  block: GridBlock
  width: Width
  configured: Width
  editing: boolean
  handle: ReactNode
  menu: ReactNode
  nothing: string
}) {
  const bareRow = editing ? (
    <div className="flex items-center gap-2">
      {handle ? <span className="-ml-2 inline-flex">{handle}</span> : null}
      <span className="label">{name}</span>
      <span className="ml-auto inline-flex">{menu}</span>
    </div>
  ) : null

  if (block.state === 'pending') {
    return (
      // **Held, not dressed** (#795): the plane is empty and says nothing —
      // no spinner, no skeleton, no `aria-busy`. It only keeps the card's
      // place, so the grid does not jump when the card lands (D4, 3A).
      <div
        className="flex-1 rounded-section bg-muted px-6 py-5"
        style={{ minHeight: blockSpec(id).minHeight }}
      >
        {bareRow}
      </div>
    )
  }
  if (block.state === 'nothing') {
    return (
      <div className="flex-1 rounded-section bg-muted px-6 py-5">
        {bareRow}
        <p className="mt-3 text-sm text-muted-foreground">{nothing}</p>
      </div>
    )
  }
  if (block.bare && editing) {
    return (
      <div className="flex flex-1 flex-col gap-3">
        <div className="px-1">{bareRow}</div>
        <div inert>{block.render(width, configured)}</div>
      </div>
    )
  }
  return (
    <SectionControlsContext.Provider
      value={{ controls: menu, leading: handle, fill: true, inert: editing }}
    >
      {block.render(width, configured)}
    </SectionControlsContext.Provider>
  )
}

/**
 * A card's cell, sortable by its ⠿ handle. The cell itself is the sortable
 * element (dnd-kit slides it with `translate` only, so a half crossing a full
 * cell is never stretched); the handle is the only thing that starts a drag.
 */
function SortableCell({
  id,
  index,
  span,
  draggable,
  label,
  role,
  children,
}: {
  id: BlockId
  index: number
  span: 1 | 2
  draggable: boolean
  label: string
  role: string
  children: (handle: ReactNode) => ReactNode
}) {
  const { ref, handleRef } = useSortable({
    id,
    index,
    disabled: !draggable,
    plugins: SORTABLE_PLUGINS,
    transition: SLIDE,
  })
  const handle = draggable ? (
    <button
      ref={handleRef}
      type="button"
      data-card-handle={id}
      aria-label={label}
      aria-roledescription={role}
      className={cn(CONTROL, 'cursor-grab pointer-coarse:hidden', FOCUS_RING)}
    >
      <GripVertical className="size-4" aria-hidden />
    </button>
  ) : null
  return (
    <div ref={ref} className={cn('flex min-w-0 flex-col', span === 2 && 'md:col-span-2')}>
      {children(handle)}
    </div>
  )
}

function CardMenu({
  id,
  name,
  placements,
  savedWidth,
  orphan,
  widthsOffered,
  onMove,
  onWidth,
  onHide,
}: {
  id: BlockId
  name: string
  placements: Placement[]
  savedWidth: Width
  orphan: boolean
  widthsOffered: boolean
  onMove: (direction: -1 | 1) => void
  onWidth: (width: Width) => void
  onHide: () => void
}) {
  const { t } = useI18n()
  // An action moves the focus itself (13A); closing the menu with Escape
  // gives it back to the trigger, as a menu does.
  const acted = useRef(false)
  const act = (run: () => void) => () => {
    acted.current = true
    run()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-card-menu={id}
          aria-label={t('dashboard.edit.options', { card: name })}
          className={cn(CONTROL, 'pointer-coarse:size-11', FOCUS_RING)}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-56"
        onCloseAutoFocus={(event) => {
          if (acted.current) event.preventDefault()
          acted.current = false
        }}
      >
        <DropdownMenuItem
          disabled={moveBlock(placements, id, -1) === null}
          onSelect={act(() => onMove(-1))}
        >
          {t('dashboard.edit.up')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={moveBlock(placements, id, 1) === null}
          onSelect={act(() => onMove(1))}
        >
          {t('dashboard.edit.down')}
        </DropdownMenuItem>
        {widthsOffered ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={savedWidth}
              aria-describedby={orphan ? `orphan-${id}` : undefined}
              onValueChange={(value) => {
                acted.current = true
                onWidth(value as Width)
              }}
            >
              <DropdownMenuRadioItem value="half">{t('dashboard.edit.half')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="full">{t('dashboard.edit.full')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {orphan ? (
              <p id={`orphan-${id}`} className="label px-2 pb-1.5 pl-8 font-normal">
                {t('dashboard.edit.orphan')}
              </p>
            ) : null}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={act(onHide)}>{t('dashboard.edit.hide')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
