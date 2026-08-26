/**
 * The ⌘K palette — **five sections, three of which read** (#797, ADR-0026).
 *
 * It is mounted in the content header bar, which is where the visible button
 * that opens it lives: a keyboard shortcut is not an interface on a phone, and
 * that bar is the one surface surviving the three sidebar states (ADR-0022).
 * One component holds both ways in, so they cannot drift apart.
 *
 * **It reads on open, and never on mount.** The three resources — the
 * positions, the accounts and the ledger — are armed by `enabled: open`, so a
 * page mounting pays nothing for a palette most sessions never open, and the
 * client's own thirty seconds of freshness (`main.tsx`) makes a second opening
 * free. That is the whole reason the reads sit here rather than in the shell.
 *
 * **The three sections that read are optional.** The palette opens with its
 * pages and its actions while all three are in flight, and a read that has not
 * landed **removes its section** instead of holding the surface — the case
 * ADR-0026 keeps `?? []` for, annotated at each of the three sites. What is not
 * said on a silence is the sentence about nothing matching: that one is a claim
 * about the reader's own portfolio, so it waits like any other claim.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { LucideIcon } from 'lucide-react'
import {
  CalendarDays,
  Coins,
  LayoutDashboard,
  Plus,
  Search,
  Settings,
  Table2,
  Wallet,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { TYPE_LABEL } from '@/components/data/LedgerTable'
import { api } from '@/lib/api'
import { declaredLabel, DEFAULT_ACCOUNT_LABEL } from '@/lib/accounts'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { identityOf, ledgerSearchOf } from '@/lib/ledger'
import { oneFailure, readConditions } from '@/lib/status'
import {
  accountsMatching,
  eventReduction,
  eventsMatching,
  heldTitles,
  matchesQuery,
  titlesMatching,
} from '@/lib/palette'

/**
 * The five pages, named by the catalogue that names them in the navigation: the
 * palette is a second way to the same five routes, never a second vocabulary —
 * which is why the settings arrived here the day ADR-0038 gave them an address,
 * and not a ticket later.
 */
