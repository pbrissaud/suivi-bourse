/**
 * The shell: the sidebar, the content header bar, the one band, and the capped
 * content column. Everything that outlives a page.
 *
 * The `max-w-7xl` cap is kept as a **measured decision**, not as an
 * inheritance: uncapping gives the content 1 616 px at 1 920 (+31,2 %), a width
 * neither paying page — the twelve-slice allocation, the eight-column accounts
 * table — was ever judged at, and the dashboard head visibly loosens there
 * (ADR-0022). The known, uncorrected cost of the cap is the other way round:
 * above 1 536 px the content is off-centre, 472 px of margin on the left
 * against 216 on the right.
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
            column — the cap, and nothing else. */}
        <div className="mx-auto w-full max-w-7xl p-6">
          <Outlet />
        </div>
        {/* Mounted by the shell and not by a route: *first run* is a predicate,
            not a place, and it is as true on `/titres` as on `/` (#726). */}
        <FirstRun />
      </SidebarInset>
    </SidebarProvider>
  )
}
