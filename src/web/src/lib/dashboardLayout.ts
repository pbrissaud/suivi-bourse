/**
 * The dashboard's layout: an **ordered list of cards, each with a width**, and
 * not a two-dimensional grid (office hours, 11/10/2026). Two widths and a fixed
 * head make the order and the widths the whole layout; CSS grid draws it.
 *
 * ```
 *  saved (GET, unknown)
 *     │ normalizeLayout ── unknown ids, duplicates, a future version: dropped;
 *     ▼                    cards it lacks: appended (a new one hidden, D7)
 *  Placement[]  ◄── moveBlock / withWidth / withHidden (the edit menu)
 *     │ resolveLayout(placements, states, mode, columns)
 *     ▼
 *  Cell[] ── a card and its span, or the empty half beside a half-only card
 * ```
 *
 * Every function here is pure and takes the registry as a parameter, so a
 * test can describe a card that has not shipped yet.
 */
import type { DashboardLayout } from '@/lib/api'
import { DASHBOARD_BLOCKS, type BlockId, type BlockSpec, type Width } from '@/lib/dashboardBlocks'

export interface Placement<Id extends string = BlockId> {
  id: Id
  width: Width
  hidden: boolean
}

/**
 * What a card renders, decided by the card itself (`xxxRenderState`) and read
 * by the page from the same function, so the two can never disagree:
 *
 * - `pending`: its read has not answered; its place is held (D4, 3A).
 * - `renders`: data, an empty state or a failure — anything at all.
 * - `nothing`: it has nothing to say; it leaves the grid in reading mode and
 *   keeps a reduced cell in edit mode, so it can still be moved or hidden.
 */
export type RenderState = 'pending' | 'renders' | 'nothing'

export type Cell<Id extends string = BlockId> =
  | { kind: 'block'; id: Id; span: 1 | 2; width: Width; orphan: boolean }
  | { kind: 'free' }

type Registry<Id extends string> = Record<Id, BlockSpec>

const LAYOUT_VERSION = 1

/** The layout of an owner who never saved one: the registry's order and widths. */
export function defaultLayout<Id extends string = BlockId>(
  registry: Registry<Id> = DASHBOARD_BLOCKS as unknown as Registry<Id>,
): Placement<Id>[] {
  return (Object.keys(registry) as Id[]).map((id) => ({
    id,
    width: registry[id].width,
    hidden: registry[id].arrivesHidden === true,
  }))
}

/**
 * The stored layout, made drawable. Anything that is not version 1 reads as
 * the default (a layout written by a later release included); an id the
 * registry does not know is dropped, a duplicate keeps its first occurrence, a
 * width the card refuses goes back to its default, and a card missing from the
 * layout is appended at its default width — hidden if it arrived later (D7).
 */
export function normalizeLayout<Id extends string = BlockId>(
  saved: unknown,
  registry: Registry<Id> = DASHBOARD_BLOCKS as unknown as Registry<Id>,
): Placement<Id>[] {
  const blocks = storedBlocks(saved)
  if (blocks === null) return defaultLayout(registry)

  const known = (value: unknown): value is Id =>
    typeof value === 'string' && Object.hasOwn(registry, value)
  const seen = new Set<Id>()
  const placements: Placement<Id>[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const { id, width, hidden } = block as Record<string, unknown>
    if (!known(id) || seen.has(id)) continue
    seen.add(id)
    const spec = registry[id]
    placements.push({
      id,
      width: spec.widths.includes(width as Width) ? (width as Width) : spec.width,
      hidden: hidden === true,
    })
  }
  for (const placement of defaultLayout(registry)) {
    if (!seen.has(placement.id)) placements.push(placement)
  }
  return placements
}

function storedBlocks(saved: unknown): unknown[] | null {
  if (typeof saved !== 'object' || saved === null) return null
  const { version, blocks } = saved as Record<string, unknown>
  return version === LAYOUT_VERSION && Array.isArray(blocks) ? blocks : null
}

/** The layout as the server keeps it. */
export function toStored(placements: readonly Placement[]): DashboardLayout {
  return {
    version: LAYOUT_VERSION,
    blocks: placements.map(({ id, width, hidden }) => ({ id, width, hidden })),
  }
}

