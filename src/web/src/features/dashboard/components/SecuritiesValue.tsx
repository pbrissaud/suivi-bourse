/**
 * *Valeur des titres* — where the securities' value sits, by security (« Relevé »,
 * DESIGN.md › The dashboard). It replaced *Répartition*: the top four lines and
 * « N autres lignes », no account view, cash left out.
 *
 * The slices and their fold are the Titres page's own (`allocation`,
 * `foldSlices`); the block is a figure, a one-bar-per-slice strip and ruled rows
 * with each share. It names what it could not place (a quote whose rate has not
 * resolved) instead of dividing a partial whole in silence.
 */
import { EmptyState } from '@/components/EmptyState'
import { Unreadable } from '@/components/Unreadable'
import { Section } from '@/components/ui/section'
import { AllocationUnplaced, sliceKey } from '@/features/shares/components/Allocation'
import type { PositionsResponse } from '@/features/shares/lib/api'
import { allocation, type ShareRow } from '@/features/shares/lib/shares'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'

interface SecuritiesValueProps {
  /** `null` while in flight — the block holds its place as an empty plane. */
  positions: PositionsResponse | null
  rows: readonly ShareRow[]
  failure?: ReadFailure | null
}

export function SecuritiesValue({ positions, rows, failure = null }: SecuritiesValueProps) {
  const { t } = useI18n()
  const f = useFormatters()

  if (positions === null) {
    return failure === null ? (
      <div aria-hidden className="min-h-60 rounded-section bg-muted" />
    ) : (
      <Section fill title={t('dashboard.securities.title')}>
        <Unreadable failure={failure} />
      </Section>
    )
  }

  const split = allocation(rows)
  const currency = positions.base_currency ?? null
  const lines = split.slices.reduce((n, slice) => n + slice.count, 0)

  return (
    <Section
      fill
      title={t('dashboard.securities.title')}
      aside={<span className="text-sm text-muted-foreground">{t('dashboard.securities.by')}</span>}
    >
      {split.slices.length === 0 ? (
        <EmptyState
          title={t('shares.allocation.empty')}
          description={t('shares.allocation.empty.body')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="flex flex-wrap items-baseline gap-x-2.5">
            <span className="fig text-4xl font-medium">{f.currency(split.total, currency)}</span>
            <span className="text-muted-foreground">
              {t('dashboard.securities.caption', { count: lines })}
            </span>
          </p>
          <div
            role="img"
            aria-label={t('dashboard.securities.bar')}
            className="flex h-3 gap-0.5 overflow-hidden rounded-xs"
          >
            {split.slices.map((slice, rank) => (
              <span
                key={sliceKey(slice)}
                className="block"
                style={{ flex: slice.share, background: `var(--alloc-${rank + 1})` }}
              />
            ))}
          </div>
          <ul aria-label={t('dashboard.securities.title')} className="flex flex-col">
            {split.slices.map((slice, rank) => (
              <li
                key={sliceKey(slice)}
                className="flex items-baseline justify-between gap-3 border-t py-1.75"
              >
                <span className="inline-flex min-w-0 items-center gap-2.5">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-xs"
                    style={{ background: `var(--alloc-${rank + 1})` }}
                  />
                  <span className="truncate">
                    {slice.symbol === null
                      ? t('dashboard.securities.others', { count: slice.count })
                      : (slice.label ?? slice.symbol)}
                  </span>
                </span>
                <span className="fig text-muted-foreground">
                  {f.percentPoints(slice.share * 100, 1)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <AllocationUnplaced unplaced={split.unplaced} />
    </Section>
  )
}
