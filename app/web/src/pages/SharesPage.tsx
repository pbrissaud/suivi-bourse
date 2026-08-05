import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api, type Share } from '@/lib/api'
import { formatCurrency, signClass } from '@/lib/format'
import { projectToAccount } from '@/lib/positions'
import { cn } from '@/lib/utils'
import { SharesTable } from '@/components/SharesTable'
import { ShareSheet } from '@/components/ShareSheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'

const ALL = '__all__'

export default function SharesPage() {
  const [account, setAccount] = useState<string>(ALL)
  const [quoteType, setQuoteType] = useState<string>(ALL)
  const [exchange, setExchange] = useState<string>(ALL)
  const [selected, setSelected] = useState<string | null>(null)

  const shares = useQuery({
    queryKey: ['shares'],
    queryFn: api.shares,
    // Points land every SB_REGULAR_INTERVAL (120 s by default), so anything
    // faster than that is polling for news that cannot have arrived.
    refetchInterval: 120_000,
  })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })

  const rows = useMemo(() => {
    const all = shares.data ?? []
    return all
      .map((share) => projectToAccount(share, account === ALL ? null : account))
      .filter((share): share is Share => share !== null)
      .filter((share) => quoteType === ALL || share.quote_type === quoteType)
      .filter((share) => exchange === ALL || share.exchange === exchange)
  }, [shares.data, account, quoteType, exchange])

  const quoteTypes = useMemo(() => distinct(shares.data, (s) => s.quote_type), [shares.data])
  const exchanges = useMemo(() => distinct(shares.data, (s) => s.exchange), [shares.data])

  // The account filter's options come from the **declaration** (#652 déc. 4),
  // falling back to what the data holds when nothing is declared — the opt-out
  // setup, where the only bucket is `default`.
  const accountOptions = useMemo(() => {
    if (accounts.data?.declared) {
      return accounts.data.accounts.map((a) => ({ id: a.id, label: a.label }))
    }
    return distinct(shares.data?.flatMap((s) => s.accounts.map((p) => p.account)), (v) => v)
      .map((id) => ({ id, label: id }))
  }, [accounts.data, shares.data])

  const totals = useMemo(() => summarise(rows), [rows])

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Titres</h1>
        <p className="text-sm text-muted-foreground">
          Positions consolidées, tous comptes confondus. Cliquez une ligne pour le détail.
        </p>
      </header>

      {shares.isError && (
        <Alert variant="destructive">
          <AlertTitle>Portefeuille indisponible</AlertTitle>
          <AlertDescription>
            {(shares.error as Error).message}
            {/* The whole point of the sibling read module: this is *not* the
                same screen as "you own nothing yet". #655 decision 8. */}
          </AlertDescription>
        </Alert>
      )}

      {shares.isLoading && <Skeleton className="h-64 w-full" />}

      {shares.data && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Filter
              label="Compte"
              value={account}
              onChange={setAccount}
              options={accountOptions}
              allLabel="Tous les comptes"
            />
            <Filter
              label="Type"
              value={quoteType}
              onChange={setQuoteType}
              options={quoteTypes.map((v) => ({ id: v, label: v }))}
              allLabel="Tous les types"
            />
            <Filter
              label="Place"
              value={exchange}
              onChange={setExchange}
              options={exchanges.map((v) => ({ id: v, label: v }))}
              allLabel="Toutes les places"
            />
            <div className="ml-auto flex gap-6 text-right">
              <Summary label="Valorisation" value={formatCurrency(totals.value, totals.currency)} />
              <Summary
                label="Plus-value latente"
                value={formatCurrency(totals.plusValue, totals.currency)}
                className={signClass(totals.plusValue)}
              />
            </div>
          </div>

          {rows.length === 0 ? (
            <Alert>
              <AlertTitle>Aucune position</AlertTitle>
              <AlertDescription>
                {shares.data.length === 0
                  ? "Aucun cours n'a encore été enregistré. Le premier relevé arrive au prochain cycle de scraping."
                  : 'Aucun titre ne correspond aux filtres sélectionnés.'}
              </AlertDescription>
            </Alert>
          ) : (
            <SharesTable shares={rows} onSelect={setSelected} />
          )}
        </>
      )}

      <ShareSheet symbol={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  )
}

function Filter({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { id: string; label: string }[]
  allLabel: string
}) {
  if (options.length === 0) return null
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function Summary({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('tabular text-lg font-semibold', className)}>{value}</div>
    </div>
  )
}

function distinct<T>(
  items: T[] | undefined,
  pick: (item: T) => string | null | undefined,
): string[] {
  if (!items) return []
  const values = new Set<string>()
  for (const item of items) {
    const value = pick(item)
    if (value) values.add(value)
  }
  return [...values].sort()
}

function summarise(rows: Share[]) {
  let value: number | null = null
  let plusValue: number | null = null
  for (const row of rows) {
    if (row.market_value !== null) value = (value ?? 0) + row.market_value
    if (row.plus_value_latente !== null) {
      plusValue = (plusValue ?? 0) + row.plus_value_latente
    }
  }
  // A mixed-currency portfolio has no meaningful total — the same condition
  // that makes `portfolio_totals` absent server-side. Rather than adding euros
  // to dollars, drop the currency and let the number render bare.
  const currencies = new Set(rows.map((row) => row.currency).filter(Boolean))
  return {
    value,
    plusValue,
    currency: currencies.size === 1 ? [...currencies][0] ?? null : null,
  }
}
