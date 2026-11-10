/**
 * One title's page (« Relevé », `/shares/<symbol>`): what the sheet used to be,
 * on the ground.
 *
 * In order: the line's valuation as the hero with its latent gain and holding;
 * the reference points (price, first purchase, number of purchases); a
 * two-colour bar of what was invested and what it gained, with the three terms
 * of the gain under it; the price chart with the purchases and the average
 * purchase price; then two sections — the last events, and what the title is.
 *
 * Nothing here is computed from a read that did not answer: the ledger's two
 * blocks wait for it, and an unreadable ledger is said where they would be.
 */
import { useAccountNames } from '@/hooks/use-account-names'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

import { Section } from '@/components/ui/section'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Unreadable } from '@/components/Unreadable'
import { PriceChart } from '@/features/shares/components/PriceChart'
import type { LedgerEvent, LedgerEventType } from '@/features/data/lib/api'
import { cashFlow } from '@/features/data/lib/ledger'
import type { ChartWindow } from '@/features/shares/lib/api'
import { positionRenderings, renderFigure } from '@/lib/absence'
import { ABSENT, useFormatters } from '@/lib/format'
import { securityTerms, termAmount, termRendering, termTone } from '@/lib/gain'
import { isMessageKey, useI18n, type MessageKey } from '@/lib/i18n'
import { dayTone } from '@/features/shares/components/SharesTable'
import {
  marketValue,
  purchaseStats,
  shareEvents,
  unitCost,
  unrealised,
  unrealisedRatio,
  weightShare,
  type ShareRow,
} from '@/features/shares/lib/shares'
import type { Position } from '@/features/shares/lib/api'
import type { ReadFailure } from '@/lib/status'
import { toneOf } from '@/lib/sign'

const TYPE_LABEL: Record<LedgerEventType, MessageKey> = {
  BUY: 'event.type.BUY',
  SELL: 'event.type.SELL',
  GRANT: 'event.type.GRANT',
  DIVIDEND: 'event.type.DIVIDEND',
  DEPOSIT: 'event.type.DEPOSIT',
  WITHDRAWAL: 'event.type.WITHDRAWAL',
}

/** The events the section lists: the most recent, the rest being the ledger's. */
const RECENT_EVENTS = 4

interface ShareDetailProps {
  row: ShareRow
  /** The positions of this symbol, one per account. */
  positions: readonly Position[]
  currency: string | null
  /** What the weight is a share of: the value of every line held. */
  whole: number
  /** The day's move, as a ratio, when the movers answered. */
  move: number | null
  /** The ledger, whole; `null` while it is in flight. */
  ledger: readonly LedgerEvent[] | null
  ledgerFailure: ReadFailure | null
  window: ChartWindow
  onWindowChange: (window: ChartWindow) => void
}

