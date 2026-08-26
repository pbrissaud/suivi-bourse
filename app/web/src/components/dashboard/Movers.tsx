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
 * **The right rail, and the ticker on every line** (#790). The block sits in
 * the narrow column of the plateau, so the two columns of five stack there and
 * spread again the moment the card has the width; and each line carries its
 * **symbol** beside the name, which is the identity the rest of the product
 * addresses a security by — `lib/api.ts`'s own rule, `symbol` being the
 * identity and `name` display only. A rail of names alone cannot be matched to
 * the allocation's legend, to the shares table, or to a broker's own screen.
 *
 * The reference close is named here and nowhere else. It is the **second** of
 * the page's two permanent time announcers — the first is the page's own price
 * mention — and it is a different instant from it: the block compares against
 * the previous session, the page states the last observation. Naming the *cut*
 * instead of the close it found announced a session that had not happened yet.
 */
import { EmptyState } from '@/components/EmptyState'
import { Unreadable } from '@/components/Unreadable'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import type { Mover } from '@/lib/api'
import { moversSplit } from '@/lib/dashboard'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ShareRow } from '@/lib/shares'
import { signClass } from '@/lib/sign'
import type { ReadFailure } from '@/lib/status'

export interface MoversProps {
  /**
   * What the server compared, or **`null` while `/api/portfolio/movers` is in
   * flight** (ADR-0026).
   *
   * The request is armed only once the page has reached its `portfolio` state,
   * so there is a real window between the table appearing and this answering —
   * and over it `?? []` put the `EmptyState` *« Rien à comparer »* **and** the
   * sentence *« N autres lignes n'apparaissent pas ici, dont aucune n'a bougé de
   * rien »* on screen together, two statements about a portfolio whose
   * movements had not been read. Its sibling block of the same ticket does the
   * opposite and does it on purpose.
   */
  movers: readonly Mover[] | null
  /** The instant the comparison is made against. `null` — nothing to compare. */
  reference: string | null
  /** The portfolio's lines, closed ones included — the block reduces them itself. */
  rows: readonly ShareRow[]
  currency: string | null
  /**
   * The block's own read, refused — `null` when it did answer or is still in
   * flight. In flight there is nothing to say yet; refused, the slot says so
   * rather than disappearing without a word (#829, ADR-0037).
   */
  failure?: ReadFailure | null
}

export function Movers({ movers, reference, rows, currency, failure = null }: MoversProps) {
  const { t } = useI18n()
  const f = useFormatters()

  // **Nothing at all, title included** (ADR-0026): a frame with an empty body
  // is a hand-written skeleton, and this product has none. The block appears by
  // a jolt rather than fading in, and that cost is accepted.
  //
  // Unless the read was **refused**, which is not the same silence: the slot
  // then says the comparison could not be read, in the place it would have
  // been (#829, ADR-0037).
  if (movers === null) return failure === null ? null : <Unreadable failure={failure} />

  const { risers, fallers, others, unchanged } = moversSplit(movers, rows)

  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">{t('dashboard.movers.title')}</h2>
        {reference === null ? null : (
          <p className="text-sm text-muted-foreground">
            {t('dashboard.movers.since', { date: f.dateTime(reference) })}
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {risers.length === 0 && fallers.length === 0 ? (
          <EmptyState
            title={t('dashboard.movers.empty')}
            description={t('dashboard.movers.empty.body')}
          />
        ) : (
          // Two columns where there is room, stacked in the rail — the rail
          // being where this block lives on the plateau.
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-1">
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
      </CardContent>
    </Card>
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
              <span className="flex min-w-0 items-baseline gap-2">
                {/* The identity, then what it is called: a rail of names alone
                    cannot be matched to anything else on the page. */}
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {mover.symbol}
                </span>
                {/* And the name only where there is one: `name` is display
                    only, and a symbol printed twice names nothing twice. */}
                {mover.name === null ? null : (
                  <span className="min-w-0 truncate">{mover.name}</span>
                )}
              </span>
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