/**
 * The cards still *Nouveau*: arrived after the first three and absent from the
 * saved layout. The next save writes them in, visible or hidden, and that is
 * what ends it (design review 18A).
 */
export function newBlocks<Id extends string = BlockId>(
  saved: unknown,
  registry: Registry<Id> = DASHBOARD_BLOCKS as unknown as Registry<Id>,
): Id[] {
  const stored = new Set(
    (storedBlocks(saved) ?? []).map((block) =>
      typeof block === 'object' && block !== null ? (block as { id?: unknown }).id : undefined,
    ),
  )
  return (Object.keys(registry) as Id[]).filter(
    (id) => registry[id].arrivesHidden === true && !stored.has(id),
  )
}

export function sameLayout(
  left: readonly Placement<string>[],
  right: readonly Placement<string>[],
) {
  return (
    left.length === right.length &&
    left.every(
      (one, index) =>
        one.id === right[index].id &&
        one.width === right[index].width &&
        one.hidden === right[index].hidden,
    )
  )
}

/**
 * Whether « Terminé » has something to write: the draft differs from what was
 * read (4A), or a card is still *Nouveau* — writing it in, visible or hidden,
 * is what ends that (18A).
 */
export function mustWrite<Id extends string = BlockId>(
  draft: readonly Placement<Id>[],
  saved: unknown,
  registry: Registry<Id> = DASHBOARD_BLOCKS as unknown as Registry<Id>,
): boolean {
  return (
    !sameLayout(draft, normalizeLayout(saved, registry)) || newBlocks(saved, registry).length > 0
  )
}

/**
 * The grid, cell by cell, in reading order — which is also the DOM and focus
 * order: no `grid-auto-flow: dense` (WCAG 2.4.3).
 *
 * - Hidden cards are out. In reading mode a `nothing` card is out too; in edit
 *   mode it keeps its cell, and a `pending` card always keeps its place (D4).
 * - Two consecutive halves share a row. A half alone is drawn full when the
 *   card accepts the full width (its saved width is untouched, and its menu
 *   says why); a half-only card alone keeps its half and leaves the other one
 *   free (decision D11 of the office hours).
 * - One column (under 768 px) is a column of full cells.
 */
export function resolveLayout<Id extends string = BlockId>(
  placements: readonly Placement<Id>[],
  states: Readonly<Record<Id, RenderState>>,
  mode: 'read' | 'edit',
  columns: 1 | 2,
  registry: Registry<Id> = DASHBOARD_BLOCKS as unknown as Registry<Id>,
): Cell<Id>[] {
  const shown = placements.filter(
    (one) => !one.hidden && (mode === 'edit' || states[one.id] !== 'nothing'),
  )
  if (columns === 1) {
    return shown.map((one) => ({
      kind: 'block',
      id: one.id,
      span: 2,
      width: 'half',
      orphan: false,
    }))
  }
  return rowsOf(shown).flatMap((row): Cell<Id>[] => {
    const [one, two] = row
    if (two !== undefined) {
      return [
        { kind: 'block', id: one.id, span: 1, width: 'half', orphan: false },
        { kind: 'block', id: two.id, span: 1, width: 'half', orphan: false },
      ]
    }
    if (one.width === 'full') {
      return [{ kind: 'block', id: one.id, span: 2, width: 'full', orphan: false }]
    }
    return registry[one.id].widths.includes('full')
      ? [{ kind: 'block', id: one.id, span: 2, width: 'full', orphan: true }]
      : [{ kind: 'block', id: one.id, span: 1, width: 'half', orphan: false }, { kind: 'free' }]
  })
}

/**
 * The visible cards grouped as the grid draws them: a pair of halves is one
 * row, a full card (or a lone half) another.
 */
function rowsOf<Id extends string>(visible: readonly Placement<Id>[]): Placement<Id>[][] {
  const rows: Placement<Id>[][] = []
  for (let index = 0; index < visible.length; index++) {
    const one = visible[index]
    const next = visible[index + 1]
    if (one.width === 'half' && next !== undefined && next.width === 'half') {
      rows.push([one, next])
      index += 1
    } else {
      rows.push([one])
    }
  }
  return rows
}

