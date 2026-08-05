import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api, type AccountSummary } from '@/lib/api'
import { formatDate } from '@/lib/format'
import { AccountsTable } from '@/components/AccountsTable'
import { AccountsTwrChart } from '@/components/AccountsTwrChart'
import { AccountSheet } from '@/components/AccountSheet'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The accounts page — #652 déc. 13, and the cheapest of the three because it is
 * the shares page's grammar over a different measurement: a comparison table
 * opening a detail sheet.
 *
 * What it adds that no other page has is the **comparison**: `account_metrics`
 * is written per account and read by the baseline one account at a time, behind
 * a `$account` template variable. Putting the accounts side by side is what
 * makes the question "which of my accounts is actually working" askable at all.
 *
 * Three states before the table, and they are three different screens on
 * purpose (#655 déc. 8):
 *
 *  - **no declaration** — the opt-out setup every default install runs. An
 *    invitation, not a failure;
 *  - **declared, but in manual mode** — `update_account_metrics` returns early
 *    without events, so the series is never written. #660 found this and put it
 *    in the dashboard's discriminator; the same discriminator answers it here,
 *    which is why this page reads the portfolio head at all;
 *  - **declared, events mode, no point yet** — a computation that has not
 *    happened. Rows with em dashes, which the table renders on its own.
 */

export default function AccountsPage() {
  const [selected, setSelected] = useState<AccountSummary | null>(null)

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: api.accounts,
    // Trap 2: today's point is rewritten in place through the day, so these
    // figures move under the cache. The perf job's own cadence is the floor.
    refetchInterval: 120_000,
  })

  // Only to tell "manual mode" from "not computed yet" — see the note above.
  // Cheap (one row) and usually already warm from the dashboard.
  const portfolio = useQuery({ queryKey: ['portfolio', 'none'], queryFn: () => api.portfolio() })

  const rows = accounts.data?.accounts ?? []
  const currencies = useMemo(
    () => [...new Set(rows.map((account) => account.currency).filter(Boolean))],
    [rows],
  )
  const manualMode =
    accounts.data?.declared === true && portfolio.data?.mode === 'titres'

  // The newest day any account was computed for. `max` rather than one row's:
  // they are written in the same cycle, and a row left behind is exactly the
  // case the table shows as em dashes.
  const asOf = useMemo(() => {
    const days = rows.map((account) => account.as_of).filter(Boolean) as string[]
    return days.length > 0 ? days.reduce((a, b) => (a > b ? a : b)) : null
  }, [rows])

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Comptes</h1>
        <p className="text-sm text-muted-foreground">
          Vos comptes déclarés, comparés. Cliquez une ligne pour le détail.
        </p>
      </header>

      {accounts.isError && (
        <Alert variant="destructive">
          <AlertTitle>Comptes indisponibles</AlertTitle>
          <AlertDescription>{(accounts.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {accounts.isLoading && <Skeleton className="h-64 w-full" />}

      {accounts.data && !accounts.data.declared && (
        <Alert>
          <AlertTitle>Aucun compte déclaré</AlertTitle>
          <AlertDescription>
            Cette page compare les comptes déclarés dans le bloc{' '}
            <code>accounts:</code> de <code>settings.yaml</code>. Les déclarer
            débloque le suivi des liquidités, des versements, du TRI et du TWR —
            par compte et au global. Sans déclaration, le portefeuille reste suivi
            au titre près sur la page « Titres ».
          </AlertDescription>
        </Alert>
      )}

      {manualMode && (
        <Alert>
          <AlertTitle>Performance non calculée en mode manuel</AlertTitle>
          <AlertDescription>
            Vos comptes sont déclarés, mais l'application tourne en mode{' '}
            <code>manual</code>&nbsp;: la performance se calcule à partir des
            événements (versements, achats, dividendes), qui n'existent que dans
            le mode <code>events</code>. Les comptes sont listés ci-dessous, leurs
            figures resteront vides.
          </AlertDescription>
        </Alert>
      )}

      {accounts.data?.declared && rows.length > 0 && (
        <>
          {/* The chart first: it is the comparison, and the table under it is
              the detail. Withheld in manual mode, where every series is empty
              and an empty chart would read as a failure rather than as a
              configuration. */}
          {!manualMode && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Performance comparée (TWR, base 100)</CardTitle>
              </CardHeader>
              <CardContent>
                <AccountsTwrChart accounts={rows} />
              </CardContent>
            </Card>
          )}

          {/* Multidevise: unlike the dashboard, which has to withhold its head,
              this page stands — every row states its own currency and nothing
              here adds two of them together. Said out loud rather than left for
              the reader to notice, which is the rule the allocation donut
              follows too. */}
          {currencies.length > 1 && (
            <p className="text-xs text-muted-foreground italic">
              Portefeuille multidevise ({currencies.join(', ')})&nbsp;: chaque
              ligne est libellée dans sa propre devise et aucun total n'est
              calculé. L'indice TWR, lui, ne porte pas de devise.
            </p>
          )}

          <AccountsTable accounts={rows} onSelect={setSelected} />

          {/* Found by looking at the page: a table of money with no date on it
              reads as "now", and these figures are a **day** — the series is
              midnight-stamped and today's point is rewritten in place through
              the day (trap 2). One line under the table is the whole fix. */}
          {asOf && (
            <p className="text-xs text-muted-foreground">
              Figures arrêtées au {formatDate(asOf)}. La performance est calculée
              une fois par jour et le point du jour est réécrit au fil des cours.
            </p>
          )}
        </>
      )}

      {accounts.data?.declared && rows.length === 0 && (
        <Alert>
          <AlertTitle>Aucun compte</AlertTitle>
          <AlertDescription>
            Le bloc <code>accounts:</code> est présent mais ne déclare aucun
            compte.
          </AlertDescription>
        </Alert>
      )}

      <AccountSheet
        account={selected}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  )
}
