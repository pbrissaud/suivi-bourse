/**
 * The rail — **the weights, and the way into one account** (ADR-0028).
 *
 * It is what is left of the comparison on this page, and the shape is the whole
 * of the trade ADR-0028 made: *how much of my portfolio is this* is a question
 * a list of names beside a bar answers at a glance, at any N, without a column
 * per figure. *Which account is working* is the other question, and it moved to
 * the dashboard's accounts card with ADR-0019's rule.
 *
 * Four things about it are decisions:
 *
 *  - **It draws a weight and a cumulative ratio, and never a rate.** ADR-0028
 *    allows a sparkline here on the condition that it carry its period, and the
 *    second half of the same clause is *or carry no figure*. Neither of the two
 *    figures on a card is a period: a **share of a total on a stated day** is
 *    not one, and `Performance totale` — `gain ÷ versé net`, the same figure the
 *    detail leads with since #833 — covers the account's whole life, which is
 *    what *totale* says. So no window is implied and none has to be stated, and
 *    that is precisely why the maquette's `perf` can stand here now while it
 *    could not before: what it puts on these cards is that cumulative ratio and
 *    never the windowed rate ADR-0028 refused. A **curve** is still not drawn:
 *    it would need a range control of its own, and one control per page is what
 *    is left of ADR-0019's rule.
 *  - **The ratio is divided out of `gain_absolu`**, where the detail divides the
 *    total it computes from four terms (ADR-0018). That is not two producers for
 *    one number: the fourth term is what closes the gap between the sum and the
 *    stored figure (`lib/gain.ts`), so the two land on the same percentage — and
 *    the rail reads no positions at all, which is the whole reason it costs one
 *    request for the page rather than one per account.
 *  - **The weights' legend carries neither.** The maquette puts its `perf` on
 *    the *accounts* — the cards, and the sticky strip that is those same cards
 *    at a narrow width — and never on the bar's legend, whose one figure is the
 *    share. Two unlabelled percentages on a twelve-pixel row would be two
 *    figures the reader has to tell apart by guessing.
 *  - **The entry is a link, so the selection is a URL.** It survives a reload,
 *    it can be handed to somebody else, and the way back out is the browser's
 *    own button. `aria-current` is what says which one is open — a class alone
 *    says it to nobody.
 *  - **An account with nothing written about it keeps its place and names its
 *    reason.** It is still an account, it still opens, and a rail that dropped
 *    it would answer *which accounts do I have* with a list shorter than the
 *    truth.
 *  - **The bar is `aria-hidden`.** Every share it draws is written beside its
 *    name one line down, so announcing the drawing too would read the same
 *    twelve figures twice.
 *  - **The stacked bar stays, and each line gains one of its own** (#800). The
 *    question the second bar raises is whether it replaces the first, and the
 *    answer has to be the same here and on the allocation, which draws a ring
 *    over a legend for exactly the same reason. It is *complements*: the two
 *    are not one figure drawn twice. A stacked bar says *these are the parts of
 *    one whole and they close it*, which is a claim about the total and is what
 *    no per-line bar makes. What it cannot answer is *is this account bigger
 *    than that one* — its segments start wherever the segment before them
 *    ended, so comparing the third against the sixth is comparing two lengths
 *    with no common origin, which is the ring's own weakness one figure down.
 *    Every per-line bar starts at the same edge and runs on the same scale.
 *    They are also two `aria-hidden` drawings of figures that are written out
 *    in full, so neither adds an announcement to the other.
 */
import { Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  accountColour as segmentColour,
  accountWeights,
  accountWorth,
  declaredLabel,
  declaredType,
  degradedReason,
  isDefaultAccount,
  onContributed,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ACCOUNT_LABEL,
  DEFAULT_ACCOUNT_TYPE,
  type AccountRow,
  type DegradedReason,
  type Reassignment as ReassignmentOffer,
} from '@/lib/accounts'
import type { Advisory } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { signClass } from '@/lib/sign'
import { cn } from '@/lib/utils'

const REASON_LABELS: Record<DegradedReason, MessageKey> = {
  withoutCashLedger: 'accounts.reason.withoutCashLedger',
  rebuilding: 'accounts.reason.rebuilding',
  empty: 'accounts.reason.empty',
}


