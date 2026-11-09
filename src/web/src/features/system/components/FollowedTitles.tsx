import { ChevronRight, TriangleAlert } from 'lucide-react'

import { useClock } from '@/features/system/lib/clock'
import type { RuntimeFollowed } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

/**
 * The titles the scrape follows, collapsible, in two columns (DESIGN.md ›
 * Système): the symbol in mono 500 with its name under it, then `à jour` in
 * `muted-foreground` or `figé depuis 16:25, 6 passages` in `foreground`. No
 * action per title. Open on arrival only when one needs a look.
 */
export function FollowedTitles({ followed }: { followed: readonly RuntimeFollowed[] }) {
  const { t } = useI18n()
  const clock = useClock()
  const f = useFormatters()
  const now = new Date()
  const stale = followed.filter((one) => one.state === 'stale')

  if (followed.length === 0) {
    return <p className="mt-3 text-sm text-muted-foreground">{t('system.titles.none')}</p>
  }

  return (
    <details open={stale.length > 0} className="group mt-3 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
        {stale.length === 0
          ? t('system.titles.summary.ok', { count: followed.length })
          : t('system.titles.summary.stale', {
              count: followed.length,
              symbols: f.list(stale.map((one) => one.symbol)),
            })}
      </summary>
      <ul className="mt-2 grid grid-cols-1 gap-x-8 md:grid-cols-2">
        {followed.map((one) => (
          <li
            key={one.symbol}
            className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b"
          >
            <span className="flex min-w-0 flex-col">
              <span className="fig font-medium">{one.symbol}</span>
              {one.name === null ? null : (
                <span className="truncate text-muted-foreground">{one.name}</span>
              )}
            </span>
            {one.state === 'stale' ? (
              <span className="flex items-center gap-1.5">
                <TriangleAlert aria-hidden className="size-3.5" />
                {one.stale_since === null
                  ? t('system.titles.stale.undated')
                  : t('system.titles.stale', {
                      since: clock.when(one.stale_since, now),
                      passes: one.stale_passes,
                    })}
              </span>
            ) : (
              <span className="text-muted-foreground">{t('system.titles.ok')}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}
