/**
 * A share's own surface — **the one place ADR-0016's form appears naked**
 * (#720).
 *
 * `Gain total` visually dominating its three terms is possible here and nowhere
 * else on the page, for a reason of geometry rather than of taste: **a block is
 * the only place subordination can be expressed.** A table row has the
 * horizontal axis and nothing else, so a total mounted beside its terms is five
 * numeric columns of equal weight and nothing says the last three are *inside*
 * the first — which is the addition ADR-0018 exists to prevent. Here the total
 * is the head, the three terms hang **under** it, inside its own group, and the
 * nesting is the statement.
 *
 * The position facts — `Cours · PRU · Détenu · Valorisation · Investi` — drop to
 * a second rank behind it. They are what the position *is*; the gain is what the
 * page is about.
 *
 * **The sheet shrinks, and the room is not filled back in.** Three things left
 * and each for its own reason:
 *
 *  - **`RuntimeDetail`** — a per-account backfill readout on a **share**'s card.
 *    It answered a question about the app's own progress on a surface about a
 *    security, and `/api/runtime` has a page where that belongs.
 *  - **the per-account breakdown at one account**, which repeated the header
 *    line for line. It comes back the moment a share is held on two accounts
 *    (`lib/shares.ts`'s `accountBreakdown`), which is the ordinary case of the
 *    domain.
 *  - **`Variation`** — the percentage already glued to the latent gain in the
 *    table, and a second announcer of one figure is the defect this product
 *    refuses on four pages.
 *
 * What stays is the chart, the event list and the fundamentals — and the chart
 * and the list are now **one object**: the liaison between them is a selection
 * of a **day**, never a hover (ADR-0016).
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Refusal } from '@/components/Refusal'
import { Explain } from '@/components/Explain'
import { Stat } from '@/components/Stat'
import { PriceChart } from '@/components/shares/PriceChart'
import { ShareEvents } from '@/components/shares/ShareEvents'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { positionRenderings, renderFigure } from '@/lib/absence'
import { api, type ChartWindow, type Position } from '@/lib/api'
import type { DocsAnchor } from '@/lib/docs'
import { useFormatters } from '@/lib/format'
import {
  gainTotal,
  securityTerms,
  sumRendering,
  termAmount,
  termCarriesSign,
  termRendering,
  type GainTermName,
} from '@/lib/gain'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import {
  accountBreakdown,
  marketValue,
  shareEvents,
  unitCost,
  unrealised,
  type ShareRow,
} from '@/lib/shares'
import { signClass } from '@/lib/sign'

/** Three terms and not four: no security carries the fees taken from a transfer. */
const SHEET_TERMS = ['unrealised', 'realised', 'dividends'] as const

const TERM_LABELS: Record<(typeof SHEET_TERMS)[number], MessageKey> = {
  unrealised: 'gain.term.unrealised',
  realised: 'gain.term.realised',
  dividends: 'gain.term.dividends',
}

const TERM_EXPLAIN: Record<(typeof SHEET_TERMS)[number], { body: MessageKey; anchor: DocsAnchor }> =
  {
    unrealised: { body: 'shares.unrealised.explain', anchor: 'latent-gain' },
    realised: { body: 'shares.realised.explain', anchor: 'realized-gain' },
    dividends: { body: 'shares.dividends.explain', anchor: 'dividends' },
  }

export interface ShareSheetProps {
  row: ShareRow | null
  /**
   * The whole payload's rows — the breakdown is per `(account, symbol)` and this
   * sheet's `row` has already folded them. Filtering here rather than carrying a
   * pre-built list keeps one shape crossing the boundary.
   */
  positions: readonly Position[]
  failures: ReadonlyMap<string, number>
  currency: string | null
  onClose: () => void
}

