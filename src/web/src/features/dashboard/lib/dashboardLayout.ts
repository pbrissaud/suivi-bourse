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
 *  Cell[] ── a card and its span, or a free track beside a half-only card
 * ```
 *
 * The grid has one track under 768 px, two up to 1 600 px and three from there
 * (#1325). `columns` only decides how a row is drawn and how far a move
 * jumps: the stored list, its two widths and its order are the same at every
 * viewport, and nothing here writes a width because of one.
 *
 * Every function here is pure and takes the registry as a parameter, so a
 * test can describe a card that has not shipped yet.
 */
import type { DashboardLayout } from '@/features/dashboard/lib/api'
import {
  DASHBOARD_BLOCKS,
  type BlockId,
  type BlockSpec,
  type Width,
} from '@/features/dashboard/lib/dashboardBlocks'

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
  // `span`: 1 is one track, 2 the whole row (two or three tracks wide).
  { kind: 'block'; id: Id; span: 1 | 2; width: Width; orphan: boolean } | { kind: 'free' }

type Registry<Id extends string> = Record<Id, BlockSpec>

const LAYOUT_VERSION = 1

/** The layout of an owner who never saved one: the registry's order and widths,
 * less the cards it keeps hidden. */
export function defaultLayout<Id extends string = BlockId>(
  registry: Registry<Id> = DASHBOARD_BLOCKS as unknown as Registry<Id>,
): Placement<Id>[] {
  return (Object.keys(registry) as Id[]).map((id) => ({
    id,
    width: registry[id].width,
    hidden: registry[id].hiddenByDefault === true,
  }))
}

/**
 * The stored layout, made drawable. Anything that is not version 1 reads as
 * the default (a layout written by a later release included); an id the
 * registry does not know is dropped, a duplicate keeps its first occurrence, a
 * width the card refuses goes back to its default, and a card missing from the
 * layout is appended at its default width — hidden if it arrived later (D7), so an arranged dashboard never gains a visible card
 * on its own.
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
    if (!seen.has(placement.id)) {
      placements.push({ ...placement, hidden: registry[placement.id].arrivesHidden === true })
    }
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
 * The cards still *Nouveau*: arrived after the first four and absent from a
 * saved layout; a fresh install has none (#1280). The next save writes them in, visible or hidden, and that is
 * what ends it (design review 18A).
 */
export function newBlocks<Id extends string = BlockId>(
  saved: unknown,
  registry: Registry<Id> = DASHBOARD_BLOCKS as unknown as Registry<Id>,
): Id[] {
  const blocks = storedBlocks(saved)
  if (blocks === null) return []
  const stored = new Set(
    blocks.map((block) =>
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
 * - Consecutive halves share a row, two of them at two tracks and up to three
 *   at three. A half alone is drawn across the row when the card accepts the
 *   full width (its saved width is untouched, and its menu says why); a
 *   half-only card keeps its track, and the tracks left in the row are free
 *   (decision D11 of the office hours, #1325). A full card takes the whole row.
 * - One column (under 768 px) is a column of full cells.
 */
export function resolveLayout<Id extends string = BlockId>(
  placements: readonly Placement<Id>[],
  states: Readonly<Record<Id, RenderState>>,
  mode: 'read' | 'edit',
  columns: 1 | 2 | 3,
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
  const perRow = tracksPerRow(columns)
  return rowsOf(shown, perRow).flatMap((row): Cell<Id>[] => {
    const [one] = row
    if (row.length > 1) {
      return [
        ...row.map(
          (card): Cell<Id> => ({
            kind: 'block',
            id: card.id,
            span: 1,
            width: 'half',
            orphan: false,
          }),
        ),
        ...Array.from({ length: perRow - row.length }, (): Cell<Id> => ({ kind: 'free' })),
      ]
    }
    if (one.width === 'full') {
      return [{ kind: 'block', id: one.id, span: 2, width: 'full', orphan: false }]
    }
    return registry[one.id].widths.includes('full')
      ? [{ kind: 'block', id: one.id, span: 2, width: 'full', orphan: true }]
      : [
          { kind: 'block', id: one.id, span: 1, width: 'half', orphan: false },
          ...Array.from({ length: perRow - 1 }, (): Cell<Id> => ({ kind: 'free' })),
        ]
  })
}

/** A phone has one track but keeps the rows of two its moves have always had. */
function tracksPerRow(columns: 1 | 2 | 3): 2 | 3 {
  return columns === 3 ? 3 : 2
}

/**
 * The visible cards grouped as the grid draws them: up to `perRow` consecutive
 * halves are one row, a full card (or a lone half) another.
 */
function rowsOf<Id extends string>(
  visible: readonly Placement<Id>[],
  perRow: 2 | 3,
): Placement<Id>[][] {
  const rows: Placement<Id>[][] = []
  for (const one of visible) {
    const last = rows.at(-1)
    if (one.width === 'half' && last?.[0].width === 'half' && last.length < perRow) last.push(one)
    else rows.push([one])
  }
  return rows
}

/**
 * *Monter* / *Descendre*, by row (Paul, 11/10/2026): a full card jumps a whole
 * row, so a row of halves (a pair, or a triple at three columns) moves as one
 * and is never split by a card passing through; a half swaps with the previous or next half in reading order,
 * skipping the full cards. Hidden cards keep their slots. `null` when there is
 * nowhere to go — the menu disables the item.
 */
export function moveBlock<Id extends string>(
  placements: readonly Placement<Id>[],
  id: Id,
  direction: -1 | 1,
  columns: 1 | 2 | 3 = 2,
): Placement<Id>[] | null {
  const visible = placements.filter((one) => !one.hidden)
  const moving = visible.find((one) => one.id === id)
  if (moving === undefined) return null

  let order: Placement<Id>[]
  if (moving.width === 'full') {
    const rows = rowsOf(visible, tracksPerRow(columns))
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

  return inSlots(placements, order)
}

/**
 * A card dragged onto another one, by the menu's rule (Paul, 11/10/2026): the
 * gesture has no rule of its own.
 *
 * - A full card goes between two rows, `side` of the row holding `overId`;
 *   never into the middle of a row of halves.
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
  columns: 1 | 2 | 3 = 2,
): Placement<Id>[] | null {
  const visible = placements.filter((one) => !one.hidden)
  const moving = visible.find((one) => one.id === activeId)
  const over = visible.find((one) => one.id === overId)
  if (moving === undefined || over === undefined || moving === over) return null

  let order: Placement<Id>[]
  if (moving.width === 'full') {
    // The rows as the menu sees them, with the card still in them: taking it
    // out first would regroup the halves on either side of it into new rows.
    const rows = rowsOf(visible, tracksPerRow(columns))
    const [row] = rows.splice(
      rows.findIndex((one) => one.includes(moving)),
      1,
    )
    const at = rows.findIndex((one) => one.includes(over))
    rows.splice(side === 'before' ? at : at + 1, 0, row)
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
  return inSlots(placements, order)
}

/** The visible cards in their new `order`, the hidden ones kept in their slots. */
function inSlots<Id extends string>(
  placements: readonly Placement<Id>[],
  order: readonly Placement<Id>[],
): Placement<Id>[] {
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
