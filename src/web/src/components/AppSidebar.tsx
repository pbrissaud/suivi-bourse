/**
 * The navigation (ADR-0022), and **width was never the question**.
 *
 * Measured on the real portfolio, a 256 px column costs the two decisions taken
 * at full width — the twelve-slice allocation and the eight-column accounts
 * table — nothing visible: 0 above 1 536 px, −7,8 % at 1 440, −20,8 % at the
 * worst realistic case (1 280), where twelve slices still sit in two columns of
 * six and eight columns neither truncate nor scroll. What separates the two
 * forms is **mechanical**: at 390 px the top bar loses its fourth route — it
 * overflows its row with no scroll and no drawer, taking the global indicator
 * with it.
 *
 * So: shadcn's `Sidebar`, `collapsible="icon"` when wide, a drawer under 768 px.
 * **Nothing is hand-written for the narrow case** — the rail, the drawer, the
 * ⌘B shortcut and the persisted state come with the component, which is what
 * removed the last open question instead of answering it.
 *
 * **It carries routes and nothing else since #829.** The status card at its
 * foot was the dot's *development where there was room*, back when the dot was
 * a colour and nothing more; the bell is not — it carries the count, it names
 * its state in its accessible name, and it opens onto a health card that says
 * that state in prose. The card was a fourth rendering of one fact, and it was
 * the one that vanished in the rail and in the drawer, which is to say on the
 * widths where a reader has least to look at (ADR-0037). The scrape cadence it
 * alone used to show was never health: it is a setting, and it is a field on
 * the settings page.
 *
 * **Five entries since ADR-0038, in three and two.** Settings left the data
 * page and the tab bar left with it, so the list grew — and it groups, because
 * a flat five that groups by nothing is worse than a three-and-two that groups
 * by one. The top is the **portfolio**, what the owner looks at; the foot is
 * what they *act on* — the ledger, where events are declared, corrected and
 * deleted, and the settings. The ledger has a claim to the top on that first
 * count and it is declined on the second, which is ADR-0038's own arbitration.
 */
import { Link, useRouterState } from '@tanstack/react-router'
import { CircleDollarSign, Database, LayoutDashboard, Settings, Wallet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { useT, type MessageKey } from '@/lib/i18n'

interface Entry {
  to: '/' | '/shares' | '/accounts' | '/ledger' | '/settings'
  label: MessageKey
  icon: LucideIcon
}

/** What the owner looks at. */
const PORTFOLIO: Entry[] = [
  { to: '/', label: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/shares', label: 'nav.shares', icon: CircleDollarSign },
  { to: '/accounts', label: 'nav.accounts', icon: Wallet },
]

/**
 * What the owner acts on — and the page is `Grand livre`, never *Registre*:
 * the concept has a word in `CONTEXT.md` and every French record uses it, so a
 * label inventing a second one puts two names on one thing (ADR-0038). The
 * source string is `Ledger`, English being decided first (ADR-0024).
 */
const WORKINGS: Entry[] = [
  { to: '/ledger', label: 'nav.ledger', icon: Database },
  { to: '/settings', label: 'nav.settings', icon: Settings },
]

export function AppSidebar() {
  const t = useT()
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  // **The five entries are five, at every N.** The accounts entry used to
  // disappear at one account, and the argument was the page's own: comparing one
  // term is not comparing. ADR-0028 made that page a master-detail — five blocks
  // about *one* account, four of which exist nowhere else — so at one account it
  // is not a degenerate comparison, it is the ordinary reading, and hiding it
  // would put the composition, the annualised rate, the dividends and the last
  // events out of reach of the install that has exactly one account, which is
  // most of them.

  return (
    <Sidebar collapsible="icon">
      {/* The drawing's own measurements: the column is padded 20 px down and
          12 px in, the wordmark row sits 8 px further in again, and 24 px
          separate it from the first route. Folded to the rail the two
          paddings meet in the middle, the badge being the only thing left. */}
      <SidebarHeader className="h-auto gap-0 px-5 pt-5 pb-6 group-data-[collapsible=icon]:px-3">
        <div className="flex items-center gap-2.5 group-data-[collapsible=icon]:justify-center">
          {/* The mark, which the app had nowhere: a mint tile carrying the
              product's initial, and the one place the brand is stated rather
              than spelled. It survives the fold where the wordmark cannot. */}
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-sidebar-primary text-lg font-bold text-sidebar-primary-foreground"
          >
            {t('app.name').slice(0, 1)}
          </span>
          <span className="truncate text-lg font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            {t('app.name')}
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {/* `flex-1`, so the group is as tall as the scroll area and the foot
            of the list is the foot of the column. */}
        <SidebarGroup className="flex-1 px-3 py-0 group-data-[collapsible=icon]:px-2">
          {/* The component ships divs; the landmark is the product's job, and
              it is what a screen reader — and a test — takes hold of. **One
              landmark over the two groups** and not one each: they are a
              grouping *inside* the navigation, and a screen reader offered two
              navigations would have to be told which is which — two names for
              one thing again, one level up. */}
          <nav aria-label={t('nav.label')} className="flex h-full flex-col">
            <SidebarMenu>
              {PORTFOLIO.map((entry) => (
                <NavEntry key={entry.to} entry={entry} pathname={pathname} />
              ))}
            </SidebarMenu>
            {/* The foot of the *list* rather than of the sidebar, which is what
                `mt-auto` buys: the two entries sit at the bottom of the column
                without a second menu having to know how tall the first one is.
                There is nothing under them any more — the status card left with
                #829. */}
            <SidebarMenu className="mt-auto pb-2.5">
              {WORKINGS.map((entry) => (
                <NavEntry key={entry.to} entry={entry} pathname={pathname} />
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}

function NavEntry({ entry, pathname }: { entry: Entry; pathname: string }) {
  const t = useT()
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip={t(entry.label)}
        // `exact` on the index only: without it "/" matches every path and two
        // entries light up at once.
        isActive={entry.to === '/' ? pathname === '/' : pathname.startsWith(entry.to)}
      >
        <Link to={entry.to}>
          <entry.icon />
          <span>{t(entry.label)}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
