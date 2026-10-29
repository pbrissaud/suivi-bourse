/**
 * The product's mark (#1337, DESIGN.md › Components › Mark): two strokes leave the
 * same point on a `sidebar-primary` tile, the portfolio's value (a solid line ending
 * on a dot) rising away from the net contributions (dotted). It is the dashboard
 * chart in one gesture, and the gap between the two is the wealth built.
 *
 * It owns no colour: the tile is `sidebar-primary`, both strokes `currentColor`
 * set to `sidebar-primary-foreground`, so a replacement theme repaints it. The
 * favicon (`public/favicon.svg`) is the one copy that cannot, a browser tab
 * reading no CSS variable.
 *
 * Under 24 px dots stop reading: the strokes thicken, the contributions become a
 * faint solid line, and the favicon is drawn from this variant.
 */
export function Mark({ size = 28 }: { size?: number }) {
  const small = size < 24
  return (
    <svg
      aria-hidden
      viewBox="0 0 28 28"
      width={size}
      height={size}
      className="shrink-0 text-sidebar-primary-foreground"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={small ? 2.6 : 1.8}
    >
      {/* radius 8 of 28: the buttons' `radius-md` at the sidebar's size. */}
      <rect width="28" height="28" rx="8" className="fill-sidebar-primary stroke-none" />
      <path
        d="M7 21 21 18"
        strokeOpacity={small ? 0.45 : 0.6}
        strokeDasharray={small ? undefined : '0.1 3.2'}
        strokeWidth={small ? 2.6 : 2}
      />
      <path d="M7 21 12.5 14.5 15.5 16 21 8" />
      <circle cx="21" cy="8" r={small ? 2.6 : 2.2} fill="currentColor" stroke="none" />
    </svg>
  )
}
