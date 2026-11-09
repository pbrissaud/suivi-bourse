import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import { type OrphanSymbol, settingsApi } from '@/features/settings/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

/**
 * *Historiques orphelins · N* with *Purger* in the sub-head of *Données*, then
 * the symbols nothing declares any more as ruled rows. Absent when there are
 * none.
 */
export function OrphansBlock({ orphans }: { orphans: readonly OrphanSymbol[] | null }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const [confirming, setConfirming] = useState(false)

  const remove = useMutation({
    mutationFn: () => settingsApi.purgeOrphans(),
    onSuccess: () => {
      setConfirming(false)
      return client.invalidateQueries({ queryKey: ['store'] })
    },
  })

  if (orphans === null || orphans.length === 0) return null

  return (
    <div className="flex flex-col pt-3 text-sm">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <span className="text-muted-foreground">
          {t('system.orphans', { count: orphans.length })}
        </span>
        <Button type="button" size="sm" onClick={() => setConfirming(true)}>
          {t('system.orphans.purge')}
        </Button>
      </div>
      <ul className="border-t">
        {orphans.map((orphan) => (
          <li
            key={orphan.symbol}
            className="flex min-h-9 items-center justify-between gap-4 border-b"
          >
            <span className="fig">{orphan.symbol}</span>
            <span className="fig text-muted-foreground">
              {t('system.orphans.points', { count: orphan.points })}
            </span>
          </li>
        ))}
      </ul>
      <ConfirmDestructive
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirm.purge.title', { count: orphans.length })}
        items={orphans.map((orphan) => ({
          key: <span className="fig">{orphan.symbol}</span>,
          value: t('system.orphans.points', { count: orphan.points }),
        }))}
        line={t('confirm.purge.line')}
        confirmLabel={t('system.orphans.purge')}
        pending={remove.isPending}
        error={remove.error ? <Refusal>{t(problemMessageKey(remove.error))}</Refusal> : null}
        onConfirm={() => remove.mutate()}
      />
    </div>
  )
}
