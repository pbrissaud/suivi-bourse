/**
 * The ledger page — **two tabs under one route**, and it was three (#794,
 * ADR-0030, ADR-0037).
 *
 * The word matters: a tab is not a page, so the product's cut at five pages
 * holds. ADR-0020 cut it in two — what the user *declared* against what the
 * installation *is* — and two things broke that arrangement. The **accounts
 * left the page** at #793, so the first half stopped being *what the owner
 * declared* and became the ledger and the two gestures a file is the unit of;
 * and a **notice is prose**, which a card in a column beside the store has
 * nowhere to say.
 *
 * **The notices tab left with #829**, and with it the badge that sat on its
 * trigger. There is one global indicator in the app now and it is the header's
 * bell (ADR-0037): the installation facts are cards in its panel, beside the
 * health and the advisories, so a second count on a tab of one page would be
 * exactly the second badge ADR-0022 refused. What is left here is *the ledger*
 * and *the installation* — and the second of the two leaves with #830, which
 * takes the bar with it.
 *
 * The reduction the assumed-currency notice leads to is not composed here any
 * more either: it arrives as an **address** (`?symbol=`), because the card that
 * asks for it is mounted in the shell and reachable from all five routes.
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router'

import { Installation } from '@/components/data/Installation'
import { Ledger, type LedgerFocus } from '@/components/data/Ledger'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/lib/i18n'
import { filtersFromSearch } from '@/lib/ledger'
import { usePageHeading } from '@/lib/pageHeading'

const LEDGER = 'ledger'
const INSTALLATION = 'installation'

/**
 * The hashes that name a tab. Anything else lands on the ledger — and *anything*
 * includes `#toString`: a lookup table written as an object literal answers
 * `valueOf`, `hasOwnProperty` and `constructor` with **inherited functions**,
 * which are truthy, and a function reaching `useState` or a setter is read as an
 * initialiser or an updater and called. `/donnees#valueOf` took the route down
 * that way. A list and a membership test have no prototype to fall through to.
 */
const NAMED: readonly string[] = [INSTALLATION]

/** The tab a hash names, or the ledger. */
function tabNamed(hash: string): string {
  return NAMED.includes(hash) ? hash : LEDGER
}

export default function DataPage() {
  const { t } = useI18n()
  // **The hash names the tab** (#726). It arrived for two links that no longer
  // exist — the status dot and the currency band's own gesture, both retired by
  // #829 (ADR-0037), and the panel's cards land on `/reglages`, on an account or
  // on a reduced ledger instead. What is left is the reason the mechanism
  // outlives its producers: `#installation` is an **address**, so a bookmark
  // taken on that tab, or the hash typed by hand, opens it rather than silently
  // landing on the ledger. A tab is not a route, so this is a hash and not a
  // path; and it is *read*, never written, so opening another tab by hand
  // leaves the URL alone rather than pushing a history entry per click.
  const hash = useLocation({ select: (location) => location.hash })
  const [tab, setTab] = useState(() => tabNamed(hash))

  // Read again on every change, not only at the mount: a reader already on
  // `/donnees` who follows a link to that hash moves it without remounting the
  // page, and the initial state would never see it. What this deliberately does
  // **not** do is re-select the tab when the hash has not moved — following the
  // same link a second time after switching tab by hand leaves the reader where
  // they put themselves, which is the lesser of the two surprises.
  useEffect(() => {
    if (NAMED.includes(hash)) setTab(hash)
  }, [hash])
  // A fresh object per gesture, so asking twice for the same reduction reduces
  // the ledger twice — the reader may well have cleared it between the two.
  const [focus, setFocus] = useState<LedgerFocus | undefined>(undefined)
  // *Record an event*, armed from the ⌘K palette. Same rule, same shape.
  const [compose, setCompose] = useState<object | undefined>(undefined)

  // **The address, and the two species it carries** (#797). A *reduction* is one:
  // `q`, `type`, `account` and — since #810 — `since`/`until` are the ledger's
  // own dimensions under the names the export resource parses, so a reduced
  // ledger's address is the query string of its own export, and it survives a
  // reload the way `?compte=` does two pages over. A *gesture* is not: `ouvrir`
  // arms the create form and is spent on arrival, because a form reopening on
  // every reload is a state nobody asked for twice.
  const search = useSearch({ from: '/donnees' })
  const navigate = useNavigate()
  const reduction = useMemo(
    () =>
      filtersFromSearch({
        q: search.q,
        type: search.type,
        account: search.account,
        symbol: search.symbol,
        since: search.since,
        until: search.until,
      }),
    [search.q, search.type, search.account, search.symbol, search.since, search.until],
  )

  useEffect(() => {
    if (reduction === null) return
    // The subject of the reduction is on the first tab, wherever the reader was.
    setFocus({ filters: reduction, named: true })
    setTab(LEDGER)
  }, [reduction])

  useEffect(() => {
    if (search.ouvrir !== 'evenement') return
    setCompose({})
    setTab(LEDGER)
    // Spent on arrival: what the address armed is about to happen, and an
    // address that went on saying so would arm it again on the next reload. The
    // *state* is spent too, one tab down — `onComposed` — because Radix unmounts
    // the inactive tab and a prop still holding the gesture would reopen the
    // form on the way back. A reduction hand-typed beside it rides on: the
    // palette never sends both, and an address that carries the two means both.
    void navigate({
      to: '/donnees',
      search: {
        q: search.q,
        type: search.type,
        account: search.account,
        symbol: search.symbol,
        since: search.since,
        until: search.until,
      },
      replace: true,
    })
  }, [
    search.ouvrir,
    search.q,
    search.type,
    search.account,
    search.symbol,
    search.since,
    search.until,
    navigate,
  ])

  /**
   * **The address has stopped describing this table**, so it stops being one.
   *
   * Two things go, and both have to: the search parameters, or a reload would
   * restore a reduction the reader has just lifted; and the `focus` prop, or the
   * *next mount of the tab* would — Radix unmounts the inactive one, so a
   * reduction lifted and then left behind for the notices came back with its own
   * sentence over a table the URL no longer described.
   */
  const release = () => {
    setFocus(undefined)
    if (reduction === null) return
    void navigate({ to: '/donnees', search: {}, replace: true })
  }

  usePageHeading(t('page.ledger'))

  return (
    <div className="space-y-8">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value={LEDGER}>{t('data.tab.ledger')}</TabsTrigger>
          <TabsTrigger value={INSTALLATION}>{t('data.tab.installation')}</TabsTrigger>
        </TabsList>
        <TabsContent value={LEDGER}>
          <Ledger
            focus={focus}
            compose={compose}
            // **The reader moved the reduction, so the address stops claiming
            // one.** Left in place it would restore, on the next reload, a
            // reduction they have just lifted — an address is a description of
            // the table, and this is the moment it stops being true of it.
            onReduced={release}
            // The arming is spent where it was made, so a tab switched away from
            // and back to does not reopen a form the reader has closed.
            onComposed={() => setCompose(undefined)}
          />
        </TabsContent>
        <TabsContent value={INSTALLATION}>
          <Installation />
        </TabsContent>
      </Tabs>
    </div>
  )
}
