/**
 * The accounts bar — **the way into one account, at every width** (#1277).
 *
 * It replaced a left rail (a weights card, one tile per account and *Declare an
 * account*) that was mostly empty while the detail scrolled, and a second,
 * narrower rendering of the same list under 976 px. One list at every width is
 * the point: the accounts are a sticky row of chips over the detail, each one a
 * colour, a name, a value and its share of the whole, and the choice stays
 * within reach however far down the detail the reader has gone.
 *
 * Three things about it are decisions:
 *
 *  - **A chip carries no rate** (#1112). One performance figure per screen,
 *    and on this one it is the detail's annualised IRR: a percentage on each
 *    chip beside it was a second rate the reader had to tell apart from the
 *    first. The share on a chip is a share of the whole, never a change, and it
 *    wears no sign.
 *  - **The entry is a link, so the selection is a URL.** It survives a reload,
 *    it can be handed to somebody else, and the way back out is the browser's
 *    own button. `aria-current` is what says which one is open — a class alone
 *    says it to nobody.
 *  - **A chip is not a card.** Bordered and filled with the card's own ground,
 *    two of them read as two objects of the page, and the second is clipped by
 *    the viewport. What the row is is one control with several options, so the
 *    ground and the edge go: the one in force is the only one filled, and a
 *    hairline rather than a shadow says the detail passes under the bar. It
 *    scrolls sideways on its own, `sticky` while it does, because the two axes
 *    are independent.
 *
 * It is mounted beside the detail and not inside a column: a sticky element
 * sticks within its containing block, and the page's own column is the one that
 * lasts as long as the detail.
 *
 * An account with nothing written about it keeps its chip, with `—` for its
 * share: it is still an account, it still opens, and a bar that dropped it would
 * answer *which accounts do I have* with a list shorter than the truth.
 */
import { useEffect, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'

import {
  accountColour,
  accountWeights,
  accountWorth,
  declaredLabel,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ACCOUNT_LABEL,
  type AccountRow,
  type Reassignment as ReassignmentOffer,
} from '@/features/accounts/lib/accounts'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** Under touch the chips are at least 44 px high (DESIGN.md's target). */
const CHIP = 'flex shrink-0 items-center gap-2.5 rounded-full px-3 py-1.5 pointer-coarse:min-h-11'

export function AccountsBar({
  rows,
  selected,
  currency,
  offer,
  onDeclare,
}: {
  rows: readonly AccountRow[]
  /** Which account the detail is about — the bar marks it `aria-current`. */
  selected: string
  /** The one currency everything is reported in. */
  currency: string | null
  /**
   * Whether events still name a row nobody declared, and **which of #725's two
   * renderings applies** — the page's answer off `reassignmentOf`, never *is one
   * of these called `default`*: a seeded row its owner has renamed is an
   * ordinary account, and the offer would then point at a population that no
   * longer exists.
   */
  offer: ReassignmentOffer
  /** Declaring an account — the dashed chip at the end of the bar. */
  onDeclare: () => void
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const weights = accountWeights(rows)
  const open = useRef<HTMLAnchorElement>(null)

  // On arrival the open chip is brought into view: a bar that scrolls sideways
  // would otherwise open on an account it has scrolled out of sight.
  useEffect(() => {
    open.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selected])

  return (
    <div
      role="group"
      aria-label={t('accounts.rail.label')}
      className="sticky top-0 z-10 -mt-1.5 flex items-center gap-1 overflow-x-auto overflow-y-hidden border-b bg-background py-2.5"
    >
      {rows.map((row, index) => {
        const share = weights.get(row.id) ?? null
        const isOpen = row.id === selected
        return (
          <Link
            key={row.id}
            ref={isOpen ? open : undefined}
            to="/accounts"
            search={{ account: row.id }}
            aria-current={isOpen ? 'true' : undefined}
            className={cn(CHIP, 'text-muted-foreground', isOpen && 'bg-muted text-foreground')}
          >
            <span
              aria-hidden
              className="inline-block size-2.25 shrink-0 rounded-xs"
              style={{ backgroundColor: accountColour(index) }}
            />
            <span className="max-w-56 truncate text-sm font-semibold whitespace-nowrap">
              {declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)}
            </span>
            <span className="tabular text-sm whitespace-nowrap">
              {f.currency(accountWorth(row), currency)}
            </span>
            <span className="tabular text-xs whitespace-nowrap">
              {share === null ? ABSENT : f.percentPoints(share * 100)}
            </span>
          </Link>
        )
      })}

      {/* The one population the promise *your declared accounts* does not cover,
          and the only way to repair it. It leads to the **seeded account's own
          detail**, where the offer stands: the link owes its reader the gesture
          and not the page (#725). */}
      {offer.kind === 'none' ? null : offer.kind === 'standing' ? (
        <Link
          to="/accounts"
          search={{ account: DEFAULT_ACCOUNT_ID }}
          className={cn(CHIP, 'text-xs whitespace-nowrap underline underline-offset-4')}
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
          className={cn(CHIP, 'text-xs whitespace-nowrap underline underline-offset-4')}
        >
          {t('accounts.default.reassign')}
        </button>
      )}

      {/* **A dashed outline and a plus** (#838): the drawing marks the gesture
          that *adds an account to this bar* as the outline of the chip it would
          add, which is what a dashed edge says and a filled button does not. */}
      <button
        type="button"
        onClick={onDeclare}
        className={cn(
          CHIP,
          'border border-dashed text-sm whitespace-nowrap text-muted-foreground hover:border-primary hover:text-primary md:ml-auto',
        )}
      >
        <Plus aria-hidden className="size-3.5" />
        {t('accounts.new')}
      </button>
    </div>
  )
}
