/**
 * The accounts page — **master-detail, in read only** (ADR-0028, ADR-0026).
 *
 * The eight-column table is gone. ADR-0019 built it to answer *which of my
 * accounts is working* and that question moved to the dashboard's accounts card
 * with its one range control; what is here now is the other question — *what is
 * in this one* — which eight columns could never have answered.
 *
 * Four page-level objects, and each is a decision:
 *
 *  - **The rail is the master, and it carries the weights.** It is sticky, so
 *    the way into another account does not scroll off the top of a detail five
 *    blocks long.
 *  - **Which account is open is a URL** (`?compte=`), the same reduction the
 *    shares page carries and for the same three reasons: it survives a reload,
 *    it can be handed to somebody else, and the way out is the browser's own
 *    back button. An id naming nothing falls back to the first declared account
 *    rather than to an empty page.
 *  - **One mention of the date**, at the level of the page — the money figures
 *    are a **day**, and a page of money with no date reads as *now*. The window
 *    is not written in words anywhere: the detail's range control carries it,
 *    and a sentence repeating it would be a second announcer.
 *  - **A failed read is said where its content would have been** (#829,
 *    ADR-0037). There is no band and no strip at the top of the column: the
 *    declaration is what the page is *made of*, so a refusal on it empties the
 *    page and the page says why; the four other reads compose the **detail**,
 *    so a refusal on one of those leaves the rail standing and says why the
 *    detail is not there. Rendering nothing would make *the store is
 *    unreadable* and *you own nothing yet* the same screen.
 *
 * **And the declaration lives here** (#793, ADR-0028): declared from the rail,
 * renamed and removed from the panel the account's own name opens. The panel is
 * the page's, not the rail's and not the detail's, because both open it — and a
 * component mounted twice would be two panels, one of which the reader cannot
 * see closing.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { AccountDetail } from '@/components/accounts/AccountDetail'
import { AccountForm } from '@/components/accounts/AccountForm'
import { AccountsRail } from '@/components/accounts/AccountsRail'
import { Unreadable } from '@/components/Unreadable'
import { EmptyState } from '@/components/EmptyState'
import { NoBaseCurrency } from '@/components/NoBaseCurrency'
import { Button } from '@/components/ui/button'
import {
  buildAccountRows,
  chooseAccount,
  reassignmentOf,
  removalOf,
  DEFAULT_ACCOUNT_ID,
} from '@/lib/accounts'
import { accountOf } from '@/lib/ledger'
import { api, type Account, type LedgerEvent, type PerfPoint, type Position } from '@/lib/api'
import { currencyUnanswered } from '@/lib/firstRun'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { oneFailure, readConditions } from '@/lib/status'

export default function AccountsPage() {
  const { t } = useI18n()
  const { compte, ouvrir } = useSearch({ from: '/comptes' })
  const navigate = useNavigate()
  // `undefined` is *the panel is shut*; `null` is *open on a declaration*; an
  // account is *open on that account*. Three states, the ledger's three.
  const [editing, setEditing] = useState<Account | null | undefined>(undefined)

  // **The declaration, armed from the ⌘K palette** (#797). An entry named
  // *declare an account* has to open the declaration, or it is a page entry
  // wearing an action's name — and unlike the reduction one page over, the
  // arming is **spent on arrival**: a gesture is not an address, so a reload
  // must not make it again.
  useEffect(() => {
    if (ouvrir !== 'compte') return
    setEditing(null)
    void navigate({ to: '/comptes', search: { compte }, replace: true })
  }, [ouvrir, compte, navigate])

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: api.portfolioTotals })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const positions = useQuery({ queryKey: ['positions'], queryFn: api.positions })
  const events = useQuery({ queryKey: ['events'], queryFn: api.events })
  // The same read the bell and the first-run modal compose their own
  // predicates from — one query key, so it is one request and no new API state.
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  // **The reading, and not the inventory** (#829, ADR-0037). The panel asks
  // what is left to act on and drops an advisory the owner has put to sleep;
  // the chip beside the figure asks what is *true of this account*, and thirty
  // days of *not now* changes nothing about the cash sitting in it. Read under
  // the panel's own key, acknowledging in the panel took the chip out with the
  // card — one gesture, two surfaces, and the distinction the record draws with
  // nothing to show for it.
  const advisories = useQuery({
    queryKey: ['advisories', 'standing'],
    queryFn: api.standingAdvisories,
  })

  const declared = accounts.data?.accounts ?? []
  const rows = buildAccountRows(declared)
  const opened = chooseAccount(rows, compte)

  // **One read per opened account, and only for the one that is open.** The
  // series is some two and a half thousand days long, and the rail owes it
  // nothing: what the rail draws is a share of a total on a stated day, not a
  // window. Read whole, because the longest range the detail offers is the
  // account's own opening and only the series says when that was.
  const history = useQuery({
    queryKey: ['account-history', opened?.id],
    queryFn: () => api.accountHistory(opened!.id),
    enabled: opened !== null,
  })

  // **What empties the page and what empties the detail are two lists.** The
  // declaration is the page: without it there is no rail, no selection and no
  // detail, so a refusal there is the page's own sentence. The four others are
  // what the detail is composed of — a ledger that would not answer must not
  // take the rail with it, which is the whole of why this is not one condition.
  const pageFailure = oneFailure(readConditions({ errors: [accounts.error] }))
  const detailFailures = {
    positions: oneFailure(readConditions({ errors: [positions.error, totals.error] })),
    points: oneFailure(readConditions({ errors: [history.error] })),
    events: oneFailure(readConditions({ errors: [events.error] })),
  }

  const currency = totals.data?.base_currency ?? null
  // `?? null` and never `?? []`: an empty payload is a **fact** about the
  // reader's data and a request in flight is not one (ADR-0026). The three
  // flattenings are here because this is where the reads are.
  const heldPositions: readonly Position[] | null = positions.data?.positions ?? null
  const ledger: readonly LedgerEvent[] | null = events.data ?? null
  const series: readonly PerfPoint[] | null = history.data?.points ?? null

  // The reassignment, composed once for the page: its **standing** half goes to
  // the seeded account's detail and its **first declaration** half rides in the
  // panel, and the two are one function so they cannot disagree about whether
  // there is anything to move.
  //
  // `?? []` is the legitimate one ADR-0026 leaves open: an absent read removes
  // the offer instead of falsifying it, and claiming there are unassigned events
  // before the ledger has answered would be the opposite mistake.
  const offer = reassignmentOf(accounts.data, ledger ?? [])

  // **The page's name, and nothing beside it** (#787).
  //
  // It carried *« Chiffres arrêtés au 22 août 2026 »* since #721, on the
  // argument that these figures are a **day** and that a page of money with no
  // date reads as *now*. The argument was right about the risk and wrong about
  // the answer, because the product answers it better elsewhere — and since
  // #829 (ADR-0037) it answers it in **one** place, which is the bell:
  //
  //  - its **icon carries the health colour**, so whether the installation is
  //    reading quotes and rebuilding history on its cadence is one glance;
  //  - its **panel** holds the reconstruction as a pinned card, saying that it
  //    is running and how far it has got — the sentence the retired band used
  //    to carry across the top of this page.
  //
  // Between them there is no state left for the date to report. The perf cycle
  // writes today's row every two minutes while the scheduler runs — weekends
  // included, the series being daily — so with the bell green and no
  // reconstruction card the day *is* today, on every install, always. A mention
  // that is constant is not a safeguard; it is a word in the one line that
  // carries the page's name, and on a phone it took that name down with it.
  //
  // What remains true is the risk it named. What answers it now is the bell,
  // which is the surface built for exactly that question.
  usePageHeading(t('page.accounts'))

  // **The band's sentence, one floor down** (#829, ADR-0037). With no reporting
  // currency nothing is converted and the perf job writes nothing at all, so
  // this page would be a column of em dashes with no reason given anywhere. It
  // says why instead, and the ledger — where the events are *declared* — stays
  // readable throughout.
  //
  // `=== true` and never a truthy test: `undefined` is *the config has not
  // landed*, and a page emptied on a silence would be the claim ADR-0026
  // forbids.
  if (currencyUnanswered(config.data?.settings) === true) {
    return <NoBaseCurrency />
  }

  // **The declaration is what this page is made of**, so its refusal is the
  // page's own emptiness and is said as one (#829, ADR-0037).
  if (pageFailure !== null) {
    return <Unreadable failure={pageFailure} />
  }

  return (
    <div className="space-y-6">
      {/* A read that has not landed is not a fact: nothing is claimed while the
          declaration is in flight, and above all not that there is none. */}
      {!accounts.data ? null : opened === null ? (
        // A state `/api/accounts` does not produce — ADR-0013 gives every
        // install one account and the resource publishes the seeded row while
        // nothing else is declared — so the sentence says that rather than
        // *you have none*, and the one way out is the declaration itself. It
        // used to send the reader to the data page, which is where the form
        // was until #793.
        <EmptyState
          title={t('accounts.empty.title')}
          description={t('accounts.empty.body')}
          action={
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              {t('accounts.new')}
            </Button>
          }
        />
      ) : (
        // Two tracks from `lg`, one below it: at the width ADR-0022 measured as
        // the worst realistic case the page is the **stacked** one and cannot
        // overflow sideways, and the rail only becomes a rail where there is
        // room for a detail beside it.
        // `grid-cols-1` is not decoration: with a column named at `lg` alone,
        // the implicit track below it is `auto` — `minmax(min-content,
        // max-content)` — so one long event label took this column past the
        // width of a phone and every card under it with it. `grid-cols-1` is
        // `repeat(1, minmax(0, 1fr))`, and the `0` is what puts the truncations
        // back in charge (`src/gridColumns.test.ts`).
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
          <AccountsRail
            rows={rows}
            selected={opened.id}
            rebuilding={runtime.data?.rebuilding ?? null}
            onDeclare={() => setEditing(null)}
            currency={currency}
            // Whether there is anything to reassign — the module's own answer
            // (#725), which is *events still naming a row nobody declared* and
            // not *a row called `default` exists*: renamed, retyped or taken
            // over by a file, that row is an ordinary account and the offer
            // would be about nothing.
            //
            // `?? []` here is the legitimate one ADR-0026 leaves open: an
            // absent read **removes the offer** instead of falsifying it, and
            // claiming there are unassigned events before the ledger has
            // answered would be the opposite mistake.
            offer={offer}
            // `?? null` and never `?? []`: a chip is a claim about the
            // reader's own account, and a read in flight is not one.
            advisories={advisories.data ?? null}
          />
          <AccountDetail
            row={opened}
            positions={heldPositions}
            events={ledger}
            points={series}
            currency={currency}
            rebuilding={runtime.data?.rebuilding ?? null}
            // The standing offer belongs to the account carrying the events, so
            // it is composed here — where both reads are — and handed to the
            // detail that is about that account. Everywhere else it is `none`
            // and the block does not exist.
            reassignment={opened.id === DEFAULT_ACCOUNT_ID ? offer : { kind: 'none' }}
            // **One entry per read, handed to the block it composes** (#829,
            // ADR-0037). There is no band above the column any more, and one
            // condition for the three would have taken a detail that read two
            // of them off the screen to report the third — the exact
            // disappearance #799 repaired on the dashboard.
            failures={detailFailures}
            onEdit={() => setEditing(declared.find((one) => one.id === opened.id) ?? null)}
          />
        </div>
      )}

      {/* One panel for the page, opened from the rail and from the detail. It
          is mounted outside the branch above so that shutting it cannot depend
          on what is on screen behind it. */}
      <AccountForm
        open={editing !== undefined}
        account={editing ?? null}
        // `null` while the ledger has not landed, never *nothing to move*: the
        // panel waits for the answer before it lets a declaration go, which is
        // what keeps the flag and the declaration one gesture (#725).
        offer={ledger === null ? null : offer}
        // `null` while the ledger has not landed (ADR-0026): the count a refusal
        // is made of comes off it, and a removal offered before it lands offers
        // a gesture the server is about to refuse.
        removal={editing == null || ledger === null ? null : removalOf(editing, named(ledger, editing.id))}
        onClose={() => setEditing(undefined)}
      />
    </div>
  )
}

/** How many events name this account — the count a refusal is made of. */
function named(events: readonly LedgerEvent[], account: string): number {
  return events.filter((event) => accountOf(event) === account).length
}