export function ShareDetail({
  row,
  positions,
  currency,
  whole,
  move,
  ledger,
  ledgerFailure,
  window,
  onWindowChange,
}: ShareDetailProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const renderings = positionRenderings(row)
  const value = marketValue(row)
  const gain = unrealised(row)
  const ratio = unrealisedRatio(row)
  const terms = securityTerms(positions)
  const average = unitCost(row)
  const stats = ledger === null ? null : purchaseStats(ledger, row.symbol)
  const share = weightShare(row, whole)

  // What was invested and what it made, as shares of the valuation. A loss draws
  // the cost alone: there is no gain to colour.
  const parts =
    value !== null && value > 0 && gain !== null
      ? { invested: Math.min(row.cost_basis, value), gain: Math.max(value - row.cost_basis, 0) }
      : null

  return (
    <div className="flex flex-col">
      <p className="mb-5 text-sm">
        <Link
          to="/shares"
          search={{}}
          className="text-muted-foreground no-underline hover:text-foreground"
        >
          {t('shares.fiche.back')}
        </Link>
      </p>

      <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
        <div className="flex min-w-0 flex-col gap-2.5">
          <p className="text-muted-foreground">{t('shares.fiche.value')}</p>
          <p className="fig text-hero font-medium tracking-hero">
            {renderFigure(renderings.valuation, () => f.currency(value, currency), t)}
          </p>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className={`fig text-2xl font-medium ${toneOf(renderings.unrealised, gain)}`}>
              {renderFigure(renderings.unrealised, () => f.signedCurrency(gain, currency), t)}
            </span>
            {renderings.unrealised.kind === 'figure' && ratio !== null ? (
              <span className={`fig text-prose ${toneOf(renderings.unrealised, gain)}`}>
                ({f.percent(ratio)})
              </span>
            ) : null}
            <span className="text-muted-foreground">{t('shares.fiche.gain')}</span>
            {row.quantity === 0 ? null : (
              <>
                <span aria-hidden className="text-border">
                  ·
                </span>
                <span className="text-muted-foreground">
                  <span className="fig text-foreground">{f.quantity(row.quantity)}</span>{' '}
                  {t('shares.fiche.unitsAt', { count: row.quantity })}{' '}
                  <span className="fig text-foreground">{f.currency(average, currency)}</span>
                </span>
              </>
            )}
          </p>
        </div>

        <dl
          aria-label={t('shares.fiche.facts')}
          className="grid grid-cols-[auto_auto] items-baseline gap-x-6 gap-y-1.5 pb-1.5"
        >
          <dt className="text-right text-sm text-muted-foreground">{t('shares.fiche.price')}</dt>
          <dd className="text-right">
            <span className="fig text-md">
              {renderFigure(
                renderings.price,
                () => f.currency(row.price?.value ?? null, row.price?.currency ?? currency),
                t,
              )}
            </span>{' '}
            {move === null ? null : (
              <span className={`fig text-xs ${dayTone(move)}`}>{f.percent(move)}</span>
            )}
          </dd>
          {stats === null ? null : (
            <>
              <dt className="text-right text-sm text-muted-foreground">
                {t('shares.fiche.firstBuy')}
              </dt>
              <dd className="fig text-right text-md">{f.date(stats.first)}</dd>
              <dt className="text-right text-sm text-muted-foreground">{t('shares.fiche.buys')}</dt>
              <dd className="fig text-right text-md">
                {t('shares.fiche.buysIn', { count: stats.count, months: stats.months })}
              </dd>
            </>
          )}
        </dl>
      </div>

      {parts === null || value === null ? null : (
        <div className="mt-5 flex flex-col gap-2.5">
          <div
            role="img"
            aria-label={t('shares.fiche.bar', {
              invested: f.percentPoints((parts.invested / value) * 100, 1),
              gain: f.percentPoints((parts.gain / value) * 100, 1),
            })}
            className="flex h-2.5 gap-0.5 overflow-hidden rounded-xs"
          >
            <span
              className="block"
              style={{ flex: Math.round(parts.invested * 1000), backgroundColor: 'var(--alloc-5)' }}
            />
            {parts.gain === 0 ? null : (
              <span
                className="block"
                style={{ flex: Math.round(parts.gain * 1000), backgroundColor: 'var(--gain)' }}
              />
            )}
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5">
            <p className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
              <span className="inline-flex items-baseline gap-2">
                <span
                  aria-hidden
                  className="size-2 self-center rounded-xs"
                  style={{ backgroundColor: 'var(--alloc-5)' }}
                />
                <span className="text-muted-foreground">{t('shares.column.invested')}</span>
                <span className="fig text-prose">{f.currency(row.cost_basis, currency)}</span>
              </span>
              <span className="inline-flex items-baseline gap-2">
                <span
                  aria-hidden
                  className="size-2 self-center rounded-xs"
                  style={{ backgroundColor: 'var(--gain)' }}
                />
                <span className="text-muted-foreground">{t('shares.fiche.gainLabel')}</span>
                <span className={`fig text-prose ${toneOf(renderings.unrealised, gain)}`}>
                  {renderFigure(renderings.unrealised, () => f.signedCurrency(gain, currency), t)}
                </span>
              </span>
            </p>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {(['unrealised', 'realised', 'dividends'] as const).map((term) => (
                <span key={term}>
                  {t(`shares.column.${term}`)}{' '}
                  <span className={`fig ${termTone(terms, term)}`}>
                    {renderFigure(
                      termRendering(terms, term),
                      () => f.signedCurrency(termAmount(terms, term), currency),
                      t,
                    )}
                  </span>
                </span>
              ))}
            </p>
          </div>
        </div>
      )}

      <div className="mt-9">
        <PriceChart
          symbol={row.symbol}
          window={window}
          onWindowChange={onWindowChange}
          // An optional read, so the `?? []` survives: with no ledger the chart
          // draws no purchases, which removes a line rather than falsifying one.
          events={ledger ?? []}
          averageCost={average}
        />
      </div>

      <div className="mt-10 grid grid-cols-1 items-start gap-5 wide:grid-cols-[3fr_2fr]">
        <Events ledger={ledger} failure={ledgerFailure} symbol={row.symbol} currency={currency} />
        <Facts row={row} share={share} />
      </div>
    </div>
  )
}

