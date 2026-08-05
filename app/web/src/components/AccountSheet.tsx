import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api, type AccountSummary, type Share } from '@/lib/api'
import {
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
  formatQuantity,
  signClass,
} from '@/lib/format'
import { projectToAccount } from '@/lib/positions'
import { cn } from '@/lib/utils'
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
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AccountHistoryChart } from '@/components/AccountHistoryChart'

/**
 * One account's detail sheet — the same grammar as the share sheet, over a
 * different measurement.
 *
 * Two deliberate differences from `ShareSheet`:
 *
 *  - **It does not refetch its head.** The share sheet re-reads its symbol
 *    because a single-symbol form of P1 exists; here the collection endpoint
 *    already carries every figure the head shows, so a `GET /api/accounts/{id}`
 *    would be the same query with a narrower `WHERE`. The row the table was
 *    clicked on *is* the payload.
 *  - **Its positions come from `/api/shares`**, filtered to this account with
 *    the projection the Titres page's own filter uses (#652 déc. 13). No new
 *    endpoint, and — since that query is already in the cache from either page —
 *    usually no new request either.
 */

interface Props {
  account: AccountSummary | null
  onOpenChange: (open: boolean) => void
}

export function AccountSheet({ account, onOpenChange }: Props) {
  const shares = useQuery({
    queryKey: ['shares'],
    queryFn: api.shares,
    enabled: account !== null,
    refetchInterval: 120_000,
  })

  const positions = useMemo(
    () => (account ? positionsOf(shares.data, account.id) : []),
    [shares.data, account],
  )

  const foreignCurrencies = useMemo(
    () => foreignCurrenciesOf(positions, account?.currency ?? null),
    [positions, account],
  )

  return (
    <Sheet open={account !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{account?.label ?? account?.id}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{account?.id}</span>
            {account?.type && <Badge variant="secondary">{account.type}</Badge>}
            {account?.currency && <Badge variant="outline">{account.currency}</Badge>}
          </SheetDescription>
        </SheetHeader>

        {account && (
          <div className="space-y-6 px-4 pb-8">
            {/* A declared account whose first perf cycle has not run. The row
                exists and the figures do not — and saying so is the whole of
                #655 déc. 8: it is neither an error nor an empty account. */}
            {account.as_of === null ? (
              <Alert>
                <AlertTitle>Performance en cours de calcul</AlertTitle>
                <AlertDescription>
                  Ce compte est déclaré, mais aucune série de performance n'a
                  encore été écrite pour lui.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Stat
                    label="Valeur totale"
                    value={formatCurrency(account.total_value, account.currency)}
                  />
                  <Stat
                    label="Titres"
                    value={formatCurrency(account.holdings_value, account.currency)}
                  />
                  <Stat
                    label="Liquidités"
                    value={formatCurrency(account.cash_balance, account.currency)}
                  />
                  <Stat
                    label="Versements nets"
                    value={formatCurrency(account.net_contributed, account.currency)}
                  />
                  <Stat
                    label="Gain"
                    value={formatCurrency(account.gain_absolu, account.currency)}
                    className={signClass(account.gain_absolu)}
                  />
                  <Stat
                    label="TRI (annualisé)"
                    hint="Rendement pondéré par les flux : ce que vos versements ont réellement rapporté."
                    value={formatPercent(account.xirr)}
                    className={signClass(account.xirr)}
                  />
                  <Stat
                    label="TWR (base 100)"
                    hint="Rendement pondéré par le temps : la performance des supports, indépendante de vos versements."
                    value={formatNumber(account.twr_index, 1)}
                  />
                </div>

                {/* A **day**, not an instant: the series is midnight-stamped and
                    today's point is rewritten in place through the day (trap 2).
                    Showing it as a timestamp would claim a precision the value
                    does not have. */}
                <p className="text-xs text-muted-foreground">
                  Arrêté au&nbsp;: {formatDate(account.as_of)}
                </p>
              </>
            )}

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Valeur et versements</h3>
              <AccountHistoryChart account={account.id} currency={account.currency} />
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Positions du compte</h3>

              {/*
                Found by looking at the page, and it is a fact about the data
                rather than about this sheet: `holdings_value` is
                Σ(quantity × price) over the account's positions, and the price
                is in the *share's* quote currency — so a share quoted in USD
                inside an account declared in EUR is summed as if it were euros,
                and every figure above inherits it.

                This is the multi-currency question one level below where the map
                has been asking it (accounts against each other): the same
                account can already mix. The sheet cannot fix it — the arithmetic
                is `performance.py`'s — so it does what the allocation donut does
                with the same problem: says so, never silently.
              */}
              {foreignCurrencies.length > 0 && (
                <p className="text-xs text-muted-foreground italic">
                  Certaines positions sont cotées en{' '}
                  {foreignCurrencies.join(', ')} alors que le compte est libellé
                  en {account.currency} : les totaux ci-dessus additionnent des
                  montants de devises différentes.
                </p>
              )}
              {shares.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : shares.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>Positions indisponibles</AlertTitle>
                  <AlertDescription>{(shares.error as Error).message}</AlertDescription>
                </Alert>
              ) : positions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Aucune position n'est rattachée à ce compte. Ses liquidités
                  restent suivies ci-dessus.
                </p>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Titre</TableHead>
                        <TableHead className="text-right">Détenu</TableHead>
                        <TableHead className="text-right">PRU</TableHead>
                        <TableHead className="text-right">Valorisation</TableHead>
                        <TableHead className="text-right">Plus-value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {positions.map((share) => (
                        <TableRow key={share.symbol}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium">{share.name ?? share.symbol}</span>
                              <span className="text-xs text-muted-foreground">
                                {share.symbol}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular">
                            {formatQuantity(share.owned_quantity)}
                          </TableCell>
                          <TableCell className="text-right tabular">
                            {formatCurrency(share.cost_price, share.currency)}
                          </TableCell>
                          <TableCell className="text-right tabular">
                            {formatCurrency(share.market_value, share.currency)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right tabular',
                              signClass(share.plus_value_latente),
                            )}
                          >
                            {formatCurrency(share.plus_value_latente, share.currency)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

/**
 * This account's positions, biggest first.
 *
 * `projectToAccount` returns `null` for a share the account does not hold, which
 * is the filter — and it also rewrites the row's figures to that account's own
 * cost price and quantity, so the numbers below are the account's, not the
 * portfolio's.
 */
export function positionsOf(shares: Share[] | undefined, account: string): Share[] {
  return (shares ?? [])
    .map((share) => projectToAccount(share, account))
    .filter((share): share is Share => share !== null)
    .sort((a, b) => (b.market_value ?? 0) - (a.market_value ?? 0))
}

/**
 * The quote currencies the account's positions use that are *not* the account's
 * own. Empty is the normal case and the silent one.
 */
export function foreignCurrenciesOf(
  positions: Share[],
  currency: string | null,
): string[] {
  if (!currency) return []
  return [
    ...new Set(
      positions
        .map((share) => share.currency)
        .filter((value): value is string => Boolean(value) && value !== currency),
    ),
  ].sort()
}

function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string
  value: string
  hint?: string
  className?: string
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground" title={hint}>
        {label}
      </div>
      <div className={cn('tabular text-sm font-medium', className)}>{value}</div>
    </div>
  )
}
