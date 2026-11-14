/**
 * *Fonds de comparaison*: the ETFs the Comparaison page offers, as a ruled list
 * (#1312). Each row names the fund, its symbol in mono, how far its history has
 * come, and one text action, « Ne plus suivre ». « Ajouter un fonds » opens the
 * sheet that follows more. **The sheet is the address**: it is open while the
 * hash is `#portfolio-references`, so the Comparaison page's link scrolls here
 * *and* opens it, and closing it removes the hash.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from '@tanstack/react-router'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { flooredPercent } from '@/features/benchmark/components/ReferenceProgress'
import type { BenchmarkReference } from '@/features/benchmark/lib/api'
import {
  REFERENCES_KEY,
  SHEET_POLL_MS,
  QUIET_POLL_MS,
  useReferences,
} from '@/features/benchmark/lib/useReferences'
import {
  AddRow,
  ListRow,
  ListSetting,
  TextAction,
} from '@/features/settings/components/ListSetting'
import { ReferencesSheet } from '@/features/settings/components/ReferencesSheet'
import { type ConfigResponse, settingsApi } from '@/features/settings/lib/api'
import { useI18n, type MessageKey, type MessageValues } from '@/lib/i18n'

/** The address of the open sheet, under the `#portfolio` section. */
export const REFERENCES_HASH = 'portfolio-references'
const FOLLOWED = 'benchmark_symbols'

/** Where a followed fund stands, in two or three words. */
function fundState(
  t: (key: MessageKey, values?: MessageValues) => string,
  row: BenchmarkReference,
): string {
  if (row.ready) return t('settings.refs.state.ready')
  if (row.never_priced) return t('settings.refs.state.neverPriced')
  if (row.waiting === 'queued') return t('settings.refs.state.waiting')
  if (row.waiting === 'no_events') return t('settings.refs.state.noEvents')
  if (row.failing) return t('settings.refs.state.failing')
  const percent = flooredPercent(row.ratio)
  return percent === null
    ? t('settings.refs.state.starting')
    : t('settings.refs.state.downloading', { percent: percent / 100 })
}

export function FundsList() {
  const { t } = useI18n()
  const client = useQueryClient()
  const navigate = useNavigate()
  const open = useLocation({ select: (location) => location.hash === REFERENCES_HASH })
  const references = useReferences(open ? SHEET_POLL_MS : QUIET_POLL_MS)
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  const followed = (references.data ?? []).filter((row) => row.followed)
  const [asked, setAsked] = useState<BenchmarkReference | null>(null)

  const unfollow = useMutation({
    mutationFn: (symbol: string) => {
      const now = (config.data?.settings.find((one) => one.key === FOLLOWED)?.value ??
        []) as string[]
      return settingsApi.saveSettings({ [FOLLOWED]: now.filter((one) => one !== symbol) })
    },
    onSuccess: (answer) => {
      setAsked(null)
      client.setQueryData<ConfigResponse>(['config'], (previous) =>
        previous ? { ...previous, settings: answer.settings } : previous,
      )
    },
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: REFERENCES_KEY }),
        client.invalidateQueries({ queryKey: ['benchmark'] }),
      ]),
  })

  return (
    <ListSetting id="funds" label={t('settings.refs.label')}>
      {followed.map((row) => (
        <ListRow
          key={row.symbol}
          name={
            <>
              {row.index} <span className="fig text-xs text-muted-foreground">{row.symbol}</span>
            </>
          }
          aside={fundState(t, row)}
          actions={
            <TextAction
              disabled={unfollow.isPending}
              aria-label={`${t('settings.refs.unfollow')} ${row.index}`}
              onClick={() => setAsked(row)}
            >
              {t('settings.refs.unfollow')}
            </TextAction>
          }
        />
      ))}
      <AddRow onClick={() => void navigate({ to: '/settings', hash: REFERENCES_HASH })}>
        {t('settings.refs.add')}
      </AddRow>
      <ConfirmDestructive
        open={asked !== null}
        onOpenChange={(next) => (next ? undefined : setAsked(null))}
        title={t('settings.refs.unfollow.title', { name: asked?.index ?? '' })}
        items={asked ? [{ key: asked.index, value: asked.symbol }] : undefined}
        line={t('settings.refs.unfollow.line')}
        confirmLabel={t('settings.refs.unfollow')}
        pending={unfollow.isPending}
        onConfirm={() => {
          if (asked) unfollow.mutate(asked.symbol)
        }}
      />
      <ReferencesSheet
        open={open}
        onClose={() => void navigate({ to: '/settings', replace: true })}
        references={references}
      />
    </ListSetting>
  )
}
