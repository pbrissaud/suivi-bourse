import type { RuntimePill as Pill, SymbolRuntime } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'

/**
 * The pill of #652 déc. 15 — one per row of the Titres table.
 *
 * It answers the only question one actually asks in front of an odd figure:
 * *is the market asleep, or is the app broken?* Nothing else in the stack
 * answers it, and nothing else could: none of this state is in InfluxDB, so
 * Grafana cannot reach it at any price.
 *
 * The server picks which of a row's several truths gets the headline; this file
 * only names them. The `title` carries the rest, so the pill never hides
 * anything it outranked.
 */

const LABELS: Record<Pill, { label: string; variant: 'secondary' | 'outline' | 'destructive' }> = {
  // Not a failure state, and styled as one would be a lie: a container that
  // booted a minute ago has observed nothing yet.
  unknown: { label: 'Jamais relevé', variant: 'outline' },
  open: { label: 'Marché ouvert', variant: 'secondary' },
  closed: { label: 'Marché fermé', variant: 'outline' },
  frozen: { label: 'Cours figé', variant: 'destructive' },
  failing: { label: 'Échecs', variant: 'destructive' },
  backoff: { label: 'Suspendu', variant: 'destructive' },
  write_failed: { label: 'Écriture refusée', variant: 'destructive' },
}

const HINTS: Record<Pill, string> = {
  unknown:
    "Aucune passe de relevé n'a encore eu lieu pour ce titre dans ce processus.",
  open: 'Le dernier relevé a écrit un point.',
  closed: 'Marché fermé au dernier relevé : le travail dort jusqu’à la prochaine ouverture.',
  frozen:
    'Le cours enregistré ne bouge plus alors que la cotation en direct, elle, bouge. ' +
    'Le relevé fonctionne et enregistre une valeur périmée.',
  failing:
    'Le relevé échoue mais réessaie encore à la cadence normale.',
  backoff:
    'Trop d’échecs consécutifs : le délai entre deux tentatives grandit, ce titre ne sera pas ' +
    'réessayé avant longtemps.',
  write_failed:
    'La cotation est arrivée, le point n’a pas été enregistré. Le garde-fou anti-titre-mort ' +
    'surveille Yahoo Finance, pas la base : de son point de vue tout va bien.',
}

/**
 * `loaded` says whether the runtime resource has answered yet, and it exists
 * because **the two resources have different row sets** — which is not a bug in
 * either of them.
 *
 * `/api/shares` is driven by what InfluxDB *observed*; `/api/runtime` by what
 * the configuration *declares* (#656 déc. 3, #661's "the declaration drives").
 * So a position removed from the portfolio keeps its stored history and goes on
 * appearing in the table, with nothing scheduling it any more. Found by looking
 * — a `BTC-USD` left over from an earlier session sat in the table with an empty
 * cell beside it, which reads as something that failed to render rather than as
 * the fact it is: *this line is not being followed, which is why it no longer
 * moves*. Without `loaded` that state is indistinguishable from "the query has
 * not come back yet", and claiming it during the first paint would be worse than
 * the blank.
 */
export function RuntimePill({
  state,
  loaded = true,
}: {
  state: SymbolRuntime | undefined
  loaded?: boolean
}) {
  if (!state) {
    if (!loaded) return null
    return (
      <Badge
        variant="outline"
        className="text-muted-foreground"
        title={
          "Ce titre n’est plus déclaré dans le portefeuille : son historique " +
          'reste en base, mais plus aucun relevé ni aucune reprise ne tourne pour lui.'
        }
      >
        Non suivi
      </Badge>
    )
  }
  const { label, variant } = LABELS[state.pill]

  return (
    <Badge variant={variant} title={describe(state)}>
      {label}
    </Badge>
  )
}

/**
 * Everything the pill outranked, as one line of hover text.
 *
 * `market_state` is shown beside the pill rather than instead of it, and the
 * two can legitimately disagree: `decide` fail-opens an unrecognised state to
 * REGULAR, so a symbol can be treated as open while Yahoo calls it something
 * nobody has heard of.
 */
export function describe(state: SymbolRuntime): string {
  const parts = [HINTS[state.pill]]
  if (state.market_state) parts.push(`État Yahoo : ${state.market_state}.`)
  if (state.failure_count > 0) parts.push(`Échecs consécutifs : ${state.failure_count}.`)
  if (state.last_pass) parts.push(`Dernière passe : ${formatDateTime(state.last_pass)}.`)
  return parts.join(' ')
}

/**
 * When the next pass is due — and the honest version of "we do not know".
 *
 * A `date` job leaves the jobstore while it runs, so an absent next run means
 * *being scraped right now* **or** *titre retiré du portefeuille*. Both are
 * named; picking one would be wrong roughly half the time and would never say
 * so.
 */
export function nextRunLabel(state: SymbolRuntime): string {
  switch (state.next_run_state) {
    case 'scheduled':
      return formatDateTime(state.next_run)
    case 'ambiguous':
      return 'relevé en cours, ou titre retiré'
    case 'unavailable':
      return 'planificateur non démarré'
  }
}
