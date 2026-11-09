/**
 * The agent's text action (DESIGN.md › Text action): an action on a row or in a
 * footer that is not the row's main one is a 13 px `muted-foreground` link,
 * underlined (offset 3, `border` colour), `foreground` on hover. One class
 * string, since `index.css` is shared with the other chantiers.
 */
export const ACT =
  'inline-flex items-center gap-1.5 text-sm text-muted-foreground underline decoration-border underline-offset-3 hover:text-foreground hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50'

/** A value the reader may change, set in the sentence it belongs to. */
export const INLINE_LINK =
  'underline decoration-border underline-offset-3 hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'

/** A row of the rail: a thread, « Nouveau fil », « Statistiques ». */
export const RAIL_ROW =
  'flex min-h-9 items-center justify-between gap-2 rounded-lg px-2.5 text-md text-foreground hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-[current=page]:bg-background aria-[current=page]:font-medium'
