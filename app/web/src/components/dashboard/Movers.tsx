/**
 * What moved since the last session close (#727), **as one list** (#838).
 *
 * The block was two columns of five — *Hausses* over *Baisses* — and the
 * drawing has one list of five, ordered from the day's best to its worst. The
 * order is the reading: the two ends of the day sit at the two ends of a short
 * list, and the two headings and their two *nothing went down* lines paid for
 * nothing the shortness does not say.
 *
 * **A sentence for the rest**, and that sentence is the ticket it was written
 * for: measured on the real portfolio, `500.PA` — the second line of it, at
 * 16,6 % — moved by `0,00 %`, so it entered no column and disappeared. Silence
 * about the second line of a portfolio reads as *nothing to say about it*, and
 * counting it costs one sentence.
 *
 * What the sentence counts is **held lines**, not rows of the payload: a share
 * with no baseline at all — its first day — is not in the collection the server
 * serves, and taking the count from what came back would leave it out of the
 * sentence too, which is the same disappearance one step further along. The
 * payload is reduced to those same held lines before anything is counted off it
 * (`moversList`), so the two halves of the sentence describe one set.
 *
 * **The ticker is a badge on every line** (#838): the drawing sets the identity
 * as a mark rather than as a word, and it is what pairs a line here to the same
 * line in the table one page over — the name alone is a rail nothing else on
 * the page can be matched against. It is `aria-hidden`, the symbol being said
 * to a screen reader beside the name it belongs to.
 */
import { EmptyState } from '@/components/EmptyState'
import { Unreadable } from '@/components/Unreadable'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import type { Mover } from '@/lib/api'
import { moversList } from '@/lib/dashboard'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ShareRow } from '@/lib/shares'
import { signClass } from '@/lib/sign'
import type { ReadFailure } from '@/lib/status'

export interface MoversProps {
  movers: readonly Mover[] | null
  reference: string | null
  rows: readonly ShareRow[]
  currency: string | null
  failure?: ReadFailure | null
}

export function Movers({ movers, reference, rows, currency, failure = null }: MoversProps) {
  const { t } = useI18n()
  const f = useFormatters()
  if (movers === null) return failure === null ? null : <Unreadable failure={failure} />
  const { rows: moved, others, unchanged } = moversList(movers, rows)
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="eyebrow">
          {t('dashboard.movers.title')}
        </h2>
        {/* The instant the comparison is against, and it is this block's own
            subject rather than the page's period: a movement is read against a
            close, and the close is a fact about the quotes rather than about
            the window the reader chose. */}
        {reference === null ? null : (
          <p className="text-2xs text-muted-foreground">
            {t('dashboard.movers.since', { date: f.dateTime(reference) })}
          </p>
        )}
      </CardHeader>
      <CardContent>
        {moved.length === 0 ? (
          <EmptyState
            title={t('dashboard.movers.empty')}
            description={t('dashboard.movers.empty.body')}
          />
        ) : (
          <ul aria-label={t('dashboard.movers.title')}>
            {moved.map((mover) => (
              <li
                key={mover.symbol}
                className="flex items-center gap-3 border-b py-2.25"
              >
                {/* The identity, set as a mark rather than as a word: a ticker
                    is read as a badge and it is what pairs a line here to the
                    same line in the table one page over. */}
                <span
                  aria-hidden
                  className="flex size-7.5 shrink-0 items-center justify-center rounded-lg bg-accent font-mono text-2xs font-semibold text-muted-foreground"
                >
                  {mover.symbol.slice(0, 4)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {mover.name ?? mover.symbol}
                  {/* The symbol still names the line for a screen reader,
                      where the badge above is decoration. */}
                  {mover.name === null ? null : <span className="sr-only"> ({mover.symbol})</span>}
                </span>
                {/* The percentage over what it did in money: a 12 % jump on a
                    token holding and a 0,4 % drift on the biggest line are not
                    the same news, and a percentage alone cannot say which. */}
                <span className="flex shrink-0 flex-col items-end">
                  <span className={`tabular text-sm font-semibold ${signClass(mover.change_pct)}`}>
                    {f.percent(mover.change_pct)}
                  </span>
                  <span className="tabular text-2xs text-muted-foreground">
                    {f.signedCurrency(mover.contribution, currency)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {others === 0 ? null : (
          <p className="mt-3 text-xs text-muted-foreground">
            {t('dashboard.movers.others', { count: others, unchanged })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