/**
 * The advisory a rail entry wears, **as a chip and never as a gesture** (#829,
 * ADR-0037).
 *
 * An advisory is read twice: here, beside the figure it comments on, which is
 * the **reading**; and in the notifications panel, which is the **inventory**.
 * What the chip never offers is the acknowledgement — one fact cannot propose
 * two different gestures depending on where it is met, so the gesture belongs
 * to the panel and to the panel alone.
 *
 * `null` is *the read has not landed*, and it draws nothing: a chip is a claim
 * about the reader's own account (ADR-0026). An empty array is an answer — this
 * portfolio has nothing to say about itself — and draws nothing either, which
 * is the same rendering for two different truths and legitimately so: an
 * absent chip asserts nothing at all.
 */
function cashShare(
  advisories: readonly Advisory[] | null,
  account: string,
): number | null {
  const found = (advisories ?? []).find(
    (advisory) => advisory.kind === 'cash_share' && advisory.detail.account === account,
  )
  const share = found === undefined ? null : Number(found.detail.share)
  return share === null || !Number.isFinite(share) ? null : share
}

export interface AccountsRailProps {
  rows: readonly AccountRow[]
  /** Which account the detail is about — the rail marks it `aria-current`. */
  selected: string
  /** Whether the reconstruction is still running. `null` — not observed yet. */
  rebuilding: boolean | null
  /**
   * Whether events still name a row nobody declared, and **which of #725's two
   * renderings applies** — the page's answer off `reassignmentOf`, never *is one
   * of these called `default`*: a seeded row its owner has renamed is an
   * ordinary account, and the offer would then point at a population that no
   * longer exists.
   */
  offer: ReassignmentOffer
  /**
   * Declaring an account — **here, because this is where the accounts are**
   * (ADR-0028). It is the one control of the rail, at its foot rather than in
   * its header: the header names what the rail shows, and a button beside a
   * title reads as acting on it.
   */
  onDeclare: () => void
  /** The one currency everything is reported in (ADR-0002). */
  currency: string | null
  /**
   * What this portfolio says about itself, or `null` while the read is in
   * flight. The rail renders the ones about **its** accounts, as chips.
   */
  advisories: readonly Advisory[] | null
}

