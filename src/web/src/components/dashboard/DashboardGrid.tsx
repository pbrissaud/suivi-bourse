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
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal } from 'lucide-react'

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
import { api } from '@/lib/api'
import { blockSpec, type BlockId, type Width } from '@/lib/dashboardBlocks'
import {
  defaultLayout,
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
} from '@/lib/dashboardLayout'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export interface GridBlock {
  state: RenderState
  /**
   * The card has no title of its own to carry the menu: it failed (its
   * `Unreadable` is not a section), so the frame draws a reduced title row.
   */
  bare: boolean
  /** The card at the width the grid draws it. */
  render: (width: Width) => ReactNode
}

const LAYOUT_KEY = ['dashboard-layout'] as const

type FocusTarget =
  | { kind: 'menu'; id: BlockId }
  | { kind: 'hidden' }
  | { kind: 'title' }
  | { kind: 'entry' }
  | { kind: 'confirm' }
  | { kind: 'reset' }

const FOCUS_SELECTORS: Record<Exclude<FocusTarget['kind'], 'menu'>, string> = {
  hidden: '[data-hidden-cards]',
  title: '[data-edit-title]',
  entry: '[data-edit-entry]',
  confirm: '[data-confirm-reset]',
  reset: '[data-reset]',
}

/** The keyboard focus ring DESIGN.md asks of every control: 2 px `primary`, 2 px off. */
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

export function DashboardGrid({
  blocks,
  onEditingChange,
}: {
  blocks: Record<BlockId, GridBlock>
  /** Edit mode began or ended — the page freezes the hero while it lasts (12B). */
  onEditingChange?: (editing: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const columns = useIsMobile() ? 1 : 2
  const root = useRef<HTMLDivElement>(null)

  const layout = useQuery({ queryKey: LAYOUT_KEY, queryFn: api.dashboardLayout })
  const [draft, setDraft] = useState<Placement[] | null>(null)
  const [toDelete, setToDelete] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [said, setSaid] = useState('')
  const [focus, setFocus] = useState<FocusTarget | null>(null)

  const editing = draft !== null
  // **Unread is only « never read »** (D6): a background refetch that fails
  // keeps the layout already read — react-query holds `data` through it — so
  // the owner's arrangement never falls back to the default behind their back.
  const unread = layout.data === undefined
  const saved = layout.data ?? null
  const placements = draft ?? normalizeLayout(saved)
  const fresh = unread ? [] : newBlocks(saved)

  const write = useMutation({
    mutationFn: async (next: Placement[] | 'default') => {
      if (next === 'default') await api.forgetDashboardLayout()
      else await api.saveDashboardLayout(toStored(next))
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
      focus.kind === 'menu' ? `[data-card-menu="${focus.id}"]` : FOCUS_SELECTORS[focus.kind]
    // After the menu has closed: Radix hands the focus back on its own way
    // out, and this has to land after it.
    const scope = root.current
    const timer = window.setTimeout(() => {
      scope.querySelector<HTMLElement>(selector)?.focus()
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

  const cells = resolveLayout(placements, stateMap(blocks), editing ? 'edit' : 'read', columns)
  const name = (id: BlockId) => t(blockSpec(id).label)
  const atDefault = editing && sameLayout(draft, defaultLayout())
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
              'label rounded-sm underline underline-offset-4 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
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

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
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
            <div
              key={cell.id}
              className={cn('flex min-w-0 flex-col', cell.span === 2 && 'md:col-span-2')}
            >
              <Cell
                id={cell.id}
                name={name(cell.id)}
                block={block}
                width={cell.width}
                editing={editing}
                menu={menu}
                nothing={t('dashboard.edit.nothing')}
              />
            </div>
          )
        })}
      </div>

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
  editing,
  menu,
  nothing,
}: {
  id: BlockId
  name: string
  block: GridBlock
  width: Width
  editing: boolean
  menu: ReactNode
  nothing: string
}) {
  const bareRow = editing ? (
    <div className="flex items-center justify-between gap-2">
      <span className="label">{name}</span>
      {menu}
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
        <div inert>{block.render(width)}</div>
      </div>
    )
  }
  return (
    <SectionControlsContext.Provider value={{ controls: menu, fill: true, inert: editing }}>
      {block.render(width)}
    </SectionControlsContext.Provider>
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
          className={cn(
            'inline-grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:text-foreground pointer-coarse:size-11',
            FOCUS_RING,
          )}
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
