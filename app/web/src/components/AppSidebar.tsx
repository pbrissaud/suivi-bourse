/**
 * The navigation (ADR-0022), and **width was never the question**.
 *
 * Measured on the real portfolio, a 256 px column costs the two decisions taken
 * at full width — the twelve-slice allocation and the eight-column accounts
 * table — nothing visible: 0 above 1 536 px, −7,8 % at 1 440, −20,8 % at the
 * worst realistic case (1 280), where twelve slices still sit in two columns of
 * six and eight columns neither truncate nor scroll. What separates the two
 * forms is **mechanical**: at 390 px the top bar loses the *Données* route — it
 * overflows its row with no scroll and no drawer, taking the status dot with it.
 *
 * So: shadcn's `Sidebar`, `collapsible="icon"` when wide, a drawer under 768 px.
 * **Nothing is hand-written for the narrow case** — the rail, the drawer, the
 * ⌘B shortcut and the persisted state come with the component, which is what
 * removed the last open question instead of answering it.
 */
import { Link, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { CircleDollarSign, Database, LayoutDashboard, Wallet } from 'lucide-react'
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
import { api } from '@/lib/api'
import { useT, type MessageKey } from '@/lib/i18n'

interface Entry {
  to: '/' | '/titres' | '/comptes' | '/donnees'
  label: MessageKey
  icon: LucideIcon
}

const ENTRIES: Entry[] = [
  { to: '/', label: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/titres', label: 'nav.shares', icon: CircleDollarSign },
  { to: '/comptes', label: 'nav.accounts', icon: Wallet },
  { to: '/donnees', label: 'nav.data', icon: Database },
]

export function AppSidebar() {
  const t = useT()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })

  // At N = 1 the accounts page leaves the **navigation** — comparing one term is
  // not comparing — and never the **route**: a bookmark valid yesterday costs a
  // 404 for nothing. Written as "hide when we know there is exactly one" rather
  // than "show when we know there are several", so an unanswered query leaves
  // the navigation whole instead of quietly losing an entry.
  const single = accounts.data?.accounts.length === 1
  const entries = ENTRIES.filter((entry) => entry.to !== '/comptes' || !single)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-12 justify-center px-4 group-data-[collapsible=icon]:px-2">
        <span className="truncate font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
          {t('app.name')}
        </span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          {/* The component ships divs; the landmark is the product's job, and
              it is what a screen reader — and a test — takes hold of. */}
          <nav aria-label={t('nav.label')}>
            <SidebarMenu>
              {entries.map((entry) => (
                <SidebarMenuItem key={entry.to}>
                  <SidebarMenuButton
                    asChild
                    tooltip={t(entry.label)}
                    // `exact` on the index only: without it "/" matches every
                    // path and two entries light up at once.
                    isActive={entry.to === '/' ? pathname === '/' : pathname.startsWith(entry.to)}
                  >
                    <Link to={entry.to}>
                      <entry.icon />
                      <span>{t(entry.label)}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
