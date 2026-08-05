import { Fragment } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api, type EffectiveSetting, type PerfRun, type RuntimeState } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { Bar } from '@/components/RuntimeBanner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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

/**
 * The always-on half of the app's runtime state, on the page that already asks
 * what kind of installation this is.
 *
 * The banner in the shell is deliberately quiet when nothing is wrong, which
 * leaves the ordinary readings — the perf gate's last verdict, the ingestion
 * that changed nothing — with nowhere to be seen. They belong here rather than
 * in the banner, because they are what you go *looking* for, not what should
 * interrupt you.
 */
export function EngineStatus() {
  const runtime = useQuery({
    queryKey: ['runtime'],
    queryFn: api.runtime,
    refetchInterval: 120_000,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">État du moteur</CardTitle>
        <CardDescription>
          Ce que font les quatre travaux planifiés. Rien de tout cela n’est stocké
          dans InfluxDB&nbsp;: c’est la mémoire du processus, et elle disparaît à
          chaque redémarrage.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {runtime.isLoading && <Skeleton className="h-32 w-full" />}

        {runtime.isError && (
          <Alert variant="destructive">
            <AlertTitle>État indisponible</AlertTitle>
            <AlertDescription>{(runtime.error as Error).message}</AlertDescription>
          </Alert>
        )}

        {runtime.data && <Body state={runtime.data} />}
      </CardContent>
    </Card>
  )
}

function Body({ state }: { state: RuntimeState }) {
  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <h3 className="text-sm font-medium">Reprise d’historique</h3>
        {state.backfill.in_scope === 0 ? (
          <p className="text-sm text-muted-foreground">
            {state.backfill.manual_mode > 0
              ? // Trap 6: manual mode has no backward pass at all, so "no
                // progress" here is nominal and must not read as a stall.
                'Aucune reprise en mode manuel — le journal d’événements, et avec lui l’historique, n’existe qu’en mode événements.'
              : 'Aucune série à reprendre.'}
          </p>
        ) : (
          <>
            <p className="text-sm">
              {state.backfill.complete} série
              {state.backfill.complete > 1 ? 's' : ''} sur {state.backfill.in_scope}{' '}
              ont atteint leur premier achat.
            </p>
            <Bar ratio={state.backfill.ratio} />
          </>
        )}
        {state.backfill.no_buy > 0 && (
          <p className="text-xs text-muted-foreground">
            {state.backfill.no_buy} série{state.backfill.no_buy > 1 ? 's' : ''} sans
            achat enregistré — rien à remonter, ce n’est pas un blocage.
          </p>
        )}
      </section>

      <section className="space-y-1">
        <h3 className="text-sm font-medium">Dernière lecture des fichiers</h3>
        {state.ingestion ? (
          <p className="text-sm">
            {formatDateTime(state.ingestion.at)} —{' '}
            {state.ingestion.kept_previous
              ? 'refusée, la configuration précédente reste active'
              : state.ingestion.outcome === 'updated'
                ? 'portefeuille mis à jour'
                : 'aucun changement'}
            {state.ingestion.shares !== null &&
              ` (${state.ingestion.shares} position${state.ingestion.shares > 1 ? 's' : ''})`}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Aucune lecture depuis le démarrage.</p>
        )}
        {state.ingestion?.error && (
          <p className="text-sm text-destructive">{state.ingestion.error}</p>
        )}
      </section>

      <section className="space-y-1">
        <h3 className="text-sm font-medium">Dernier calcul de performance</h3>
        <PerfVerdict perf={state.perf} />
      </section>
    </div>
  )
}

/**
 * #618's gate, shown as its three inputs rather than as one "reason".
 *
 * A skip *is* the three of them being quiet, so naming a single cause would be
 * impossible to do honestly — and the last verdict cannot be pulled from the
 * scheduler either: `_perf_dirty_live` is read **and cleared** by the perf job,
 * so a request thread reading it learns about a run that is pending and nothing
 * about the one that just happened.
 */
function PerfVerdict({ perf }: { perf: PerfRun | null }) {
  if (!perf) {
    return (
      <p className="text-sm text-muted-foreground">
        Aucun cycle depuis le démarrage.
      </p>
    )
  }

  const REASONS: [keyof PerfRun['reasons'], string][] = [
    ['events_changed', 'événements rechargés'],
    ['backfill_pending', 'historique complété'],
    ['live_write', 'cours écrit en direct'],
  ]

  return (
    <div className="space-y-1">
      <p className="text-sm">
        {formatDateTime(perf.at)} —{' '}
        {perf.verdict === 'ran'
          ? 'recalculé'
          : perf.verdict === 'failed'
            ? 'échec'
            : 'ignoré, rien n’a changé'}
      </p>
      {/*
        A two-column reading rather than three badges, and the badges were a
        defect found by looking: `secondary` and `outline` differ by a shade of
        grey, so the three conditions rendered as one indistinguishable row of
        chips — while **which of them fired** is the entire content. A word in
        the second column cannot be misread at any font size.
      */}
      <dl className="grid max-w-xs grid-cols-[1fr_auto] gap-x-4 text-xs">
        {REASONS.map(([key, label]) => (
          <Fragment key={key}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd
              className={
                perf.reasons[key] ? 'font-medium' : 'text-muted-foreground'
              }
            >
              {perf.reasons[key] ? 'oui' : 'non'}
            </dd>
          </Fragment>
        ))}
      </dl>
      {perf.error && <p className="text-sm text-destructive">{perf.error}</p>}
    </div>
  )
}

/**
 * The read-only effective configuration — #654's one survivor.
 *
 * Of seventeen environment variables, eight are cheap to *apply* at runtime and
 * **zero** can be persisted: `.env` is a host file the container never sees, and
 * compose re-reads it only at `up`. So this answers "what is this container
 * actually running?" and offers no button, which is not a limitation of the
 * prototype but the honest shape of the thing.
 */
export function EffectiveConfig({ settings }: { settings: EffectiveSetting[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Configuration effective</CardTitle>
        <CardDescription>
          Les variables d’environnement que <em>l’application lit</em> — ce n’est
          pas la même liste que celles envoyées par compose&nbsp;:{' '}
          <code>SB_VERSION</code> et <code>SB_CONFIG_DIR</code> portent le préfixe
          mais sont consommées par Docker, jamais par l’application. En lecture
          seule, définitivement&nbsp;: le <code>.env</code> vit sur l’hôte, que le
          conteneur ne voit pas.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variable</TableHead>
                <TableHead>Valeur effective</TableHead>
                <TableHead>Origine</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {settings.map((setting) => (
                <TableRow key={setting.name}>
                  <TableCell className="font-mono text-xs">
                    {setting.name}
                    {setting.deprecated && (
                      <Badge variant="outline" className="ml-2 font-normal">
                        obsolète
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {/* Redacted **by name**, never by value — the prototype has
                        no authentication at all. */}
                    {setting.secret ? (
                      <span className="text-muted-foreground">
                        {setting.set ? '•••••• (défini)' : 'non défini'}
                      </span>
                    ) : (
                      (setting.value ?? <span className="text-muted-foreground">—</span>)
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {ORIGIN[setting.source]}
                    {setting.scope === 'runtime' && ' · relu à chaque cycle'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

const ORIGIN: Record<EffectiveSetting['source'], string> = {
  environment: 'environnement',
  default: 'valeur par défaut',
  unset: 'non défini',
}