const PAGES = [
  { to: '/', label: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/titres', label: 'nav.shares', icon: Coins },
  { to: '/comptes', label: 'nav.accounts', icon: Wallet },
  { to: '/donnees', label: 'nav.ledger', icon: Table2 },
  { to: '/reglages', label: 'nav.settings', icon: Settings },
] as const satisfies readonly { to: string; label: MessageKey; icon: LucideIcon }[]

/** One line of the palette: what it says, and what it does. */
interface Entry {
  key: string
  mark: ReactNode
  label: string
  hint: string | null
  run: () => void
}

export function Palette() {
  const { t } = useI18n()
  const f = useFormatters()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

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

  // **The three reads, armed by the opening.** The query keys are the pages'
  // own, so opening on a page that has already read the positions costs nothing
  // at all — and closing leaves the answers in the cache for the next opening.
  const positions = useQuery({ queryKey: ['positions'], queryFn: api.positions, enabled: open })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts, enabled: open })
  const events = useQuery({ queryKey: ['events'], queryFn: api.events, enabled: open })

  function leave(run: () => void) {
    setOpen(false)
    setQuery('')
    run()
  }

  // **The first of the three optional `?? []`** (ADR-0026): the positions absent
  // remove the titles section, they falsify no line of the four that remain.
  const titles = useMemo(() => heldTitles(positions.data?.positions ?? []), [positions.data])
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
  // And the third.
  const ledger = events.data ?? []

  // **An entry lands on an address of its own, and never on the one in force.**
  // The five sections are read over the whole portfolio, so a title reached from
  // a page reduced to one account has to be shown: carrying `?compte=` along
  // would open the sheet of a row that reduction removed — which is to say open
  // nothing at all, the palette's one entry that does nothing. What the reader
  // sees instead is the reduction lifted, on a page that says so where it says
  // it, which is the honest of the two silences.
  const shares: Entry[] = titlesMatching(titles, query).map((title) => ({
    key: title.symbol,
    mark: <span className="font-mono text-[10px]">{title.symbol.slice(0, 4)}</span>,
    label: title.name ?? title.symbol,
    hint: title.name === null ? null : title.symbol,
    run: () => leave(() => void navigate({ to: '/titres', search: { titre: title.symbol } })),
  }))

  const books: Entry[] = accountsMatching(named, query).map((account) => ({
    key: account.id,
    mark: <Wallet className="size-3.5" />,
    label: account.name,
    hint: account.name === account.id ? null : account.id,
    run: () => leave(() => void navigate({ to: '/comptes', search: { compte: account.id } })),
  }))

  const rows: Entry[] = eventsMatching(ledger, query).map((event, index) => {
    const identity = identityOf(event)
    return {
      key: `${event.date}-${index}`,
      mark: <CalendarDays className="size-3.5" />,
      label: identity.ticker ?? identity.label ?? t(TYPE_LABEL[event.event_type]),
      hint: `${t(TYPE_LABEL[event.event_type])} · ${f.date(event.date)}`,
      // **The reduction, and it is an address** — so the ledger it lands on can
      // name what it retains and offer the way out of it (`lib/palette.ts`).
      run: () =>
        leave(() =>
          void navigate({ to: '/donnees', search: ledgerSearchOf(eventReduction(event)) }),
        ),
    }
  })

  const pages: Entry[] = PAGES.filter((page) => matchesQuery(query, [t(page.label)])).map(
    (page) => ({
      key: page.to,
      mark: <page.icon className="size-3.5" />,
      label: t(page.label),
      hint: null,
      run: () => leave(() => void navigate({ to: page.to })),
    }),
  )

  const actions: Entry[] = ACTIONS.filter((action) =>
    matchesQuery(query, [t(action.label), t(action.keywords)]),
  ).map((action) => ({
    key: action.label,
    mark: <action.icon className="size-3.5" />,
    label: t(action.label),
    hint: null,
    run: () => leave(() => void navigate(action.go)),
  }))

  // What Enter in the field runs: the first entry drawn, whichever section it is
  // in. A palette answers a typed name; asking the reader to reach for the one
  // result they are already reading is a gesture for nothing.
  const foremost = [...shares, ...books, ...rows, ...pages, ...actions][0] ?? null

  // **A read that failed is neither in flight nor empty**, and it is the state
  // where a palette that only knew those two rendered a dialog with a field and
  // a blank body. The product's own vocabulary says why — `problemMessageKey`,
  // through the ordered list every page's band is built from — and it is a line
  // and not a `Refusal`: the page underneath keeps its own announcer, and what this
  // says is why a section is missing *here*.
  const failure = oneFailure(
    readConditions({ errors: [positions.error, accounts.error, events.error] }),
  )

  // **Every read has landed and nothing matched.** The one sentence here that is
  // a claim about the reader's data, so it is the one that waits: said while a
  // read hangs — or over one that came back an error — it would announce an
  // empty portfolio on something nobody has read.
  const landed =
    positions.data !== undefined && accounts.data !== undefined && events.data !== undefined
  const nothing = landed && query.trim() !== '' && foremost === null

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-2 px-2 text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <Search />
        {/* The word is the button's name at every width; the badge goes below
            `sm` and the word stays, a shortcut being the half of the pair a
            finger cannot use. */}
        <span>{t('palette.open')}</span>
        <span aria-hidden className="hidden rounded border px-1.5 font-mono text-[11px] sm:inline">
          {t('palette.shortcut')}
        </span>
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery('')
        }}
      >
        <DialogContent className="top-24 max-w-xl translate-y-0 gap-0 p-0">
          {/* The palette names itself for a screen reader and shows the name
              nowhere: the field says what the surface is for, and a heading over
              a search field is chrome in a surface whose whole subject is the
              handful of entries below it. */}
          <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('palette.description')}</DialogDescription>

          <div className="flex items-center gap-3 border-b px-4 py-3 pr-12">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <label htmlFor="palette-query" className="sr-only">
              {t('palette.title')}
            </label>
            <input
              id="palette-query"
              type="search"
              autoFocus
              value={query}
              placeholder={t('palette.placeholder')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // **Only over something typed.** An empty query matches
                // everything, so Enter on an untouched field would run the first
                // title the reader owns — a navigation nobody asked for, on the
                // most reflexive keystroke there is.
                if (event.key !== 'Enter' || query.trim() === '' || foremost === null) return
                event.preventDefault()
                foremost.run()
              }}
              className="min-w-0 grow bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-2">
            <Section title={t('palette.section.shares')} entries={shares} />
            <Section title={t('palette.section.accounts')} entries={books} />
            <Section title={t('palette.section.events')} entries={rows} />
            <Section title={t('palette.section.pages')} entries={pages} />
            <Section title={t('palette.section.actions')} entries={actions} />

            {failure === null ? null : (
              <p className="px-3 py-4 text-sm text-muted-foreground">{t(failure.message)}</p>
            )}

            {nothing ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
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
 * The two gestures the palette **arms**, and no third.
 *
 * An entry named after a gesture has to make it: *Saisir un événement* landing
 * the reader on the data page with the form shut would be a page entry wearing
 * an action's name. Each route takes the arming in its own address, and spends
 * it on arrival — a gesture is not an address, so nothing of it survives the
 * reload a reduction is built to survive.
 */
const ACTIONS = [
  {
    label: 'palette.action.event',
    keywords: 'palette.action.event.keywords',
    icon: Plus,
    go: { to: '/donnees', search: { ouvrir: 'evenement' } },
  },
  {
    label: 'palette.action.account',
    keywords: 'palette.action.account.keywords',
    icon: Plus,
    go: { to: '/comptes', search: { ouvrir: 'compte' } },
  },
] as const
// The literals are held by `t()` itself: a key that is in neither catalogue
// does not compile at the call site, which is what `MessageKey` is for.

/**
 * One section — and **a section with nothing in it does not exist**, heading
 * included (#724). That is what makes an absent read *remove* a section rather
 * than draw an empty one, which would be the hand-written skeleton this product
 * has none of.
 */
function Section({ title, entries }: { title: string; entries: readonly Entry[] }) {
  if (entries.length === 0) return null
  return (
    <div className="py-1">
      <p className="px-3 py-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </p>
      <ul aria-label={title}>
        {entries.map((entry) => (
          <li key={entry.key}>
            {/* A button and not a link: what an entry does is not always a
                place — two of them arm a gesture. */}
            <button
              type="button"
              onClick={entry.run}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted font-medium text-muted-foreground">
                {entry.mark}
              </span>
              <span className="min-w-0 grow truncate">{entry.label}</span>
              {entry.hint === null ? null : (
                <span className="shrink-0 text-xs text-muted-foreground">{entry.hint}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
