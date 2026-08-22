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
 */
import { Link } from '@tanstack/react-router'

import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  accountWeights,
  declaredLabel,
  declaredType,
  degradedReason,
  isDefaultAccount,
  DEFAULT_ACCOUNT_LABEL,
  DEFAULT_ACCOUNT_TYPE,
  type AccountRow,
  type DegradedReason,
} from '@/lib/accounts'
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
 */
const SEGMENT_HUES = [264, 324, 24, 84, 144, 204] as const

function segmentColour(index: number): string {
  return `oklch(0.62 0.15 ${SEGMENT_HUES[index % SEGMENT_HUES.length]})`
}

export interface AccountsRailProps {
  rows: readonly AccountRow[]
  /** Which account the detail is about — the rail marks it `aria-current`. */
  selected: string
  /** Whether the reconstruction is still running. `null` — not observed yet. */
  rebuilding: boolean | null
  /**
   * Whether events still name a row nobody declared (#725) — the page's answer
   * off `reassignmentOf`, never *is one of these called `default`*: a seeded row
   * its owner has renamed is an ordinary account, and the offer would then point
   * at a population that no longer exists.
   */
  reassignable: boolean
}

export function AccountsRail({ rows, selected, rebuilding, reassignable }: AccountsRailProps) {
  const { t } = useI18n()
  const f = useFormatters()

  const weights = accountWeights(rows)
  // Nothing to draw is not nothing to list: an install whose reconstruction has
  // never run has a weight for no account at all, and the names are still the
  // way into each of them.
  const drawable = rows.filter((row) => (weights.get(row.id) ?? null) !== null)

  return (
    <Card className="gap-4 lg:sticky lg:top-6">
      <CardHeader>
        <h2 className="text-sm font-medium">{t('accounts.rail.title')}</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        {drawable.length === 0 ? null : (
          <span aria-hidden className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
            {rows.map((row, index) => {
              const share = weights.get(row.id) ?? null
              if (share === null) return null
              return (
                <span
                  key={row.id}
                  style={{ width: `${share * 100}%`, backgroundColor: segmentColour(index) }}
                />
              )
            })}
          </span>
        )}

        <ul aria-label={t('accounts.rail.label')} className="-mx-2 flex flex-col">
          {rows.map((row, index) => {
            const share = weights.get(row.id) ?? null
            const reason = degradedReason(row, rebuilding)
            const name = declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)
            return (
              <li key={row.id}>
                <Link
                  to="/comptes"
                  search={{ compte: row.id }}
                  aria-current={row.id === selected ? 'true' : undefined}
                  className={cn(
                    'flex flex-col gap-0.5 rounded-md px-2 py-2 text-sm hover:bg-muted/60',
                    row.id === selected && 'bg-muted',
                  )}
                >
                  <span className="flex items-baseline gap-2">
                    <span
                      aria-hidden
                      className="inline-block size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: segmentColour(index) }}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                    {/* A share of a whole, never a change: `percent` signs what
                        it renders, and a weight has no sign to carry. The em
                        dash is right here — an account nothing has been written
                        about has no share to compute, and the sentence under it
                        names why. */}
                    <span className="tabular shrink-0 text-muted-foreground">
                      {share === null ? ABSENT : f.percentPoints(share * 100)}
                    </span>
                  </span>
                  <span className="pl-[1.125rem] text-xs text-muted-foreground">
                    {declaredType(row) ??
                      (isDefaultAccount(row.id) ? t(DEFAULT_ACCOUNT_TYPE) : row.id)}
                  </span>
                  {reason === null ? null : (
                    <span className="pl-[1.125rem] text-xs text-attention">
                      {t(REASON_LABELS[reason])}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>

        {/* The one population the promise *your declared accounts* does not
            cover, and the only way to repair it. The **hash** is what makes that
            repair reachable (#725): the link owes its reader the gesture and not
            the page. */}
        {reassignable ? (
          <Link
            to="/donnees"
            hash="reassignment"
            className="block px-2 text-xs underline underline-offset-4"
          >
            {t('accounts.default.reassign')}
          </Link>
        ) : null}
      </CardContent>
    </Card>
  )
}
