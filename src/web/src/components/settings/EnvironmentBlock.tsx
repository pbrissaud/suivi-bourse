/**
 * *What the container imposes* — a **description**, and the test of that is
 * mechanical: nothing in it is an `input`, and nothing in it can be focused
 * (#724, #830, ADR-0014).
 *
 * It was the second half of the settings block and it is a card of its own
 * since #830, for the reason the mock-up puts it last: it is the only thing on
 * this page nothing can be done about from here. Rendered as greyed fields it
 * would invite the click and read as a form that refused, so it is a key/value
 * list — and *changing one means recreating the container* is written **once for
 * the card** rather than under each of three rows.
 *
 * It rides on the same read as the dials, which is why the page draws it under
 * the same condition: a description of a configuration nobody has read yet is
 * not a description of anything (ADR-0026).
 */
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import type { ConfigResponse } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

/** The id the card's landmark is named by — one constant, two readers. */
const ENVIRONMENT_HEADING = 'settings-environment'

export interface EnvironmentBlockProps {
  config: ConfigResponse
}

export function EnvironmentBlock({ config }: EnvironmentBlockProps) {
  const { t } = useI18n()

  return (
    <Card role="region" aria-labelledby={ENVIRONMENT_HEADING}>
      <CardHeader>
        <h2 id={ENVIRONMENT_HEADING} className="eyebrow">
          {t('installation.settings.imposed')}
        </h2>
        {/* Written once for the card, never under each of three rows. */}
        <p className="max-w-prose text-sm text-muted-foreground">
          {t('installation.settings.imposed.note')}
        </p>
      </CardHeader>
      <CardContent>
        <dl className="divide-y rounded-lg border text-sm">
          {config.environment.map((variable) => (
            <div key={variable.name} className="flex flex-wrap gap-2 px-4 py-2">
              <dt className="font-mono text-xs text-muted-foreground">{variable.name}</dt>
              <dd className="tabular ml-auto font-mono text-xs">
                {variable.value ?? ''}
                {variable.set ? null : (
                  <span className="ml-2 font-sans text-muted-foreground">
                    {t('installation.settings.imposed.default')}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
        {/* `unread_environment` is deliberately **not** repeated here: it is one
            of the installation facts, the bell's panel says it with the names it
            found, and two announcers on one fact is the defect this page was
            rebuilt to remove. */}
      </CardContent>
    </Card>
  )
}
