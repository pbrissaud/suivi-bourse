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
 *  - **One band, for every read the page makes.** `/api/runtime` answers from
 *    process memory and never opens the store (#668), so the shell's banner is
 *    silent on the one failure that empties this page — and a page that rendered
 *    nothing would make *the store is unreadable* and *you own nothing yet* the
 *    same screen.
 *
 * **And the declaration lives here** (#793, ADR-0028): declared from the rail,
 * renamed and removed from the panel the account's own name opens. The panel is
 * the page's, not the rail's and not the detail's, because both open it — and a
 * component mounted twice would be two panels, one of which the reader cannot
 * see closing.
 */
import { useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { AccountDetail } from '@/components/accounts/AccountDetail'
import { AccountForm } from '@/components/accounts/AccountForm'
import { AccountsRail } from '@/components/accounts/AccountsRail'
import { Band } from '@/components/Band'
import { EmptyState } from '@/components/EmptyState'
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
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { oneBand, readConditions } from '@/lib/status'

export default function AccountsPage() {
  const { t } = useI18n()
  const f = useFormatters()
  const { compte } = useSearch({ from: '/comptes' })
  // `undefined` is *the panel is shut*; `null` is *open on a declaration*; an
  // account is *open on that account*. Three states, the ledger's three.
  const [editing, setEditing] = useState<Account | null | undefined>(undefined)

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: api.portfolioTotals })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const positions = useQuery({ queryKey: ['positions'], queryFn: api.positions })
  const events = useQuery({ queryKey: ['events'], queryFn: api.events })

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

  const failure = oneBand(
    readConditions({
      shellError: runtime.error,
      errors: [accounts.error, totals.error, positions.error, events.error, history.error],
    }),
  )

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

  // The page's name and the day its figures are of, both said in the header
  // (#789). **The day is the opened account's own**, not a `max` over all of
  // them: on the eight-column table the newest day covered every row, and on a
  // master-detail it would put *« arrêtés au 2 mars »* over an account still
  // being backfilled to 15 January. The date waits for the read the way every
  // figure does — an invented *today* is the reading this mention exists to
  // prevent.
  usePageHeading(
    t('page.accounts'),
    opened?.as_of == null ? null : t('accounts.asOf', { date: f.date(opened.as_of) }),
  )

  return (
    <div className="space-y-6">
      {failure ? <Band>{t(failure.message)}</Band> : null}

      {/* **The declaration is what this page is made of, and the four other
          reads are what its blocks are made of.** A band is raised for any of
          them — one band or none, `lib/status.ts` — but only the declaration
          failing empties the page: a ledger that would not answer took the rail
          and the detail with it, so an owner lost every figure they *did* have
          because the *last events* block could not be composed.

          A read that has not landed is not a fact either: nothing is claimed
          while the declaration is in flight, and above all not that there is
          none. */}
      {accounts.error || !accounts.data ? null : opened === null ? (
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
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
          <AccountsRail
            rows={rows}
            selected={opened.id}
            rebuilding={runtime.data?.rebuilding ?? null}
            onDeclare={() => setEditing(null)}
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
