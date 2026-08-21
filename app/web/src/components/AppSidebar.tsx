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
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { STATE_TONE } from '@/components/StatusDot'
import { api } from '@/lib/api'
import { useT, type MessageKey } from '@/lib/i18n'
import { installationState } from '@/lib/status'
import { cn } from '@/lib/utils'

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
      <StatusCard />
      <SidebarRail />
    </Sidebar>
  )
}

/**
 * The **development** of the status dot, never its home (ADR-0022, #789).
 *
 * The dot is a colour and a link; this says the same fact in words, where there
 * is room for words. Which is exactly why it is not the dot's home: it is
 * absent in the two sidebar states that cannot hold it — the icon rail, where
 * shadcn hides anything with a label, and the drawer, which takes the whole
 * navigation behind a gesture — and the reader must not lose the state of their
 * installation by folding a menu.
 *
 * It is **absent while the read is in flight** as well (ADR-0026). `unknown` is
 * a real state of the dot, because a grey dot claims nothing; a sentence cannot
 * be grey, and *the installation state is unknown* written out in the sidebar
 * is a claim about the reader's install made before anybody looked.
 */
function StatusCard() {
  const t = useT()
  const { state: sidebar, isMobile } = useSidebar()
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const state = installationState({ runtime: runtime.data, error: runtime.error })

  if (isMobile || sidebar === 'collapsed' || state === 'unknown') return null

  return (
    <SidebarFooter>
      <div className="flex items-start gap-2.5 rounded-lg border bg-sidebar-accent/40 p-3">
        <span
          aria-hidden
          className={cn('mt-1.5 size-2 shrink-0 rounded-full', STATE_TONE[state])}
        />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{t('sidebar.status.title', { state })}</p>
          <p className="text-xs text-muted-foreground">{t('sidebar.status.body', { state })}</p>
        </div>
      </div>
    </SidebarFooter>
  )
}
