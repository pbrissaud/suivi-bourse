import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import {
  api,
  type AccountsPortfolio,
  type MultiCurrencyPortfolio,
  type Portfolio,
  type TitresPortfolio,
} from '@/lib/api'
import {
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
  signClass,
} from '@/lib/format'
import { cn } from '@/lib/utils'
import { Allocation } from '@/components/Allocation'
import { Movers } from '@/components/Movers'
import { PortfolioChart } from '@/components/PortfolioChart'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The consolidated dashboard — #652 déc. 5–8.
 *
 * The head is driven by a **discriminated union**, so this file never asks "is
 * `gain_absolu` null?" to work out what to render. It switches on `mode`, and
 * TypeScript then only lets each branch reach the fields that exist there. That
 * is #655 déc. 8 doing its job: inferring a *designed* mode from missing values
 * is what would eventually make "no declared accounts" and "the perf job has not
 * run yet" the same screen.
 */

/** The relative-delta preference of #652 déc. 2 — a head preference, and
 *  deliberately **not** wired to the chart's zoom below it. */
type Since = 'none' | '1S' | '1M' | '1A'

const SINCE_DAYS: Record<Exclude<Since, 'none'>, number> = { '1S': 7, '1M': 30, '1A': 365 }

const DAY_MS = 86_400_000

