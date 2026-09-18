/**
 * *The orphaned securities* — what nothing declares any more, and the one
 * gesture that removes them (#724, #830, #982).
 *
 * **Two ways in, and the body names both.** Deleting the events that named a
 * security is the first. Emptying the comparison reference is the second
 * (#982): a reference is followed because a dial names it, so un-naming it
 * drops the series into exactly this list — nothing was deleted, and a body
 * that said *your events were deleted* would describe something the reader
 * never did.
 *
 * Two things it keeps, and both are decisions:
 *
 *  - **It is absent at zero.** Not a maintenance table with an empty state: it
 *    is the visible consequence of a gesture the reader has just made — and a
 *    block with nothing in it does not exist. A **sold position is not one of
 *    them**, its events being in the ledger still.
 *  - **The count is said and the list is named.** The count alone would leave
 *    the reader to accept a purge on trust; the list alone would leave them
 *    counting rows. Each line carries how many quotes are being kept for it,
 *    which is what the purge actually returns.
 *
 * **`null` is a read that has not landed**, and it renders exactly as zero does
 * — nothing at all — because the two are the same screen here and only one of
 * them is a claim. The page passes `?? null`, never `?? []`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { api, type OrphanSymbol } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

/** The id the card's landmark is named by — one constant, two readers. */
const ORPHANS_HEADING = 'settings-orphans'

interface OrphansBlockProps {
  /** The list, or `null` while `GET /api/store` has not answered. */
  orphans: readonly OrphanSymbol[] | null
}

export function OrphansBlock({ orphans }: OrphansBlockProps) {
  const { t } = useI18n()
  const client = useQueryClient()

  const purge = useMutation({
    mutationFn: () => api.purgeOrphans(),
    onSuccess: () => client.invalidateQueries({ queryKey: ['store'] }),
  })

  if (orphans === null || orphans.length === 0) return null

  return (
    <Card role="region" aria-labelledby={ORPHANS_HEADING}>
      <CardHeader>
        <h2 id={ORPHANS_HEADING} className="eyebrow">
          {t('installation.orphans')}
        </h2>
        {/* The count, said rather than counted off the rows below it. */}
        <p className="font-medium">
          {t('installation.store.orphans', { count: orphans.length })}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="max-w-prose text-sm text-muted-foreground">
          {t('installation.store.orphans.body')}
        </p>
        <ul className="space-y-1 text-sm">
          {orphans.map((orphan) => (
            <li key={orphan.symbol} className="flex gap-3">
              <span className="font-medium">{orphan.symbol}</span>
              <span className="tabular text-muted-foreground">
                {t('installation.store.orphans.points', { count: orphan.points })}
              </span>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          variant="outline"
          disabled={purge.isPending}
          onClick={() => purge.mutate()}
        >
          {t('installation.store.purge')}
        </Button>
      </CardContent>
    </Card>
  )
}
