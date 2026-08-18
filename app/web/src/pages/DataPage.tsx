/**
 * The data page — **two tabs under one route** (#723, #724, ADR-0020).
 *
 * The word matters: a tab is not a page, so the product's cut at four pages
 * holds. And the line between the two is not *data against settings* but **what
 * the user declared** against **what the installation is** — ADR-0014's boot test
 * (can this be answered before the store opens?) transposed to the render.
 *
 * The import block, the export and the accounts declaration land under the first
 * tab with #728 and #729.
 *
 * Two things live here rather than in either tab, because they are about the
 * pair:
 *
 *  - **The badge counts unacknowledged notices and nothing else** (#724). Not
 *    the ephemeral store — a predicate that is never acknowledgeable would give
 *    a permanent badge, which is noise and takes down the notices that matter
 *    with it — not the orphan symbols, which are a choice and not a waste, and
 *    not the reconstruction, which has exactly one announcer and it is the
 *    banner. `lib/advisories.ts` holds that list, so the badge and the block it
 *    promises read the *same* one.
 *  - **The notice that names events leads to them.** The assumed-currency notice
 *    is the one with a gesture inside the app, and its subject is on the other
 *    tab — so the switch and the ledger's reduction are decided here, where both
 *    halves are in scope.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'

import { Installation } from '@/components/data/Installation'
import { Ledger } from '@/components/data/Ledger'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { unacknowledgedCount } from '@/lib/advisories'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

const LEDGER = 'ledger'
const INSTALLATION = 'installation'

export default function DataPage() {
  const { t } = useI18n()
  // **The hash names the tab**, which is what makes the two links that point at
  // it arrive somewhere (#726): the status dot — the only hold a trial user has
  // on *this container keeps nothing* once the modal is closed — and the
  // currency band's own gesture, whose whole reason to exist is to reach the
  // field. Both said `#installation` and both landed on the ledger, because
  // nothing here read it. A tab is not a route, so this is a hash and not a
  // path; and it is *read*, never written, so opening the other tab by hand
  // leaves the URL alone rather than pushing a history entry per click.
  const hash = useLocation({ select: (location) => location.hash })
  const [tab, setTab] = useState(hash === INSTALLATION ? INSTALLATION : LEDGER)

  // Read again on every change, not only at the mount: a reader already on
  // `/donnees` who clicks the status dot moves the hash without remounting the
  // page, and the initial state would never see it. What this deliberately does
  // **not** do is re-select the tab when the hash has not moved — following the
  // same link a second time after switching tab by hand leaves the reader where
  // they put themselves, which is the lesser of the two surprises.
  useEffect(() => {
    if (hash === INSTALLATION) setTab(INSTALLATION)
  }, [hash])
  // A fresh object per gesture, so asking twice for the same securities reduces
  // the ledger twice — the reader may well have cleared the reduction between
  // the two.
  const [focus, setFocus] = useState<{ symbols: readonly string[] } | undefined>(undefined)

  // Read here as well as inside the tab: the badge is on the trigger, which is
  // visible while the other tab is. One query key, so it is one request.
  const advisories = useQuery({ queryKey: ['advisories'], queryFn: api.advisories })
  // **An optional read, so the `?? []` survives** (ADR-0026): a badge at zero is
  // *not rendered at all*, so a read in flight takes an ornament off a tab
  // rather than making a claim — and the two tabs must be reachable while it
  // is in flight.
  const badge = unacknowledgedCount(advisories.data ?? [])

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('page.data')}</h1>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value={LEDGER}>{t('data.tab.ledger')}</TabsTrigger>
          <TabsTrigger value={INSTALLATION}>
            {t('data.tab.installation')}
            {badge > 0 ? (
              <span
                className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-attention/15 px-1.5 text-xs font-medium text-attention"
                aria-label={t('data.tab.installation.badge', { count: badge })}
              >
                {badge}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>
        <TabsContent value={LEDGER}>
          <Ledger focus={focus} />
        </TabsContent>
        <TabsContent value={INSTALLATION}>
          <Installation
            onShowInLedger={(symbols) => {
              setFocus({ symbols })
              setTab(LEDGER)
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
