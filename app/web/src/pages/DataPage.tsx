import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { api, type DeclaredShare } from '@/lib/api'
import { AccountsEditor } from '@/components/AccountsEditor'
import { EventFiles } from '@/components/EventFiles'
import { EventLedger } from '@/components/EventLedger'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatNumber, formatQuantity } from '@/lib/format'

/**
 * The data page — the write half of the map, and the only screen that can
 * destroy something.
 *
 * It is really **two** pages behind one route, chosen by the installation's
 * mode rather than by whether any data came back. That is #655 decision 8's
 * discriminator rule applied one last time: an events install with an empty
 * directory and a manual install both have zero events, and they need entirely
 * different screens.
 */
export default function DataPage() {
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })

  const eventsMode = config.data?.mode === 'events'
  const editable = config.data?.editable === true

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Données</h1>
        <p className="text-sm text-muted-foreground">
          Le portefeuille tel qu'il est déclaré — et, en mode événements, tel
          qu'il se modifie.
        </p>
      </header>

      {config.isLoading && <Skeleton className="h-64 w-full" />}

      {config.isError && (
        <Alert variant="destructive">
          <AlertTitle>Configuration illisible</AlertTitle>
          <AlertDescription>{(config.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {/* The deployment condition, up front rather than on the first failed
          save. It is the visible end of the map's PaaS fog: a platform that
          regenerates the stack and never runs `make init` runs the container as
          1000:1000 over files owned by someone else. */}
      {config.data && eventsMode && !editable && (
        <Alert variant="destructive">
          <AlertTitle>Journal en lecture seule</AlertTitle>
          <AlertDescription>
            {config.data.read_only_reason}
            <br />
            Le conteneur doit tourner sous l'utilisateur propriétaire du dossier
            de configuration&nbsp;: <code>make init</code> inscrit vos{' '}
            <code>SB_UID</code>/<code>SB_GID</code> dans le <code>.env</code>. Une
            plateforme qui régénère la stack elle-même ne le fait pas et retombe
            sur <code>1000:1000</code>.
          </AlertDescription>
        </Alert>
      )}

      {config.data && !eventsMode && <ManualPortfolio shares={config.data.shares} />}

      {config.data && eventsMode && (
        <EventLedger editable={editable} accounts={accounts.data?.accounts ?? []} />
      )}

      {/* Two columns only when there are two cards: in manual mode the files
          card does not exist, and a lone half-width card beside an empty half
          reads as something that failed to load. */}
      <div className={`grid gap-6 ${eventsMode ? 'lg:grid-cols-2' : ''}`}>
        {config.data && eventsMode && <EventFiles editable={editable} />}
        {config.data && <AccountsEditor eventsMode={eventsMode} />}
      </div>

      {config.data && <LogLevel current={config.data.log_level} />}
    </div>
  )
}

/**
 * The manual-mode screen: the positions `config.yaml` declares, read-only.
 *
 * And **no offered conversion**, which is the decision rather than an omission.
 * An aggregated position carries no dates — only a quantity and a weighted
 * average price — so synthesising events from it would mean inventing a
 * purchase date, and that date is not decoration: it is the backfill's target
 * (`first_buy_date`) and the denominator of the money-weighted return. Inventing
 * it silently would produce a performance history that looks authoritative and
 * is fiction.
 */
function ManualPortfolio({ shares }: { shares: DeclaredShare[] }) {
  return (
    <section className="space-y-3">
      <Alert>
        <AlertTitle>Mode manuel</AlertTitle>
        <AlertDescription>
          <p>
            Le portefeuille est déclaré dans <code>config.yaml</code> et n'est
            pas modifiable ici. Le journal d'événements — et avec lui l'historique
            des achats, des dividendes et de la performance — n'existe qu'en mode{' '}
            <code>events</code>.
          </p>
          <p>
            Aucune conversion automatique n'est proposée&nbsp;: une position
            agrégée ne porte aucune date. La reconstruire en événements
            supposerait d'inventer une date d'achat, qui pilote ensuite la reprise
            d'historique et le calcul de rendement. Pour passer aux événements,
            écrivez vos transactions réelles dans un <code>.csv</code> et
            déposez-le dans le dossier <code>events/</code>.
          </p>
        </AlertDescription>
      </Alert>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Titre</TableHead>
              <TableHead>Symbole</TableHead>
              <TableHead className="text-right">Quantité détenue</TableHead>
              <TableHead className="text-right">Quantité achetée</TableHead>
              <TableHead className="text-right">PRU</TableHead>
              <TableHead className="text-right">Frais</TableHead>
              <TableHead className="text-right">Dividendes reçus</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shares.map((share) => (
              <TableRow key={`${share.symbol}-${share.account ?? ''}`}>
                <TableCell>{share.name}</TableCell>
                <TableCell className="font-mono">{share.symbol}</TableCell>
                <TableCell className="text-right">
                  {formatQuantity(share.estate.quantity)}
                </TableCell>
                <TableCell className="text-right">
                  {formatQuantity(share.purchase.quantity)}
                </TableCell>
                <TableCell className="text-right">
                  {formatNumber(share.purchase.cost_price)}
                </TableCell>
                <TableCell className="text-right">{formatNumber(share.purchase.fee)}</TableCell>
                <TableCell className="text-right">
                  {formatNumber(share.estate.received_dividend)}
                </TableCell>
              </TableRow>
            ))}
            {shares.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                  Aucun titre déclaré dans <code>config.yaml</code>.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

/**
 * The one setting this app can honestly offer (#654).
 *
 * Of seventeen environment variables, eight are cheap to *apply* at runtime and
 * **zero** can be persisted: `.env` is a host file the container never sees, and
 * compose re-reads it only at `up`. So a settings page was ruled out of the map
 * entirely, and what survives is this — offered as exactly what it is, with the
 * expiry written next to it rather than discovered after a restart.
 */
function LogLevel({ current }: { current: string }) {
  const [level, setLevel] = useState(current)
  const apply = useMutation({
    mutationFn: (next: string) => api.setLogLevel(next),
    onSuccess: (result) => setLevel(result.log_level),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Journalisation</CardTitle>
        <CardDescription>
          Niveau de log du processus, le temps de diagnostiquer quelque chose.
          Revient à sa valeur d'origine au prochain redémarrage du conteneur —
          les réglages vivent dans le <code>.env</code> de l'hôte, que le
          conteneur ne voit pas.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-1.5">
        {['DEBUG', 'INFO', 'WARNING', 'ERROR'].map((option) => (
          <Button
            key={option}
            size="sm"
            variant={option === level ? 'default' : 'outline'}
            disabled={apply.isPending}
            onClick={() => apply.mutate(option)}
          >
            {option}
          </Button>
        ))}
      </CardContent>
    </Card>
  )
}
