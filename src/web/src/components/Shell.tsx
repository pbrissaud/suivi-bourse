/**
 * The shell: the sidebar, the content header bar and the content column —
 * everything that outlives a page.
 *
 * **There is no band any more** (#829, ADR-0037). The strip at the top of the
 * column held three live conditions — a missing base currency, a running
 * reconstruction, a stopped scheduler — and it is retired rather than replaced:
 * they are entries of the notifications panel behind the header's bell, and the
 * *sentence* the band carried descends one floor, into the empty state of each
 * page it used to explain.
 *
 * **The column is uncapped** (ADR-0022, amended by #792). `max-w-7xl` was a
 * measured decision and its measurement expired: the two pages it was taken on
 * — the twelve-slice allocation and the eight-column accounts table — were
 * rebuilt into a plateau and deleted outright by the redesign, and the
 * dashboard head that *visibly loosened* at 1 616 px was rewritten in the same
 * session. What the cap did on the branch was the cost this file already
 * recorded and never corrected: nothing at all below 1 536 px, where the
 * sidebar has taken the width first, and above it an **off-centre** page —
 * 472 px of margin on the left against 216 on the right, `mx-auto` centring
 * inside a `SidebarInset` already offset by the column.
 *
 * Width is answered by **tracks and not by longer rows**: the dashboard and the
 * accounts page gain a column where there is room for one. The bound a dense
 * table wants at 2 560 px is that table's subject and not the shell's.
 *
 * **And the column may be narrower than what is in it** (#832). `SidebarInset`
 * is a flex item beside the navigation, so its `min-width` is `auto` — *never
 * smaller than my content* — and a table wider than the column therefore pushed
 * the column out instead of scrolling inside it. Measured on the shares page:
 * at 768 px the page overflowed by 256, at 976 px by 238, and the
 * `overflow-x-auto` that `components/ui/table.tsx` puts around every table did
 * nothing at all, its parent having grown to fit. `min-w-0` is the whole
 * repair, and it is the shell's rather than the table's: the same one line
 * governs every dense surface, and a floor of zero is what puts the scrollers
 * already written back in charge.
 */
import { Outlet } from '@tanstack/react-router'

import { AppSidebar } from '@/components/AppSidebar'
import { ContentHeader } from '@/components/ContentHeader'
import { FirstRun } from '@/components/FirstRun'
import { SIDEBAR_COOKIE_NAME, SidebarInset, SidebarProvider } from '@/components/ui/sidebar'

/**
 * **Reading back what the registry component already writes.**
 *
 * `SidebarProvider` stores the fold in a `sidebar_state` cookie on every
 * toggle, and never reads it: upstream is a Next.js component, where the cookie
 * is read on the server and handed down as `defaultOpen`. This app is a static
 * bundle Flask serves, so there is no server render to do that — the write
 * landed and nothing ever looked at it, and the fold was lost on every reload.
 *
 * So the read is the product's, and it is the **same cookie** rather than a
 * fourth `sb.*` key: the reader's preferences are three, one mechanism
 * (ADR-0024), and the fold of a menu is not one of them — it is chrome, it is
 * the component's own memory, and a second spelling of it here would leave two
 * places disagreeing about one menu the day the component's name for it moves.
 *
 * Absent, unreadable or anything but `false`, the navigation is open: the fold
 * is the choice, and *not remembered* has to fall back to the ordinary state.
 */
function navigationWasFolded(): boolean | null {
  try {
    const stored = document.cookie
      .split('; ')
      .find((entry) => entry.startsWith(`${SIDEBAR_COOKIE_NAME}=`))
    if (stored === undefined) return null
    return stored === `${SIDEBAR_COOKIE_NAME}=false`
  } catch {
    // A document that refuses cookies is not a reason to refuse a navigation.
    return null
  }
}

/**
 * **And where nothing was ever chosen, the width chooses** (#838).
 *
 * The drawing folds the navigation to its rail below 1 024 px and leaves it
 * open above — not as a breakpoint on the component, but as the *default* a
 * reader who has never pressed the toggle gets. That is the difference between
 * `null` and `false` above: a fold that was chosen is honoured at every width,
 * and one that was never chosen is the one the room decides. Under 768 px the
 * question does not arise — the navigation is a drawer there, and the component
 * owns that.
 */
const WIDE_ENOUGH_TO_LEAVE_IT_OPEN = 1024

function navigationOpens(): boolean {
  const folded = navigationWasFolded()
  return folded === null ? window.innerWidth >= WIDE_ENOUGH_TO_LEAVE_IT_OPEN : !folded
}

export function Shell() {
  return (
    <SidebarProvider defaultOpen={navigationOpens()}>
      <AppSidebar />
      {/* `min-w-0`, and it is not cosmetic — see the header comment: without it
          a table wider than the column takes the whole page sideways with it,
          and every `overflow-x-auto` under here is inert. */}
      <SidebarInset className="min-w-0">
        <ContentHeader />
        {/* `SidebarInset` is already the `<main>` landmark, so this is a plain
            column — the padding, and nothing else. `mx-auto` went with the cap:
            centring a column that fills its parent does nothing, and what it
            centred in was never the viewport. */}
        {/* The page's gutter is the header's, and it is the drawing's ladder:
            14 px on a phone, 20 from `md`, 28 from `lg`. */}
        <div className="w-full p-3.5 md:p-5 lg:p-7">
          <Outlet />
        </div>
        {/* Mounted by the shell and not by a route: *first run* is a predicate,
            not a place, and it is as true on `/shares` as on `/` (#726). */}
        <FirstRun />
      </SidebarInset>
    </SidebarProvider>
  )
}
