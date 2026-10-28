/**
 * The content header bar — an **object of the product**, not a mount for a
 * trigger. It is on all five pages and carries the page's own name on the left,
 * beside the collapse trigger; the **search** and the **bell** on the right. The
 * reader's three preferences left it with #1276: they are set once, in
 * Settings › On this device.
 *
 * It exists because it is the one surface that survives the **three** sidebar
 * states: shadcn hides `SidebarMenuBadge` in icon mode, and the drawer takes
 * the whole navigation with it — so anything mounted in the column disappears
 * twice. That is also why the page's `<h1>` came up here (#789): a bar that
 * carried four controls and no name left the reader deducing which page they
 * were on from the navigation, which is exactly what the drawer takes away.
 */
import { Notifications } from '@/components/Notifications'
import { Palette } from '@/components/Palette'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { usePageHeadingValue } from '@/lib/pageHeading'

export function ContentHeader() {
  const { title, subtitle } = usePageHeadingValue()

  return (
    // 56 px tall and padded like the page under it — the drawing gives the bar
    // and the content column one gutter, 14 px on a phone, 20 from `md` and 24
    // from `lg`, so nothing in the header hangs off what is below it.
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3.5 md:px-5 lg:px-6">
      {/* No `aria-label` here: the trigger names itself from `header.toggleSidebar`
          — the vendored English was fixed in the component rather than covered
          over at this one call site, which left the rail and the drawer speaking
          English (#713). */}
      <SidebarTrigger />
      {/* An empty `<h1>` is worse than none, so the pair is drawn only once the
      page has declared it — one render, and never a blank heading.

      **Neither half is dropped by a breakpoint.** The subtitle is the instant
      the page's figures are of, and that mention exists to stop a reader
      reading them as *now* — a phone is where a stale figure is most likely to
      be read, not where the safeguard can be spared. So both truncate and
      neither hides: narrow degrades the sentence, it does not remove it.

      **But the title does not pay for it** (#787). The name is short and fixed,
      so it takes the room it needs and the sentence takes what is left. */}
      <div className="flex min-w-0 flex-col md:flex-row md:items-baseline md:gap-1.5">
        {title === '' ? null : <h1 className="shrink-0 text-prose font-medium">{title}</h1>}
        {/* **Under `md` it wraps to a second line, it is never hidden**
            (#1430). Beside the title at 390 px what was left of the sentence
            was `C.` (#838), so it was hidden — and with it the quote date and
            the Benchmark's period, which the header alone carries. Under the
            title it has the bar's width. From `md` it sits beside the name. */}
        {subtitle === null ? null : (
          <p className="truncate text-xs text-muted-foreground">
            <span aria-hidden="true" className="hidden md:inline">
              ·{' '}
            </span>
            {subtitle}
          </p>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {/* The visible half of the ⌘K palette (#797): a shortcut is not an
            interface on a phone, and this bar is where a control that belongs to
            no page lives. */}
        <Palette />
        <Notifications />
      </div>
    </header>
  )
}