export function AccountsRail({
  rows,
  selected,
  rebuilding,
  offer,
  onDeclare,
  currency,
  advisories,
}: AccountsRailProps) {
  const { t } = useI18n()
  const f = useFormatters()

  const weights = accountWeights(rows)
  // Nothing to draw is not nothing to list: an install whose reconstruction has
  // never run has a weight for no account at all, and the names are still the
  // way into each of them.
  const drawable = rows.filter((row) => (weights.get(row.id) ?? null) !== null)

  return (
    // **Two objects, not one** (#787): the weights are one card, and each
    // account is its own. Folded into a single card the rail read as a legend
    // with links in it, where what it is is a stack of accounts with a bar above
    // them — and an account with room for its own figure stops being a row in
    // somebody else's table.
    <div className="space-y-3 wide:sticky wide:top-7">
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <h2 className="eyebrow">{t('accounts.rail.title')}</h2>
        </CardHeader>
        <CardContent className="space-y-3 px-4">
          {drawable.length === 0 ? null : (
            <span
              aria-hidden
              data-weights-bar
              className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full"
            >
              {rows.map((row, index) => {
                const share = weights.get(row.id) ?? null
                if (share === null) return null
                return (
                  <span
                    key={row.id}
                    data-account={row.id}
                    className="block"
                    style={{ width: `${share * 100}%`, backgroundColor: segmentColour(index) }}
                  />
                )
              })}
            </span>
          )}

          {/* The bar's own legend, and only that: it pairs a colour to a name
              and states the share. What each account *is* is its own card. */}
          <ul aria-label={t('accounts.rail.title')} className="space-y-1.5">
            {rows.map((row, index) => {
              const share = weights.get(row.id) ?? null
              return (
                <li
                  key={row.id}
                  data-account={row.id}
                  className="flex flex-col text-xs text-muted-foreground"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block size-2 shrink-0 rounded-sm"
                        style={{ backgroundColor: segmentColour(index) }}
                      />
                      <span className="truncate">
                        {declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)}
                      </span>
                    </span>
                    <span className="tabular shrink-0 font-mono">
                      {share === null ? ABSENT : f.percentPoints(share * 100)}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>

      {/* One card per account, and the list is **bounded**: a rail is a rail and
          not a page, so past a dozen accounts it scrolls inside itself rather
          than pushing the declaration off the bottom of the screen.

          **Drawn only from 976 px** (#838): under that width the same choice is
          the sticky row of chips above, and the two together would be the list
          of accounts twice on one screen — once as a bar the reader keeps and
          once as a stack they scroll past. */}
      <ul
        aria-label={t('accounts.rail.label')}
        className="hidden max-h-105 space-y-2 overflow-y-auto wide:block"
      >
        {rows.map((row, index) => {
          const reason = degradedReason(row, rebuilding)
          const cash = cashShare(advisories, row.id)
          const name = declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)
          const type =
            declaredType(row) ?? (isDefaultAccount(row.id) ? t(DEFAULT_ACCOUNT_TYPE) : row.id)
          // `null` where there is no ratio to state — nothing written about this
          // account yet, nothing ever paid in, or more taken out than put in.
          const performance = onContributed(row.gain_absolu, row.net_contributed)
          return (
            <li key={row.id}>
              <Link
                to="/accounts"
                search={{ account: row.id }}
                aria-current={row.id === selected ? 'true' : undefined}
                className={cn(
                  'block rounded-xl border bg-card px-4 py-3 hover:border-primary/40',
                  row.id === selected && 'border-primary/50 bg-muted',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <span
                      aria-hidden
                      className="inline-block size-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: segmentColour(index) }}
                    />
                    <span className="truncate">{name}</span>
                    {/* The advisory, **read beside its figure and offering
                        nothing** (ADR-0037). It says what the panel's card
                        says in one line; what it does not carry is the
                        acknowledgement. Beside the name since #838, which is
                        where the drawing puts it — under the card it read as a
                        second row of the card rather than as a mark on it. */}
                    {cash === null ? null : (
                      <span className="shrink-0 rounded-md bg-attention/14 px-1.5 py-0.5 text-2xs font-medium text-attention">
                        {t('accounts.advisory.cash', { share: cash })}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">{type}</span>
                </span>

                {/* **What the account is worth, and what it has done with it.**
                    The maquette pairs the two on this card and ADR-0028 lets it
                    since #833: the figure beside the value is `Performance
                    totale`, a cumulative ratio whose extent is the account's own
                    life, and not the windowed rate a rail with no range control
                    could never have stated a period for. The value is the
                    absolute the share above is a share *of*. */}
                <span className="mt-1 flex items-baseline justify-between gap-3">
                  <span className="tabular text-xl font-heavy tracking-tight">
                    {f.currency(accountWorth(row), currency)}
                  </span>
                  {/* The name is announced and not drawn: the card already
                      carries a value and a type, so a bare percentage read out
                      after them says nothing about which figure it is. It
                      carries no bubble — ADR-0016 puts one icon per figure and
                      per surface, and this page's is on the detail's own head. */}
                  <span
                    className={cn(
                      'tabular shrink-0 font-mono text-xs',
                      signClass(performance),
                    )}
                  >
                    <span className="sr-only">
                      {t('accounts.figure.totalPerformance')}{' '}
                    </span>
                    {performance === null ? ABSENT : f.percent(performance)}
                  </span>
                </span>

                {reason === null ? null : (
                  <span className="mt-1 block text-xs text-attention">
                    {t(REASON_LABELS[reason])}
                  </span>
                )}

              </Link>
            </li>
          )
        })}
      </ul>

      {/* The one population the promise *your declared accounts* does not cover,
          and the only way to repair it. It leads to the **seeded account's own
          detail**, where the offer stands: the link owes its reader the gesture
          and not the page (#725). */}
      {offer.kind === 'none' ? null : offer.kind === 'standing' ? (
        <Link
          to="/accounts"
          search={{ account: DEFAULT_ACCOUNT_ID }}
          className="block px-1 text-left text-xs underline underline-offset-4"
        >
          {t('accounts.default.reassign')}
        </Link>
      ) : (
        // **Where nothing is declared yet the gesture *is* the declaration**, so
        // this one opens the panel instead of leading anywhere: there is no list
        // of accounts to assign to, and the account the reader is about to create
        // is the only answer the question can have. A button, not a link.
        <button
          type="button"
          onClick={onDeclare}
          className="block px-1 text-left text-xs underline underline-offset-4"
        >
          {t('accounts.default.reassign')}
        </button>
      )}

      {/* **A dashed outline and a plus** (#838): the drawing marks the one
          gesture that *adds a card to this rail* as an outline of the card it
          would add, which is what a dashed edge says and a filled button does
          not. */}
      <Button
        type="button"
        variant="outline"
        className="h-9.5 w-full gap-2 rounded-xl border-dashed bg-transparent text-muted-foreground hover:border-primary hover:text-primary dark:bg-transparent"
        onClick={onDeclare}
      >
        <Plus aria-hidden />
        {t('accounts.new')}
      </Button>
    </div>
  )
}

/**
 * **Under 976 px the rail is a bar of chips at the top of the screen** (#838,
 * the drawing read at its stacked width).
 *
 * The column of cards is a *rail* only where there is a column beside it to be
 * a rail of: laid out above the detail it becomes a stack the reader scrolls
 * past to reach the account they opened, and the way back to the others goes
 * off the top of the screen with it. The drawing answers that with one sticky
 * row that scrolls sideways — every account on one line, the one in force
 * raised — so the choice stays reachable however far down the detail the reader
 * has gone.
 *
 * **It is mounted beside the grid and not inside the rail**, and that is the
 * whole of why it is its own component: a sticky element sticks *within its
 * containing block*, and the rail's column ends where the detail begins — put
 * there, the bar came unstuck a third of the way down the page. Its containing
 * block has to be the page's own column.
 *
 * It is `sticky` while being its own horizontal scroller, which is the
 * drawing's arrangement and works because the two axes are independent: the row
 * scrolls its chips sideways and stays put vertically. The page's ground and a
 * hairline are what say the detail passes **under** it.
 *
 * **A chip is not a card**, and that is the one thing about it that is drawn
 * rather than arranged. Bordered and filled with the card's own ground, two of
 * them read as two objects of the page — and the second is *clipped by the
 * viewport*, which is a card cut in half at the edge of a phone. What the row
 * is is one control with several options, so the ground and the edge go: a chip
 * is a colour, a name and its figures, and the one in force is the only one
 * filled. The bar keeps a hairline under it rather than a shadow, a shadow
 * being the other half of what made the strip read as a raised card.
 */
export function AccountsChips({
  rows,
  selected,
  currency,
}: {
  rows: readonly AccountRow[]
  selected: string
  currency: string | null
}) {
  const { t } = useI18n()
  const f = useFormatters()
  return (
    <div
      role="group"
      aria-label={t('accounts.rail.label')}
      className="sticky top-0 z-10 -mt-1.5 flex gap-1 overflow-x-auto overflow-y-hidden border-b bg-background py-2.5 wide:hidden"
    >
      {rows.map((row, index) => {
        const performance = onContributed(row.gain_absolu, row.net_contributed)
        return (
          <Link
            key={row.id}
            to="/accounts"
            search={{ account: row.id }}
            aria-current={row.id === selected ? 'true' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2.5 rounded-full px-3 py-1.5 text-muted-foreground',
              row.id === selected && 'bg-muted text-foreground',
            )}
          >
            <span
              aria-hidden
              className="inline-block size-2.25 shrink-0 rounded-xs"
              style={{ backgroundColor: segmentColour(index) }}
            />
            <span className="text-sm font-semibold whitespace-nowrap">
              {declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)}
            </span>
            <span className="tabular font-mono text-sm whitespace-nowrap">
              {f.currency(accountWorth(row), currency)}
            </span>
            {/* The name is announced and not drawn: a bare percentage read
                out after a label and a value says nothing about which figure
                it is. */}
            <span
              className={cn(
                'tabular font-mono text-xs whitespace-nowrap',
                signClass(performance),
              )}
            >
              <span className="sr-only">{t('accounts.figure.totalPerformance')} </span>
              {performance === null ? ABSENT : f.percent(performance)}
            </span>
          </Link>
        )
      })}
    </div>
  )
}