function Events({
  ledger,
  failure,
  symbol,
  currency,
}: {
  ledger: readonly LedgerEvent[] | null
  failure: ReadFailure | null
  symbol: string
  currency: string | null
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const all = ledger === null ? [] : shareEvents(ledger, symbol)
  const recent = all.slice(0, RECENT_EVENTS)

  return (
    <Section
      title={t('shares.events.title')}
      aside={
        all.length > recent.length ? (
          <span className="text-sm text-muted-foreground">
            {t('shares.events.recent', { shown: recent.length, total: all.length })}
          </span>
        ) : null
      }
    >
      {failure !== null ? (
        <Unreadable failure={failure} />
      ) : ledger === null ? null : all.length === 0 ? (
        <p className="text-muted-foreground">{t('shares.events.empty')}</p>
      ) : (
        <>
          <Table>
            <caption className="sr-only">{t('shares.events.label')}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('shares.events.col.date')}</TableHead>
                <TableHead>{t('shares.events.col.kind')}</TableHead>
                <TableHead numeric>{t('shares.events.col.quantity')}</TableHead>
                <TableHead numeric>{t('shares.events.col.price')}</TableHead>
                <TableHead numeric>{t('shares.events.col.amount')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((event, index) => (
                <TableRow key={event.id ?? `${event.date}-${index}`}>
                  <TableCell className="fig text-muted-foreground">{f.date(event.date)}</TableCell>
                  <TableCell>
                    {t(TYPE_LABEL[event.event_type])}
                    {event.notes ? (
                      <span className="text-muted-foreground"> · {event.notes}</span>
                    ) : null}
                  </TableCell>
                  <TableCell numeric>
                    {event.quantity === null ? ABSENT : f.quantity(event.quantity)}
                  </TableCell>
                  <TableCell numeric>{f.currency(event.unit_price, currency)}</TableCell>
                  <TableCell numeric>{f.signedCurrency(cashFlow(event), currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-1 text-sm">
            <Link
              to="/ledger"
              search={{ symbol: [symbol] }}
              className="underline underline-offset-4"
            >
              {t('shares.events.all')}
            </Link>
          </p>
        </>
      )}
    </Section>
  )
}

/**
 * A code of the quote source (`EQUITY`, `PAR`) in the reader's words; a code
 * the glossary does not know is shown as it came rather than dropped.
 */
function named(
  t: (key: MessageKey) => string,
  prefix: string,
  code: string | null | undefined,
): string | null {
  if (!code) return null
  const key = `${prefix}.${code}`
  return isMessageKey(key) ? t(key) : code
}

/** What the title is: its nature, its place, its currency, its accounts, its weight. */
function Facts({ row, share }: { row: ShareRow; share: number | null }) {
  const { t } = useI18n()
  const f = useFormatters()
  const accountName = useAccountNames()
  const attributes = row.fundamentals
  const lines: { label: MessageKey; value: ReactNode }[] = [
    {
      label: 'shares.fundamentals.quoteType',
      value: named(t, 'shares.quoteType', attributes?.quote_type),
    },
    {
      label: 'shares.fundamentals.exchange',
      value: named(t, 'shares.exchange', attributes?.exchange),
    },
    { label: 'shares.fundamentals.currency', value: attributes?.currency ?? null },
    {
      label: 'shares.fiche.account',
      value:
        row.accounts.length === 0 ? null : (
          <span className="flex flex-wrap justify-end gap-x-3">
            {row.accounts.map((account) => (
              <Link
                key={account}
                to="/accounts"
                search={{ account }}
                className="underline underline-offset-4"
              >
                {accountName(account)}
              </Link>
            ))}
          </span>
        ),
    },
    {
      label: 'shares.fiche.weight',
      value: share === null ? null : <span className="fig">{f.percentPoints(share * 100, 1)}</span>,
    },
  ]

  return (
    <Section title={t('shares.fundamentals.title')}>
      <dl className="flex flex-col text-md">
        {lines
          .filter((line) => line.value !== null)
          .map((line) => (
            <div
              key={line.label}
              className="flex justify-between gap-4 border-b py-2 last:border-b-0"
            >
              <dt className="text-muted-foreground">{t(line.label)}</dt>
              <dd>{line.value}</dd>
            </div>
          ))}
      </dl>
    </Section>
  )
}
