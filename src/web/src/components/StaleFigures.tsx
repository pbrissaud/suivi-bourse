/**
 * **The figures under this are the previous pass's**, said on the three pages
 * the perf job writes the figures of (#994).
 *
 * It is one component and not a sentence copied per page for the reason
 * `lib/absence.ts` is one module: the claim is about **one** pass, made on
 * three surfaces at once, and a rule copied per surface is a rule that drifts
 * per surface. The pages hand it {@link stalePerfPass}'s answer — which is
 * `null` unless a pass actually raised — so mounting it costs a line and says
 * nothing on an install where nothing is wrong.
 *
 * It is a **sentence and not a band** (#829). There is no strip across the top
 * of the column anywhere in this product, and this is not one coming back: a
 * band announces the *installation*, which the bell has done since #829 and
 * already does for this exact fact — `health_performance` puts the dot on
 * *attention* the cycle a pass raises. What the bell cannot say is *the number
 * you are looking at is the one from before*, because that is true of a page
 * and not of an install, so it is said on the page, in the muted register every
 * other *why this figure reads like that* sentence uses.
 *
 * It carries no `role` for the same reason `Unreadable` carries none: the one
 * announcer of *something is wrong with this installation* is the bell, and a
 * live region per page would announce one failed pass three times.
 */
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

/** `at` — the instant of the failed pass, or `null` when nothing says so. */
export function StaleFigures({ at }: { at: string | null }) {
  const { t } = useI18n()
  const f = useFormatters()

  if (at === null) return null
  return (
    <p className="max-w-prose text-sm text-muted-foreground">
      {t('figures.stale', { date: f.dateTime(at) })}
    </p>
  )
}
