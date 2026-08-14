/**
 * The shares page (#719, ADR-0017, ADR-0016).
 *
 * The page the owner actually opens, and the one that carried the most wrong
 * figure in the product: `Plus-value latente 335,22 €`, holding **−1 288,32 €**
 * of phantom loss from three closed positions valued at `0,00 €`. What repairs
 * it is not a better sum, it is a coupling: **the header sums the lines it sits
 * above, so the closed positions never leave the table — they fold.**
 *
 * Three page-level objects and each is a decision:
 *
 *  - **One mention of the date**, under the title — *Cours au 7 août 2026,
 *    17:42* — and never a column. A table of money with no date reads as *now*,
 *    which is true of most lines and false of two families: one carried at its
 *    cost, one whose last reading is old. Both already say so by the absence
 *    rule, so a *last reading* column would be the fourth near-constant column
 *    of a page that has just deleted one.
 *  - **The anomaly counter, which *is* the filter at a click.** The per-row
 *    market pill is dead — ten identical *Marché ouvert* out of eleven — and the
 *    exception it hid is an icon on the `Titre` cell plus this counter. The
 *    counter is what keeps #659's sorting argument (*at forty symbols, show me
 *    the ones that are not writing is one click*) without paying a column, and
 *    the header is the only place where the **absence** of an anomaly reads as
 *    information rather than as a void.
 *  - **No *hide the closed ones* switch, anywhere.** It is the whole point.
 *
 * **And one reduction, `?compte=`** (#722), which an account's panel leads to in
 * place of a positions table of its own. It is not the switch this page refuses:
 * that one hid a *part of the table the header summed*, silently and with
 * nothing on screen able to say which of two correct figures was the owner's
 * gain. This one **states itself with the account it names, offers the way out,
 * and the header goes on summing the lines it sits above** — reduced, those are
 * the account's lines, and the total is that account's. It names the account by
 * its **id**, which is what the `Compte` column of this table already renders:
 * one naming on one page, rather than a fifth read to fetch a label that would
 * disagree with the column beside it.
 *
 * Reads and failures follow the dashboard head's rule and for the same reason:
 * `/api/runtime` answers from process memory and never opens the store (#668),
 * so the shell's banner is silent on the one failure that empties this page.
 * `lib/status.ts` keeps the causal order across the two surfaces, so there is
 * one band on screen or none.
 */
