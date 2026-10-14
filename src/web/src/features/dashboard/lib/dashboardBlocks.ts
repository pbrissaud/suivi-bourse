/**
 * The dashboard's cards: the **only** list of them (eng review D2).
 *
 * The server stores a layout's shape and knows none of these ids — the Docker
 * build keeps the two halves apart, and a card the front does not know is
 * dropped by `normalizeLayout` on the way back in. So this file is the whole
 * registry, and a card joins the dashboard by joining it.
 *
 * **A card accepts the full width only if it shows more there** (Paul,
 * 11/10/2026): the movers go from five lines to ten, while the gain's bar and
 * the rhythm's twelve months only stretch, so those two are half-only. A card
 * with one width has no width choice in its menu, and so no reason to give.
 *
 * The order of the entries is the default order.
 */
import type { MessageKey } from '@/lib/i18n'

export type Width = 'half' | 'full'

export interface BlockSpec {
  /** The card's title, which is also how its menu is named. */
  label: MessageKey
  widths: readonly Width[]
  /** The width a card takes until the owner says otherwise. */
  width: Width
  /**
   * The height its place is held at while its read is in flight (design
   * review 3A), so the grid does not jump when the card lands.
   */
  minHeight: number
  /**
   * A card that arrives with a release after the first three: it lands
   * hidden, under *Nouveau* in edit mode, until a layout is saved with it in
   * (decisions D7 and 18A).
   */
  arrivesHidden?: boolean
}

export const DASHBOARD_BLOCKS = {
  'gain-breakdown': {
    label: 'dashboard.breakdown.title',
    widths: ['half'],
    width: 'half',
    minHeight: 260,
  },
  rhythm: {
    label: 'dashboard.rhythm.title',
    widths: ['half'],
    width: 'half',
    minHeight: 260,
  },
  movers: {
    label: 'dashboard.movers.title',
    widths: ['half', 'full'],
    width: 'full',
    minHeight: 300,
  },
} as const satisfies Record<string, BlockSpec>

export type BlockId = keyof typeof DASHBOARD_BLOCKS

export const BLOCK_IDS = Object.keys(DASHBOARD_BLOCKS) as BlockId[]

export function blockSpec(id: BlockId): BlockSpec {
  return DASHBOARD_BLOCKS[id]
}
