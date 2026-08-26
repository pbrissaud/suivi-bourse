/**
 * *The orphaned securities* — what no event declares any more, and the one
 * gesture that removes them (#724, #830, ADR-0021, ADR-0038).
 *
 * It was the last block of the store card and it is a card of its own since
 * #830: ADR-0038 enumerates the page as *the settings, the store with its path,
 * its size and its last write, the orphans, the workloads*, and a securities
 * list carrying a destructive button is not a fifth row of a key/value list
 * about a file.
 *
 * Two things it keeps, and both are decisions:
 *
 *  - **It is absent at zero.** Not a maintenance table with an empty state: it
 *    is the visible consequence of a gesture the reader has just made —
 *    deleting the events that named a security — and a block with nothing in it
 *    does not exist. A **sold position is not one of them**, its events being in
 *    the ledger still.
 *  - **The count is said and the list is named.** The count alone would leave
 *    the reader to accept a purge on trust; the list alone would leave them
 *    counting rows. Each line carries how many quotes are being kept for it,
 *    which is what the purge actually returns.
 *
 * **`null` is a read that has not landed**, and it renders exactly as zero does
 * — nothing at all — because the two are the same screen here and only one of
 * them is a claim (ADR-0026). The page passes `?? null`, never `?? []`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { api, type OrphanSymbol } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

/** The id the card's landmark is named by — one constant, two readers. */
const ORPHANS_HEADING = 'settings-orphans'

export interface OrphansBlockProps {
  /** The list, or `null` while `GET /api/store` has not answered (ADR-0026). */
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
        <h2 id={ORPHANS_HEADING} className="text-lg font-semibold tracking-tight">
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
