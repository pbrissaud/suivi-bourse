/**
 * The ⌘K palette (#797, « Relevé »): **a search line, then groups of 40 px rows**.
 *
 * Typed, it groups what matches — Titres, Comptes, Événements, Fils de l'agent,
 * then the Actions and the Pages that match. Untouched, it offers Récents (the
 * last titles and accounts reached from here), Actions and Pages. A row opens with
 * the icon of what it is, names the match in 600, says what it is in a sub-line
 * and puts its amount or its date in mono on the right.
 *
 * It is mounted in the content header bar, which is where the visible button
 * that opens it lives: a keyboard shortcut is not an interface on a phone, and
 * that bar is the one surface surviving the three sidebar states. One component
 * holds both ways in, so they cannot drift apart.
 *
 * **It reads on open, and never on mount.** The four resources — the
 * positions, the accounts, the ledger and the agent's threads — are armed by
 * `enabled: open`, so a page mounting pays nothing for a palette most sessions
 * never open, and the client's own thirty seconds of freshness (`main.tsx`)
 * makes a second opening free.
 *
 * **A read that has not landed removes its group** rather than holding the
 * surface: the optional `?? []` below are the acceptable ones. What is not said
 * on a silence is the sentence about nothing matching: that one is a claim about
 * the reader's own portfolio, so it waits like any other claim.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useQuery } from '@tanstack/react-query'
import {
  CircleDollarSign,
  Lock,
  MessageSquarePlus,
  Plus,
  Search,
  Sparkles,
  Upload,
  Wallet,
  Database,
  type LucideIcon,
} from 'lucide-react'

import { useAgentChat } from '@/features/agent/lib/agentChatProvider'
import { agentApi } from '@/features/agent/lib/api'
import { ADMINISTRATION, PORTFOLIO, pageLink } from '@/components/AppSidebar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useAuth } from '@/features/auth/components/AuthBoot'
import { authApi } from '@/features/auth/lib/api'
import { TYPE_LABEL } from '@/features/data/components/LedgerTable'
import { accountsApi } from '@/features/accounts/lib/api'
import { dataApi } from '@/features/data/lib/api'
import { sharesApi } from '@/features/shares/lib/api'
import { declaredLabel, DEFAULT_ACCOUNT_LABEL } from '@/features/accounts/lib/accounts'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import {
  accountOf,
  fold,
  identityOf,
  ledgerSearchOf,
  matchesQuery,
} from '@/features/data/lib/ledger'
import { oneFailure, readConditions } from '@/lib/status'
import { browserStorage, rememberPreference } from '@/lib/storage'
import {
  accountsMatching,
  eventReduction,
  eventsMatching,
  heldByAccount,
  heldTitles,
  titlesMatching,
} from '@/lib/palette'

// The sidebar's own two lists: a page added there is found here.
const PAGES = [...PORTFOLIO, ...ADMINISTRATION]

const RECENTS_KEY = 'suivibourse.palette.recents'
const RECENTS_SHOWN = 4

/** What the palette remembers of a title or an account it led to. */
interface Recent {
  kind: 'title' | 'account'
  id: string
}

