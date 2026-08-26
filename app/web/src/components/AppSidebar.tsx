/**
 * The navigation (ADR-0022), and **width was never the question**.
 *
 * Measured on the real portfolio, a 256 px column costs the two decisions taken
 * at full width — the twelve-slice allocation and the eight-column accounts
 * table — nothing visible: 0 above 1 536 px, −7,8 % at 1 440, −20,8 % at the
 * worst realistic case (1 280), where twelve slices still sit in two columns of
 * six and eight columns neither truncate nor scroll. What separates the two
 * forms is **mechanical**: at 390 px the top bar loses its fourth route — it
 * overflows its row with no scroll and no drawer, taking the status dot with it.
 *
 * So: shadcn's `Sidebar`, `collapsible="icon"` when wide, a drawer under 768 px.
 * **Nothing is hand-written for the narrow case** — the rail, the drawer, the
 * ⌘B shortcut and the persisted state come with the component, which is what
 * removed the last open question instead of answering it.
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
import { useQuery } from '@tanstack/react-query'
import { CircleDollarSign, Database, LayoutDashboard, Settings, Wallet } from 'lucide-react'
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
  to: '/' | '/titres' | '/comptes' | '/donnees' | '/reglages'
  label: MessageKey
  icon: LucideIcon
}

/** What the owner looks at. */
const PORTFOLIO: Entry[] = [
  { to: '/', label: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/titres', label: 'nav.shares', icon: CircleDollarSign },
  { to: '/comptes', label: 'nav.accounts', icon: Wallet },
]

/**
 * What the owner acts on — and the page is `Grand livre`, never *Registre*:
 * the concept has a word in `CONTEXT.md` and every French record uses it, so a
 * label inventing a second one puts two names on one thing (ADR-0038). The
 * source string is `Ledger`, English being decided first (ADR-0024).
 */
const WORKINGS: Entry[] = [
  { to: '/donnees', label: 'nav.ledger', icon: Database },
  { to: '/reglages', label: 'nav.settings', icon: Settings },
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
      <SidebarHeader className="h-12 justify-center px-4 group-data-[collapsible=icon]:px-2">
        <span className="truncate font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
          {t('app.name')}
        </span>
      </SidebarHeader>
      <SidebarContent>
        {/* `flex-1`, so the group is as tall as the scroll area and the foot
            of the list is the foot of the column. */}
        <SidebarGroup className="flex-1">
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
            {/* The foot of the list, not the foot of the sidebar: the status
                card lives there and it is not a route. `mt-auto` is what puts
                the two entries at the bottom of the column without a second
                menu having to know how tall the first one is. */}
            <SidebarMenu className="mt-auto">
              {WORKINGS.map((entry) => (
                <NavEntry key={entry.to} entry={entry} pathname={pathname} />
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
 *
 * It reads **the same route, through the same derivation, off the same tone
 * table** as the dot (#819). That is what *development* means here and it is a
 * rule rather than an economy: a card deciding for itself what *attention*
 * covers would be a second opinion on the reader's own installation, said one
 * column away from the first.
 */
function StatusCard() {
  const t = useT()
  const { state: sidebar, isMobile } = useSidebar()
  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
  const state = installationState({ health: health.data, error: health.error })

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