import { useMemo, useState } from 'react'
import { Link, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { Band } from '@/components/Band'
import { EmptyState } from '@/components/EmptyState'
import { ClosedShares } from '@/components/shares/ClosedShares'
import { SharesHead } from '@/components/shares/SharesHead'
import { SharesTable } from '@/components/shares/SharesTable'
import { ShareSheet } from '@/components/shares/ShareSheet'
import { api } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { buildShareRows, closedRows, heldRows, isAnomalous } from '@/lib/shares'
import { oneBand, readConditions } from '@/lib/status'
import { cn } from '@/lib/utils'

export default function SharesPage() {
  const { t } = useI18n()
  const f = useFormatters()
  const [onlyAnomalies, setOnlyAnomalies] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const { compte = null } = useSearch({ from: '/titres' })

  const positions = useQuery({ queryKey: ['positions'], queryFn: api.positions })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })

  // The counter of fruitless readings is what separates *asked and got nothing*
  // from *not asked yet*, and it lives on the app's own state — never in the
  // data payload (rule four of the map, the only one proved in production).
  const failures = useMemo(
    () => new Map((runtime.data?.symbols ?? []).map((s) => [s.symbol, s.consecutive_failures])),
    [runtime.data],
  )

  // The reduction is applied to the **positions**, before the folding: a row of
  // this page is a symbol across its accounts (`lib/shares.ts`), so reducing
  // afterwards would keep a line held on two accounts whole and state the other
  // account's quantity under a bar naming this one.
  const reduced = useMemo(() => {
    const all = positions.data?.positions ?? []
    return compte === null ? all : all.filter((position) => position.account === compte)
  }, [positions.data, compte])

  const rows = useMemo(() => buildShareRows(reduced, failures), [reduced, failures])

  const failure = oneBand(
    readConditions({ shellError: runtime.error, errors: [positions.error] }),
  )

  const held = heldRows(rows)
  const closed = closedRows(rows)
  const anomalies = held.filter(isAnomalous)
  const shown = onlyAnomalies ? anomalies : held
  const currency = positions.data?.base_currency ?? null

  // **What the header sums**, and it is the literal sentence of ADR-0017: the
  // rows it sits above. The folded ones are in that set — a fold is not a
  // filter, so opening the section moves nothing — and the anomaly lens is,
  // which is the other half of the same rule: a header that went on stating the
  // portfolio's gain over a table showing one line would be read as that line's
  // summary, which is the very reading the *hide the closed ones* switch was
  // deleted for. The lens is a diagnostic and it names itself, pressed, on
  // screen; the switch was a setting whose effect was invisible.
  const onScreen = [...shown, ...closed]
  const onScreenSymbols = new Set(onScreen.map((row) => row.symbol))
  // Off the **reduced** set, not the payload: a symbol held on two accounts has
  // a row on each, and summing both under a header naming one account is the
  // *other correct figure* again, one axis over.
  const summed = reduced.filter((position) => onScreenSymbols.has(position.symbol))

  // The freshest quote the page holds — one instant for the whole table. There
  // is nothing to date when nothing has ever been quoted, and an invented
  // *now* would be the very reading the mention exists to prevent.
  const pricedAt = rows.reduce<string | null>(
    (newest, row) =>
      row.price !== null && (newest === null || row.price.at > newest) ? row.price.at : newest,
    null,
  )

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('page.shares')}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {pricedAt === null ? null : <p>{t('shares.pricedAt', { date: f.dateTime(pricedAt) })}</p>}
          {/* At zero it is a sentence, not a control: there is nothing to filter
              to, and the absence is the information. */}
          {anomalies.length === 0 ? (
            <p>{t('shares.anomaly.count', { count: 0 })}</p>
          ) : (
            <button
              type="button"
              aria-pressed={onlyAnomalies}
              onClick={() => setOnlyAnomalies((previous) => !previous)}
              className={cn(
                'rounded underline underline-offset-4',
                onlyAnomalies ? 'text-attention' : 'text-muted-foreground',
              )}
            >
              {t('shares.anomaly.count', { count: anomalies.length })}
            </button>
          )}
        </div>
      </header>

      {failure ? <Band>{t(failure.message)}</Band> : null}

      {/* **The reduction states itself, with the account it names and the way
          out.** A table silently shorter than expected is the defect #724 met
          on the ledger, and it is worse here: the header over it is a *sum* of
          the lines it shows. */}
      {compte === null ? null : (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <p>{t('shares.reduced', { account: compte })}</p>
          <Link
            to="/titres"
            search={{}}
            className="text-muted-foreground underline underline-offset-4"
          >
            {t('shares.reduced.undo')}
          </Link>
        </div>
      )}

      {/* A read that has not landed is not a fact: nothing is claimed while the
          positions are in flight, and above all not the sentence that says the
          portfolio is empty. Reduced, *empty* is a different sentence — the
          portfolio's own emptiness would be a claim about the reader's data
          made on the strength of a filter they can lift in one click. */}
      {failure || !positions.data ? null : rows.length === 0 ? (
        compte !== null ? (
          <EmptyState
            title={t('shares.reduced.empty.title')}
            description={t('shares.reduced.empty.body', { account: compte })}
            action={
              <Link to="/titres" search={{}} className="font-medium underline underline-offset-4">
                {t('shares.reduced.undo')}
              </Link>
            }
          />
        ) : (
          <EmptyState
            title={t('shares.empty.title')}
            description={t('shares.empty.body')}
            action={
              <Link to="/donnees" className="font-medium underline underline-offset-4">
                {t('shares.empty.link')}
              </Link>
            }
          />
        )
      ) : (
        <>
          {/* The rows it sits above, closed ones included — the argument is the
              rule, and handing it the held lines alone is what printed the
              other correct figure. */}
          <SharesHead positions={summed} rows={onScreen} currency={currency} />
          <SharesTable rows={shown} currency={currency} onSelect={setSelected} />
          <ClosedShares rows={closed} currency={currency} onSelect={setSelected} />
        </>
      )}

      {/* The raw rows go with the folded one: the sheet's per-account breakdown
          is keyed by `(account, symbol)`, which is exactly what `buildShareRows`
          has just folded away. */}
      <ShareSheet
        row={rows.find((row) => row.symbol === selected) ?? null}
        positions={reduced}
        failures={failures}
        currency={currency}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}
