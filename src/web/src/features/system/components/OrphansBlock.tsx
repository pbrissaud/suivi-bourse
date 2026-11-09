import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/ui/section'
import { type OrphanSymbol, settingsApi } from '@/features/settings/lib/api'
import { useI18n } from '@/lib/i18n'

/** Securities nothing declares any more. Absent when there are none. */
export function OrphansBlock({ orphans }: { orphans: readonly OrphanSymbol[] | null }) {
  const { t } = useI18n()
  const client = useQueryClient()

  const purge = useMutation({
    mutationFn: () => settingsApi.purgeOrphans(),
    onSuccess: () => {
      setConfirming(false)
      return client.invalidateQueries({ queryKey: ['store'] })
    },
  })
  const [confirming, setConfirming] = useState(false)

  if (orphans === null || orphans.length === 0) return null

  return (
    <Section
      title={t('installation.orphans')}
      aside={
        <span className="text-xs text-muted-foreground">
          {t('installation.store.orphans', { count: orphans.length })}
        </span>
      }
    >
      <p className="text-sm text-muted-foreground">{t('installation.store.orphans.body')}</p>
      <ul className="mt-3 divide-y text-sm">
        {orphans.map((orphan) => (
          <li key={orphan.symbol} className="flex gap-3 py-2">
            <span className="fig text-xs">{orphan.symbol}</span>
            <span className="fig ml-auto text-muted-foreground">
              {t('installation.store.orphans.points', { count: orphan.points })}
            </span>
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" className="mt-3" onClick={() => setConfirming(true)}>
        {t('installation.store.purge')}
      </Button>
      <ConfirmDestructive
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirm.purge.title', { count: orphans.length })}
        items={orphans.map((orphan) => ({
          key: <span className="fig">{orphan.symbol}</span>,
          value: t('installation.store.orphans.points', { count: orphan.points }),
        }))}
        line={t('confirm.purge.line')}
        confirmLabel={t('installation.store.purge')}
        pending={purge.isPending}
        onConfirm={() => purge.mutate()}
      />
    </Section>
  )
}