export function ShareSheet({ row, positions, failures, currency, onClose }: ShareSheetProps) {
  const { t } = useI18n()
  const f = useFormatters()
  // The range is the sheet's, not the chart's: reopening on another share keeps
  // the range the reader last chose, which is the one thing a chart control
  // must not forget between two lines of the same table.
  const [window, setWindow] = useState<ChartWindow>('1Y')
  // The selection is a **day**, and it is the sheet's because two objects share
  // it. `scrollRequest` is bumped by the chart alone — see `ShareEvents`.
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [scrollRequest, setScrollRequest] = useState(0)

  const symbol = row?.symbol ?? null
  // The ledger, whole and from process memory — `GET /api/events` opens no store
  // (#764), so this list survives the one failure that empties the page under it.
  // Read only while a sheet is open: the page under it owes the ledger nothing.
  const ledger = useQuery({
    queryKey: ['events'],
    queryFn: api.events,
    enabled: symbol !== null,
  })

  const events = useMemo(
    () => (symbol === null ? [] : shareEvents(ledger.data ?? [], symbol)),
    [ledger.data, symbol],
  )

  // A selection is about one security: carrying it to the next sheet would mark
  // a day that share has no event on, and grow a marker that is not there.
  useEffect(() => {
    setSelectedDay(null)
    setScrollRequest(0)
  }, [symbol])

  // Nothing to render, and nothing to hand a handler to: `Sheet` is Radix's
  // Dialog `Root`, so with no `SheetTrigger` and no `SheetContent` under it
  // nothing is mounted and no gesture — Escape, the overlay, a trigger — can
  // ever reach `onOpenChange`. The closed Root was an empty element carrying a
  // callback that could not fire.
  if (row === null) {
    return null
  }

  const held = positions.filter((position) => position.symbol === row.symbol)
  // `securityTerms` and not `portfolioTerms(held, null)`: a security is not a
  // place money is transferred to, so the fourth term has no subject here —
  // where `null` says *there is no day to bound existing fees by* (#775).
  const terms = securityTerms(held)
  const total = gainTotal(terms)
  const renderings = positionRenderings(row)
  const value = marketValue(row)
  const breakdown = accountBreakdown(positions, row.symbol, failures)

  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full gap-6 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{row.name ?? row.symbol}</SheetTitle>
          <SheetDescription>{t('shares.sheet.description')}</SheetDescription>
        </SheetHeader>

        <div className="space-y-8 px-4 pb-8">
          {/* ADR-0016's form, naked: the total, then its terms **under** it and
              inside its own group. Vertical, because subordination is. */}
          <Stat
            size="head"
            label={t('shares.gainTotal')}
            value={renderFigure(
              sumRendering(total),
              () => f.currency(total.known ? total.value : null, currency),
              t,
            )}
            valueClassName={signClass(total.known ? total.value : null)}
            explain={
              <Explain
                figure={t('shares.gainTotal')}
                body="shares.sheet.gainTotal.explain"
                anchor="total-gain"
              />
            }
          >
            <ul className="mt-3 flex flex-col gap-3 border-t pt-3">
              {SHEET_TERMS.map((term) => {
                const amount = termAmount(terms, term as GainTermName)
                return (
                  <li key={term}>
                    <Stat
                      size="term"
                      label={t(TERM_LABELS[term])}
                      value={renderFigure(
                        termRendering(terms, term as GainTermName),
                        () => f.currency(amount, currency),
                        t,
                      )}
                      valueClassName={
                        amount === null
                          ? signClass(null)
                          : termCarriesSign(term as GainTermName)
                            ? signClass(amount)
                            : signClass(0)
                      }
                      explain={
                        <Explain
                          figure={t(TERM_LABELS[term])}
                          body={TERM_EXPLAIN[term].body}
                          anchor={TERM_EXPLAIN[term].anchor}
                        />
                      }
                    />
                  </li>
                )
              })}
            </ul>
          </Stat>

          {/* Second rank. `Cours` and `Valorisation` carry no bubble here for the
              reason the table's own headers do not: the carrying rule is stated
              once, on the page header this sheet was opened from. */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-t pt-6 sm:grid-cols-3">
            <Stat
              size="term"
              label={t('shares.column.price')}
              value={renderFigure(
                renderings.price,
                () => f.currency(row.price?.value ?? null, row.price?.currency ?? currency),
                t,
              )}
            />
            <Stat
              size="term"
              label={t('shares.column.avgCost')}
              value={f.currency(unitCost(row), currency)}
              explain={
                <Explain
                  figure={t('shares.column.avgCost')}
                  body="shares.avgCost.explain"
                  anchor="avg-cost"
                />
              }
            />
            <Stat
              size="term"
              label={t('shares.column.quantity')}
              value={f.quantity(row.quantity)}
            />
            <Stat
              size="term"
              label={t('shares.column.value')}
              value={renderFigure(renderings.valuation, () => f.currency(value, currency), t)}
            />
            {/* `Investi` is `Valorisation − latente`, which is why it is not a
                tenth column in the table and is here instead. */}
            <Stat
              size="term"
              label={t('shares.column.invested')}
              value={f.currency(row.cost_basis, currency)}
            />
          </div>

          <div className="space-y-6 border-t pt-6">
            <PriceChart
              symbol={row.symbol}
              window={window}
              onWindowChange={setWindow}
              // **An optional read, so the `?? []` survives** (ADR-0026): with
              // no ledger the chart draws no marker rail — *a band with nothing
              // in it does not exist* — which removes a line rather than
              // falsifying one, and the price series under it is this block's
              // own subject. The list below waits for the same read and is
              // guarded on `ledger.data`, because there *empty* would read as
              // *this security has no event*.
              events={ledger.data ?? []}
              selectedDay={selectedDay}
              onSelectDay={(day) => {
                setSelectedDay((previous) => (previous === day ? null : day))
                setScrollRequest((request) => request + 1)
              }}
            />

            {ledger.error ? (
              <Refusal>{t(problemMessageKey(ledger.error))}</Refusal>
            ) : !ledger.data ? null : (
              <ShareEvents
                events={events}
                currency={currency}
                selectedDay={selectedDay}
                onSelectDay={(day) =>
                  setSelectedDay((previous) => (previous === day ? null : day))
                }
                scrollRequest={scrollRequest}
              />
            )}
          </div>

          {/* Absent at one account: it would repeat the block above it. */}
          {breakdown.length === 0 ? null : (
            <section className="space-y-3 border-t pt-6">
              <h3 className="text-sm font-medium">{t('shares.breakdown.title')}</h3>
              <Table>
                <caption className="sr-only">{t('shares.breakdown.label')}</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('shares.column.account')}</TableHead>
                    <TableHead className="text-right">{t('shares.column.quantity')}</TableHead>
                    <TableHead className="text-right">{t('shares.column.avgCost')}</TableHead>
                    <TableHead className="text-right">{t('shares.column.value')}</TableHead>
                    <TableHead className="text-right">{t('shares.column.unrealised')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {breakdown.map((line) => {
                    const lineRenderings = positionRenderings(line)
                    const lineValue = marketValue(line)
                    const lineGain = unrealised(line)
                    return (
                      <TableRow key={line.accounts[0]}>
                        {/* One account per line by construction, so plain text
                            and never a list of one (#684 D11). */}
                        <TableCell>{line.accounts[0]}</TableCell>
                        <TableCell className="text-right tabular">
                          {f.quantity(line.quantity)}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {f.currency(unitCost(line), currency)}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {renderFigure(
                            lineRenderings.valuation,
                            () => f.currency(lineValue, currency),
                            t,
                          )}
                        </TableCell>
                        <TableCell
                          className={`text-right tabular ${
                            lineRenderings.unrealised.kind === 'figure'
                              ? signClass(lineGain)
                              : signClass(null)
                          }`}
                        >
                          {renderFigure(
                            lineRenderings.unrealised,
                            () => f.currency(lineGain, currency),
                            t,
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </section>
          )}

          <Fundamentals row={row} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * What the instrument **is** — and *a block with nothing in it does not exist*
 * (#724's rule, applied here): a symbol the fetch has never reached renders no
 * block at all rather than five em dashes.
 *
 * A member that is absent inside a present block is the other absence and the
 * ordinary one — yfinance publishes no `pe_ratio` for an ETF — so the line is
 * simply not written, and `quote_type` beside it is what makes that legible
 * rather than suspicious.
 */
function Fundamentals({ row }: { row: ShareRow }) {
  const { t } = useI18n()
  const f = useFormatters()
  const attributes = row.fundamentals
  if (attributes === null) return null

  const lines = ([
    { label: 'shares.fundamentals.exchange', value: attributes.exchange },
    { label: 'shares.fundamentals.quoteType', value: attributes.quote_type },
    { label: 'shares.fundamentals.currency', value: attributes.currency },
    {
      label: 'shares.fundamentals.dividendYield',
      value:
        attributes.dividend_yield === null
          ? null
          : f.percentPoints(attributes.dividend_yield),
    },
    {
      label: 'shares.fundamentals.peRatio',
      value: attributes.pe_ratio === null ? null : f.number(attributes.pe_ratio),
    },
    {
      label: 'shares.fundamentals.marketCap',
      value:
        attributes.market_cap === null
          ? null
          : f.compact(attributes.market_cap, attributes.currency),
    },
  ] satisfies { label: MessageKey; value: string | null }[]).filter(
    (line) => line.value !== null,
  )

  if (lines.length === 0) return null

  return (
    <section className="space-y-3 border-t pt-6">
      <h3 className="text-sm font-medium">{t('shares.fundamentals.title')}</h3>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
        {lines.map((line) => (
          <div key={line.label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{t(line.label)}</dt>
            <dd className="tabular">{line.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
