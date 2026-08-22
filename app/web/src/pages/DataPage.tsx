/**
 * The data page — **three tabs under one route** (#794, ADR-0030).
 *
 * The word matters: a tab is not a page, so the product's cut at four pages
 * holds. ADR-0020 cut it in two — what the user *declared* against what the
 * installation *is* — and two things broke that arrangement. The **accounts
 * left the page** at #793, so the first half stopped being *what the owner
 * declared* and became the ledger and its provenance; and a **notice is
 * prose**, which a card in a column beside the store has nowhere to say.
 *
 * So: *the ledger* (what you declared, and where it came from), *the notices*
 * (what the app has to tell you), *the installation* (what it is).
 *
 * Two things live here rather than in any one tab, because they are about the
 * set:
 *
 *  - **The badge counts unacknowledged notices and nothing else** (#724), and
 *    it sits on the tab those notices are on. Not the ephemeral store — a
 *    predicate that is never acknowledgeable would give a permanent badge,
 *    which is noise and takes down the notices that matter with it — not the
 *    orphan symbols, which are a choice and not a waste, and not the
 *    reconstruction, which has exactly one announcer and it is the block the
 *    dot leads to. `lib/advisories.ts` holds that list, so the badge and the
 *    tab it promises read the *same* one.
 *  - **The notice that names events leads to them.** The assumed-currency
 *    notice is the one with a gesture inside the app, and its subject is on
 *    another tab — so the switch and the ledger's reduction are decided here,
 *    where both halves are in scope.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'

import { Installation } from '@/components/data/Installation'
import { Ledger } from '@/components/data/Ledger'
import { Notices } from '@/components/data/Notices'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { unacknowledgedCount } from '@/lib/advisories'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'

const LEDGER = 'ledger'
const NOTICES = 'notices'
const INSTALLATION = 'installation'

/**
 * The hashes that name a tab. Anything else lands on the ledger — and *anything*
 * includes `#toString`: a lookup table written as an object literal answers
 * `valueOf`, `hasOwnProperty` and `constructor` with **inherited functions**,
 * which are truthy, and a function reaching `useState` or a setter is read as an
 * initialiser or an updater and called. `/donnees#valueOf` took the route down
 * that way. A list and a membership test have no prototype to fall through to.
 */
const NAMED: readonly string[] = [NOTICES, INSTALLATION]

/** The tab a hash names, or the ledger. */
function tabNamed(hash: string): string {
  return NAMED.includes(hash) ? hash : LEDGER
}

export default function DataPage() {
  const { t } = useI18n()
  // **The hash names the tab**, which is what makes the two links that point at
  // it arrive somewhere (#726): the status dot — the only hold a trial user has
  // on *this container keeps nothing* once the modal is closed — and the
  // currency band's own gesture, whose whole reason to exist is to reach the
  // field. Both said `#installation` and both landed on the ledger, because
  // nothing here read it. A tab is not a route, so this is a hash and not a
  // path; and it is *read*, never written, so opening another tab by hand
  // leaves the URL alone rather than pushing a history entry per click.
  const hash = useLocation({ select: (location) => location.hash })
  const [tab, setTab] = useState(() => tabNamed(hash))

  // Read again on every change, not only at the mount: a reader already on
  // `/donnees` who clicks the status dot moves the hash without remounting the
  // page, and the initial state would never see it. What this deliberately does
  // **not** do is re-select the tab when the hash has not moved — following the
  // same link a second time after switching tab by hand leaves the reader where
  // they put themselves, which is the lesser of the two surprises.
  useEffect(() => {
    if (NAMED.includes(hash)) setTab(hash)
  }, [hash])
  // A fresh object per gesture, so asking twice for the same securities reduces
  // the ledger twice — the reader may well have cleared the reduction between
  // the two.
  const [focus, setFocus] = useState<{ symbols: readonly string[] } | undefined>(undefined)

  // Read here as well as inside the tab: the badge is on a trigger, which is
  // visible while another tab is. One query key, so it is one request.
  const advisories = useQuery({ queryKey: ['advisories'], queryFn: api.advisories })
  // **An optional read, so the `?? []` survives** (ADR-0026): a badge at zero is
  // *not rendered at all*, so a read in flight takes an ornament off a tab
  // rather than making a claim — and the three tabs must be reachable while it
  // is in flight.
  const badge = unacknowledgedCount(advisories.data ?? [])

  usePageHeading(t('page.data'))

  return (
    <div className="space-y-8">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value={LEDGER}>{t('data.tab.ledger')}</TabsTrigger>
          <TabsTrigger value={NOTICES}>
            {t('data.tab.notices')}
            {badge > 0 ? (
              <span
                className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-attention/15 px-1.5 text-xs font-medium text-attention"
                aria-label={t('data.tab.notices.badge', { count: badge })}
              >
                {badge}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value={INSTALLATION}>{t('data.tab.installation')}</TabsTrigger>
        </TabsList>
        <TabsContent value={LEDGER}>
          <Ledger focus={focus} />
        </TabsContent>
        <TabsContent value={NOTICES}>
          <Notices
            onShowInLedger={(symbols) => {
              setFocus({ symbols })
              setTab(LEDGER)
            }}
          />
        </TabsContent>
        <TabsContent value={INSTALLATION}>
          <Installation />
        </TabsContent>
      </Tabs>
    </div>
  )
}
