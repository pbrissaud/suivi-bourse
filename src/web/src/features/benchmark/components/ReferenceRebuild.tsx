/**
 * « Followed, none ready »: the page's content while the first followed ETF is
 * still downloading, in the slot the figure will occupy (#1312).
 *
 * **A narrow, written exception to #829.** `DashboardPage` posts *no
 * installation fact lands here* and sends reconstruction progress to the
 * notifications panel and only there. #829's two arguments do not reach this
 * page: the fact is not invisible to whoever landed elsewhere — it was
 * **started by a gesture** the owner made in Settings — and it does not compete
 * with the bell, because the bell does not carry it: an index backfill is a
 * workload `notifications.ts` does not know. The fact has zero announcers, not
 * two.
 *
 * **Not `RebuildBlock`.** That block measures `(horizon → today) / (first event
 * → today)` and names which account is holding it back; both ends and the name
 * are meaningless for a fund. The bounds here are the later of the fund's
 * inception and the ledger's first day, which is where the backfill stops.
 *
 * **No promised duration**: an ETF back to 2008 takes about twenty minutes, and
 * a mute symbol backing off to twenty-four hours is why none is named.
 *
 * While this renders, **no figure appears anywhere on the page**. A gap
 * computed over a half-built series is a wrong number and not a short one.
 */
import { Link } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { Section } from '@/components/ui/section'
import { ReferenceProgress } from '@/features/benchmark/components/ReferenceProgress'
import type { BenchmarkRebuild } from '@/features/benchmark/lib/api'
import { useI18n } from '@/lib/i18n'

export function ReferenceRebuild({
  rebuild,
  index,
}: {
  rebuild: BenchmarkRebuild
  /** The fund's index, which the title names. */
  index: string
}) {
  const { t } = useI18n()

  return (
    <Section title={t('benchmark.followed.title', { index })}>
      <div className="space-y-4">
        <ReferenceProgress
          index={index}
          reached={rebuild.reached}
          target={rebuild.target}
          ratio={rebuild.ratio}
        />
        <Button asChild variant="outline" className="max-md:h-11">
          <Link to="/settings" hash="portfolio-references">
            {t('benchmark.followed.manage')}
          </Link>
        </Button>
      </div>
    </Section>
  )
}
