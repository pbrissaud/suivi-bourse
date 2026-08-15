/**
 * *The store* — the third block of the installation tab (#724, ADR-0015,
 * spec #695 § 10).
 *
 * Four things, and each one is here because of what it prevents:
 *
 *  - **The path, and whether it survives.** Both come off `/api/runtime`, which
 *    opens nothing — so they are still on screen when the store itself cannot
 *    answer, which is exactly the moment *"where did my data go?"* is asked.
 *  - **An ephemeral store dominates the block** instead of appearing in it as a
 *    note. This is the only screen where a trial run learns that it is a trial
 *    run, and *this container keeps nothing* is not a footnote to a file size.
 *    It is **never a notice**: its predicate is not acknowledgeable — the
 *    container either keeps nothing or it does — so acknowledging it would make
 *    it go quiet while it was still true, and counting it would give a permanent
 *    badge.
 *  - **The size, with what a purge will not do.** Measured: 79 % of a real
 *    store's rows purged for **zero bytes** returned — 126,0 Mo before, 126,0 Mo
 *    after, the same content rebuilt from scratch fitting in 26,0. Shown bare
 *    beside a purge button the figure is a lie by juxtaposition; hidden, it is
 *    still there for anyone who runs `du`, and only its explanation is gone.
 *  - **The last write of the ledger**, and never the last observed price. The
 *    second is liveness and belongs to the banner; here it would make a store
 *    whose last import was a year ago read as freshly written.
 *
 * And the orphan list is **absent at zero**. It is not a maintenance table: it
 * is the visible consequence of a gesture the reader has just made — forgetting
 * an import. A **sold position is not one of them**, its events being in the
 * ledger still.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { api, type RuntimeStore, type StoreState } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

export interface StoreBlockProps {
  /** The path and the persistence, from the resource that opens nothing. */
  runtimeStore: RuntimeStore | undefined
  /** The figures. Absent while the read has not landed, or when it failed. */
  store: StoreState | undefined
}

export function StoreBlock({ runtimeStore, store }: StoreBlockProps) {
  const { t } = useI18n()
  const format = useFormatters()
  const client = useQueryClient()

  const purge = useMutation({
    mutationFn: () => api.purgeOrphans(),
    onSuccess: () => client.invalidateQueries({ queryKey: ['store'] }),
  })

  const persistence = runtimeStore?.persistence ?? 'unknown'
  // **An optional read, so the `?? []` survives** (ADR-0026): the orphan list is
  // absent at zero, so a read in flight removes a block rather than falsifying
  // one — and the two facts above it ride on `/api/runtime`, which is the whole
  // point of the split (#668).
  //
  // What is **not** repaired here and is named rather than repaired: the last
  // ledger write reads *« jamais »* while `/api/store` is in flight, which is a
  // statement about the reader's own data made on silence. It is a sentence and
  // not an emptiness primitive, so the in-flight net does not see it either.
  const orphans = store?.orphans ?? []

  return (
    <section aria-labelledby="installation-store" className="space-y-4">
      <h2 id="installation-store" className="text-lg font-semibold tracking-tight">
        {t('installation.store')}
      </h2>

      {/* It dominates. Not a note under the size, not a notice in the block
          above — the one screen where a trial run learns what it is. */}
      {persistence === 'ephemeral' ? (
        <div className="rounded-lg border border-attention/50 bg-attention/10 p-4">
          <p className="font-medium">{t('installation.store.ephemeral.title')}</p>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            {t('installation.store.ephemeral.body')}
          </p>
        </div>
      ) : null}

      <dl className="divide-y rounded-lg border text-sm">
        <div className="space-y-1 px-4 py-3">
          <dt className="text-muted-foreground">{t('installation.store.path')}</dt>
          <dd className="font-mono text-xs break-all">{runtimeStore?.path ?? '—'}</dd>
          <p className="text-xs text-muted-foreground">
            {t('installation.store.persistence', { state: persistence })}
          </p>
        </div>

        <div className="space-y-1 px-4 py-3">
          <dt className="text-muted-foreground">{t('installation.store.size')}</dt>
          <dd className="tabular">{format.bytes(store?.size_bytes ?? null)}</dd>
          {/* The sentence travels with the figure, always — it is what stops the
              purge below reading as a way to get bytes back. */}
          <p className="max-w-prose text-xs text-muted-foreground">
            {t('installation.store.size.note')}
          </p>
        </div>

        <div className="space-y-1 px-4 py-3">
          <dt className="text-muted-foreground">{t('installation.store.lastWrite')}</dt>
          <dd className="tabular">
            {store?.ledger_last_write
              ? format.dateTime(store.ledger_last_write)
              : t('installation.store.lastWrite.never')}
          </dd>
        </div>
      </dl>

      {orphans.length > 0 ? (
        <div className="space-y-3 rounded-lg border p-4">
          <p className="font-medium">
            {t('installation.store.orphans', { count: orphans.length })}
          </p>
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
        </div>
      ) : null}
    </section>
  )
}
