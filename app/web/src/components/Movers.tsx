import type { Mover } from '@/lib/api'
import { formatCurrency, formatDate, formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * "What is moving" — the other half of #652 déc. 8's third block, and the
 * second objective gap of the Grafana baseline it names: there, the information
 * exists but is spread across a row repeated once per share, which cannot be
 * sorted, so it is unreadable by construction.
 *
 * Two columns rather than one ranked list, because a portfolio's news is
 * two-sided and a single list buries whichever end is shorter.
 *
 * The percentage is the rank; the euro figure beside it is what the move was
 * *worth*. Both are needed and neither replaces the other — a 12 % jump on a
 * token holding and a 0.4 % drift on the biggest line look nothing alike in
 * percent and can be the same money.
 */

/** How many names each column shows. Beyond that it stops being news. */
const TOP_N = 5

interface Props {
  movers: Mover[]
  /**
   * The close the moves are measured from — stated, not implied.
   *
   * This is the API's `reference` (an observed price's timestamp), **never** its
   * `since` (the midnight cut). Found by looking at the page: on the afternoon
   * of 5 August the cut is 5 August 00:00, and the block read « depuis la
   * clôture du 5 août 2026 » — a close that had not happened yet.
   */
  reference: string | null
}

export function Movers({ movers, reference }: Props) {
  const risers = movers.filter((m) => (m.change ?? 0) > 0).slice(0, TOP_N)
  const fallers = movers
    .filter((m) => (m.change ?? 0) < 0)
    .slice(-TOP_N)
    .reverse()

  if (movers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aucune variation mesurable : il faut au moins deux séances enregistrées.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {/* Naming the baseline is the point of the trap. On a Sunday this reads
          "depuis le 31 juil." and not "aujourd'hui", which is the difference
          between a truthful empty block and a misleading full one. */}
      <p className="text-xs text-muted-foreground">
        Depuis la clôture du {formatDate(reference)}
      </p>

      <div className="grid gap-6 sm:grid-cols-2">
        <Column title="Hausses" rows={risers} empty="Aucune hausse." />
        <Column title="Baisses" rows={fallers} empty="Aucune baisse." />
      </div>

      {/* A share on its first day has nothing to compare against — it has not
          failed to move. Saying so beats a silently shorter list. */}
      {movers.every((m) => m.change === 0) && (
        <p className="text-xs text-muted-foreground italic">
          Aucun marché n'a rouvert depuis cette clôture.
        </p>
      )}
    </div>
  )
}

function Column({
  title,
  rows,
  empty,
}: {
  title: string
  rows: Mover[]
  empty: string
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((mover) => (
            <li key={mover.symbol} className="flex items-baseline gap-3 text-sm">
              <span className="w-20 shrink-0 truncate font-medium">{mover.symbol}</span>
              <span className="flex-1 truncate text-muted-foreground">
                {mover.name ?? ''}
              </span>
              <span
                className={cn(
                  'tabular w-20 shrink-0 text-right font-medium',
                  signClassOf(mover.change),
                )}
              >
                {formatPercent(mover.change_pct)}
              </span>
              <span
                className={cn(
                  'tabular w-24 shrink-0 text-right text-xs',
                  signClassOf(mover.change),
                )}
              >
                {formatCurrency(mover.contribution, mover.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Colour follows the **move**, not the percentage.
 *
 * They disagree exactly once, and it is worth guarding: a position whose
 * baseline price was zero has a real change and a `null` percentage, and reading
 * the colour off the ratio would render a genuine move as neutral grey.
 */
function signClassOf(change: number | null): string {
  if (change === null || change === 0) return 'text-muted-foreground'
  return change > 0 ? 'text-[var(--gain)]' : 'text-[var(--loss)]'
}