/**
 * *Monter* / *Descendre*, by row (Paul, 11/10/2026): a full card jumps a whole
 * row, so a pair of halves moves as one and is never split by a card passing
 * through; a half swaps with the previous or next half in reading order,
 * skipping the full cards. Hidden cards keep their slots. `null` when there is
 * nowhere to go — the menu disables the item.
 */
export function moveBlock<Id extends string>(
  placements: readonly Placement<Id>[],
  id: Id,
  direction: -1 | 1,
): Placement<Id>[] | null {
  const visible = placements.filter((one) => !one.hidden)
  const moving = visible.find((one) => one.id === id)
  if (moving === undefined) return null

  let order: Placement<Id>[]
  if (moving.width === 'full') {
    const rows = rowsOf(visible)
    const from = rows.findIndex((row) => row.includes(moving))
    const to = from + direction
    if (to < 0 || to >= rows.length) return null
    ;[rows[from], rows[to]] = [rows[to], rows[from]]
    order = rows.flat()
  } else {
    const halves = visible.filter((one) => one.width === 'half')
    const other = halves[halves.indexOf(moving) + direction]
    if (other === undefined) return null
    order = visible.slice()
    const a = order.indexOf(moving)
    const b = order.indexOf(other)
    ;[order[a], order[b]] = [order[b], order[a]]
  }

  let next = 0
  return placements.map((one) => (one.hidden ? one : order[next++]))
}

/**
 * A card dragged onto another one, by the menu's rule (Paul, 11/10/2026): the
 * gesture has no rule of its own.
 *
 * - A full card goes between two rows, `side` of the row holding `overId`;
 *   never into the middle of a pair.
 * - A half takes the place of the half it is dropped on. Dropped on a full
 *   card, it takes the place of the nearest half on that `side` of it, as
 *   *Monter* / *Descendre* would skip the full card.
 *
 * Hidden cards keep their slots. `null` when nothing would change.
 */
export function dropBlock<Id extends string>(
  placements: readonly Placement<Id>[],
  activeId: Id,
  overId: Id,
  side: 'before' | 'after',
): Placement<Id>[] | null {
  const visible = placements.filter((one) => !one.hidden)
  const moving = visible.find((one) => one.id === activeId)
  const over = visible.find((one) => one.id === overId)
  if (moving === undefined || over === undefined || moving === over) return null

  let order: Placement<Id>[]
  if (moving.width === 'full') {
    const rows = rowsOf(visible.filter((one) => one !== moving))
    const at = rows.findIndex((row) => row.includes(over))
    rows.splice(side === 'before' ? at : at + 1, 0, [moving])
    order = rows.flat()
  } else {
    const target =
      over.width === 'half'
        ? over
        : side === 'before'
          ? visible
              .slice(0, visible.indexOf(over))
              .filter((one) => one.width === 'half')
              .at(-1)
          : visible.slice(visible.indexOf(over) + 1).find((one) => one.width === 'half')
    if (target === undefined || target === moving) return null
    order = visible.slice()
    const a = order.indexOf(moving)
    const b = order.indexOf(target)
    ;[order[a], order[b]] = [order[b], order[a]]
  }

  if (order.every((one, index) => one === visible[index])) return null
  let next = 0
  return placements.map((one) => (one.hidden ? one : order[next++]))
}

/** The position a card holds among the visible ones, 1-based, and how many there are. */
export function positionOf<Id extends string>(placements: readonly Placement<Id>[], id: Id) {
  const visible = placements.filter((one) => !one.hidden)
  return { position: visible.findIndex((one) => one.id === id) + 1, total: visible.length }
}

export function withWidth<Id extends string>(
  placements: readonly Placement<Id>[],
  id: Id,
  width: Width,
): Placement<Id>[] {
  return placements.map((one) => (one.id === id ? { ...one, width } : one))
}

/** Hidden cards keep their slot, so a card shown again comes back where it was. */
export function withHidden<Id extends string>(
  placements: readonly Placement<Id>[],
  id: Id,
  hidden: boolean,
): Placement<Id>[] {
  return placements.map((one) => (one.id === id ? { ...one, hidden } : one))
}
