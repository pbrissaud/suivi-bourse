/**
 * The navigation, and **width was never the question**.
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
 * So: shadcn's `Sidebar`, `collapsible="icon"` when wide, a drawer under 768
 * px. **Nothing is hand-written for the narrow case** — the rail, the drawer,
 * the ⌘B shortcut and the persisted state come with the component, which is
 * what removed the last open question instead of answering it.
 *
 * **It carries routes and nothing else since #829.** The status card at its
 * foot was the dot's *development where there was room*, back when the dot was
 * a colour and nothing more; the bell is not — it carries the count, it names
 * its state in its accessible name, and it opens onto a health card that says
 * that state in prose. The card was a fourth rendering of one fact, and it was
 * the one that vanished in the rail and in the drawer, which is to say on the
 * widths where a reader has least to look at. The scrape cadence it alone used
 * to show was never health: it is a setting, and it is a field on the settings
 * page.
 *
 * **Two groups, no label** (#1276). The top is what the owner reads and
 * records — the ledger, where events are declared, corrected and deleted,
 * included; the foot is the administration, System and Settings. The column is
 * 200 px, the width DESIGN.md always set, and its brand row is 56 px tall,
 * level with the header bar.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import {
  Server,
  CircleDollarSign,
  Database,
  LayoutDashboard,
  Scale,
  Settings,
  Sparkles,
  Wallet,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Mark } from '@/components/Mark'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { useAgentChat } from '@/features/agent/lib/agentChatProvider'
import { api } from '@/lib/api'
import { useT, type MessageKey } from '@/lib/i18n'

interface Entry {
  to: '/' | '/shares' | '/accounts' | '/benchmark' | '/agent' | '/ledger' | '/system' | '/settings'
  label: MessageKey
  icon: LucideIcon
}

/**
 * What the owner reads and records — and the ledger page is `Grand livre`,
 * never *Registre*: the concept has a word in `CONTEXT.md` and every French
 * record uses it, so a label inventing a second one puts two names on one
 * thing. The source string is `Ledger`, English being decided first.
 */
export const PORTFOLIO: Entry[] = [
  { to: '/', label: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/shares', label: 'nav.shares', icon: CircleDollarSign },
  { to: '/accounts', label: 'nav.accounts', icon: Wallet },
  { to: '/ledger', label: 'nav.ledger', icon: Database },
  { to: '/benchmark', label: 'nav.benchmark', icon: Scale },
  // Always there, the agent switched off included: the page says what to connect.
  { to: '/agent', label: 'nav.agent', icon: Sparkles },
]

/** The administration, pinned to the foot of the column. */
export const ADMINISTRATION: Entry[] = [
  { to: '/system', label: 'nav.system', icon: Server },
  { to: '/settings', label: 'nav.settings', icon: Settings },
]

export function AppSidebar() {
  const t = useT()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // The phone drawer is a modal over the page: once a page is chosen — by an
  // entry or by Back — it has done its job (#1375).
  const { setOpenMobile } = useSidebar()
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile])

  // **The eight entries are eight, at every N.** The accounts entry used to
  // disappear at one account, and the argument was the page's own: comparing
  // one term is not comparing. The comparison entry follows the same rule for
  // a stronger reason — it is a page whose whole purpose is to be reached
  // before there is anything on it, and the emptiness is where the choice is
  // made (#760).

  return (
    <Sidebar collapsible="icon">
      {/* 56 px tall, level with the header bar, and the wordmark centred in it.
          Folded to the rail the padding meets in the middle, the mark being
          the only thing left. */}
      <SidebarHeader className="h-14 justify-center gap-0 px-5 py-0 group-data-[collapsible=icon]:px-3">
        <div className="flex items-center gap-2.5 group-data-[collapsible=icon]:justify-center">
          {/* The mark (#1337): the one place the brand is drawn rather than
              spelled, and what survives the fold where the wordmark cannot —
              which stays for a screen reader, as `sr-only`. */}
          <Mark size={28} />
          <span className="truncate text-base font-semibold group-data-[collapsible=icon]:sr-only">
            {t('app.name')}
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {/* `flex-1`, so the group is as tall as the scroll area and the foot
            of the list is the foot of the column. */}
        <SidebarGroup className="flex-1 px-3 pt-2 pb-0 group-data-[collapsible=icon]:px-2">
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
              {ADMINISTRATION.map((entry) => (
                <NavEntry key={entry.to} entry={entry} pathname={pathname} />
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
      <BuildLine />
      <SidebarRail />
    </Sidebar>
  )
}

/**
 * The running build, small at the foot of the column: what a bug report copies.
 * Under it, a newer release when the server found one (#1237).
 */
function BuildLine() {
  const t = useT()
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const build = runtime.data?.build
  // Keyed on the version: an upgraded container never shows two that disagree.
  const release = useQuery({
    queryKey: ['release', build?.version],
    queryFn: api.release,
    enabled: build?.source === 'release',
  })
  const latest = release.data?.latest
  const shown = build?.version ?? build?.revision?.slice(0, 7)
  if (!build || !shown) return null
  return (
    <div className="mx-3 space-y-1 border-t px-2 pt-3 pb-4 text-2xs text-muted-foreground group-data-[collapsible=icon]:hidden">
      <p
        title={[t('installation.build.source', { source: build.source }), build.revision]
          .filter(Boolean)
          .join(' · ')}
      >
        {t('nav.version')} <span className="tabular">{shown}</span>
      </p>
      {latest ? (
        <a
          href={latest.url}
          target="_blank"
          rel="noreferrer"
          aria-label={t('nav.release.label', { version: latest.version })}
          className="tabular block w-fit rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t('nav.release', { version: latest.version })} <span aria-hidden="true">↗</span>
        </a>
      ) : null}
    </div>
  )
}

/**
 * Where a page entry leads. The agent's entry leads back to the conversation on
 * screen (#1196): `/agent` is a new thread, and starting one stops an answer
 * still streaming. Shared with the ⌘K palette, so the two cannot drift.
 */
export function pageLink(
  entry: Entry,
  chat: { id: string; messages: readonly unknown[] },
  pathname: string,
) {
  return entry.to === '/agent' && (chat.messages.length > 0 || pathname === `/agent/${chat.id}`)
    ? ({ to: '/agent/$threadId', params: { threadId: chat.id } } as const)
    : ({ to: entry.to } as const)
}

function NavEntry({ entry, pathname }: { entry: Entry; pathname: string }) {
  const t = useT()
  const { chat } = useAgentChat()
  const link = pageLink(entry, chat, pathname)
  // The pathname effect misses the entry of the page already shown: the route
  // does not change, so the click closes the drawer itself.
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip={t(entry.label)}
        // `exact` on the index only: without it "/" matches every path and two
        // entries light up at once.
        isActive={entry.to === '/' ? pathname === '/' : pathname.startsWith(entry.to)}
      >
        <Link {...link} onClick={() => setOpenMobile(false)}>
          <entry.icon />
          <span>{t(entry.label)}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
