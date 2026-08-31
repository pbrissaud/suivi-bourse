/**
 * The ledger page — **one route, one thing, and no tab bar** (#794, #830,
 * ADR-0030, ADR-0037, ADR-0038).
 *
 * It held three tabs, then two, and now none. ADR-0020 cut it in two — what the
 * user *declared* against what the installation *is* — and the two halves left
 * one at a time: the **accounts** at #793, so the first half stopped being *what
 * the owner declared* and became the ledger; the **notices** at #829, into the
 * panel behind the header's bell, a notice being prose that a card in a column
 * beside the store has nowhere to say; and the **installation** here, to
 * `/settings`. What is left is *the ledger*, which is what the page is now
 * called — `Grand livre`, the word the glossary and every French record already
 * use, never a third one.
 *
 * **The hash goes with the bar it named.** `#installation` was an *address* on a
 * tab, read and never written, so a bookmark taken on that tab opened it; a tab
 * that no longer exists has no address to keep, and the surface it named has a
 * path of its own — which is the whole of what ADR-0038 bought. A hash typed by
 * hand now lands on the ledger, which is what every hash but that one already
 * did.
 *
 * The reduction the assumed-currency notice leads to is not composed here
 * either: it arrives as an **address** (`?symbol=`), because the card that asks
 * for it is mounted in the shell and reachable from all five routes.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'

import { Ledger, type LedgerFocus } from '@/components/data/Ledger'
import { useI18n } from '@/lib/i18n'
import { filtersFromSearch } from '@/lib/ledger'
import { usePageHeading } from '@/lib/pageHeading'

export default function DataPage() {
  const { t } = useI18n()
  // A fresh object per gesture, so asking twice for the same reduction reduces
  // the ledger twice — the reader may well have cleared it between the two.
  const [focus, setFocus] = useState<LedgerFocus | undefined>(undefined)
  // *Record an event*, armed from the ⌘K palette. Same rule, same shape.
  const [compose, setCompose] = useState<object | undefined>(undefined)

  // **The address, and the two species it carries** (#797). A *reduction* is one:
  // `q`, `type`, `account` and — since #810 — `since`/`until` are the ledger's
  // own dimensions under the names the export resource parses, so a reduced
  // ledger's address is the query string of its own export, and it survives a
  // reload the way `?account=` does two pages over. A *gesture* is not: `open`
  // arms the create form and is spent on arrival, because a form reopening on
  // every reload is a state nobody asked for twice.
  const search = useSearch({ from: '/ledger' })
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
    setFocus({ filters: reduction, named: true })
  }, [reduction])

  useEffect(() => {
    if (search.open !== 'event') return
    setCompose({})
    // Spent on arrival: what the address armed is about to happen, and an
    // address that went on saying so would arm it again on the next reload. The
    // *state* is spent too, down in the table — `onComposed` — so that a form
    // the reader has closed is not reopened by a prop still holding the
    // gesture. A reduction hand-typed beside it rides on: the palette never
    // sends both, and an address that carries the two means both.
    void navigate({
      to: '/ledger',
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
    search.open,
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
   * restore a reduction the reader has just lifted; and the `focus` prop, or a
   * later mount would restore it from a state the URL no longer describes.
   */
  const release = () => {
    setFocus(undefined)
    if (reduction === null) return
    void navigate({ to: '/ledger', search: {}, replace: true })
  }

  usePageHeading(t('page.ledger'))

  return (
    <div className="space-y-8">
      <Ledger
        focus={focus}
        compose={compose}
        // **The reader moved the reduction, so the address stops claiming
        // one.** Left in place it would restore, on the next reload, a
        // reduction they have just lifted — an address is a description of the
        // table, and this is the moment it stops being true of it.
        onReduced={release}
        // The arming is spent where it was made, so nothing reopens a form the
        // reader has closed.
        onComposed={() => setCompose(undefined)}
      />
    </div>
  )
}
