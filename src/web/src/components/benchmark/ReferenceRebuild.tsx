/**
 * The rebuild panel, in the slot the figure will occupy.
 *
 * **A narrow, written exception to #829.** `DashboardPage` posts *no
 * installation fact lands here* and sends reconstruction progress to the
 * notifications panel and only there. #829's two arguments do not reach this
 * page: the fact is not invisible to whoever landed elsewhere — it was
 * **started by a gesture on this page** — and it does not compete with the
 * bell, because the bell does not carry it: an index backfill is a workload
 * `notifications.ts` does not know. The fact has zero announcers, not two.
 *
 * **Not `RebuildBlock`.** That block measures `(horizon → today) / (first event
 * → today)` and names which account is holding it back; both ends and the name
 * are meaningless for a fund. The bounds here are the fund's own inception and
 * today, which the backfill already knows.
 *
 * **No promised duration.** `RebuildBlock` already refuses to name an hour, and
 * a mute symbol backing off to twenty-four hours is why.
 *
 * While this renders, **no figure appears anywhere on the page**. A gap
 * computed over a half-built series is a wrong number and not a short one.
 */
import { Card, CardContent } from '@/components/ui/card'
import type { BenchmarkRebuild } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

export function ReferenceRebuild({ rebuild }: { rebuild: BenchmarkRebuild }) {
  const { t } = useI18n()
  const f = useFormatters()

  // **Floored, never rounded.** `Math.round(0.999 * 100)` is 100, and a bar
  // that reads finished while the fetch has hours left is the same lie the
  // off-list target was: the owner stops waiting and the figure never comes.
  // Only a ratio that has actually reached 1 shows 100.
  const percent =
    rebuild.ratio === null
      ? null
      : rebuild.ratio >= 1
        ? 100
        : Math.floor(rebuild.ratio * 100)

  return (
    <Card>
      <CardContent className="space-y-3 py-6">
        <p className="font-medium">{t('benchmark.rebuild.title', { symbol: rebuild.symbol })}</p>
        <p className="text-sm text-muted-foreground">
          {rebuild.reached === null
            ? t('benchmark.rebuild.starting')
            : rebuild.target === null
              ? t('benchmark.rebuild.progress', { reached: f.date(rebuild.reached) })
              : t('benchmark.rebuild.target', {
                  reached: f.date(rebuild.reached),
                  target: f.date(rebuild.target),
                })}
        </p>
        {percent === null ? null : (
          // A native `<progress>`, the same one `RebuildBlock` draws: the bar
          // is the rendering and the percentage is the fact, **announced**
          // rather than drawn. The hand-rolled ARIA equivalent is refused
          // across this front (`noSpinner.test.ts`) — a shape that dresses a
          // wait says nothing, and what is said here is a measurement.
          <progress
            className="h-1.5 w-full"
            value={percent}
            max={100}
            aria-label={t('benchmark.rebuild.label', { percent: percent / 100 })}
          />
        )}
      </CardContent>
    </Card>
  )
}
