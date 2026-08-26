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
 *  - **It draws a weight and never a rate.** ADR-0028 allows a sparkline here
 *    on the condition that it carry its period, and the second half of the same
 *    clause is *or carry no figure*. What this rail carries is a **share of a
 *    total on a stated day** — the page's own `Chiffres arrêtés au …` — which is
 *    not a period at all, so no window is being implied and none has to be
 *    stated. A curve here would need a range control of its own beside the
 *    detail's, and two controls on one page are the two announcers this product
 *    has already paid for once.
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

import { ShareBar } from '@/components/ShareBar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  accountWeights,
  accountWorth,
  declaredLabel,
  declaredType,
  degradedReason,
  isDefaultAccount,
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
import { cn } from '@/lib/utils'

const REASON_LABELS: Record<DegradedReason, MessageKey> = {
  withoutCashLedger: 'accounts.reason.withoutCashLedger',
  rebuilding: 'accounts.reason.rebuilding',
  empty: 'accounts.reason.empty',
}

/**
 * The stops the bar's segments are drawn in. The twelve allocation stops are
 * deliberately not reused: those encode **rank** on a sorted, legended figure,
 * and this bar is in declaration order — a segment's colour here says *which
 * account*, which is what a hue does and a lightness does not.
 *
 * **The wheel starts on the accent's own hue** (#787), `165`, and turns by sixty
 * degrees from there. An identity palette cannot be one colour — that is the
 * whole of what it is for — but it can start somewhere rather than nowhere: at
 * `264` the first account, which on most installs is the only one anybody looks
 * at, was drawn in a blue the product uses nowhere. It is now the mint, and the
 * five after it are that mint's own wheel.
 */
const SEGMENT_HUES = [165, 225, 285, 345, 45, 105] as const

function segmentColour(index: number): string {
  return `oklch(0.62 0.15 ${SEGMENT_HUES[index % SEGMENT_HUES.length]})`
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
    <div className="space-y-3 lg:sticky lg:top-6">
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t('accounts.rail.title')}
          </h2>
        </CardHeader>
        <CardContent className="space-y-3 px-4">
          {drawable.length === 0 ? null : (
            <span aria-hidden className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
              {rows.map((row, index) => {
                const share = weights.get(row.id) ?? null
                if (share === null) return null
                return (
                  <span
                    key={row.id}
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
                <li key={row.id} className="flex flex-col gap-1 text-xs text-muted-foreground">
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
                    <span className="tabular shrink-0">
                      {share === null ? ABSENT : f.percentPoints(share * 100)}
                    </span>
                  </span>
                  {/* And nothing at all where there is no share: an account
                      nothing has been written about keeps its place and its em
                      dash, and a bar at zero beside that dash would be the
                      fifth rendering of absence ADR-0021 refuses. `ShareBar`
                      answers `null` with no bar, which is why the condition is
                      not spelled again here. */}
                  <ShareBar share={share} fill={segmentColour(index)} />
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>

      {/* One card per account, and the list is **bounded**: a rail is a rail and
          not a page, so past a dozen accounts it scrolls inside itself rather
          than pushing the declaration off the bottom of the screen. */}
      <ul aria-label={t('accounts.rail.label')} className="max-h-[26rem] space-y-2 overflow-y-auto">
        {rows.map((row, index) => {
          const reason = degradedReason(row, rebuilding)
          const cash = cashShare(advisories, row.id)
          const name = declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)
          const type =
            declaredType(row) ?? (isDefaultAccount(row.id) ? t(DEFAULT_ACCOUNT_TYPE) : row.id)
          return (
            <li key={row.id}>
              <Link
                to="/comptes"
                search={{ compte: row.id }}
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
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{type}</span>
                </span>

                {/* **What the account is worth, and never how it performed.** The
                    maquette puts a `perf` here and ADR-0028 does not let it: a
                    rate with no stated period beside a total is the
                    unbounded-window failure in miniature, and this rail has no
                    range control to state one. The value is the absolute the
                    share above is a share *of*. */}
                <span className="tabular mt-1 block text-lg font-semibold tracking-tight">
                  {f.currency(accountWorth(row), currency)}
                </span>

                {/* The id, on a line of its own: it is what every event names and
                    what a file's `account` column has to spell, and a card is
                    where there is finally room for it. *Already said* is
                    **either line above it** — an account whose id is `CTO` and
                    whose type is `CTO` printed the same word twice. */}
                {name === row.id || type === row.id ? null : (
                  <span className="mt-2 block border-t pt-2 font-mono text-xs text-muted-foreground">
                    {row.id}
                  </span>
                )}

                {reason === null ? null : (
                  <span className="mt-1 block text-xs text-attention">
                    {t(REASON_LABELS[reason])}
                  </span>
                )}

                {/* The advisory, **read beside its figure and offering nothing**
                    (ADR-0037). It says what the panel's card says in one line;
                    what it does not carry is the acknowledgement. */}
                {cash === null ? null : (
                  <span className="mt-2 inline-flex rounded-full bg-attention/10 px-2 py-0.5 text-[11px] font-medium text-attention">
                    {t('accounts.advisory.cash', { share: cash })}
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
          to="/comptes"
          search={{ compte: DEFAULT_ACCOUNT_ID }}
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

      <Button type="button" variant="outline" className="w-full" onClick={onDeclare}>
        {t('accounts.new')}
      </Button>
    </div>
  )
}
