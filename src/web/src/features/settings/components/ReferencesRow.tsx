/**
 * « Références de comparaison »: the row of Portfolio that follows ETFs (#1312).
 *
 * It summarises in one sentence what the Benchmark page offers and what is still
 * downloading, and « Gérer » opens the sheet. **The sheet is the address**: it
 * is open while the hash is `#portfolio-references`, so the Benchmark page's
 * link scrolls here *and* opens it, and closing it removes the hash — neither a
 * reload nor Back reopens it.
 *
 * No skeleton while the read is on its way: the sentence is simply absent, and
 * a read that failed is said in the sheet by `Unreadable`.
 */
import { useNavigate, useLocation } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { flooredPercent } from '@/features/benchmark/components/ReferenceProgress'
import type { BenchmarkReference } from '@/features/benchmark/lib/api'
import { SHEET_POLL_MS, QUIET_POLL_MS, useReferences } from '@/features/benchmark/lib/useReferences'
import { ReferencesSheet } from '@/features/settings/components/ReferencesSheet'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

/** The address of the open sheet, under the `#portfolio` section. */
export const REFERENCES_HASH = 'portfolio-references'

export function ReferencesRow() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const open = useLocation({ select: (location) => location.hash === REFERENCES_HASH })
  const references = useReferences(open ? SHEET_POLL_MS : QUIET_POLL_MS)

  return (
    <SettingRow
      label={t('settings.refs.label')}
      description={references.data ? <Summary rows={references.data} /> : undefined}
    >
      <Button
        variant="outline"
        className="max-md:h-11"
        onClick={() => void navigate({ to: '/settings', hash: REFERENCES_HASH })}
      >
        {t('settings.refs.manage')}
      </Button>
      <ReferencesSheet
        open={open}
        onClose={() => void navigate({ to: '/settings', replace: true })}
        references={references}
      />
    </SettingRow>
  )
}

/** « MSCI World et S&P 500 sont proposés sur la page Référence. CAC 40 en téléchargement, 62 %. » */
function Summary({ rows }: { rows: readonly BenchmarkReference[] }) {
  const { t } = useI18n()
  const f = useFormatters()

  const followed = rows.filter((row) => row.followed)
  if (followed.length === 0) return <>{t('settings.refs.none')}</>

  const ready = followed.filter((row) => row.ready)
  const pending = followed.filter((row) => !row.ready)
  const running = pending.find((row) => row.waiting === null)
  const percent = running ? flooredPercent(running.ratio) : null
  const queued = pending.filter((row) => row.waiting === 'queued')

  const sentences = [
    ready.length > 0
      ? t('settings.refs.offered', {
          names: f.list(ready.map((row) => row.index)),
          count: ready.length,
        })
      : null,
    running
      ? percent !== null
        ? t('settings.refs.downloading', { index: running.index, percent: percent / 100 })
        : t('settings.refs.starting', { index: running.index })
      : null,
    queued.length > 0
      ? t('settings.refs.waiting', { names: f.list(queued.map((row) => row.index)) })
      : null,
    pending.some((row) => row.waiting === 'no_events') ? t('settings.refs.noEvents') : null,
  ].filter((sentence) => sentence !== null)

  return <>{sentences.join(' ')}</>
}
