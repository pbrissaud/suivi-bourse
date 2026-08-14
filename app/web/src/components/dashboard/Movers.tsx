/**
 * What moved since the last session close (#727).
 *
 * Two columns of five, and **a sentence for the rest**. That sentence is the
 * ticket: measured on the real portfolio, `500.PA` — the second line of it, at
 * 16,6 % — moved by `0,00 %`, so it entered neither column and disappeared from
 * both. Silence about the second line of a portfolio reads as *nothing to say
 * about it*, and counting it costs one sentence.
 *
 * What the sentence counts is **held lines**, not rows of the payload: a share
 * with no baseline at all — its first day — is not in the collection the server
 * serves, and taking the count from what came back would leave it out of the
 * sentence too, which is the same disappearance one step further along. The
 * payload is reduced to those same held lines before anything is counted off it
 * (`moversSplit`), so the two halves of the sentence describe one set.
 *
 * The reference close is named here and nowhere else. It is the **second** of
 * the page's two permanent time announcers — the first is the page's own price
 * mention — and it is a different instant from it: the block compares against
 * the previous session, the page states the last observation. Naming the *cut*
 * instead of the close it found announced a session that had not happened yet.
 */
import { EmptyState } from '@/components/EmptyState'
import type { Mover } from '@/lib/api'
import { moversSplit } from '@/lib/dashboard'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ShareRow } from '@/lib/shares'
import { signClass } from '@/lib/sign'

export interface MoversProps {
  movers: readonly Mover[]
  /** The instant the comparison is made against. `null` — nothing to compare. */
  reference: string | null
  /** The portfolio's lines, closed ones included — the block reduces them itself. */
  rows: readonly ShareRow[]
  currency: string | null
}

export function Movers({ movers, reference, rows, currency }: MoversProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const { risers, fallers, others, unchanged } = moversSplit(movers, rows)

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">{t('dashboard.movers.title')}</h2>
        {reference === null ? null : (
          <p className="text-sm text-muted-foreground">
            {t('dashboard.movers.since', { date: f.dateTime(reference) })}
          </p>
        )}
      </div>

      {risers.length === 0 && fallers.length === 0 ? (
        <EmptyState
          title={t('dashboard.movers.empty')}
          description={t('dashboard.movers.empty.body')}
        />
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          <Column
            title={t('dashboard.movers.risers')}
            rows={risers}
            currency={currency}
            empty={t('dashboard.movers.noRiser')}
          />
          <Column
            title={t('dashboard.movers.fallers')}
            rows={fallers}
            currency={currency}
            empty={t('dashboard.movers.noFaller')}
          />
        </div>
      )}

      {others === 0 ? null : (
        <p className="text-sm text-muted-foreground">
          {t('dashboard.movers.others', { count: others, unchanged })}
        </p>
      )}
    </section>
  )
}

function Column({
  title,
  rows,
  currency,
  empty,
}: {
  title: string
  rows: readonly Mover[]
  currency: string | null
  empty: string
}) {
  const f = useFormatters()

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((mover) => (
            <li key={mover.symbol} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{mover.name ?? mover.symbol}</span>
              <span className="flex shrink-0 items-baseline gap-3">
                {/* The percentage and what it did in money: a 12 % jump on a
                    token holding and a 0,4 % drift on the biggest line are not
                    the same news, and a percentage alone cannot say which. */}
                <span className={`tabular ${signClass(mover.change_pct)}`}>
                  {f.percent(mover.change_pct)}
                </span>
                <span className={`tabular ${signClass(mover.contribution)}`}>
                  {f.signedCurrency(mover.contribution, currency)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
