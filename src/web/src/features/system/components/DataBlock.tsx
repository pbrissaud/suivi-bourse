import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { Section } from '@/components/ui/section'
import { OrphansBlock } from '@/features/system/components/OrphansBlock'
import type { OrphanSymbol } from '@/features/settings/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

/** A ruled `label … value` row of *Données* and *Installation*. */
export function FactRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 border-b">
      <dt>{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  )
}

interface DataBlockProps {
  /** `null` while the ledger is unread. */
  events: number | null
  /** `undefined` while unread; `null` when nothing was ever written. */
  sizeBytes: number | null | undefined
  orphans: readonly OrphanSymbol[] | null
}

/** *Données*: what the store holds, and the histories nothing declares any more. */
export function DataBlock({ events, sizeBytes, orphans }: DataBlockProps) {
  const { t } = useI18n()
  const f = useFormatters()

  return (
    <Section title={t('system.data')}>
      <dl className="text-sm">
        <FactRow label={t('system.data.events')}>
          <span className="fig">{events === null ? null : f.number(events, 0)}</span>
        </FactRow>
        <FactRow label={t('system.data.size')}>
          <span className="fig">{sizeBytes === undefined ? null : f.bytes(sizeBytes)}</span>
        </FactRow>
      </dl>
      {/* What « Exporter » leaves out, said where the owner looks for a backup. */}
      <p className="mt-3 text-sm text-muted-foreground">
        {t('system.data.export')}{' '}
        <Link to="/ledger" className="underline underline-offset-4">
          {t('system.data.export.link')}
        </Link>
      </p>
      <OrphansBlock orphans={orphans} />
    </Section>
  )
}
