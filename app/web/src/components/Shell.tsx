/**
 * The shell: the sidebar, the content header bar, the one band, and the content
 * column. Everything that outlives a page.
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
 */
import { Outlet } from '@tanstack/react-router'

import { AppSidebar } from '@/components/AppSidebar'
import { Banner } from '@/components/Banner'
import { ContentHeader } from '@/components/ContentHeader'
import { FirstRun } from '@/components/FirstRun'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'

export function Shell() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <ContentHeader />
        {/* Inside the column and full width of it: mounted across the viewport
            its left edge would run behind the sidebar (ADR-0022). */}
        <Banner />
        {/* `SidebarInset` is already the `<main>` landmark, so this is a plain
            column — the padding, and nothing else. `mx-auto` went with the cap:
            centring a column that fills its parent does nothing, and what it
            centred in was never the viewport. */}
        <div className="w-full p-6">
          <Outlet />
        </div>
        {/* Mounted by the shell and not by a route: *first run* is a predicate,
            not a place, and it is as true on `/titres` as on `/` (#726). */}
        <FirstRun />
      </SidebarInset>
    </SidebarProvider>
  )
}