function readRecents(): Recent[] {
  try {
    const parsed: unknown = JSON.parse(browserStorage()?.getItem(RECENTS_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Recent =>
            item !== null &&
            typeof item === 'object' &&
            (item.kind === 'title' || item.kind === 'account') &&
            typeof item.id === 'string',
        )
      : []
  } catch {
    return []
  }
}

/** One line of the palette: what it says, and what it does. */
interface Entry {
  key: string
  label: string
  /** What it is, under the label. */
  sub: string | null
  /** A figure in mono. */
  right: string | null
  icon: LucideIcon
  run: () => void
}

interface Group {
  key: string
  title: string
  entries: Entry[]
}

/** The label with the typed word in 600. Folding keeps the length: one base letter per letter. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const needle = fold(query.trim())
  const folded = fold(text)
  const at = needle === '' ? -1 : folded.indexOf(needle)
  if (at < 0 || folded.length !== text.length) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-inherit">
        {text.slice(at, at + needle.length)}
      </mark>
      {text.slice(at + needle.length)}
    </>
  )
}

/** The events whose amount leaves the account. */
const OUT = ['BUY', 'WITHDRAWAL']

export function Palette() {
  const { t } = useI18n()
  const f = useFormatters()
  const navigate = useNavigate()
  const auth = useAuth()
  const { chat, startThread } = useAgentChat()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [moved, setMoved] = useState(false)
  const [recents, setRecents] = useState<Recent[]>(readRecents)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // `Ctrl` alongside `⌘` rather than instead of it: the badge on the button
      // names one of the two, the shortcut answers to both, and one portfolio is
      // read from a Mac and from a Linux desktop by the same person.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // **The four reads, armed by the opening.** The query keys are the pages'
  // own, so opening on a page that has already read the positions costs nothing
  // at all — and closing leaves the answers in the cache for the next opening.
  const positions = useQuery({
    queryKey: ['positions'],
    queryFn: sharesApi.positions,
    enabled: open,
  })
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.accounts,
    enabled: open,
  })
  const events = useQuery({ queryKey: ['events'], queryFn: dataApi.events, enabled: open })
  // The agent is optional: its threads are a group when they answer, and no
  // failure of the palette when they do not.
  const threadsRead = useQuery({
    queryKey: ['agent-threads'],
    queryFn: agentApi.agentThreads,
    enabled: open,
  })

  function leave(run: () => void) {
    setOpen(false)
    setQuery('')
    run()
  }

  function remember(recent: Recent) {
    const next = [
      recent,
      ...recents.filter((r) => r.kind !== recent.kind || r.id !== recent.id),
    ].slice(0, RECENTS_SHOWN)
    setRecents(next)
    rememberPreference(RECENTS_KEY, JSON.stringify(next))
  }

  // **The first of the optional `?? []`**: the positions absent remove the
  // titles group, they falsify no line of the others.
  const held = positions.data?.positions
  const titles = useMemo(() => heldTitles(held ?? []), [held])
  const byAccount = useMemo(() => heldByAccount(held ?? []), [held])
  // The second. The name is the reader's fold — the seeded row reads its own
  // from the catalogue — so it is resolved here and matched on afterwards.
  const named = useMemo(
    () =>
      (accounts.data?.accounts ?? []).map((account) => ({
        id: account.id,
        name: declaredLabel(account) ?? t(DEFAULT_ACCOUNT_LABEL),
      })),
    [accounts.data, t],
  )
  const nameOf = new Map(named.map((account) => [account.id, account.name]))
  // And the third.
  const ledger = events.data ?? []
  const baseCurrency = positions.data?.base_currency ?? null
  const money = (value: number | null) =>
    value === null || baseCurrency === null ? null : f.currency(value, baseCurrency)

  // **An entry lands on an address of its own, and never on the one in force.**
  // The groups are read over the whole portfolio, so a title reached from a page
  // reduced to one account has to be shown: carrying `?account=` along would open
  // the sheet of a row that reduction removed — the palette's one entry that does
  // nothing.
  const titleEntry = (title: (typeof titles)[number]): Entry => ({
    key: `title:${title.symbol}`,
    label: title.name ?? title.symbol,
    // The sub-line is one sentence: it waits whole for the accounts' read,
    // an id not being an account's name.
    sub:
      accounts.data === undefined
        ? ''
        : [
            title.name === null ? null : title.symbol,
            ...title.accounts.map((id) => nameOf.get(id) ?? id),
          ]
            .filter((part) => part !== null)
            .join(' · '),
    right: money(title.value),
    icon: CircleDollarSign,
    run: () =>
      leave(() => {
        remember({ kind: 'title', id: title.symbol })
        void navigate({ to: '/shares', search: { symbol: title.symbol } })
      }),
  })

  const accountEntry = (account: { id: string; name: string }): Entry => {
    const holds = byAccount.get(account.id)
    return {
      key: `account:${account.id}`,
      label: account.name,
      // One sentence, waiting whole for the positions' read, like a title's.
      sub:
        positions.data === undefined
          ? ''
          : [
              t('palette.account.kind'),
              holds === undefined ? null : t('palette.account.titles', { count: holds.titles }),
            ]
              .filter((part) => part !== null)
              .join(' · '),
      right: money(holds?.value ?? null),
      icon: Wallet,
      run: () =>
        leave(() => {
          remember({ kind: 'account', id: account.id })
          void navigate({ to: '/accounts', search: { account: account.id } })
        }),
    }
  }

  // The amount is said in the base currency (the positions) and the account by
  // its declared name (the accounts): until both have answered or refused the
  // line would say less than it will, and a result should not change under the
  // reader's eye.
  const unread = [positions, accounts].some((read) => read.data === undefined && !read.isError)
  const eventEntries: Entry[] = (unread ? [] : eventsMatching(ledger, query)).map(
    (event, index) => {
      const identity = identityOf(event)
      const account = accountOf(event)
      const type = t(TYPE_LABEL[event.event_type])
      return {
        key: `event:${event.date}-${index}`,
        icon: Database,
        label: [identity.name ?? identity.ticker ?? identity.label, type]
          .filter((part) => part !== null)
          .join(' · '),
        // Date · account: the same dividend on the same day in two accounts must
        // not read, nor be named, twice.
        sub: [event.date === null ? null : f.date(event.date), nameOf.get(account) ?? account]
          .filter((part) => part !== null)
          .join(' · '),
        right:
          event.amount === null || baseCurrency === null
            ? null
            : f.signedCurrency(
                OUT.includes(event.event_type) ? -event.amount : event.amount,
                baseCurrency,
              ),
        // **The reduction, and it is an address** — so the ledger it lands on can
        // name what it retains and offer the way out of it (`lib/palette.ts`).
        run: () =>
          leave(
            () => void navigate({ to: '/ledger', search: ledgerSearchOf(eventReduction(event)) }),
          ),
      }
    },
  )

  const threadEntries: Entry[] = (threadsRead.data ?? [])
    .filter((thread) => thread.title !== null && matchesQuery(query, [thread.title]))
    .slice(0, 5)
    .map((thread) => ({
      key: `thread:${thread.id}`,
      label: thread.title ?? '',
      icon: Sparkles,
      sub: thread.updated_at === null ? null : f.date(thread.updated_at),
      right: null,
      run: () =>
        leave(() => void navigate({ to: '/agent/$threadId', params: { threadId: thread.id } })),
    }))

  const pages: Entry[] = PAGES.filter((page) => matchesQuery(query, [t(page.label)])).map(
    (page) => ({
      key: page.to,
      label: t(page.label),
      sub: null,
      right: null,
      icon: page.icon,
      run: () => leave(() => void navigate(pageLink(page, chat, pathname))),
    }),
  )

  const actions: Entry[] = ACTIONS.filter((action) =>
    matchesQuery(query, [t(action.label), t(action.keywords)]),
  ).map((action) => ({
    key: action.label,
    label: t(action.label),
    sub: null,
    right: null,
    icon: action.icon,
    run: () => leave(() => void navigate(action.go)),
  }))
  if (matchesQuery(query, [t('palette.action.thread'), t('palette.action.thread.keywords')])) {
    actions.push({
      key: 'palette.action.thread',
      label: t('palette.action.thread'),
      sub: null,
      right: null,
      icon: MessageSquarePlus,
      run: () =>
        leave(() => {
          startThread()
          void navigate({ to: '/agent' })
        }),
    })
  }
  // Locking exists only while a code does (#1203).
  if (
    auth.status.enabled &&
    matchesQuery(query, [t('palette.action.logout'), t('palette.action.logout.keywords')])
  ) {
    actions.push({
      key: 'palette.action.logout',
      label: t('palette.action.logout'),
      sub: null,
      right: null,
      icon: Lock,
      run: () =>
        leave(
          () =>
            void authApi
              .logout()
              .then(auth.signedOut)
              .catch(() => toast.error(t('palette.action.logout.failed'))),
        ),
    })
  }

  const typed = query.trim() !== ''
  const recentEntries: Entry[] = recents.flatMap((recent) => {
    if (recent.kind === 'title') {
      const title = titles.find((candidate) => candidate.symbol === recent.id)
      return title === undefined ? [] : [titleEntry(title)]
    }
    const account = named.find((candidate) => candidate.id === recent.id)
    return account === undefined ? [] : [accountEntry(account)]
  })

  const group = (key: MessageKey, entries: Entry[]): Group[] =>
    entries.length === 0 ? [] : [{ key, title: t(key), entries }]
  const groups: Group[] = typed
    ? [
        ...group('palette.group.titles', titlesMatching(titles, query).map(titleEntry)),
        ...group('palette.group.accounts', accountsMatching(named, query).map(accountEntry)),
        ...group('palette.group.events', eventEntries),
        ...group('palette.group.threads', threadEntries),
        ...group('palette.group.actions', actions),
        ...group('palette.group.pages', pages),
      ]
    : [
        ...group('palette.group.recent', recentEntries),
        ...group('palette.group.actions', actions),
        ...group('palette.group.pages', pages),
      ]
  const flat = groups.flatMap((entry) => entry.entries)
  const current = Math.min(active, Math.max(flat.length - 1, 0))
  // A highlight over an untouched field would promise an Enter that does
  // nothing (below), so there is none until something is typed or moved.
  const highlighted = typed || moved ? flat[current] : undefined

  useEffect(() => {
    list.current?.querySelector('[data-on]')?.scrollIntoView?.({ block: 'nearest' })
  }, [current, moved, query])

  // **A read that failed is neither in flight nor empty**, and it is the state
  // where a palette that only knew those two rendered a dialog with a field and
  // a blank body. The product's own vocabulary says why — `problemMessageKey`,
  // through the ordered list every surface's failed reads are folded by.
  const failure = oneFailure(readConditions({ queries: [positions, accounts, events] }))

  // **Every read has landed and nothing matched.** The one sentence here that is
  // a claim about the reader's data, so it is the one that waits.
  const landed =
    positions.data !== undefined && accounts.data !== undefined && events.data !== undefined
  const nothing = landed && typed && flat.length === 0

  return (
    <>
      {/* **A field, not a word** (#838): the visible way in, from `lg`; below
          that a flat icon like the bell beside it, since a frame around a lone
          icon says nothing the icon does not. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('palette.open.label')}
        className="size-8 rounded-lg text-muted-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11 lg:h-8.5 lg:w-50 lg:justify-start lg:gap-2.5 lg:border lg:border-input lg:bg-card lg:pr-2 lg:pl-2.5 xl:w-70"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
        <span className="hidden min-w-0 truncate text-sm lg:inline">{t('palette.open')}</span>
        <span
          aria-hidden
          className="ml-auto hidden shrink-0 rounded-sm border px-1.25 py-px fig text-xs lg:inline"
        >
          {t('palette.shortcut')}
        </span>
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) {
            setQuery('')
            setActive(0)
            setMoved(false)
          }
        }}
      >
        <DialogContent showCloseButton={false} className="top-24 max-w-150 translate-y-0 gap-0 p-0">
          {/* The palette names itself for a screen reader and shows the name
              nowhere: the field says what the surface is for. */}
          <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('palette.description')}</DialogDescription>

          <div className="flex items-center gap-2.5 border-b px-4.5 py-3.5">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <label htmlFor="palette-query" className="sr-only">
              {t('palette.title')}
            </label>
            <input
              id="palette-query"
              type="search"
              autoFocus
              value={query}
              placeholder={t('palette.placeholder')}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  setMoved(true)
                  const step = event.key === 'ArrowDown' ? 1 : -1
                  setActive(Math.min(Math.max(current + step, 0), Math.max(flat.length - 1, 0)))
                  return
                }
                // **Only over something typed, or moved to.** An empty query
                // matches everything, so Enter on an untouched field would run
                // the first entry — a navigation nobody asked for, on the most
                // reflexive keystroke there is.
                if (event.key !== 'Enter' || highlighted === undefined) return
                event.preventDefault()
                highlighted.run()
              }}
              className="min-w-0 grow bg-transparent text-lg outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
            <kbd
              aria-hidden
              className="rounded-sm border px-1.25 py-px font-sans text-xs text-muted-foreground"
            >
              esc
            </kbd>
          </div>

          <div ref={list} className="max-h-130 overflow-y-auto px-2 pt-1.5 pb-2.5">
            {groups.map((entry) => (
              <Section
                key={entry.key}
                title={entry.title}
                entries={entry.entries}
                query={query}
                on={highlighted}
              />
            ))}

            {failure === null ? null : (
              <p className="px-2.5 py-4 text-muted-foreground">{t(failure.message)}</p>
            )}

            {nothing ? (
              <p className="px-2.5 py-7 text-center text-muted-foreground">
                {t('palette.empty', { query: query.trim() })}
              </p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * The gestures the palette **arms**. An entry named after a gesture has to make
 * it: *Saisir un événement* landing the reader on the ledger with the form shut
 * would be a page entry wearing an action's name. Each route takes the arming
 * in its own address, and spends it on arrival.
 */
const ACTIONS = [
  {
    label: 'palette.action.event',
    keywords: 'palette.action.event.keywords',
    go: { to: '/ledger', search: { open: 'event' } },
    icon: Plus,
  },
  {
    label: 'palette.action.import',
    keywords: 'palette.action.import.keywords',
    go: { to: '/ledger/import' },
    icon: Upload,
  },
  {
    label: 'palette.action.account',
    keywords: 'palette.action.account.keywords',
    go: { to: '/accounts', search: { open: 'account' } },
    icon: Wallet,
  },
] as const

/**
 * One group — and **a group with nothing in it does not exist**, heading
 * included (#724): an absent read *removes* a group rather than drawing an
 * empty one.
 */
function Section({
  title,
  entries,
  query,
  on,
}: {
  title: string
  entries: readonly Entry[]
  query: string
  on: Entry | undefined
}) {
  return (
    <div>
      <p className="label px-2.5 pt-2.5 pb-1">{title}</p>
      <ul aria-label={title}>
        {entries.map((entry) => (
          <li key={entry.key}>
            {/* A button and not a link: what an entry does is not always a
                place — two of them arm a gesture. */}
            <button
              type="button"
              onClick={entry.run}
              data-on={entry === on ? '' : undefined}
              className="grid min-h-10 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2.5 text-left text-md hover:bg-muted focus-visible:bg-muted focus-visible:outline-none data-on:bg-muted"
            >
              <entry.icon aria-hidden className="size-4 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">
                  <Highlighted text={entry.label} query={query} />
                </span>
                {entry.sub === null || entry.sub === '' ? null : (
                  <span className="truncate text-xs text-muted-foreground">{entry.sub}</span>
                )}
              </span>
              {entry.right === null ? null : (
                <span className="fig text-xs text-muted-foreground">{entry.right}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
