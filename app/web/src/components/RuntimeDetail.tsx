import type { BackfillProgress, SymbolRuntime } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { Bar } from '@/components/RuntimeBanner'
import { RuntimePill, nextRunLabel } from '@/components/RuntimePill'

/**
 * One symbol's runtime state, at the granularity the table cannot carry.
 *
 * #656 déc. 5 fixes that granularity as the **job's**, not the screen's: the
 * scrape job is per symbol, both backfill passes are per `(symbol, account)`.
 * So the row folds to one pill and the detail lives here — the same shape the
 * shares sheet already uses for the per-account position breakdown.
 */

const BACKFILL_LABELS: Record<string, string> = {
  // The three terminals, which must never be collapsed. Only the first is
  // progress; the other two describe series with nothing to fetch.
  complete: 'Historique complet',
  no_buy: 'Aucun achat enregistré',
  manual_mode: 'Sans objet en mode manuel',
  // The forward pass's healthy steady state during a trading session: it stands
  // aside so the live writer stays the sole writer of the present.
  too_recent: 'À jour',
  no_series: 'En attente de la première donnée',
  window_too_small: 'Fenêtre trop courte, reporté',
  no_share_info: 'En attente des métadonnées du titre',
  running: 'En cours',
  failing: 'En échec',
  unknown: 'Jamais exécuté',
}

export function RuntimeDetail({ state }: { state: SymbolRuntime | undefined }) {
  if (!state) {
    return (
      <p className="text-sm text-muted-foreground">
        L’état du planificateur n’a pas pu être lu.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <RuntimePill state={state} />
        <span className="text-xs text-muted-foreground">
          Dernière passe&nbsp;: {formatDateTime(state.last_pass)}
        </span>
        <span className="text-xs text-muted-foreground">
          Prochaine&nbsp;: {nextRunLabel(state)}
        </span>
      </div>

      {state.error && (
        <p className="text-sm text-destructive">{state.error}</p>
      )}

      {state.failure_count > 0 && (
        <p className="text-xs text-muted-foreground">
          {state.failure_count} échec{state.failure_count > 1 ? 's' : ''} consécutif
          {state.failure_count > 1 ? 's' : ''} de récupération du cours.
        </p>
      )}

      <div className="space-y-3">
        {state.accounts.map((account) => (
          <div key={account.account} className="rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{account.account}</span>
              {account.frozen && (
                <span className="text-xs text-destructive">
                  Cours enregistré figé
                </span>
              )}
            </div>
            <div className="mt-2 space-y-2">
              <Pass label="Historique (vers le passé)" progress={account.backward} />
              <Pass label="Rattrapage (vers le présent)" progress={account.forward} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Pass({
  label,
  progress,
}: {
  label: string
  progress: BackfillProgress | null
}) {
  if (!progress) return null

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span>{BACKFILL_LABELS[progress.state] ?? progress.state}</span>
      </div>

      {/* Null rather than zero when there is no span to measure against — the
          forward pass has no target, and a bar with an invented denominator says
          something false about a pass that is behaving correctly. */}
      <Bar ratio={progress.ratio} />

      {progress.target && (
        <p className="text-xs text-muted-foreground">
          Remonté jusqu’au {formatDateTime(progress.oldest)}, cible&nbsp;:{' '}
          {formatDateTime(progress.target)}
        </p>
      )}

      {progress.failures > 0 && (
        <p className="text-xs text-destructive">
          {progress.failures} cycle{progress.failures > 1 ? 's' : ''} en échec
          d’affilée{progress.error ? ` — ${progress.error}` : ''}
        </p>
      )}
    </div>
  )
}
