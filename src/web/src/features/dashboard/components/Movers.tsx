/**
 * What moved since the last session close (#727), **as one list** (#838).
 *
 * The block was two columns of five — *Hausses* over *Baisses* — and the
 * drawing has one list, ranked by the size of the move, whichever way it went.
 * The order is the reading: what moved most comes first, the colour says which
 * way, and the two headings and their two *nothing went down* lines paid for
 * nothing the shortness does not say.
 *
 * **Five lines on half the width, ten across the full width** (dashboard grid,
 * 11/10/2026). The ten are still that **one** list, numbered, flowing down the
 * left column and then the right: one `<ol>`, laid out by CSS columns, so the
 * reading order and a screen reader's are the ranking. It is not the old split
 * back: the two columns are ranks 1–5 and 6–10, not gains and losses.
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
 * **The ticker is a badge on every line** (#838), cut to what comes before its
 * first `.` or `-` (`tickerBadge`: `MC.PA` is `MC`): the drawing sets the identity
 * as a mark rather than as a word, and it is what pairs a line here to the same
 * line in the table one page over — the name alone is a rail nothing else on
 * the page can be matched against. It is `aria-hidden`, the symbol being said
 * to a screen reader beside the name it belongs to.
 */
import { EmptyState } from '@/components/EmptyState'
import { Unreadable } from '@/components/Unreadable'
import { Section } from '@/components/ui/section'
import type { Mover } from '@/features/dashboard/lib/api'
import { MOVERS_ROWS, moversList, tickerBadge } from '@/features/dashboard/lib/dashboard'
import type { Width } from '@/features/dashboard/lib/dashboardBlocks'
import type { RenderState } from '@/features/dashboard/lib/dashboardLayout'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ShareRow } from '@/features/shares/lib/shares'
import { signClass } from '@/lib/sign'
import type { ReadFailure } from '@/lib/status'
import { cn } from '@/lib/utils'

interface MoversProps {
  movers: readonly Mover[] | null
  rows: readonly ShareRow[]
  currency: string | null
  failure?: ReadFailure | null
  /** The width the grid draws the card at — not the saved one (`features/dashboard/lib/dashboardLayout`). */
  width?: Width
}

/** What this block renders: the block's own `null` and the grid's, one rule. */
export function moversRenderState({
  movers,
  failure = null,
}: Pick<MoversProps, 'movers' | 'failure'>): RenderState {
  return movers === null && failure === null ? 'pending' : 'renders'
}

export function Movers({ movers, rows, currency, failure = null, width = 'half' }: MoversProps) {
  const { t } = useI18n()
  const f = useFormatters()
  if (movers === null) return failure === null ? null : <Unreadable failure={failure} />
  const { rows: moved, others, unchanged } = moversList(movers, rows, MOVERS_ROWS[width])
  // More lines than half the width holds flow into two columns; the first line
  // of each column carries no rule above it. The columns balance, so the right
  // one starts half-way. Fewer stay one column across the width (#1145): a
  // short list split in two left its figures half-way across the section.
  const twoColumns = width === 'full' && moved.length > MOVERS_ROWS.half
  const split = twoColumns ? Math.ceil(moved.length / 2) : moved.length
  return (
    <Section
      title={t('dashboard.movers.title')}
      // Undated (#1142): each line is read against its own previous close, and
      // a weekend puts a stock's on Thursday and a 24/7 line's on Saturday, so
      // no one date is true of the whole list.
      aside={moved.length === 0 ? null : <p className="label">{t('dashboard.movers.since')}</p>}
    >
      {moved.length === 0 ? (
        <EmptyState
          title={t('dashboard.movers.empty')}
          description={t('dashboard.movers.empty.body')}
        />
      ) : (
        <ol
          aria-label={t('dashboard.movers.title')}
          className={cn(twoColumns && 'columns-2 gap-x-7')}
        >
          {moved.map((mover, index) => (
            <li
              key={mover.symbol}
              className={cn(
                'flex break-inside-avoid items-center gap-3 border-t py-2.25',
                (index === 0 || index === split) && 'border-t-0',
              )}
            >
              {/* The rank is the list's own position, which `<ol>` already
                  says to a screen reader: drawn, not read twice. One line has
                  nothing to be ranked against, so it draws none (#1147). */}
              {moved.length === 1 ? null : (
                <span aria-hidden className="w-4 shrink-0 text-right text-xs text-muted-foreground">
                  {index + 1}
                </span>
              )}
              {/* The identity, set as a mark rather than as a word: a ticker
                    is read as a badge and it is what pairs a line here to the
                    same line in the table one page over. */}
              <span
                aria-hidden
                className="flex size-7.5 shrink-0 items-center justify-center rounded-lg bg-accent font-mono text-2xs font-semibold text-muted-foreground"
              >
                {tickerBadge(mover.symbol)}
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
        </ol>
      )}
      {others === 0 ? null : (
        <p className="mt-3 text-xs text-muted-foreground">
          {/* Every hidden line unchanged is said once, not as « dont 11 » of 11 (#1146). */}
          {unchanged === others
            ? t('dashboard.movers.othersAllUnchanged', { count: others })
            : t('dashboard.movers.others', { count: others, unchanged })}
        </p>
      )}
    </Section>
  )
}
