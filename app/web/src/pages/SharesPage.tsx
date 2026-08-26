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
 * **Two gestures on the table itself** (#791), and neither of them removes a
 * line — which is what lets the header go on stating the sum of what is under
 * it without a word of explanation. **The order** is the reader's, by any of the
 * nine columns, and it moves rows about; **the grouping by account** cuts the
 * same rows into blocks, each with its subtotal in its own header. A partition
 * and a permutation both leave the set alone, and that is the property the page
 * is built on.
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
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { Refusal } from '@/components/Refusal'
import { EmptyState } from '@/components/EmptyState'
import { NoBaseCurrency } from '@/components/NoBaseCurrency'
import { ClosedShares } from '@/components/shares/ClosedShares'
import { SharesHead } from '@/components/shares/SharesHead'
import { SharesTable } from '@/components/shares/SharesTable'
import { ShareSheet } from '@/components/shares/ShareSheet'
import { api } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { currencyUnanswered } from '@/lib/firstRun'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import {
  DEFAULT_SORT,
  accountGroups,
  buildShareRows,
  closedRows,
  heldRows,
  isAnomalous,
  nextSort,
  type ShareGroup,
  type ShareSort,
  type SortColumn,
} from '@/lib/shares'
import { oneFailure, readConditions } from '@/lib/status'
import { cn } from '@/lib/utils'

export default function SharesPage() {
  const { t } = useI18n()
  const f = useFormatters()
  const [onlyAnomalies, setOnlyAnomalies] = useState(false)
  // The order and the grouping are **states of the page**, exactly like the
  // fold and the anomaly lens beside them — not addresses. `?titre=` and
  // `?compte=` are in the URL because something outside this page leads to
  // them (⌘K, an account's panel); nobody leads to *this table sorted by PRU*,
  // and a search parameter nothing links to is a shape to maintain for no
  // reader.
  const [sort, setSort] = useState<ShareSort>(DEFAULT_SORT)
  const [grouped, setGrouped] = useState(false)
  const { compte = null, titre = null } = useSearch({ from: '/titres' })
  const navigate = useNavigate()
  // **Which sheet is open is a URL** (#797), the same clause as the reduction
  // beside it: the ⌘K palette reaches a held security from any of the four
  // routes, and a selection kept in a state no link can carry is a place nothing
  // outside this page can lead to. The reduction rides along untouched — leaving
  // a sheet must not silently show the accounts it was reduced away from.
  //
  // **It replaces rather than pushes, in both directions.** A sheet is a modal
  // and not a place: pushed on the way in and replaced on the way out, three
  // sheets opened and dismissed leave three identical `/titres` entries the
  // reader has to press Back through before anything moves. Escape, the cross
  // and the overlay are its way out; the address exists so that somebody can
  // **arrive** at one — which is what ⌘K does — not so that the history holds a
  // record of every row that was looked at.
  const select = (symbol: string | null) =>
    void navigate({
      to: '/titres',
      search: (previous) => ({ ...previous, titre: symbol ?? undefined }),
      replace: true,
    })

  const positions = useQuery({ queryKey: ['positions'], queryFn: api.positions })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  // The same read the bell and the first-run modal compose their own
  // predicates from — one query key, so it is one request and no new API state.
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })

  // The counter of fruitless readings is what separates *asked and got nothing*
  // from *not asked yet*, and it lives on the app's own state — never in the
  // data payload (rule four of the map, the only one proved in production).
  //
  // **An optional read, so the `?? []` survives** (ADR-0026): with no counter a
  // row is *carried at its cost* instead of *N readings, no price* — a line
  // removed from a cell, never a false one — and the table must not be
  // withheld for it, `/api/runtime` being the read that answers when the store
  // does not.
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

  const failure = oneFailure(
    readConditions({ errors: [positions.error] }),
  )

  const held = heldRows(rows, sort)
  const closed = closedRows(rows)
  const anomalies = held.filter(isAnomalous)
  const shown = onlyAnomalies ? anomalies : held
  const currency = positions.data?.base_currency ?? null

  // The accounts the reduction actually holds. Below two there is nothing to
  // group — one group would repeat the page header line for line, which is the
  // reason `accountBreakdown` does not exist at one account either — so the
  // control is not offered rather than offered and inert.
  const accountCount = new Set(reduced.map((position) => position.account)).size

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

  // What the live table is made of — **one block, or one per account**. The
  // grouping is a partition of the very same lines, which is why the header
  // above does not move when it is turned on: `summed` is untouched by it.
  //
  // The positions handed to `accountGroups` are those of the **shown** symbols,
  // so a group header sums the lines it sits above exactly as the page header
  // does, the anomaly lens included.
  const shownSymbols = new Set(shown.map((row) => row.symbol))
  const shownPositions = reduced.filter((position) => shownSymbols.has(position.symbol))
  const groups: ShareGroup[] = grouped
    ? accountGroups(shownPositions, failures, sort)
    : [{ account: null, rows: shown, positions: shownPositions }]

  // The freshest quote the page holds — one instant for the whole table. There
  // is nothing to date when nothing has ever been quoted, and an invented
  // *now* would be the very reading the mention exists to prevent.
  const pricedAt = rows.reduce<string | null>(
    (newest, row) =>
      row.price !== null && (newest === null || row.price.at > newest) ? row.price.at : newest,
    null,
  )

  usePageHeading(
    t('page.shares'),
    pricedAt === null ? null : t('shares.pricedAt', { date: f.dateTime(pricedAt) }),
  )

  // **The band's sentence, one floor down** (#829, ADR-0037). With no reporting
  // currency nothing is converted and the perf job writes nothing at all, so
  // this page would be a column of em dashes with no reason given anywhere. It
  // says why instead, and the ledger — where the events are *declared* — stays
  // readable throughout.
  //
  // `=== true` and never a truthy test: `undefined` is *the config has not
  // landed*, and a page emptied on a silence would be the claim ADR-0026
  // forbids.
  if (currencyUnanswered(config.data?.settings) === true) {
    return <NoBaseCurrency />
  }

  return (
    <div className="space-y-8">
      {/* The page's name and the instant its figures are of are the header
          bar's now (#789), which leaves this line with the one thing it ever
          asserted — and a line asserting nothing does not exist, so it waits
          for the two reads rather than drawing an empty row above the table. */}
      {!positions.data || !runtime.isSuccess ? null : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {/* At zero it is a sentence, not a control: there is nothing to filter
              to, and the absence is the information.

              **And the sentence waits for both reads** (ADR-0026, the fourth
              occurrence after #775, #777 and #778). *Aucun titre en anomalie* is
              a claim, and three chains used to make it on a silence: positions
              in flight leaves `rows` empty, so the count is zero before
              anything is known; runtime in flight leaves every counter at zero,
              so `absenceCase` answers *carried at cost* where it owes *no
              quote* and three mute symbols read as none; and runtime in **error**
              hands `readConditions` a `shellError`, which short-circuits to no
              band at all — so the page said nothing was wrong on the strength
              of a read that failed. The counter is the one part of this header
              that asserts something, so it is the one part that waits. */}
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

          {/* **A partition, offered only where there is something to partition.**
              At one account the group header would repeat the page header line
              for line, which is the argument `accountBreakdown` already makes
              one file over — and a control that cannot change anything is the
              per-row marker rule met at the level of a button. */}
          {accountCount < 2 ? null : (
            <button
              type="button"
              aria-pressed={grouped}
              onClick={() => setGrouped((previous) => !previous)}
              className={cn(
                'rounded underline underline-offset-4',
                grouped ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {t('shares.group.toggle')}
            </button>
          )}
        </div>
      )}

      {failure ? <Refusal>{t(failure.message)}</Refusal> : null}

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
          <SharesTable
            groups={groups}
            currency={currency}
            sort={sort}
            onSort={(column: SortColumn) => setSort((previous) => nextSort(previous, column))}
            onSelect={select}
          />
          <ClosedShares rows={closed} currency={currency} onSelect={select} />
        </>
      )}

      {/* The raw rows go with the folded one: the sheet's per-account breakdown
          is keyed by `(account, symbol)`, which is exactly what `buildShareRows`
          has just folded away. */}
      <ShareSheet
        row={rows.find((row) => row.symbol === titre) ?? null}
        positions={reduced}
        failures={failures}
        currency={currency}
        onClose={() => select(null)}
      />
    </div>
  )
}