export default function DashboardPage() {
  const [since, setSince] = useState<Since>('1M')

  const sinceDate =
    since === 'none' ? undefined : new Date(Date.now() - SINCE_DAYS[since] * DAY_MS)

  const portfolio = useQuery({
    queryKey: ['portfolio', since],
    queryFn: () => api.portfolio(sinceDate),
    refetchInterval: 120_000,
  })

  // The same query the Titres page runs, and the same cache entry — #652 déc. 8's
  // "one query, two consumers". Opening this page after the table costs nothing.
  const shares = useQuery({
    queryKey: ['shares'],
    queryFn: api.shares,
    refetchInterval: 120_000,
  })

  const movers = useQuery({
    queryKey: ['movers'],
    queryFn: api.movers,
    refetchInterval: 120_000,
  })

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Tableau de bord</h1>
        <p className="text-sm text-muted-foreground">
          Vue consolidée du portefeuille.
        </p>
      </header>

      {portfolio.isError && (
        <Alert variant="destructive">
          <AlertTitle>Portefeuille indisponible</AlertTitle>
          <AlertDescription>{(portfolio.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {portfolio.isLoading && <Skeleton className="h-40 w-full" />}

      {portfolio.data && (
        <Head data={portfolio.data} since={since} onSinceChange={setSince} />
      )}

      {/* Gated on `data`, not just on the mode: rendering the card while the
          head is still loading would title it from a mode we do not have yet,
          and the reader would watch the heading change under them. */}
      {portfolio.data && portfolio.data.mode !== 'multi_currency' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {portfolio.data.mode === 'accounts'
                ? 'Valeur totale et montant investi'
                : 'Valorisation et prix de revient'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PortfolioChart currency={currencyOf(portfolio.data)} />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Répartition</CardTitle>
          </CardHeader>
          <CardContent>
            {shares.isLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : shares.isError ? (
              <p className="text-sm text-muted-foreground">
                {(shares.error as Error).message}
              </p>
            ) : (
              <Allocation shares={shares.data ?? []} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mouvements</CardTitle>
          </CardHeader>
          <CardContent>
            {movers.isLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : movers.isError ? (
              <p className="text-sm text-muted-foreground">
                {(movers.error as Error).message}
              </p>
            ) : (
              <Movers
                movers={movers.data?.movers ?? []}
                reference={movers.data?.reference ?? null}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Head({
  data,
  since,
  onSinceChange,
}: {
  data: Portfolio
  since: Since
  onSinceChange: (value: Since) => void
}) {
  switch (data.mode) {
    case 'accounts':
      return <AccountsHead data={data} since={since} onSinceChange={onSinceChange} />
    case 'titres':
      return <TitresHead data={data} />
    case 'multi_currency':
      return <MultiCurrencyHead data={data} />
  }
}

function AccountsHead({
  data,
  since,
  onSinceChange,
}: {
  data: AccountsPortfolio
  since: Since
  onSinceChange: (value: Since) => void
}) {
  // Declared accounts whose first perf cycle has not run. Not an error and not
  // an empty portfolio — a computation that has not happened yet, which is why
  // the mode still says `accounts` and this branch exists to say so.
  if (data.as_of === null) {
    return (
      <Alert>
        <AlertTitle>Performance en cours de calcul</AlertTitle>
        <AlertDescription>
          Vos comptes sont déclarés, mais aucune série de performance n'a encore
          été écrite. Le premier cycle arrive dans les deux minutes qui suivent
          le démarrage.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-6 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            {/*
              #652 déc. 5: the headline is `gain_absolu` **in euros**, not a
              rate — the eye looks for money. Grafana's `Total Performance %`
              was deleted rather than ported: `(val + div − inv) / inv` ignores
              cash and external flows, and a fourth calculation standing beside
              three correct ones is worse than a missing one.
            */}
            <div className="text-xs tracking-wide text-muted-foreground uppercase">
              Gain
            </div>
            <div
              className={cn(
                'tabular text-4xl font-semibold',
                signClass(data.gain_absolu),
              )}
            >
              {formatCurrency(data.gain_absolu, data.currency)}
            </div>
            <div className="text-sm text-muted-foreground">
              sur {formatCurrency(data.net_contributed, data.currency)} investis
            </div>
          </div>

          <SinceSelector value={since} onChange={onSinceChange} />
        </div>

        {data.baseline && (
          <div className="text-sm">
            <span className="text-muted-foreground">
              Depuis le {formatDate(data.baseline.since)} :{' '}
            </span>
            <span className={cn('tabular font-medium', signClass(data.baseline.change))}>
              {formatCurrency(data.baseline.change, data.currency)} (
              {formatPercent(data.baseline.change_pct)})
            </span>
            {data.baseline.total_value === null && (
              <span className="text-muted-foreground italic">
                {' '}
                — rien n'était enregistré à cette date
              </span>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-6 border-t pt-4 sm:grid-cols-5">
          <Stat
            label="Valeur totale"
            value={formatCurrency(data.total_value, data.currency)}
          />
          <Stat
            label="Titres"
            value={formatCurrency(data.holdings_value, data.currency)}
          />
          <Stat
            label="Liquidités"
            value={formatCurrency(data.cash_balance, data.currency)}
          />
          {/* Two rates answering two different questions, which is why both are
              here and neither is "the" performance. */}
          <Stat
            label="TRI (annualisé)"
            hint="Rendement pondéré par les flux : ce que vos versements ont réellement rapporté."
            value={formatPercent(data.xirr)}
            className={signClass(data.xirr)}
          />
          <Stat
            label="TWR (base 100)"
            hint="Rendement pondéré par le temps : la performance des supports, indépendante de vos versements."
            value={formatNumber(data.twr_index, 1)}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function TitresHead({ data }: { data: TitresPortfolio }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-6 pt-6">
          <div className="space-y-1">
            {/*
              Deliberately *not* labelled "Gain". #652 déc. 6 fixes two terms
              that must never be conflated, and the union above guarantees this
              branch cannot even read the other one's field.
            */}
            <div className="text-xs tracking-wide text-muted-foreground uppercase">
              Plus-value latente
            </div>
            <div
              className={cn(
                'tabular text-4xl font-semibold',
                signClass(data.plus_value_latente),
              )}
            >
              {formatCurrency(data.plus_value_latente, data.currency)}
            </div>
            <div className="text-sm text-muted-foreground">
              soit {formatPercent(data.plus_value_pct)} du prix de revient
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6 border-t pt-4 sm:grid-cols-4">
            <Stat
              label="Valorisation"
              value={formatCurrency(data.holdings_value, data.currency)}
            />
            <Stat
              label="Prix de revient"
              value={formatCurrency(data.invested, data.currency)}
            />
            <Stat
              label="Dividendes perçus"
              value={formatCurrency(data.received_dividend, data.currency)}
            />
            <Stat
              label="Frais"
              value={formatCurrency(data.purchased_fee, data.currency)}
            />
          </div>
        </CardContent>
      </Card>

      {/*
        The invitation of #652 déc. 6. This mode is what every default install
        runs, so the message must read as "here is what unlocks more", never as
        "your configuration is incomplete".
      */}
      <Alert>
        <AlertTitle>Déclarez vos comptes pour aller plus loin</AlertTitle>
        <AlertDescription>
          La plus-value latente compare la valeur de vos titres à leur prix de
          revient. Déclarer vos comptes dans <code>settings.yaml</code> débloque le
          gain réel — valeur totale moins versements nets — ainsi que le TRI, le
          TWR et le suivi des liquidités.
        </AlertDescription>
      </Alert>
    </div>
  )
}

function MultiCurrencyHead({ data }: { data: MultiCurrencyPortfolio }) {
  return (
    <Alert>
      <AlertTitle>Portefeuille multidevise</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          Vos comptes sont libellés en {data.currencies.join(', ')}. Aucune série
          consolidée n'est calculée : additionner des devises demande des taux de
          change, hors du périmètre de l'application. Les figures par compte
          restent justes, chacune dans sa devise.
        </p>
        <ul className="text-sm">
          {data.accounts.map((account) => (
            <li key={account.id}>
              {account.label} — {account.currency}
            </li>
          ))}
        </ul>
        <p className="text-sm">
          Le bloc « Mouvements » ci-dessous reste lisible : une variation en
          pourcentage ne porte pas de devise.
        </p>
      </AlertDescription>
    </Alert>
  )
}

function SinceSelector({
  value,
  onChange,
}: {
  value: Since
  onChange: (value: Since) => void
}) {
  return (
    <div className="space-y-1">
      <div className="text-right text-xs text-muted-foreground">Évolution depuis</div>
      <div className="flex gap-1">
        {(['1S', '1M', '1A', 'none'] as Since[]).map((key) => (
          <Button
            key={key}
            size="sm"
            variant={value === key ? 'secondary' : 'ghost'}
            onClick={() => onChange(key)}
          >
            {key === 'none' ? '—' : key}
          </Button>
        ))}
      </div>
    </div>
  )
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
    <div>
      <div className="text-xs text-muted-foreground" title={hint}>
        {label}
      </div>
      <div className={cn('tabular text-lg font-semibold', className)}>{value}</div>
    </div>
  )
}

/** The head owns the currency; the chart borrows it rather than re-deriving it. */
function currencyOf(data: Portfolio | undefined): string | null {
  if (!data || data.mode === 'multi_currency') return null
  return data.currency
}
