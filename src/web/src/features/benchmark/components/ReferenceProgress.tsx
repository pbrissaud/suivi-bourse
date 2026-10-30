/**
 * How far one ETF's download has got — the line and the bar, drawn the same
 * everywhere (#1312): the Settings sheet, the page's « none ready » screen and
 * the dashboard card.
 *
 * **Floored, never rounded.** `Math.round(0.999 * 100)` is 100, and a bar that
 * reads finished while the fetch has hours left makes the owner stop waiting
 * for a figure that is not coming. Only a ratio that has reached 1 shows 100.
 *
 * **A native `<progress>`**, the one `RebuildBlock` draws: the bar is the
 * rendering and the percentage is the fact. The hand-rolled ARIA equivalent is
 * refused across this front (`lint/no-wait-dressing.grit`). The percentage is
 * never announced as it moves; the sheet announces « prêt » once.
 */
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

/** `0`…`1` as a whole percent, floored; `null` where there is nothing to measure. */
export function flooredPercent(ratio: number | null): number | null {
  if (ratio === null) return null
  return ratio >= 1 ? 100 : Math.floor(ratio * 100)
}

export function ReferenceProgress({
  index,
  reached,
  target,
  ratio,
}: {
  index: string
  reached: string | null
  target: string | null
  ratio: number | null
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const percent = flooredPercent(ratio)
  const measured = reached !== null && target !== null && percent !== null

  return (
    <div className="space-y-1.5">
      <p className="text-sm text-muted-foreground">
        {measured
          ? t('benchmark.refs.progress', {
              reached: f.monthYear(reached),
              target: f.monthYear(target),
              percent: percent / 100,
            })
          : t('benchmark.refs.starting')}
      </p>
      {measured ? (
        <progress
          className="h-1.5 w-full"
          value={percent}
          max={100}
          aria-label={t('benchmark.refs.label', { index, percent: percent / 100 })}
        />
      ) : null}
    </div>
  )
}
