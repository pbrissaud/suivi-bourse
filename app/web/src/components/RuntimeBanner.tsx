import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { api, type RuntimeState } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/**
 * The global banner of #652 déc. 15 — background work, surfaced where it can be
 * seen from any page.
 *
 * **It is quiet by default**, and that is the whole design of it. A strip that
 * is always on screen is a strip nobody reads, so this renders nothing at all
 * while the four jobs are doing what they should. What makes it speak is
 * exactly the set of things that are silent today: a rejected configuration the
 * app is quietly running past, a backfill that has stopped advancing, an error
 * that only exists as a `logger.error` line.
 *
 * It reads `/api/runtime`, which touches no InfluxDB — so it keeps talking when
 * every other panel on the page has gone to a 503. That is the point of the
 * resource, and it is why #659's reserved `status` slot on `/api/shares` was
 * retired rather than filled.
 */
export function RuntimeBanner() {
  const runtime = useQuery({
    queryKey: ['runtime'],
    queryFn: api.runtime,
    // The scrape cadence, like every other poll in the app. Nothing here moves
    // faster than a scrape pass, so anything shorter polls for news that cannot
    // have arrived.
    refetchInterval: 120_000,
  })

  // Deliberately silent on its own failure. This component sits above every
  // page; an error strip permanently pinned there because one endpoint is
  // unreachable would be worse than the silence, and each page already renders
  // its own failure state.
  const state = runtime.data
  if (!state) return null

  const news = summarise(state)
  if (news.length === 0) return null

  return (
    <div className="border-b bg-muted/30">
      <div className="mx-auto max-w-7xl space-y-2 px-6 py-3">
        {news.map((item) => (
          <Alert key={item.key} variant={item.variant}>
            <AlertTitle>{item.title}</AlertTitle>
            <AlertDescription>{item.body}</AlertDescription>
          </Alert>
        ))}
      </div>
    </div>
  )
}

interface News {
  key: string
  variant: 'default' | 'destructive'
  title: string
  body: React.ReactNode
}

/**
 * What is worth interrupting for, in the order it matters.
 *
 * Each entry answers a question that has no other answer anywhere in the stack.
 * A configuration the app refused is the sharpest of them: since #658 an invalid
 * one is never published, so the app keeps running — *correctly* — on the
 * previous snapshot, and nothing on any screen would otherwise differ.
 */
function summarise(state: RuntimeState): News[] {
  const news: News[] = []
  // Sources that get an alert of their own below, and must therefore be kept
  // out of the generic error list. Found by looking: a rejected configuration
  // printed the same message twice — once with its context and a way to fix it,
  // once again as a bare line under "1 erreur en arrière-plan" — which reads as
  // two problems and makes the second block untrustworthy for the errors that
  // genuinely have nowhere else to appear.
  const named = new Set<string>()

  if (state.ingestion?.kept_previous) {
    named.add('ingest')
    news.push({
      key: 'ingestion',
      variant: 'destructive',
      title: 'Configuration refusée — l’ancienne est toujours active',
      body: (
        <>
          <p>
            La dernière lecture des fichiers ({formatDateTime(state.ingestion.at)}) a
            échoué&nbsp;: {state.ingestion.error}
          </p>
          <p>
            L’application continue de tourner sur la configuration précédente, donc
            rien d’autre à l’écran ne change. Corrigez le journal depuis la page{' '}
            <Link to="/donnees" className="underline">
              Données
            </Link>
            .
          </p>
        </>
      ),
    })
  }

  if (!state.scheduler_running) {
    news.push({
      key: 'scheduler',
      variant: 'destructive',
      title: 'Planificateur arrêté',
      body: 'Aucun relevé, aucune reprise d’historique et aucun calcul de performance ne tourne dans ce processus.',
    })
  }

  // The bar #656 asked for, and the only place the backfill's progress is
  // visible at all: `_backfill_backward` logs a warning and returns 0, which is
  // the same value a healthy weekend returns.
  const { in_scope: scope, complete, failing } = state.backfill
  if (scope > 0 && complete < scope) {
    news.push({
      key: 'backfill',
      variant: failing > 0 ? 'destructive' : 'default',
      title:
        failing > 0
          ? 'Reprise d’historique en difficulté'
          : 'Reprise d’historique en cours',
      body: (
        <div className="space-y-2">
          <p>
            {complete} série{complete > 1 ? 's' : ''} sur {scope} ont atteint leur
            premier achat.
            {failing > 0 &&
              ` ${failing} série${failing > 1 ? 's échouent' : ' échoue'} de façon répétée — les graphiques resteront tronqués tant que cela dure.`}
          </p>
          <Bar ratio={state.backfill.ratio} />
        </div>
      ),
    })
  }

  // The errors that are `logger.error` lines and nothing else today — minus the
  // ones an alert above already explains. Capped at three: this is a banner.
  const rest = state.errors.filter((error) => !named.has(error.source))
  if (rest.length > 0) {
    news.push({
      key: 'errors',
      variant: 'destructive',
      title: `${rest.length} erreur${rest.length > 1 ? 's' : ''} en arrière-plan`,
      body: (
        <ul className="space-y-0.5 text-sm">
          {rest.slice(0, 3).map((error, index) => (
            <li key={`${error.source}-${error.key}-${index}`}>
              <span className="font-mono text-xs">{error.source}</span>
              {error.key && <span className="text-xs"> ({error.key})</span>} —{' '}
              {error.message}
            </li>
          ))}
        </ul>
      ),
    })
  }

  return news
}

/** A bar, or nothing — never a bar with an invented denominator. */
export function Bar({ ratio }: { ratio: number | null }) {
  if (ratio === null) return null
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
  )
}
