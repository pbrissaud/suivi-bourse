/**
 * What the dashboard's cards still share: the width a card is drawn at and
 * what it renders.
 *
 * The dashboard is fixed (DESIGN.md, decision of 7 Nov. 2026): there is no
 * registry of cards, no saved order and no hidden card any more.
 */

export type Width = 'half' | 'full'

/**
 * What a card renders, decided by the card itself (`xxxRenderState`):
 *
 * - `pending`: its read has not answered; its place is held.
 * - `renders`: data, an empty state or a failure — anything at all.
 * - `nothing`: it has nothing to say.
 */
export type RenderState = 'pending' | 'renders' | 'nothing'
