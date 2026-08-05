import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import {
  formatCompact,
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatPercentPoints,
  formatQuantity,
  signClass,
} from '@/lib/format'
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
import { PriceChart } from '@/components/PriceChart'

/**
 * The detail sheet of #652 déc. 9/12: the per-account breakdown, the yfinance
 * fundamentals, and the chart.
 *
 * The fundamentals are here *repaired for free* by déc. 1. The baseline had to
 * hardcode a 30-day lookback on dividend yield / P/E / market cap (panels
 * 17/18/19) purely to escape `$__timeFilter`, because yfinance supplies them
 * intermittently and a 7-day window would show nothing (trap 7). With "current"
 * made absolute, there is no window to escape.
 */

interface Props {
  symbol: string | null
  onOpenChange: (open: boolean) => void
}

export function ShareSheet({ symbol, onOpenChange }: Props) {
  // Fetched rather than reused from the table's row: it exercises the
  // single-symbol form of P1, and it is what the sheet would need anyway once
  // the payload carries more than a table row does.
  const share = useQuery({
    queryKey: ['share', symbol],
    queryFn: () => api.share(symbol as string),
    enabled: symbol !== null,
  })

  const data = share.data

  return (
    <Sheet open={symbol !== null} onOpenChange={onOpenChange}>
      {/* The width override has to carry the *same* variant chain the component
          uses (`data-[side=right]:sm:max-w-sm`). A bare `sm:max-w-2xl` is a
          different selector as far as tailwind-merge is concerned, so both
          survive and the attribute selector wins — the sheet stays narrow and
          the breakdown table spills into a horizontal scrollbar. */}
      <SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{data?.name ?? symbol}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{symbol}</span>
            {/* `quote_type` and `share_exchange` were declared as Grafana
                template variables, queried on every dashboard load, and read by
                zero panels (trap 11). Here they are actually shown. */}
            {data?.quote_type && <Badge variant="secondary">{data.quote_type}</Badge>}
            {data?.exchange && <Badge variant="outline">{data.exchange}</Badge>}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-8">
          {share.isLoading && <Skeleton className="h-64 w-full" />}

          {share.isError && (
            <Alert variant="destructive">
              <AlertTitle>Titre indisponible</AlertTitle>
              <AlertDescription>{(share.error as Error).message}</AlertDescription>
            </Alert>
          )}

          {data && (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Cours" value={formatCurrency(data.price, data.currency)} />
                <Stat label="PRU" value={formatCurrency(data.cost_price, data.currency)} />
                <Stat label="Détenu" value={formatQuantity(data.owned_quantity)} />
                <Stat
                  label="Valorisation"
                  value={formatCurrency(data.market_value, data.currency)}
                />
                <Stat
                  label="Plus-value latente"
                  value={formatCurrency(data.plus_value_latente, data.currency)}
                  className={signClass(data.plus_value_latente)}
                />
                <Stat
                  label="Variation"
                  value={formatPercent(data.plus_value_pct)}
                  className={signClass(data.plus_value_pct)}
                />
                <Stat
                  label="Investi"
                  value={formatCurrency(data.invested, data.currency)}
                />
                <Stat
                  label="Dividendes reçus"
                  value={formatCurrency(data.received_dividend, data.currency)}
                />
              </div>

              <p className="text-xs text-muted-foreground">
                Dernier relevé&nbsp;: {formatDateTime(data.price_time)}
              </p>

              <Separator />

              <section className="space-y-3">
                <h3 className="text-sm font-medium">Cours et mouvements</h3>
                <PriceChart
                  symbol={data.symbol}
                  currency={data.currency}
                  costPrice={data.cost_price}
                />
              </section>

              <Separator />

              <section className="space-y-3">
                <h3 className="text-sm font-medium">Répartition par compte</h3>
                {/* The breakdown P1 computes and every Grafana panel immediately
                    sums away (#652 déc. 6, item 6). */}
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Compte</TableHead>
                        <TableHead className="text-right">Détenu</TableHead>
                        <TableHead className="text-right">PRU</TableHead>
                        <TableHead className="text-right">Valorisation</TableHead>
                        <TableHead className="text-right">Plus-value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.accounts.map((position) => (
                        <TableRow key={position.account}>
                          <TableCell>{position.account}</TableCell>
                          <TableCell className="text-right tabular">
                            {formatQuantity(position.owned_quantity)}
                          </TableCell>
                          <TableCell className="text-right tabular">
                            {formatCurrency(position.cost_price, data.currency)}
                          </TableCell>
                          <TableCell className="text-right tabular">
                            {formatCurrency(position.market_value, data.currency)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right tabular',
                              signClass(position.plus_value_latente),
                            )}
                          >
                            {formatCurrency(position.plus_value_latente, data.currency)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <h3 className="text-sm font-medium">Fondamentaux</h3>
                <div className="grid grid-cols-3 gap-4">
                  <Stat
                    label="Rendement"
                    value={formatPercentPoints(data.dividend_yield)}
                  />
                  <Stat label="PER" value={formatNumber(data.pe_ratio)} />
                  <Stat
                    label="Capitalisation"
                    value={formatCompact(data.market_cap, data.currency)}
                  />
                </div>
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Stat({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('tabular text-sm font-medium', className)}>{value}</div>
    </div>
  )
}
