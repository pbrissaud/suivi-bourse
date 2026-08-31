/**
 * *Which SuiviBourse is this?* — the card a bug report is copied out of.
 *
 * It rides on `/api/runtime`, the resource that opens nothing, and that is the
 * whole reason it is on this page rather than beside the imposed configuration:
 * the question is asked when something is broken, and every card fed by a read
 * of the store is a hole on exactly that screen. Here the answer is process
 * memory, settled at `execve` (`application/build_info.py`).
 *
 * **The unstamped build is a state, not an absence.** A card that vanished when
 * the two facts were `null` would leave an owner who built the image by hand
 * hunting for a version the page had silently decided not to mention. So the
 * card stays and says that nothing stamped this build — which is also the
 * sentence that stops them from inventing one in the ticket.
 *
 * What does not render is the read *in flight* (ADR-0026): `null` is a runtime
 * that has not answered yet, and a block that waits renders nothing at all,
 * title included.
 */
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import type { RuntimeBuild } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

/** The id the card's landmark is named by — one constant, two readers. */
const BUILD_HEADING = 'settings-build'

/**
 * How much of a commit is shown. Twelve characters is what `git log --oneline`
 * of a repository this size is unambiguous at, and the full hash stays in the
 * payload: a truncated one cannot be lengthened again, so the shortening is
 * done here and nowhere upstream.
 */
const SHORT = 12

export interface BuildBlockProps {
  /** **`null` until `GET /api/runtime` has landed** (#777, ADR-0026). */
  build: RuntimeBuild | null
}

export function BuildBlock({ build }: BuildBlockProps) {
  const { t } = useI18n()

  if (build === null) return null

  return (
    <Card role="region" aria-labelledby={BUILD_HEADING}>
      <CardHeader>
        <h2 id={BUILD_HEADING} className="eyebrow">
          {t('installation.build')}
        </h2>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="divide-y rounded-lg border text-sm">
          {/* Absent rather than rendered as an em dash: on a build from a
              branch there is no version to have an opinion about, and a row
              saying so would read as a release whose number went missing. */}
          {build.version !== null ? (
            <div className="flex flex-wrap gap-2 px-4 py-2">
              <dt className="text-muted-foreground">{t('installation.build.version')}</dt>
              <dd className="tabular ml-auto font-mono text-xs">{build.version}</dd>
            </div>
          ) : null}
          {build.revision !== null ? (
            <div className="flex flex-wrap gap-2 px-4 py-2">
              <dt className="text-muted-foreground">{t('installation.build.revision')}</dt>
              <dd className="tabular ml-auto font-mono text-xs">
                {build.revision.slice(0, SHORT)}
              </dd>
            </div>
          ) : null}
        </dl>
        {/* One sentence for the four states, said under the rows rather than
            beside one of them: it is about the pair, not about either half. */}
        <p className="max-w-prose text-sm text-muted-foreground">
          {t('installation.build.source', { source: build.source })}
        </p>
      </CardContent>
    </Card>
  )
}
